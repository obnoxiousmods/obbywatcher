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
    delivery: "cloudflare"
  },
  {
    id: "direct",
    label: "Direct",
    host: "s.test",
    pageUrl: "https://s.test/",
    dashUrl: "https://s.test/stream.mpd",
    hlsUrl: "https://s.test/stream.m3u8",
    delivery: "direct"
  }
];

describe("stable HLS config", () => {
  it("uses hard-reconnect-first live playback settings", () => {
    const config = createStableHlsConfig();

    expect(config.lowLatencyMode).toBe(false);
    expect(config.liveSyncDurationCount).toBe(3);
    expect(config.liveMaxLatencyDurationCount).toBe(8);
    expect(config.maxLiveSyncPlaybackRate).toBe(1.1);
    expect(config.maxBufferLength).toBeGreaterThanOrEqual(60);
    expect(config.manifestLoadingTimeOut).toBeLessThanOrEqual(5_000);
    expect(config.manifestLoadingMaxRetry).toBe(0);
    expect(config.levelLoadingTimeOut).toBeLessThanOrEqual(5_000);
    expect(config.levelLoadingMaxRetry).toBe(0);
    expect(config.fragLoadingTimeOut).toBeLessThanOrEqual(7_000);
    expect(config.fragLoadingMaxRetry).toBe(0);
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
