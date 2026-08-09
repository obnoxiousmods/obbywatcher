import { describe, expect, it } from "vitest";
import { sourcesForMirror, streamConfig, type StreamMirror } from "./stream";

describe("sourcesForMirror", () => {
  const mirror: StreamMirror = {
    id: "fight",
    label: "Primary",
    host: "fight.nswfiles.com",
    pageUrl: "https://fight.nswfiles.com/",
    dashUrl: "https://fight.nswfiles.com/stream/ufc.mpd",
    hlsUrl: "https://fight.nswfiles.com/stream/ufc.m3u8",
    delivery: "cloudflare",
  };

  it("derives a DASH and an HLS source from a mirror", () => {
    const sources = sourcesForMirror(mirror);
    expect(sources).toHaveLength(2);
    const [dash, hls] = sources;
    expect(dash).toMatchObject({ id: "fight-dash", protocol: "dash", url: mirror.dashUrl, mirrorId: "fight" });
    expect(hls).toMatchObject({ id: "fight-hls", protocol: "hls", url: mirror.hlsUrl, mirrorId: "fight" });
  });

  it("labels sources from the mirror label", () => {
    const [dash, hls] = sourcesForMirror(mirror);
    expect(dash.label).toBe("Primary DASH");
    expect(hls.label).toBe("Primary HLS");
  });
});

describe("streamConfig", () => {
  it("routes API-bearing mirrors through cockpit-known hosts", () => {
    const hosts = streamConfig.mirrors.map((m) => m.host);
    expect(hosts).toContain("fight.nswfiles.com");
    expect(hosts).toContain("s.obby.ca");
  });

  it("has unique mirror ids", () => {
    const ids = streamConfig.mirrors.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses https playback URLs", () => {
    for (const mirror of streamConfig.mirrors) {
      expect(mirror.dashUrl.startsWith("https://")).toBe(true);
      expect(mirror.hlsUrl.startsWith("https://")).toBe(true);
    }
  });
});
