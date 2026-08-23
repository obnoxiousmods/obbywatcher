import { describe, expect, it } from "vitest";
import type { StreamMirror } from "../config/stream";
import { createStableHlsConfig, orderedSourcesForCapabilities, selectPreferredProtocol } from "./useLiveHls";

const mirrors: StreamMirror[] = [
  {
    id: "primary",
    label: "Primary",
    host: "fight.test",
    pageUrl: "https://fight.test/",
    dashUrl: "https://fight.test/stream.mpd",
    hlsUrl: "https://fight.test/stream.m3u8",
    delivery: "cloudflare",
    origin: "primary-vhost"
  },
  {
    id: "direct",
    label: "Direct",
    host: "s.test",
    pageUrl: "https://s.test/",
    dashUrl: "https://s.test/stream.mpd",
    hlsUrl: "https://s.test/stream.m3u8",
    delivery: "direct",
    origin: "direct-vhost"
  }
];

/** What the obbystreams encoder currently publishes: `--hls-time` / `--hls-size`
 *  in bin/obbystreams. The live-tuning options below are counted in *segments*,
 *  so they only make sense against these. */
const ENCODER_SEGMENT_SECONDS = 2;
const ENCODER_WINDOW_SECONDS = 30;

describe("stable HLS config", () => {
  it("uses bounded loader timeouts", () => {
    const config = createStableHlsConfig();

    expect(config.lowLatencyMode).toBe(false);
    expect(config.manifestLoadingTimeOut).toBeLessThanOrEqual(5_000);
    expect(config.manifestLoadingMaxRetry).toBe(0);
    expect(config.levelLoadingTimeOut).toBeLessThanOrEqual(5_000);
    expect(config.fragLoadingTimeOut).toBeLessThanOrEqual(7_000);
  });

  it("reacts to a stall in a fraction of a second, not seconds", () => {
    const config = createStableHlsConfig();

    // The default is 2s, and Shaka's equivalent default is 1s. Those defaults ARE
    // the freeze: the two residual interruptions measured on 2026-08-22 were
    // 834ms and 955ms, which is not how long the underlying hiccup lasted -- it
    // is how long the player sat on it before nudging the playhead.
    expect(config.highBufferWatchdogPeriod).toBeLessThanOrEqual(0.25);
    // ...but still several frames, so playback that was about to resume on its
    // own is left alone rather than skipped over.
    expect(config.highBufferWatchdogPeriod).toBeGreaterThanOrEqual(0.1);
    // A nudge that does not take should be retried, not escalated into a full
    // pipeline rebuild, which costs the viewer a visible jump.
    expect(config.nudgeMaxRetry).toBeGreaterThanOrEqual(3);
  });

  it("keeps live-edge catch-up inaudible", () => {
    const config = createStableHlsConfig();

    // 1.05 is a 5% rate change -- an audible pitch shift, and measured on the
    // Shaka side as 0.981x average playback over 165s (it sat at the correction
    // rate for roughly a third of the session). Correcting slowly for longer is
    // strictly better than correcting fast and being heard.
    expect(config.maxLiveSyncPlaybackRate).toBeLessThanOrEqual(1.02);
  });

  it("holds enough live buffer to outlast a bursty upstream publish gap", () => {
    const config = createStableHlsConfig();
    const targetSeconds = (config.liveSyncDurationCount ?? 0) * ENCODER_SEGMENT_SECONDS;

    // Measured origin publish jitter on a bursty feed: p90 5.25s, max 7.54s
    // between publishes against a 2.002s nominal. Sit closer to the edge than
    // that and the buffer empties inside one gap.
    expect(targetSeconds).toBeGreaterThanOrEqual(9);
    // ...but still comfortably inside the published window, or the player ends up
    // riding the oldest retained segment and 404s when it rotates out.
    expect(targetSeconds).toBeLessThan(ENCODER_WINDOW_SECONDS / 2);
  });

  it("lets hls.js absorb routine segment errors instead of rebuilding the pipeline", () => {
    const config = createStableHlsConfig();

    // With 0 retries, every 404 on a segment that had just rotated out of the
    // live window counted toward softRecoveryFailureThreshold (3). Three of
    // those -- routine on a live playlist with publish jitter -- destroyed and
    // rebuilt the pipeline, and the rebuild is the visible skip. Shaka already
    // had this budget via retryParameters.maxAttempts; hls.js did not.
    expect(config.fragLoadingMaxRetry).toBeGreaterThanOrEqual(3);
    expect(config.levelLoadingMaxRetry).toBeGreaterThanOrEqual(2);
  });

  it("targets a live latency the encoder can actually sustain", () => {
    const config = createStableHlsConfig();
    const targetSeconds = (config.liveSyncDurationCount ?? 0) * ENCODER_SEGMENT_SECONDS;

    // The floor is set by segment-publish jitter, not by a fixed number of
    // seconds: chase an edge that moves more than your buffer and you rebuffer
    // constantly. Publication is paced at 2s with about a segment of jitter, so
    // three segments is the smallest target that absorbs it. (This was 5 while
    // publication was still erratic; pacing and UTCTiming are what earned the
    // reduction, and liveSync corrects by playback rate rather than stalling.)
    expect(targetSeconds).toBeGreaterThanOrEqual(3 * ENCODER_SEGMENT_SECONDS);
    expect(targetSeconds).toBeLessThan(ENCODER_WINDOW_SECONDS / 2);
  });

  it("keeps every buffer bound inside the encoder's publish window", () => {
    const config = createStableHlsConfig();
    const ceilingSeconds = (config.liveMaxLatencyDurationCount ?? 0) * ENCODER_SEGMENT_SECONDS;

    expect(config.liveMaxLatencyDurationCount ?? 0).toBeGreaterThan(config.liveSyncDurationCount ?? 0);
    expect(ceilingSeconds).toBeLessThanOrEqual(ENCODER_WINDOW_SECONDS);
    // Buffering past the window means chasing segments that already rotated off.
    expect(config.maxBufferLength ?? 0).toBeLessThanOrEqual(ENCODER_WINDOW_SECONDS);
  });

  it("avoids artifacts the viewer would notice", () => {
    const config = createStableHlsConfig();

    // Rate-warping to catch up is audible past a couple of percent.
    expect(config.maxLiveSyncPlaybackRate ?? 1).toBeLessThanOrEqual(1.05);
    // A jumpable gap approaching a segment reads as a skip.
    expect(config.maxBufferHole ?? 0).toBeLessThan(ENCODER_SEGMENT_SECONDS / 4);
  });
});

describe("protocol capability ordering", () => {
  it("defaults Apple/native-HLS devices to HLS", () => {
    const capability = { appleNativePath: true, nativeHls: true, hlsJs: true, dash: true };

    expect(selectPreferredProtocol(capability)).toBe("hls");
    expect(orderedSourcesForCapabilities(mirrors, capability).map((source) => source.id)).toEqual([
      "primary-hls",
      "direct-hls",
      "primary-dash",
      "direct-dash"
    ]);
  });

  it("defaults Shaka-capable non-Apple browsers to DASH with HLS fallback", () => {
    const capability = { appleNativePath: false, nativeHls: false, hlsJs: true, dash: true };

    expect(selectPreferredProtocol(capability)).toBe("dash");
    expect(orderedSourcesForCapabilities(mirrors, capability).map((source) => source.id)).toEqual([
      "primary-dash",
      "direct-dash",
      "primary-hls",
      "direct-hls"
    ]);
  });

  it("uses HLS-only order when DASH is unavailable", () => {
    const capability = { appleNativePath: false, nativeHls: false, hlsJs: true, dash: false };

    expect(selectPreferredProtocol(capability)).toBe("hls");
    expect(orderedSourcesForCapabilities(mirrors, capability).map((source) => source.id)).toEqual([
      "primary-hls",
      "direct-hls"
    ]);
  });

  it("allows manual HLS preference while keeping DASH as fallback when supported", () => {
    const capability = { appleNativePath: false, nativeHls: false, hlsJs: true, dash: true };

    expect(orderedSourcesForCapabilities(mirrors, capability, "hls").map((source) => source.id)).toEqual([
      "primary-hls",
      "direct-hls",
      "primary-dash",
      "direct-dash"
    ]);
  });

  it("falls back to an available protocol when a manual preference is unsupported", () => {
    const capability = { appleNativePath: false, nativeHls: false, hlsJs: true, dash: false };

    expect(orderedSourcesForCapabilities(mirrors, capability, "dash").map((source) => source.id)).toEqual([
      "primary-hls",
      "direct-hls"
    ]);
  });
});