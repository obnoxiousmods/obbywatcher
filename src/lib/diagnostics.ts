/**
 * Playback diagnostics: a bounded event log and the per-heartbeat metric roll-up.
 *
 * Why this exists. The 2026-08-22 freeze bug (nginx serving a playlist up to 30s
 * stale) was invisible to every check we had, because they all read the origin --
 * which was perfect throughout. What the player saw and what the server saw had
 * diverged, and nothing measured the player. These are the numbers that would
 * have named it in one glance: a manifest that stops advancing, a sequence that
 * goes backwards, a buffer that drains, a playhead that stops.
 *
 * Two shapes, deliberately:
 *  - COUNTERS accumulate and are reported as a delta per heartbeat, so the server
 *    can sum them across viewers without double counting.
 *  - GAUGES describe the window itself (min/max/percentile) and are reported
 *    absolutely, because an average of an average is meaningless.
 */

/** One thing that happened, with when. Kept small: this is shipped over the wire. */
export type DiagEvent = {
  /** ms since the log was created */
  t: number;
  kind: string;
  detail?: string;
};

export const DIAG_RING_CAPACITY = 200;
/** Events are free-form and partly engine-supplied; cap what reaches the wire. */
export const DIAG_DETAIL_MAX = 120;

/**
 * A fixed-capacity event log. Oldest entries are dropped, never the newest --
 * when something goes wrong the tail is what explains it.
 */
export function createDiagnosticsRing(capacity = DIAG_RING_CAPACITY, now = () => Date.now()) {
  const created = now();
  let events: DiagEvent[] = [];
  let dropped = 0;
  return {
    push(kind: string, detail?: string | number) {
      const entry: DiagEvent = { t: now() - created, kind };
      if (detail !== undefined && detail !== null && detail !== "") {
        entry.detail = String(detail).slice(0, DIAG_DETAIL_MAX);
      }
      events.push(entry);
      if (events.length > capacity) {
        events = events.slice(events.length - capacity);
        dropped += 1;
      }
    },
    /** Read and clear. The heartbeat ships what happened since the last beat. */
    drain(): DiagEvent[] {
      const out = events;
      events = [];
      return out;
    },
    /** Read without clearing, for the debug overlay. */
    peek(): readonly DiagEvent[] {
      return events;
    },
    droppedCount() {
      return dropped;
    },
    size() {
      return events.length;
    }
  };
}

export type DiagnosticsRing = ReturnType<typeof createDiagnosticsRing>;

/** Everything the player learned since the last heartbeat. snake_case = wire shape. */
export type PlaybackMetrics = {
  // -- manifest freshness: the blind spot that hid the freeze bug --
  manifest_age_ms: number | null;
  manifest_advance_rate: number | null;
  manifest_sequence_regressions: number;
  manifest_jump_max_segments: number;
  manifest_fetch_ms_max: number | null;
  // -- the freeze itself --
  stall_events: number;
  stall_total_ms: number;
  stall_longest_ms: number;
  buffer_min_seconds: number | null;
  gap_jumps: number;
  buffer_gap_events: number;
  // -- timeline accuracy --
  live_latency_max_seconds: number | null;
  latency_drift_seconds: number | null;
  playback_rate_avg: number | null;
  rate_warp_ms: number;
  seek_range_span_seconds: number | null;
  // -- delivery --
  segment_ttfb_ms_p50: number | null;
  segment_ttfb_ms_max: number | null;
  bandwidth_estimate_bps: number | null;
  segment_error_count: number;
  // -- engine / quality --
  level_switches: number;
  fps_drop_events: number;
  corrupted_frames: number;
  dropped_frame_ratio: number | null;
};

const percentile = (values: readonly number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

const round = (value: number | null, places = 2) =>
  value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places;

/**
 * Accumulates raw player observations and rolls them into one heartbeat's worth
 * of metrics. `collect()` resets the window, mirroring qoeDelta's contract.
 */
export function createMetricsAccumulator(now = () => Date.now()) {
  const fresh = () => ({
    stallEvents: 0,
    stallTotalMs: 0,
    stallLongestMs: 0,
    gapJumps: 0,
    bufferGapEvents: 0,
    levelSwitches: 0,
    fpsDropEvents: 0,
    segmentErrors: 0,
    manifestRegressions: 0,
    manifestJumpMax: 0,
    rateWarpMs: 0,
    bufferMin: null as number | null,
    latencyMax: null as number | null,
    latencyFirst: null as number | null,
    latencyLast: null as number | null,
    seekRangeSpan: null as number | null,
    manifestFetchMsMax: null as number | null,
    bandwidthBps: null as number | null,
    corruptedFrames: 0,
    droppedFrames: 0,
    decodedFrames: 0,
    ttfb: [] as number[],
    rates: [] as number[],
    // manifest advance tracking
    seqFirst: null as number | null,
    seqLast: null as number | null,
    seqFirstAtMs: null as number | null,
    seqLastAtMs: null as number | null,
    targetDuration: 2
  });

  let w = fresh();
  let stallStartedAt: number | null = null;

  return {
    /** Playback stopped. Idempotent: a burst of waiting/stalled is one stall. */
    stallBegin() {
      if (stallStartedAt !== null) return;
      stallStartedAt = now();
      w.stallEvents += 1;
    },
    stallEnd() {
      if (stallStartedAt === null) return;
      const ms = now() - stallStartedAt;
      stallStartedAt = null;
      w.stallTotalMs += ms;
      if (ms > w.stallLongestMs) w.stallLongestMs = ms;
    },
    /** 1 Hz health sample. */
    sample({
      bufferAheadSeconds,
      liveLatencySeconds,
      playbackRate,
      seekRangeSpanSeconds,
      inBufferGap
    }: {
      bufferAheadSeconds: number;
      liveLatencySeconds: number | null;
      playbackRate: number;
      seekRangeSpanSeconds?: number | null;
      inBufferGap?: boolean;
    }) {
      if (w.bufferMin === null || bufferAheadSeconds < w.bufferMin) w.bufferMin = bufferAheadSeconds;
      if (liveLatencySeconds !== null && Number.isFinite(liveLatencySeconds)) {
        if (w.latencyMax === null || liveLatencySeconds > w.latencyMax) w.latencyMax = liveLatencySeconds;
        if (w.latencyFirst === null) w.latencyFirst = liveLatencySeconds;
        w.latencyLast = liveLatencySeconds;
      }
      if (seekRangeSpanSeconds != null && Number.isFinite(seekRangeSpanSeconds)) {
        w.seekRangeSpan = seekRangeSpanSeconds;
      }
      if (Number.isFinite(playbackRate)) {
        w.rates.push(playbackRate);
        // Any rate that is not exactly 1 is the player warping time to chase the
        // live edge. Small warps are inaudible but they are still not playback.
        if (playbackRate !== 1) w.rateWarpMs += 1000;
      }
      if (inBufferGap) w.bufferGapEvents += 1;
    },
    /**
     * The manifest advertised a new media sequence.
     *
     * A DECREASE is the signature of a cache serving different versions of the
     * playlist (nginx open_file_cache across workers did exactly this) and is
     * never legitimate mid-stream. A large forward JUMP is the same fault seen
     * from the other side: the cache expiring and releasing everything at once.
     */
    manifestSequence(sequence: number, targetDurationSeconds?: number) {
      if (!Number.isFinite(sequence)) return;
      if (targetDurationSeconds && Number.isFinite(targetDurationSeconds)) {
        w.targetDuration = targetDurationSeconds;
      }
      const t = now();
      if (w.seqLast !== null) {
        const step = sequence - w.seqLast;
        if (step < 0) w.manifestRegressions += 1;
        else if (step > w.manifestJumpMax) w.manifestJumpMax = step;
      }
      if (w.seqFirst === null) {
        w.seqFirst = sequence;
        w.seqFirstAtMs = t;
      }
      w.seqLast = sequence;
      w.seqLastAtMs = t;
    },
    manifestFetchMs(ms: number) {
      if (!Number.isFinite(ms)) return;
      if (w.manifestFetchMsMax === null || ms > w.manifestFetchMsMax) w.manifestFetchMsMax = ms;
    },
    segmentLoaded({ ttfbMs, bandwidthBps }: { ttfbMs?: number; bandwidthBps?: number }) {
      if (ttfbMs !== undefined && Number.isFinite(ttfbMs)) w.ttfb.push(ttfbMs);
      if (bandwidthBps !== undefined && Number.isFinite(bandwidthBps)) w.bandwidthBps = bandwidthBps;
    },
    segmentError() {
      w.segmentErrors += 1;
    },
    gapJump() {
      w.gapJumps += 1;
    },
    levelSwitch() {
      w.levelSwitches += 1;
    },
    fpsDrop() {
      w.fpsDropEvents += 1;
    },
    frames({ decoded, dropped, corrupted }: { decoded?: number | null; dropped?: number | null; corrupted?: number | null }) {
      if (decoded != null && Number.isFinite(decoded)) w.decodedFrames = decoded;
      if (dropped != null && Number.isFinite(dropped)) w.droppedFrames = dropped;
      if (corrupted != null && Number.isFinite(corrupted)) w.corruptedFrames = corrupted;
    },
    /** Roll up and start a new window. */
    collect(): PlaybackMetrics {
      const cur = w;
      // Carry an in-flight stall forward rather than losing it at the boundary.
      if (stallStartedAt !== null) {
        const ms = now() - stallStartedAt;
        cur.stallTotalMs += ms;
        if (ms > cur.stallLongestMs) cur.stallLongestMs = ms;
        stallStartedAt = now();
      }
      w = fresh();
      w.targetDuration = cur.targetDuration;
      // Continuity: the next window must be able to detect a regression across
      // the boundary, so the last sequence carries over.
      w.seqLast = cur.seqLast;

      let advanceRate: number | null = null;
      if (
        cur.seqFirst !== null && cur.seqLast !== null &&
        cur.seqFirstAtMs !== null && cur.seqLastAtMs !== null &&
        cur.seqLastAtMs > cur.seqFirstAtMs
      ) {
        const mediaSeconds = (cur.seqLast - cur.seqFirst) * cur.targetDuration;
        const wallSeconds = (cur.seqLastAtMs - cur.seqFirstAtMs) / 1000;
        advanceRate = mediaSeconds / wallSeconds;
      }

      return {
        manifest_age_ms: cur.seqLastAtMs === null ? null : Math.max(0, now() - cur.seqLastAtMs),
        manifest_advance_rate: round(advanceRate, 3),
        manifest_sequence_regressions: cur.manifestRegressions,
        manifest_jump_max_segments: cur.manifestJumpMax,
        manifest_fetch_ms_max: round(cur.manifestFetchMsMax, 0),
        stall_events: cur.stallEvents,
        stall_total_ms: Math.round(cur.stallTotalMs),
        stall_longest_ms: Math.round(cur.stallLongestMs),
        buffer_min_seconds: round(cur.bufferMin),
        gap_jumps: cur.gapJumps,
        buffer_gap_events: cur.bufferGapEvents,
        live_latency_max_seconds: round(cur.latencyMax, 1),
        latency_drift_seconds:
          cur.latencyFirst === null || cur.latencyLast === null
            ? null
            : round(cur.latencyLast - cur.latencyFirst, 1),
        playback_rate_avg: cur.rates.length
          ? round(cur.rates.reduce((a, b) => a + b, 0) / cur.rates.length, 4)
          : null,
        rate_warp_ms: cur.rateWarpMs,
        seek_range_span_seconds: round(cur.seekRangeSpan, 1),
        segment_ttfb_ms_p50: round(percentile(cur.ttfb, 0.5), 0),
        segment_ttfb_ms_max: round(cur.ttfb.length ? Math.max(...cur.ttfb) : null, 0),
        bandwidth_estimate_bps: round(cur.bandwidthBps, 0),
        segment_error_count: cur.segmentErrors,
        level_switches: cur.levelSwitches,
        fps_drop_events: cur.fpsDropEvents,
        corrupted_frames: cur.corruptedFrames,
        dropped_frame_ratio: cur.decodedFrames > 0 ? round(cur.droppedFrames / cur.decodedFrames, 4) : null
      };
    }
  };
}

export type MetricsAccumulator = ReturnType<typeof createMetricsAccumulator>;

/** A metrics object with nothing observed. Used before a player exists. */
export function emptyPlaybackMetrics(): PlaybackMetrics {
  return createMetricsAccumulator(() => 0).collect();
}
