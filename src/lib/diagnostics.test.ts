import { describe, expect, it } from "vitest";
import {
  DIAG_DETAIL_MAX,
  createDiagnosticsRing,
  createMetricsAccumulator
} from "./diagnostics";

describe("diagnostics ring", () => {
  it("keeps the newest events when it overflows", () => {
    let t = 0;
    const ring = createDiagnosticsRing(3, () => t);
    for (const k of ["a", "b", "c", "d", "e"]) { t += 10; ring.push(k); }
    // When something goes wrong the tail is what explains it, so the oldest go.
    expect(ring.peek().map((e) => e.kind)).toEqual(["c", "d", "e"]);
    expect(ring.droppedCount()).toBe(2);
  });

  it("stamps events relative to creation and truncates detail", () => {
    let t = 1_000;
    const ring = createDiagnosticsRing(10, () => t);
    t = 1_250;
    ring.push("stall", "x".repeat(500));
    const [e] = ring.peek();
    expect(e.t).toBe(250);
    expect(e.detail).toHaveLength(DIAG_DETAIL_MAX);
  });

  it("omits empty detail rather than sending a blank string", () => {
    const ring = createDiagnosticsRing();
    ring.push("playing");
    ring.push("err", "");
    expect(ring.peek()[0].detail).toBeUndefined();
    expect(ring.peek()[1].detail).toBeUndefined();
  });

  it("drains so each heartbeat ships only what is new", () => {
    const ring = createDiagnosticsRing();
    ring.push("a");
    expect(ring.drain().map((e) => e.kind)).toEqual(["a"]);
    expect(ring.drain()).toEqual([]);
    expect(ring.size()).toBe(0);
  });
});

describe("metrics accumulator", () => {
  const harness = () => {
    let t = 0;
    const acc = createMetricsAccumulator(() => t);
    return { acc, at: (ms: number) => { t = ms; }, now: () => t };
  };

  it("counts a burst of stall signals as one stall and measures its length", () => {
    const { acc, at } = harness();
    at(1_000); acc.stallBegin();
    at(1_100); acc.stallBegin();   // waiting AND stalled both fire; still one stall
    at(2_500); acc.stallEnd();
    const m = acc.collect();
    expect(m.stall_events).toBe(1);
    expect(m.stall_total_ms).toBe(1_500);
    expect(m.stall_longest_ms).toBe(1_500);
  });

  it("carries an in-flight stall across the heartbeat boundary", () => {
    const { acc, at } = harness();
    at(0); acc.stallBegin();
    at(5_000);
    // Still frozen when the beat fires: the time so far must be reported, not lost.
    expect(acc.collect().stall_total_ms).toBe(5_000);
    at(7_000);
    expect(acc.collect().stall_total_ms).toBe(2_000);
  });

  it("flags a media sequence going backwards", () => {
    const { acc, at } = harness();
    at(0); acc.manifestSequence(100, 2);
    at(2_000); acc.manifestSequence(102, 2);
    // The nginx open_file_cache signature: workers disagreeing, sequence rolls back.
    at(4_000); acc.manifestSequence(95, 2);
    const m = acc.collect();
    expect(m.manifest_sequence_regressions).toBe(1);
  });

  it("measures how fast the manifest advances against wall clock", () => {
    const { acc, at } = harness();
    at(0); acc.manifestSequence(0, 2);
    for (let i = 1; i <= 5; i += 1) { at(i * 2_000); acc.manifestSequence(i, 2); }
    // 5 segments x 2s of media over 10s of wall clock = keeping up exactly.
    expect(acc.collect().manifest_advance_rate).toBe(1);
  });

  it("reports a stalled manifest as a low advance rate and a large jump", () => {
    const { acc, at } = harness();
    at(0); acc.manifestSequence(0, 2);
    // 30s frozen, then 15 segments released at once -- exactly what a 30s
    // open_file_cache produced.
    at(30_000); acc.manifestSequence(15, 2);
    const m = acc.collect();
    expect(m.manifest_jump_max_segments).toBe(15);
    expect(m.manifest_advance_rate).toBe(1);
    expect(m.manifest_age_ms).toBe(0);
  });

  it("detects a regression across a heartbeat boundary", () => {
    const { acc, at } = harness();
    at(0); acc.manifestSequence(200, 2);
    acc.collect();
    at(2_000); acc.manifestSequence(190, 2);
    expect(acc.collect().manifest_sequence_regressions).toBe(1);
  });

  it("tracks buffer low-water mark and latency drift", () => {
    const { acc, at } = harness();
    at(0); acc.sample({ bufferAheadSeconds: 12, liveLatencySeconds: 8, playbackRate: 1 });
    at(1_000); acc.sample({ bufferAheadSeconds: 3.4, liveLatencySeconds: 9, playbackRate: 1 });
    at(2_000); acc.sample({ bufferAheadSeconds: 9, liveLatencySeconds: 11.5, playbackRate: 1 });
    const m = acc.collect();
    expect(m.buffer_min_seconds).toBe(3.4);
    expect(m.live_latency_max_seconds).toBe(11.5);
    expect(m.latency_drift_seconds).toBe(3.5);
  });

  it("counts any rate that is not 1.0 as warped time", () => {
    const { acc, at } = harness();
    at(0); acc.sample({ bufferAheadSeconds: 9, liveLatencySeconds: 9, playbackRate: 0.95 });
    at(1_000); acc.sample({ bufferAheadSeconds: 9, liveLatencySeconds: 9, playbackRate: 1 });
    at(2_000); acc.sample({ bufferAheadSeconds: 9, liveLatencySeconds: 9, playbackRate: 1.02 });
    const m = acc.collect();
    // 5% and 2% corrections are inaudible but they are still not real-time playback.
    expect(m.rate_warp_ms).toBe(2_000);
    expect(m.playback_rate_avg).toBeCloseTo(0.99, 3);
  });

  it("summarises segment timing and gives a dropped-frame ratio", () => {
    const { acc } = harness();
    acc.segmentLoaded({ ttfbMs: 40, bandwidthBps: 5_000_000 });
    acc.segmentLoaded({ ttfbMs: 120 });
    acc.segmentLoaded({ ttfbMs: 80 });
    acc.frames({ decoded: 1_000, dropped: 25, corrupted: 2 });
    const m = acc.collect();
    expect(m.segment_ttfb_ms_max).toBe(120);
    expect(m.segment_ttfb_ms_p50).toBe(80);
    expect(m.bandwidth_estimate_bps).toBe(5_000_000);
    expect(m.dropped_frame_ratio).toBe(0.025);
    expect(m.corrupted_frames).toBe(2);
  });

  it("resets counters each window so the server can sum deltas safely", () => {
    const { acc, at } = harness();
    at(0); acc.gapJump(); acc.levelSwitch(); acc.segmentError(); acc.fpsDrop();
    const first = acc.collect();
    expect([first.gap_jumps, first.level_switches, first.segment_error_count, first.fps_drop_events])
      .toEqual([1, 1, 1, 1]);
    const second = acc.collect();
    expect([second.gap_jumps, second.level_switches, second.segment_error_count, second.fps_drop_events])
      .toEqual([0, 0, 0, 0]);
  });

  it("returns nulls rather than zeros when nothing was observed", () => {
    // A zero would be indistinguishable from a real measurement of zero and would
    // poison any server-side average.
    const m = createMetricsAccumulator(() => 0).collect();
    expect(m.buffer_min_seconds).toBeNull();
    expect(m.live_latency_max_seconds).toBeNull();
    expect(m.manifest_advance_rate).toBeNull();
    expect(m.dropped_frame_ratio).toBeNull();
    expect(m.segment_ttfb_ms_p50).toBeNull();
    expect(m.stall_events).toBe(0);
  });
});
