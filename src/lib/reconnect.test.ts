import { describe, expect, it } from "vitest";
import {
  chooseFreshestProbe,
  getBufferedAhead,
  isPlaylistStale,
  nextMirrorIndex,
  parseHlsManifest,
  retryDelayMs,
  shouldRotateMirror,
  sourceWithCacheBust
} from "./reconnect";

describe("reconnect policy", () => {
  it("calculates capped exponential backoff with deterministic jitter", () => {
    const options = { baseMs: 500, maxMs: 10_000, jitterRatio: 0.2 };

    expect(retryDelayMs(1, options, () => 0.5)).toBe(500);
    expect(retryDelayMs(2, options, () => 0.5)).toBe(1000);
    expect(retryDelayMs(8, options, () => 0.5)).toBe(10_000);
  });

  it("rotates mirrors only after the failure threshold is reached", () => {
    expect(shouldRotateMirror(1, 2, 2)).toBe(false);
    expect(shouldRotateMirror(2, 2, 2)).toBe(true);
    expect(shouldRotateMirror(4, 1, 2)).toBe(false);
    expect(nextMirrorIndex(1, 2)).toBe(0);
  });

  it("detects stale playlists from target duration", () => {
    expect(
      isPlaylistStale({
        nowMs: 20_001,
        lastSequenceAtMs: 1_000,
        targetDurationSeconds: 4,
        staleTargetDurations: 4
      })
    ).toBe(true);

    expect(
      isPlaylistStale({
        nowMs: 12_000,
        lastSequenceAtMs: 1_000,
        targetDurationSeconds: 4,
        staleTargetDurations: 4
      })
    ).toBe(false);
  });

  it("reports buffered seconds ahead of the current playhead", () => {
    const ranges = {
      length: 2,
      start: (index: number) => (index === 0 ? 0 : 20),
      end: (index: number) => (index === 0 ? 10 : 40)
    };

    expect(getBufferedAhead(ranges, 4)).toBe(6);
    expect(getBufferedAhead(ranges, 30)).toBe(10);
    expect(getBufferedAhead(ranges, 12)).toBe(0);
  });

  it("adds a cache buster without breaking existing query strings", () => {
    expect(sourceWithCacheBust("https://example.com/live.m3u8", "abc")).toBe(
      "https://example.com/live.m3u8?ow=abc"
    );
    expect(sourceWithCacheBust("https://example.com/live.m3u8?a=1", "abc")).toBe(
      "https://example.com/live.m3u8?a=1&ow=abc"
    );
  });

  it("parses live HLS manifests for active probing", () => {
    const parsed = parseHlsManifest(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:120
#EXTINF:4.000,
seg120.ts
#EXTINF:4.000,
seg121.ts
#EXTINF:4.000,
seg122.ts`);

    expect(parsed).toEqual({
      mediaSequence: 120,
      targetDurationSeconds: 4,
      segmentCount: 3,
      endSequence: 122,
      isLive: true
    });
  });

  it("chooses the freshest healthy manifest probe", () => {
    expect(
      chooseFreshestProbe([
        {
          ok: false,
          mirrorIndex: 0,
          url: "https://a.test/live.m3u8",
          fetchedAtMs: 10,
          error: "timeout"
        },
        {
          ok: true,
          mirrorIndex: 1,
          url: "https://b.test/live.m3u8",
          fetchedAtMs: 12,
          mediaSequence: 90,
          targetDurationSeconds: 4,
          segmentCount: 3,
          endSequence: 92,
          isLive: true
        },
        {
          ok: true,
          mirrorIndex: 0,
          url: "https://a.test/live.m3u8",
          fetchedAtMs: 11,
          mediaSequence: 88,
          targetDurationSeconds: 4,
          segmentCount: 3,
          endSequence: 90,
          isLive: true
        }
      ])?.mirrorIndex
    ).toBe(1);
  });
});
