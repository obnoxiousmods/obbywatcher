export type TimeRangeSource = {
  length: number;
  start(index: number): number;
  end(index: number): number;
};

export type RetryBackoffOptions = {
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
};

export type StalePlaylistInput = {
  nowMs: number;
  lastSequenceAtMs: number | null;
  targetDurationSeconds: number;
  staleTargetDurations: number;
};

export type ParsedManifestProbe = {
  mediaSequence: number | null;
  targetDurationSeconds: number;
  segmentCount: number;
  variantCount?: number;
  endSequence: number | null;
  isLive: boolean;
};

export type ManifestProbeResult = ParsedManifestProbe & {
  mirrorIndex: number;
  url: string;
  fetchedAtMs: number;
  ok: true;
};

export type ManifestProbeFailure = {
  mirrorIndex: number;
  url: string;
  fetchedAtMs: number;
  ok: false;
  error: string;
};

export type ManifestProbe = ManifestProbeResult | ManifestProbeFailure;

type MirrorDelivery = "cloudflare" | "direct";

type MirrorLike = {
  id: string;
  delivery: MirrorDelivery;
  /** Mirrors sharing an origin resolve to the same vhost and the same encoder
   *  output. Optional so callers with older mirror shapes still type-check; an
   *  absent origin falls back to the mirror id, i.e. "shares with nobody". */
  origin?: string;
};

type SourceLike = {
  mirrorId: string;
  protocol: string;
};

export function retryDelayMs(
  attempt: number,
  options: RetryBackoffOptions,
  random: () => number = Math.random
) {
  const safeAttempt = Math.max(1, attempt);
  const exponential = options.baseMs * 2 ** (safeAttempt - 1);
  const capped = Math.min(options.maxMs, exponential);
  const jitterRange = capped * options.jitterRatio;
  const jitter = (random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(capped + jitter));
}

export function nextMirrorIndex(currentIndex: number, totalMirrors: number) {
  if (totalMirrors <= 1) return 0;
  return (currentIndex + 1) % totalMirrors;
}

/** A mirror's origin group, falling back to its own id when untagged. */
function originOf(mirror: MirrorLike | undefined, fallbackId: string | undefined) {
  return mirror?.origin ?? mirror?.id ?? fallbackId ?? "";
}

export function chooseNextSourceIndex(
  currentIndex: number,
  sources: readonly SourceLike[],
  mirrors: readonly MirrorLike[]
) {
  if (sources.length <= 1) return 0;

  const currentSource = sources[currentIndex] ?? sources[0];
  const currentMirror = mirrors.find((mirror) => mirror.id === currentSource?.mirrorId);
  const currentDelivery = currentMirror?.delivery ?? "cloudflare";
  const currentOrigin = originOf(currentMirror, currentSource?.mirrorId);

  const ranked = sources
    .map((source, index) => {
      const mirror = mirrors.find((item) => item.id === source.mirrorId);
      const delivery = mirror?.delivery ?? "cloudflare";
      const distance = index > currentIndex ? index - currentIndex : index + sources.length - currentIndex;
      // Sharing an origin is the strongest signal that a candidate will fail for
      // the same reason the current source just did: same vhost, same disk, same
      // encoder. It outranks sharing a mirror id, which is only a subset of it.
      const sameOriginPenalty = originOf(mirror, source.mirrorId) === currentOrigin ? 100 : 0;
      const sameMirrorPenalty = source.mirrorId === currentSource?.mirrorId ? 40 : 0;
      const sameDeliveryPenalty = delivery === currentDelivery ? 20 : 0;
      // Switching protocol swaps the whole player engine (Shaka <-> hls.js), so
      // it clears engine-specific faults. Prefer it over another mirror that is
      // really the same server. This used to be inverted: a protocol change was
      // PENALISED 5, so rotation exhausted every same-origin mirror first.
      const sameProtocolPenalty = source.protocol === currentSource?.protocol ? 30 : 0;
      return {
        index,
        score: sameOriginPenalty + sameMirrorPenalty + sameDeliveryPenalty + sameProtocolPenalty + distance,
      };
    })
    .filter((candidate) => candidate.index !== currentIndex)
    .sort((left, right) => left.score - right.score);

  return ranked[0]?.index ?? nextMirrorIndex(currentIndex, sources.length);
}

export function shouldRotateMirror(consecutiveSourceFailures: number, totalMirrors: number, threshold: number) {
  return totalMirrors > 1 && consecutiveSourceFailures >= threshold;
}

/** Never call a playlist stale sooner than this, however short the segments are.
 *  It has to clear the player's own loader timeouts (levelLoading 5s,
 *  fragLoading 7s) or a slow-but-successful load is declared stale before it can
 *  finish, and the pipeline is torn down for nothing.
 *
 *  12_000 is exactly 5s + 7s, i.e. zero margin: a load that succeeds on the last
 *  retry lands precisely on the threshold and races it. Carry 3s of headroom. */
export const MIN_PLAYLIST_STALE_MS = 15_000;

export function isPlaylistStale({
  nowMs,
  lastSequenceAtMs,
  targetDurationSeconds,
  staleTargetDurations
}: StalePlaylistInput) {
  if (!lastSequenceAtMs) return false;

  const safeTargetSeconds = Math.max(2, targetDurationSeconds || 4);
  const staleAfterMs = Math.max(
    MIN_PLAYLIST_STALE_MS,
    safeTargetSeconds * staleTargetDurations * 1000
  );

  return nowMs - lastSequenceAtMs > staleAfterMs;
}

/** How far back from the seekable end to land when jumping to live. Two segments,
 *  so the playhead has buffered content under it instead of stalling on arrival. */
export function liveEdgeBackoffSeconds(targetDurationSeconds: number) {
  const safeTargetSeconds = Math.max(2, targetDurationSeconds || 4);
  return Math.min(8, safeTargetSeconds * 2);
}

export function getBufferedAhead(buffered: TimeRangeSource, currentTime: number) {
  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index);
    const end = buffered.end(index);

    if (currentTime >= start && currentTime <= end) {
      return Math.max(0, end - currentTime);
    }
  }

  return 0;
}

export function sourceWithCacheBust(source: string, stamp: number | string) {
  // Strip any existing cache-bust param so reloads/reconnects don't accumulate
  // duplicate query keys.
  const [base, search] = source.split("?", 2);
  const params = search
    ? new URLSearchParams(
        search
          .split("&")
          .filter((pair) => !pair.startsWith("ow=") && pair !== "ow=")
          .join("&")
      )
    : new URLSearchParams();
  params.set("ow", String(stamp));
  return `${base}?${params.toString()}`;
}

export function parseHlsManifest(manifest: string): ParsedManifestProbe | null {
  if (!manifest.includes("#EXTM3U")) return null;

  let mediaSequence: number | null = null;
  let targetDurationSeconds = 4;
  let segmentCount = 0;
  let variantCount = 0;
  let isLive = true;

  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const parsed = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
      if (Number.isFinite(parsed)) mediaSequence = parsed;
      continue;
    }

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const parsed = Number.parseFloat(line.slice("#EXT-X-TARGETDURATION:".length));
      if (Number.isFinite(parsed) && parsed > 0) targetDurationSeconds = parsed;
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      segmentCount += 1;
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      variantCount += 1;
      continue;
    }

    if (line === "#EXT-X-ENDLIST") {
      isLive = false;
    }
  }

  const usableEntries = Math.max(segmentCount, variantCount);
  const endSequence = mediaSequence === null ? null : mediaSequence + Math.max(0, usableEntries - 1);

  return {
    mediaSequence,
    targetDurationSeconds,
    segmentCount: usableEntries,
    variantCount,
    endSequence,
    isLive
  };
}

export function parseDashManifest(manifest: string): ParsedManifestProbe | null {
  if (!manifest.includes("<MPD")) return null;
  const representationCount = (manifest.match(/<Representation\b/g) ?? []).length;
  const segmentTemplateCount = (manifest.match(/<SegmentTemplate\b/g) ?? []).length;
  const mediaSequenceMatch = manifest.match(/startNumber="(\d+)"/);
  const durationMatch = manifest.match(/duration="(\d+)"/);
  const timescaleMatch = manifest.match(/timescale="(\d+)"/);
  const segmentTimelineCount = (manifest.match(/<S\b/g) ?? []).length;
  const mediaSequence = mediaSequenceMatch ? Number.parseInt(mediaSequenceMatch[1], 10) : null;
  const duration = durationMatch ? Number.parseFloat(durationMatch[1]) : null;
  const timescale = timescaleMatch ? Number.parseFloat(timescaleMatch[1]) : null;
  const targetDurationSeconds = duration && timescale ? Math.max(1, duration / timescale) : 4;
  const segmentCount = Math.max(segmentTimelineCount, segmentTemplateCount > 0 ? representationCount : 0);
  const endSequence = mediaSequence === null ? null : mediaSequence + Math.max(0, segmentCount - 1);
  const staticPresentation = /type="static"/.test(manifest);

  if (representationCount === 0 && segmentTemplateCount === 0) return null;

  return {
    mediaSequence,
    targetDurationSeconds,
    segmentCount,
    endSequence,
    isLive: !staticPresentation
  };
}

export function chooseFreshestProbe(probes: readonly ManifestProbe[]) {
  const healthy = probes.filter((probe): probe is ManifestProbeResult => probe.ok && probe.isLive && probe.segmentCount > 0);
  if (healthy.length === 0) return null;

  return healthy.reduce((freshest, probe) => {
    const probeSequence = probe.endSequence ?? probe.mediaSequence ?? -1;
    const freshestSequence = freshest.endSequence ?? freshest.mediaSequence ?? -1;

    if (probeSequence !== freshestSequence) {
      return probeSequence > freshestSequence ? probe : freshest;
    }

    return probe.fetchedAtMs > freshest.fetchedAtMs ? probe : freshest;
  });
}

/** True while a freshly attached player should not be judged at all. */
export function withinAttachGrace(nowMs: number, attachedAtMs: number, attachGraceMs: number) {
  return nowMs - attachedAtMs < attachGraceMs;
}

export type StallInput = {
  nowMs: number;
  lastTimeUpdateAtMs: number;
  stallTimeoutMs: number;
  playheadMoved: boolean;
  bufferAheadSeconds: number;
  minBufferSeconds?: number;
};

/**
 * Whether playback has genuinely stalled and warrants tearing the pipeline down.
 *
 * Callers MUST keep lastTimeUpdateAtMs moving forward during the attach grace
 * window. Leaving it stamped at attach time means this returns true on the first
 * tick after the grace lifts, which collapses the tolerance from
 * (grace + stallTimeout) to just grace and re-attaches a slow client forever.
 */
export function isPlaybackStalled({
  nowMs,
  lastTimeUpdateAtMs,
  stallTimeoutMs,
  playheadMoved,
  bufferAheadSeconds,
  minBufferSeconds = 0.8
}: StallInput) {
  if (playheadMoved) return false;
  return nowMs - lastTimeUpdateAtMs > stallTimeoutMs && bufferAheadSeconds < minBufferSeconds;
}
