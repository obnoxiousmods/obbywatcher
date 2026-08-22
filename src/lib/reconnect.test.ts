import { describe, expect, it } from "vitest";
import {
  chooseNextSourceIndex,
  chooseFreshestProbe,
  getBufferedAhead,
  isPlaybackStalled,
  isPlaylistStale,
  liveEdgeBackoffSeconds,
  MIN_PLAYLIST_STALE_MS,
  nextMirrorIndex,
  parseDashManifest,
  parseHlsManifest,
  retryDelayMs,
  shouldRotateMirror,
  sourceWithCacheBust,
  withinAttachGrace
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

  // The production shape: "fight" and "live" are two hostnames for ONE nginx
  // vhost serving ONE encoder, both behind Cloudflare. "direct" is a separate
  // vhost reached without Cloudflare.
  const productionSources = [
    { mirrorId: "fight", protocol: "dash" },
    { mirrorId: "live", protocol: "dash" },
    { mirrorId: "direct", protocol: "dash" },
    { mirrorId: "fight", protocol: "hls" },
    { mirrorId: "live", protocol: "hls" },
    { mirrorId: "direct", protocol: "hls" },
  ];
  const productionMirrors = [
    { id: "fight", delivery: "cloudflare" as const, origin: "live-vhost" },
    { id: "live", delivery: "cloudflare" as const, origin: "live-vhost" },
    { id: "direct", delivery: "direct" as const, origin: "cockpit-vhost" },
  ];

  it("never rotates to a mirror that shares an origin with the one that just failed", () => {
    // From fight-dash (index 0), "live" is the same server: rotating there
    // re-tries the identical origin and buys another teardown for nothing.
    const next = chooseNextSourceIndex(0, productionSources, productionMirrors);
    expect(productionSources[next].mirrorId).not.toBe("fight");
    expect(productionSources[next].mirrorId).not.toBe("live");
    expect(productionSources[next].mirrorId).toBe("direct");
  });

  it("prefers a different protocol on a different origin, so the engine changes too", () => {
    // direct-hls: different origin, different delivery, and swaps Shaka for hls.js.
    expect(chooseNextSourceIndex(0, productionSources, productionMirrors)).toBe(5);
  });

  it("falls back to the mirror id when no origin is tagged", () => {
    // Untagged mirrors must not all collapse into one origin group.
    const next = chooseNextSourceIndex(
      0,
      productionSources,
      [
        { id: "fight", delivery: "cloudflare" as const },
        { id: "live", delivery: "cloudflare" as const },
        { id: "direct", delivery: "direct" as const },
      ]
    );
    expect(next).not.toBe(0);
    expect(productionSources[next].mirrorId).not.toBe("fight");
  });

  it("cache-busts URLs without accumulating duplicate ow params", () => {
    expect(sourceWithCacheBust("https://example.com/stream.m3u8", "abc")).toBe(
      "https://example.com/stream.m3u8?ow=abc"
    );
    expect(sourceWithCacheBust("https://example.com/stream.m3u8?ow=old", "abc")).toBe(
      "https://example.com/stream.m3u8?ow=abc"
    );
    expect(sourceWithCacheBust("https://example.com/stream.m3u8?x=1&ow=old", "abc")).toBe(
      "https://example.com/stream.m3u8?x=1&ow=abc"
    );
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

  it("never declares a playlist stale faster than the player's own load timeouts", () => {
    // 2s segments x 3 would be a 6s window, which is under hls.js's 7s
    // fragLoadingTimeOut: a slow-but-successful load would be called stale and
    // the pipeline torn down for nothing.
    expect(
      isPlaylistStale({
        nowMs: 1_000 + 7_500,
        lastSequenceAtMs: 1_000,
        targetDurationSeconds: 2,
        staleTargetDurations: 3
      })
    ).toBe(false);

    expect(
      isPlaylistStale({
        nowMs: 1_000 + MIN_PLAYLIST_STALE_MS + 1,
        lastSequenceAtMs: 1_000,
        targetDurationSeconds: 2,
        staleTargetDurations: 3
      })
    ).toBe(true);
  });

  it("backs off two segments when jumping to live", () => {
    expect(liveEdgeBackoffSeconds(2)).toBe(4);
    expect(liveEdgeBackoffSeconds(4)).toBe(8);
    // Unparsed/zero target duration must still land somewhere playable.
    expect(liveEdgeBackoffSeconds(0)).toBeGreaterThanOrEqual(4);
    // And never so far back that "go live" isn't live.
    expect(liveEdgeBackoffSeconds(60)).toBeLessThanOrEqual(8);
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
      variantCount: 0,
      endSequence: 122,
      isLive: true
    });
  });

  it("treats HLS master playlists as viable live probes", () => {
    const parsed = parseHlsManifest(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6200000,RESOLUTION=1920x1080
1080p/index.m3u8`);

    expect(parsed).toEqual({
      mediaSequence: null,
      targetDurationSeconds: 4,
      segmentCount: 2,
      variantCount: 2,
      endSequence: null,
      isLive: true
    });
  });

  it("parses live DASH manifests for active probing", () => {
    const parsed = parseDashManifest(`<MPD type="dynamic">
<Period>
<AdaptationSet>
<Representation id="0" bandwidth="2500000">
<SegmentTemplate timescale="1" duration="4" startNumber="20" media="ufc_chunk_0_$Number$.m4s" />
</Representation>
<Representation id="2" bandwidth="6000000">
<SegmentTemplate timescale="1" duration="4" startNumber="20" media="ufc_chunk_2_$Number$.m4s" />
</Representation>
</AdaptationSet>
</Period>
</MPD>`);

    expect(parsed).toEqual({
      mediaSequence: 20,
      targetDurationSeconds: 4,
      segmentCount: 2,
      endSequence: 21,
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

describe("attach grace and stall detection", () => {
  const GRACE = 8_000;
  const STALL = 8_000;

  it("mutes judgement for the whole grace window", () => {
    expect(withinAttachGrace(1_000, 1_000, GRACE)).toBe(true);
    expect(withinAttachGrace(1_000 + GRACE - 1, 1_000, GRACE)).toBe(true);
    expect(withinAttachGrace(1_000 + GRACE, 1_000, GRACE)).toBe(false);
  });

  it("does not fire the instant the grace window lifts", () => {
    // The bug: lastTimeUpdateAtMs stamped at attach and left frozen through the
    // grace means the stall timer has already run its full length by the time
    // judgement resumes, so it trips on the next tick and a slow client
    // re-attaches forever. The caller must carry the clock forward, and this is
    // what that looks like from here.
    const attachedAt = 1_000;
    const graceEnds = attachedAt + GRACE;
    const carriedForward = graceEnds; // refreshed on the last in-grace tick

    expect(
      isPlaybackStalled({
        nowMs: graceEnds + 1,
        lastTimeUpdateAtMs: carriedForward,
        stallTimeoutMs: STALL,
        playheadMoved: false,
        bufferAheadSeconds: 0
      })
    ).toBe(false);

    // Total tolerance is grace + stallTimeout, not max(grace, stallTimeout).
    expect(
      isPlaybackStalled({
        nowMs: graceEnds + STALL + 1,
        lastTimeUpdateAtMs: carriedForward,
        stallTimeoutMs: STALL,
        playheadMoved: false,
        bufferAheadSeconds: 0
      })
    ).toBe(true);
  });

  it("never reports a stall while the playhead is advancing", () => {
    expect(
      isPlaybackStalled({
        nowMs: 10_000_000,
        lastTimeUpdateAtMs: 0,
        stallTimeoutMs: STALL,
        playheadMoved: true,
        bufferAheadSeconds: 0
      })
    ).toBe(false);
  });

  it("never reports a stall while there is buffer to play", () => {
    expect(
      isPlaybackStalled({
        nowMs: 100_000,
        lastTimeUpdateAtMs: 0,
        stallTimeoutMs: STALL,
        playheadMoved: false,
        bufferAheadSeconds: 5
      })
    ).toBe(false);
  });
});
