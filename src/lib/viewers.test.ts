import { describe, expect, it } from "vitest";
import { qoeDelta, totalViewerCount, viewerCountForSource } from "./viewers";

describe("viewer count helpers", () => {
  it("prefers per-source counts from by_source", () => {
    const viewers = {
      total: 8,
      by_source: { "server-1": 4 },
      sources: [{ id: "server-1", viewer_count: 12 }]
    };

    expect(viewerCountForSource(viewers, "server-1", 33)).toBe(4);
  });

  it("falls back to source entries, then provided fallback", () => {
    const viewers = {
      sources: [{ id: "public-a", viewer_count: 3 }]
    };

    expect(viewerCountForSource(viewers, "public-a", 0)).toBe(3);
    expect(viewerCountForSource(viewers, "missing", 7)).toBe(7);
  });

  it("uses explicit total when present", () => {
    expect(totalViewerCount({ total: 5, by_source: { a: 2, b: 2 } })).toBe(5);
  });

  it("sums by_source when total is missing", () => {
    expect(totalViewerCount({ by_source: { a: 2, b: 3 } })).toBe(5);
  });

  it("rejects invalid and negative counts", () => {
    expect(viewerCountForSource({ by_source: { a: -1 }, sources: [{ id: "a", viewer_count: 2 }] }, "a")).toBe(2);
    expect(totalViewerCount({ total: Number.NaN, by_source: { a: 1 } })).toBe(1);
  });
});

describe("qoeDelta", () => {
  it("reports the change since the previous heartbeat", () => {
    const report = qoeDelta(
      { recoveryCount: 7, droppedFrames: 120, liveLatencySeconds: 9.27 },
      { recoveryCount: 4, droppedFrames: 100 }
    );

    expect(report.reattaches).toBe(3);
    expect(report.dropped_frames).toBe(20);
    expect(report.live_latency_seconds).toBe(9.3);
  });

  it("treats a counter reset as no activity rather than a negative spike", () => {
    // The player rebuilds on a source switch and both counters restart at zero.
    const report = qoeDelta(
      { recoveryCount: 0, droppedFrames: 0, liveLatencySeconds: 4 },
      { recoveryCount: 12, droppedFrames: 900 }
    );

    expect(report.reattaches).toBe(0);
    expect(report.dropped_frames).toBe(0);
  });

  it("omits latency that is unknown or not finite", () => {
    expect(
      qoeDelta({ recoveryCount: 0, droppedFrames: 0, liveLatencySeconds: null }, { recoveryCount: 0, droppedFrames: 0 })
        .live_latency_seconds
    ).toBeNull();
    expect(
      qoeDelta({ recoveryCount: 0, droppedFrames: 0, liveLatencySeconds: Infinity }, { recoveryCount: 0, droppedFrames: 0 })
        .live_latency_seconds
    ).toBeNull();
  });

  it("is stable when nothing changed", () => {
    const report = qoeDelta(
      { recoveryCount: 5, droppedFrames: 5, liveLatencySeconds: 0 },
      { recoveryCount: 5, droppedFrames: 5 }
    );
    expect(report).toEqual({
      reattaches: 0,
      dropped_frames: 0,
      live_latency_seconds: 0,
      last_error: null,
      mirror_id: null
    });
  });

  it("carries the last error and mirror so the server can tell re-attaches apart", () => {
    const report = qoeDelta(
      {
        recoveryCount: 3,
        droppedFrames: 0,
        liveLatencySeconds: 8.24,
        lastError: "  Playback stalled at the live edge.  ",
        mirrorId: "fight"
      },
      { recoveryCount: 1, droppedFrames: 0 }
    );
    expect(report.reattaches).toBe(2);
    expect(report.last_error).toBe("Playback stalled at the live edge.");
    expect(report.mirror_id).toBe("fight");
  });

  it("nulls an empty error rather than sending a blank string", () => {
    const report = qoeDelta(
      { recoveryCount: 0, droppedFrames: 0, liveLatencySeconds: null, lastError: "   ", mirrorId: "" },
      { recoveryCount: 0, droppedFrames: 0 }
    );
    expect(report.last_error).toBeNull();
    expect(report.mirror_id).toBeNull();
  });
});
