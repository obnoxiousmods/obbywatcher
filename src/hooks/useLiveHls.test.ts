import { describe, expect, it } from "vitest";
import { createStableHlsConfig } from "./useLiveHls";

describe("stable HLS config", () => {
  it("uses hard-reconnect-first live playback settings", () => {
    const config = createStableHlsConfig();

    expect(config.lowLatencyMode).toBe(false);
    expect(config.liveSyncDurationCount).toBe(3);
    expect(config.liveMaxLatencyDurationCount).toBe(8);
    expect(config.maxLiveSyncPlaybackRate).toBe(1.1);
    expect(config.maxBufferLength).toBeGreaterThanOrEqual(60);
    expect(config.manifestLoadingMaxRetry).toBeLessThanOrEqual(1);
    expect(config.levelLoadingMaxRetry).toBeLessThanOrEqual(1);
    expect(config.fragLoadingMaxRetry).toBeLessThanOrEqual(1);
  });
});
