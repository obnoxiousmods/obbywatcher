import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import type { HlsConfig } from "hls.js";
import shaka from "shaka-player";
import { sourcesForMirror } from "../config/stream";
import type { StreamMirror, StreamProtocol, StreamSource } from "../config/stream";
import {
  chooseNextSourceIndex,
  chooseFreshestProbe,
  getBufferedAhead,
  isPlaybackStalled,
  isPlaylistStale,
  liveEdgeBackoffSeconds,
  nextMirrorIndex,
  parseDashManifest,
  parseHlsManifest,
  retryDelayMs,
  shouldRotateMirror,
  sourceWithCacheBust,
  withinAttachGrace
} from "../lib/reconnect";
import type { ManifestProbe, ManifestProbeFailure, ManifestProbeResult } from "../lib/reconnect";
import { createDiagnosticsRing, createMetricsAccumulator, emptyPlaybackMetrics, type DiagEvent, type PlaybackMetrics } from "../lib/diagnostics";

export type LivePlaybackStatus = "idle" | "connecting" | "live" | "buffering" | "reconnecting" | "offline" | "failed";
export type PlaybackEngine = "shaka" | "hls.js" | "native" | "unsupported" | "pending";
export type ProtocolPreference = StreamProtocol | "auto";

export type PlaybackCapability = {
  appleNativePath: boolean;
  nativeHls: boolean;
  hlsJs: boolean;
  dash: boolean;
};

export type LiveProbeSnapshot = {
  ok: boolean;
  mirrorIndex: number;
  host: string;
  protocol: StreamProtocol;
  sequence: number | null;
  fetchedAtMs: number;
  error: string | null;
};

export type LiveHlsSnapshot = {
  status: LivePlaybackStatus;
  mode: PlaybackEngine;
  activeMirrorIndex: number;
  activeProtocol: StreamProtocol;
  activeSourceUrl: string;
  attempt: number;
  recoveryCount: number;
  bufferAheadSeconds: number;
  targetDurationSeconds: number;
  currentSequence: number | null;
  lastSegmentAtMs: number | null;
  lastSequenceAtMs: number | null;
  lastError: string | null;
  lastFallbackReason: string | null;
  nextRetryAtMs: number | null;
  isOnline: boolean;
  autoplayBlocked: boolean;
  soundEnabled: boolean;
  nativeControls: boolean;
  liveLatencySeconds: number | null;
  decodedFrames: number | null;
  droppedFrames: number | null;
  lastProbe: LiveProbeSnapshot | null;
  /** Rolling diagnostics for the debug overlay. The heartbeat drains its own
   *  copy separately -- this one is peeked so the UI can render without
   *  stealing events from the wire. */
  recentEvents: readonly DiagEvent[];
};

export type LiveHlsOptions = {
  /** When false, the managed pipeline is fully suspended (no play/reconnect) so a
   *  public/custom source can own playback without the managed stream recovering
   *  and playing behind it (double-audio bug). */
  active?: boolean;
  autoPlay?: boolean;
  forceAutoplayAudio?: boolean;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitterRatio?: number;
  healthIntervalMs?: number;
  staleTargetDurations?: number;
  stallTimeoutMs?: number;
  mirrorFailureThreshold?: number;
  softRecoveryFailureThreshold?: number;
  probeTimeoutMs?: number;
  /** Grace period after an attach during which the stall/stale checks are muted.
   *  An attach empties the buffer, so without this the recovery manufactures the
   *  exact condition that triggers the next recovery. */
  attachGraceMs?: number;
};

export type LiveHlsController = {
  snapshot: LiveHlsSnapshot;
  activeMirror: StreamMirror;
  activeSource: StreamSource;
  retryNow: () => void;
  reload: () => void;
  hardReconnect: () => void;
  enableAudio: () => Promise<void>;
  seekToLive: () => void;
  switchMirror: (index: number) => void;
  switchProtocol: (protocol: StreamProtocol) => void;
  /** Roll up and RESET this heartbeat's window. Exactly one caller (the
   *  heartbeat) may use it, or windows get split and metrics silently halve. */
  collectDiagnostics: () => { metrics: PlaybackMetrics; events: DiagEvent[] };
};

const defaultOptions: Required<LiveHlsOptions> = {
  active: true,
  autoPlay: true,
  forceAutoplayAudio: true,
  backoffBaseMs: 800,
  backoffMaxMs: 8_000,
  jitterRatio: 0.22,
  healthIntervalMs: 1_000,
  staleTargetDurations: 3,
  stallTimeoutMs: 8_000,
  mirrorFailureThreshold: 4,
  // hls.js emits non-fatal errors routinely on a lossy upstream (this one drops
  // packets). Tearing the pipeline down on the first one is what produced 2-5
  // visible skips per minute per viewer; let it self-heal a few times first.
  softRecoveryFailureThreshold: 3,
  probeTimeoutMs: 1_500,
  attachGraceMs: 8_000
};

/** How many extra stall windows to grant while the origin is demonstrably
 *  reachable. At stallTimeoutMs 8s that is ~32s of patience before a re-attach,
 *  which comfortably covers an upstream hiccup or a source-side segment gap,
 *  while still recovering a player that is genuinely wedged. */
const ORIGIN_ALIVE_STALL_EXTENSIONS = 3;

const emptySource: StreamSource = {
  id: "pending",
  mirrorId: "pending",
  label: "Pending",
  host: "unknown",
  pageUrl: "#",
  protocol: "hls",
  url: ""
};

const initialSnapshot: LiveHlsSnapshot = {
  status: "idle",
  mode: "pending",
  activeMirrorIndex: 0,
  activeProtocol: "hls",
  activeSourceUrl: "",
  attempt: 0,
  recoveryCount: 0,
  bufferAheadSeconds: 0,
  targetDurationSeconds: 4,
  currentSequence: null,
  lastSegmentAtMs: null,
  lastSequenceAtMs: null,
  lastError: null,
  lastFallbackReason: null,
  nextRetryAtMs: null,
  isOnline: typeof navigator === "undefined" ? true : navigator.onLine,
  autoplayBlocked: false,
  soundEnabled: true,
  nativeControls: false,
  liveLatencySeconds: null,
  decodedFrames: null,
  droppedFrames: null,
  lastProbe: null,
  recentEvents: []
};

type ControllerActions = {
  retryNow: () => void;
  reload: () => void;
  hardReconnect: () => void;
  enableAudio: () => Promise<void>;
  seekToLive: () => void;
  switchMirror: (index: number) => void;
  switchProtocol: (protocol: StreamProtocol) => void;
  collectDiagnostics: () => { metrics: PlaybackMetrics; events: DiagEvent[] };
};

type PlaybackQualityVideo = HTMLVideoElement & {
  webkitDecodedFrameCount?: number;
  webkitDroppedFrameCount?: number;
};

function isAppleNativePath() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const vendor = navigator.vendor;
  const appleMobile = /iPad|iPhone|iPod/.test(ua);
  const safari = /Safari/.test(ua) && /Apple/.test(vendor) && !/Chrome|CriOS|FxiOS|Edg|OPR/.test(ua);
  return appleMobile || safari;
}

function prefersNativeControls() {
  return false;
}

function canUseNativeHls(video: HTMLVideoElement) {
  return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

function canUseDash() {
  if (isAppleNativePath()) return false;
  try {
    shaka.polyfill.installAll();
    return shaka.Player.isBrowserSupported();
  } catch {
    return false;
  }
}

function hlsErrorLabel(data: { type?: string; details?: string; fatal?: boolean }) {
  const fatality = data.fatal ? "fatal" : "recoverable";
  return [fatality, data.type, data.details].filter(Boolean).join(" ");
}

function getLiveLatencySeconds(video: HTMLVideoElement) {
  if (video.seekable.length === 0) return null;
  const liveEdge = video.seekable.end(video.seekable.length - 1);
  return Math.max(0, liveEdge - video.currentTime);
}

function getFrameStats(video: HTMLVideoElement) {
  if (typeof video.getVideoPlaybackQuality === "function") {
    const quality = video.getVideoPlaybackQuality();
    return {
      decodedFrames: quality.totalVideoFrames,
      droppedFrames: quality.droppedVideoFrames
    };
  }
  const legacyVideo = video as PlaybackQualityVideo;
  return {
    decodedFrames: legacyVideo.webkitDecodedFrameCount ?? null,
    droppedFrames: legacyVideo.webkitDroppedFrameCount ?? null
  };
}

export function selectPreferredProtocol(capability: PlaybackCapability): ProtocolPreference {
  if (capability.appleNativePath && capability.nativeHls) return "hls";
  if (capability.dash) return "dash";
  if (capability.hlsJs || capability.nativeHls) return "hls";
  return "auto";
}

export function orderedSourcesForCapabilities(
  mirrors: readonly StreamMirror[],
  capability: PlaybackCapability,
  preference: ProtocolPreference = "auto"
): StreamSource[] {
  const allowedProtocols: StreamProtocol[] = [];
  if (capability.dash) allowedProtocols.push("dash");
  if (capability.hlsJs || capability.nativeHls) allowedProtocols.push("hls");
  if (allowedProtocols.length === 0) return [];

  const requested = preference === "auto" ? selectPreferredProtocol(capability) : preference;
  const preferred = requested !== "auto" && allowedProtocols.includes(requested) ? requested : allowedProtocols[0];
  const protocolOrder = [
    preferred,
    ...allowedProtocols.filter((protocol) => protocol !== preferred)
  ].filter((protocol): protocol is StreamProtocol => protocol === "dash" || protocol === "hls");

  return protocolOrder.flatMap((protocol) =>
    mirrors.flatMap((mirror) => sourcesForMirror(mirror).filter((source) => source.protocol === protocol))
  );
}

function getPlaybackCapability(video: HTMLVideoElement): PlaybackCapability {
  return {
    appleNativePath: isAppleNativePath(),
    nativeHls: canUseNativeHls(video),
    hlsJs: Hls.isSupported(),
    dash: canUseDash()
  };
}

function orderedSources(mirrors: readonly StreamMirror[], video: HTMLVideoElement): StreamSource[] {
  const capability = getPlaybackCapability(video);

  // Apple browsers, including all iOS browsers, should stay on HLS. MSE-driven DASH remains the better
  // default for Chromium/Firefox class browsers where Shaka support is available and we can control live recovery.
  if (capability.appleNativePath && capability.nativeHls) {
    return orderedSourcesForCapabilities(mirrors, { ...capability, dash: false }, "hls");
  }
  return orderedSourcesForCapabilities(mirrors, capability, "auto");
}

function probeSnapshotFromResult(probe: ManifestProbe, sources: readonly StreamSource[]): LiveProbeSnapshot {
  const source = sources[probe.mirrorIndex] ?? sources[0] ?? emptySource;
  return {
    ok: probe.ok,
    mirrorIndex: probe.mirrorIndex,
    host: source.host,
    protocol: source.protocol,
    sequence: probe.ok ? probe.endSequence ?? probe.mediaSequence : null,
    fetchedAtMs: probe.fetchedAtMs,
    error: probe.ok ? null : probe.error
  };
}

export function createStableHlsConfig(): Partial<HlsConfig> {
  return {
    lowLatencyMode: false,
    // Counts of segments, not seconds. Sized against measured PUBLISH jitter,
    // not against the nominal segment duration: the muxer emits perfectly
    // uniform 2.002s of content, but the files land on disk in bursts — measured
    // gaps 0.44s to 3.97s, with 26% over 3s. 3 segments (6s) leaves almost no
    // margin when a 4s gap lands and every viewer stalls together; 4 absorbs it.
    // Lower this only after the jitter is fixed at source (chunked CMAF output),
    // not because the segments are "only" 2s long.
    // 5 segments ~= 10s, matching the Shaka targetLatency above. Both are sized
    // against measured publish jitter (p90 5.25s, max 7.54s), not a round number.
    liveSyncDurationCount: 5,
    liveMaxLatencyDurationCount: 12,
    // This is hls.js's only smooth catch-up: below ~1.05 a viewer who falls 20s
    // behind needs ~20min to recover and instead hits the seek-to-live threshold,
    // which is a hard skip. 1.1 was audible; 1.05 recovers without warping pitch.
    // 1.05 is an audible 5% pitch shift. Correct slowly and inaudibly instead.
    maxLiveSyncPlaybackRate: 1.02,
    backBufferLength: 90,
    // Must stay under the 30s publish window or hls.js chases segments that
    // have already rotated off the playlist.
    maxBufferLength: 20,
    // A jumpable hole was a quarter of a 2s segment; that reads as a skip.
    maxBufferHole: 0.1,
    manifestLoadingTimeOut: 5_000,
    manifestLoadingMaxRetry: 0,
    levelLoadingTimeOut: 5_000,
    levelLoadingMaxRetry: 2,
    fragLoadingTimeOut: 7_000,
    // Shaka absorbs a rotated-out segment via retryParameters.maxAttempts and only
    // escalates on CRITICAL. hls.js had no equivalent: with 0 retries every routine
    // 404 counted toward softRecoveryFailureThreshold, so three of them -- normal
    // on a live playlist with publish jitter -- destroyed the whole pipeline.
    fragLoadingMaxRetry: 3
  };
}

export function useLiveHls(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  mirrors: readonly StreamMirror[],
  options: LiveHlsOptions = {}
): LiveHlsController {
  const opts = useMemo(() => ({ ...defaultOptions, ...options }), [options]);
  const [snapshot, setSnapshot] = useState<LiveHlsSnapshot>(initialSnapshot);
  const activeSourceRef = useRef<StreamSource>(emptySource);
  const actionsRef = useRef<ControllerActions>({
    retryNow: () => undefined,
    reload: () => undefined,
    hardReconnect: () => undefined,
    enableAudio: async () => undefined,
    seekToLive: () => undefined,
    switchMirror: () => undefined,
    switchProtocol: () => undefined,
    // Before the effect runs there is no player, so there is nothing to report.
    collectDiagnostics: () => ({ metrics: emptyPlaybackMetrics(), events: [] })
  });

  useEffect(() => {
    const media = videoRef.current;
    if (!media || mirrors.length === 0) return undefined;
    const video: HTMLVideoElement = media;
    if (!opts.active) {
      // Suspended: a public/custom source owns playback. Stop the managed element
      // and set up no hls/reconnect/health loops, so it cannot recover and replay
      // behind the active source (the double-audio bug).
      video.pause();
      return undefined;
    }
    const sources = orderedSources(mirrors, video);
    if (sources.length === 0) return undefined;

    let mounted = true;
    let hls: Hls | null = null;
    let shakaPlayer: shaka.Player | null = null;
    let reconnectTimer: number | null = null;
    let reconnectPending = false;
    let healthTimer: number | null = null;
    let stableTimer: number | null = null;
    let probeRun = 0;
    let activeSourceIndex = 0;
    const probeControllers: AbortController[] = [];
    let attempt = 0;
    let recoveryCount = 0;
    let consecutiveSourceFailures = 0;
    let mediaRecoveryAttempts = 0;
    let softRecoveryFailures = 0;
    let currentSequence: number | null = null;
    let lastSegmentAtMs: number | null = null;
    let lastSequenceAtMs: number | null = null;
    let lastTimeUpdateAtMs = Date.now();
    // Stall arbitration state. A frozen playhead alone does not justify tearing
    // the pipeline down, so we ask the origin what it thinks before escalating.
    const diag = createDiagnosticsRing();
    let statsTick = 0;
    const metrics = createMetricsAccumulator();
    let stallProbeInFlight = false;
    let lastStallProbeSequence: number | null = null;
    let originAliveStallExtensions = 0;
    let lastObservedTime = 0;
    let attachedAtMs = Date.now();
    let targetDurationSeconds = 4;
    const nativeControls = prefersNativeControls();

    const publish = (partial: Partial<LiveHlsSnapshot>) => {
      if (!mounted) return;
      const bufferAheadSeconds = getBufferedAhead(video.buffered, video.currentTime);
      const frameStats = getFrameStats(video);
      const source = sources[activeSourceIndex] ?? sources[0];
      activeSourceRef.current = source;
      const activeMirrorIndex = Math.max(0, mirrors.findIndex((mirror) => mirror.id === source.mirrorId));

      setSnapshot((current) => ({
        ...current,
        ...partial,
        activeMirrorIndex,
        activeProtocol: source.protocol,
        activeSourceUrl: source.url,
        attempt,
        recoveryCount,
        bufferAheadSeconds,
        targetDurationSeconds,
        currentSequence,
        lastSegmentAtMs,
        lastSequenceAtMs,
        isOnline: navigator.onLine,
        soundEnabled: !video.muted && video.volume > 0,
        nativeControls,
        liveLatencySeconds: getLiveLatencySeconds(video),
        decodedFrames: frameStats.decodedFrames,
        droppedFrames: frameStats.droppedFrames,
        // peek(), not drain(): the heartbeat owns draining. Rendering must not
        // consume events or the wire silently loses whatever the UI showed.
        recentEvents: diag.peek().slice(-40)
      }));
    };

    const clearTimer = (timer: number | null) => {
      if (timer !== null) window.clearTimeout(timer);
    };
    const clearIntervalTimer = (timer: number | null) => {
      if (timer !== null) window.clearInterval(timer);
    };
    const destroyHls = () => {
      hls?.destroy();
      hls = null;
    };
    const destroyShaka = async () => {
      const player = shakaPlayer;
      shakaPlayer = null;
      if (player) await player.destroy();
    };
    const resetMediaElement = async () => {
      destroyHls();
      await destroyShaka();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    const markStableSoon = () => {
      clearTimer(stableTimer);
      stableTimer = window.setTimeout(() => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        softRecoveryFailures = 0;
        publish({ attempt: 0, lastError: null, lastFallbackReason: null, nextRetryAtMs: null });
        // Must exceed stallTimeoutMs, or a stream that stalls every few seconds
        // resets its own backoff before it can ever escalate.
      }, 12_000);
    };
    const maybePlay = async () => {
      if (!opts.autoPlay) return;
      video.autoplay = true;
      video.playsInline = true;
      video.controls = nativeControls;
      if (opts.forceAutoplayAudio) {
        video.muted = false;
        if (video.volume === 0) video.volume = 1;
      }
      try {
        await video.play();
        publish({ autoplayBlocked: false, soundEnabled: !video.muted && video.volume > 0, lastError: null });
        return;
      } catch (error) {
        // Every mobile browser blocks autoplay WITH SOUND. Without the retry
        // below, unmuting first meant play() rejected and nothing played at all
        // — a black player on every phone, while desktop worked because media
        // engagement heuristics let the unmuted attempt through.
        if (!opts.forceAutoplayAudio || video.muted) {
          const name = error instanceof DOMException ? error.name : "AutoplayError";
          publish({
            status: "buffering",
            autoplayBlocked: true,
            soundEnabled: false,
            lastError: `${name}: browser blocked autoplay. Press play.`
          });
          return;
        }
      }
      // Muted autoplay is permitted everywhere. Start the picture immediately and
      // let the viewer add sound with one tap, rather than showing them nothing.
      try {
        video.muted = true;
        await video.play();
        publish({
          autoplayBlocked: true,
          soundEnabled: false,
          lastError: "Tap Enable sound to unmute."
        });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "AutoplayError";
        publish({
          status: "buffering",
          autoplayBlocked: true,
          soundEnabled: false,
          lastError: `${name}: browser blocked autoplay. Press play.`
        });
      }
    };
    const probeSource = async (source: StreamSource, index: number, run: number): Promise<ManifestProbe> => {
      const fetchedAtMs = Date.now();
      const controller = new AbortController();
      probeControllers.push(controller);
      const timeout = window.setTimeout(() => controller.abort(), opts.probeTimeoutMs);
      const url = sourceWithCacheBust(source.url, `probe-${fetchedAtMs}-${run}`);
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          return { ok: false, mirrorIndex: index, url, fetchedAtMs, error: `probe HTTP ${response.status}` } satisfies ManifestProbeFailure;
        }
        const text = await response.text();
        const parsed = source.protocol === "dash" ? parseDashManifest(text) : parseHlsManifest(text);
        if (!parsed) {
          return { ok: false, mirrorIndex: index, url, fetchedAtMs, error: `probe returned a non-${source.protocol.toUpperCase()} response` };
        }
        return { ...parsed, ok: true, mirrorIndex: index, url, fetchedAtMs } satisfies ManifestProbeResult;
      } catch (error) {
        const label = error instanceof Error ? error.message : "probe failed";
        return { ok: false, mirrorIndex: index, url, fetchedAtMs, error: label } satisfies ManifestProbeFailure;
      } finally {
        window.clearTimeout(timeout);
        const idx = probeControllers.indexOf(controller);
        if (idx >= 0) probeControllers.splice(idx, 1);
      }
    };
    const abortActiveProbes = () => {
      probeControllers.forEach((controller) => {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      });
      probeControllers.length = 0;
    };

    const probeFreshSource = async () => {
      const run = (probeRun += 1);
      abortActiveProbes();
      const probes = await Promise.all(sources.map((source, index) => probeSource(source, index, run)));
      if (!mounted || run !== probeRun) return null;
      const freshest = chooseFreshestProbe(probes);
      const probeForSnapshot = freshest ?? probes[activeSourceIndex] ?? probes[0];
      if (freshest) {
        targetDurationSeconds = freshest.targetDurationSeconds || targetDurationSeconds;
        publish({ lastProbe: probeSnapshotFromResult(freshest, sources) });
        return freshest;
      }
      if (probeForSnapshot) publish({ lastProbe: probeSnapshotFromResult(probeForSnapshot, sources) });
      return null;
    };

    function attachNativeSource(source: StreamSource, url: string) {
      video.src = url;
      video.load();
      publish({ mode: "native", status: "connecting", nextRetryAtMs: null });
      void maybePlay();
    }

    function attachHlsSource(source: StreamSource, url: string) {
      hls = new Hls(createStableHlsConfig());
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(url));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        publish({ mode: "hls.js", status: "connecting", autoplayBlocked: false, lastError: null, nextRetryAtMs: null });
        void maybePlay();
      });
      hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
        const details = data.details;
        const sequence = typeof details.endSN === "number" ? details.endSN : null;
        targetDurationSeconds = details.targetduration || targetDurationSeconds;
        if (sequence !== null) metrics.manifestSequence(sequence, targetDurationSeconds);
        if (sequence !== null && sequence !== currentSequence) {
          currentSequence = sequence;
          lastSequenceAtMs = Date.now();
        }
        publish({ status: video.paused ? "connecting" : "live", lastError: null, nextRetryAtMs: null });
      });
      // FRAG_BUFFERED carries frag.stats: real TTFB and transfer time per segment.
      // Without it "the stream is slow" and "this viewer's link is slow" are
      // indistinguishable from the server side.
      hls.on(Hls.Events.FRAG_BUFFERED, (_e, data) => {
        const stats = (data as { frag?: { stats?: { loading?: { first?: number; start?: number; end?: number } } } })?.frag?.stats;
        const loading = stats?.loading;
        if (loading?.first !== undefined && loading?.start !== undefined) {
          metrics.segmentLoaded({ ttfbMs: loading.first - loading.start, bandwidthBps: hls?.bandwidthEstimate });
        } else {
          metrics.segmentLoaded({ bandwidthBps: hls?.bandwidthEstimate });
        }
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        metrics.levelSwitch();
        diag.push("levelswitch", (data as { level?: number })?.level);
      });
      hls.on(Hls.Events.FPS_DROP, (_e, data) => {
        metrics.fpsDrop();
        const d = data as { currentDropped?: number; currentDecoded?: number };
        diag.push("fpsdrop", `${d?.currentDropped}/${d?.currentDecoded}`);
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        lastSegmentAtMs = Date.now();
        softRecoveryFailures = 0;
        publish({ status: video.paused ? "connecting" : "live", lastError: null, nextRetryAtMs: null });
        markStableSoon();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const label = hlsErrorLabel(data);
        diag.push(data.fatal ? "hls-fatal" : "hls-error", label);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) metrics.segmentError();
        // hls.js nudges the playhead when it stalls with buffer present. Each
        // nudge is a micro-skip, and 10 of them appeared in the telemetry the
        // day the stale-playlist bug was found.
        if (data.details === Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL) metrics.gapJump();
        if (!data.fatal) {
          softRecoveryFailures += 1;
          if (softRecoveryFailures >= opts.softRecoveryFailureThreshold) {
            consecutiveSourceFailures += 1;
            scheduleReconnect(`${label}; hard reconnect after soft recovery failure`);
            return;
          }
          // Let hls.js resume its own loaders rather than rebuilding the pipeline;
          // a full re-attach costs the viewer a visible jump.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
          publish({ status: data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ? "buffering" : "connecting", lastError: label });
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hls && mediaRecoveryAttempts < opts.softRecoveryFailureThreshold) {
          mediaRecoveryAttempts += 1;
          softRecoveryFailures += 1;
          recoveryCount += 1;
          hls.recoverMediaError();
          publish({ status: "reconnecting", lastError: `${label}; recovering media pipeline before hard reconnect` });
          return;
        }
        consecutiveSourceFailures += 1;
        scheduleReconnect(label);
      });
      publish({ mode: "hls.js", status: "connecting", nextRetryAtMs: null });
      hls.attachMedia(video);
    }

    async function attachDashSource(url: string) {
      shaka.polyfill.installAll();
      shakaPlayer = new shaka.Player(video);
      shakaPlayer.configure({
        manifest: {
          // The encoder derives suggestedPresentationDelay from seg_duration, so it
          // advertises PT2S — one segment of buffer. Chasing that edge guarantees a
          // rebuffer on any publish jitter. Ignore it and set our own.
          dash: { ignoreSuggestedPresentationDelay: true },
          // NB: this lives under `manifest`, not `streaming`. Shaka silently drops
          // unknown config keys, so putting it in the wrong section is a no-op.
          defaultPresentationDelay: 10
        },
        streaming: {
          // Must stay well under the 30s publish window; 30 meant Shaka tried to
          // buffer the entire window and sat at the oldest retained segment.
          //
          // Sized against MEASURED origin publish jitter, not a round number. A
          // bursty upstream feed delivers segments in clumps: p90 5.25s, max
          // 7.54s between publishes against a 2.002s nominal. The buffer has to
          // outlast that gap or the viewer freezes, so steady-state buffer must
          // exceed rebufferingGoal + worst gap.
          bufferingGoal: 20,
          // Lowered, not raised: this is the floor at which Shaka STOPS playback
          // to re-buffer. 4s meant a single 5s publish gap tripped it.
          rebufferingGoal: 3,
          lowLatencyMode: false,
          // Without this Shaka has NO catch-up: one stall drops the viewer further
          // behind live and they stay there for the rest of the session. Measured
          // viewers stuck at 22/34/58s behind, each at their own fixed offset.
          liveSync: {
            enabled: true,
            targetLatency: 10,
            // Widened from 3. The tolerance is a deadband: inside it Shaka leaves
            // playback alone. At +/-3s around a target the band was narrower than
            // the feed's own jitter, so Shaka micro-corrected almost continuously
            // -- measured 0.981x average over 165s, i.e. it sat at 0.95x for
            // roughly a third of the session. Rate warping IS a viewer-visible
            // defect (5% is an audible pitch shift), so the deadband must be
            // wider than the jitter it is reacting to.
            targetLatencyTolerance: 6,
            // Narrowed from 1.05/0.95 to keep any correction imperceptible.
            // Correcting slowly for longer beats correcting fast and being heard.
            maxPlaybackRate: 1.02,
            minPlaybackRate: 0.99,
            // Beyond this the drift is too big to rate-correct; jump to live.
            panicMode: true,
            panicThreshold: 30
          },
          retryParameters: { maxAttempts: 4, baseDelay: 500, backoffFactor: 1.6, fuzzFactor: 0.2 }
        }
      });
      // Shaka had exactly ONE listener (error) and getStats() was untapped, so a
      // Shaka viewer -- which is every non-Safari browser, i.e. most of them --
      // was the least observable path in the app.
      shakaPlayer.addEventListener("buffering", (event) => {
        const buffering = (event as unknown as { buffering?: boolean }).buffering;
        if (buffering) {
          metrics.stallBegin();
          diag.push("shaka-buffering", "start");
        } else {
          metrics.stallEnd();
          diag.push("shaka-buffering", "end");
        }
      });
      shakaPlayer.addEventListener("stalldetected", () => {
        metrics.stallBegin();
        diag.push("shaka-stall");
      });
      shakaPlayer.addEventListener("gapjumped", () => {
        metrics.gapJump();
        diag.push("shaka-gapjump");
      });
      shakaPlayer.addEventListener("adaptation", () => {
        metrics.levelSwitch();
        diag.push("shaka-adaptation");
      });
      shakaPlayer.addEventListener("manifestupdated", () => {
        diag.push("shaka-manifestupdated");
      });
      shakaPlayer.addEventListener("error", (event) => {
        const detail = ("detail" in event ? event.detail : null) as { code?: number; severity?: number } | null;
        // Shaka retries recoverable errors itself (a 404 on a segment that just
        // rotated is routine). Only a CRITICAL error means playback is actually dead.
        if (detail?.severity !== undefined && detail.severity !== shaka.util.Error.Severity.CRITICAL) return;
        consecutiveSourceFailures += 1;
        diag.push("shaka-critical", detail?.code);
        scheduleReconnect(`DASH error${detail?.code ? ` ${detail.code}` : ""}`);
      });
      publish({ mode: "shaka", status: "connecting", nextRetryAtMs: null });
      try {
        await shakaPlayer.load(url);
        lastSequenceAtMs = Date.now();
        lastSegmentAtMs = Date.now();
        publish({ mode: "shaka", status: video.paused ? "connecting" : "live", lastError: null, nextRetryAtMs: null });
        void maybePlay();
        markStableSoon();
      } catch (error) {
        consecutiveSourceFailures += 1;
        scheduleReconnect(error instanceof Error ? error.message : "DASH load failed", true);
      }
    }

    async function attachSource(index: number, reason: string) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      reconnectPending = true;
      activeSourceIndex = index;
      const source = sources[activeSourceIndex] ?? sources[0];
      const url = sourceWithCacheBust(source.url, `${Date.now()}-${attempt}`);
      currentSequence = null;
      lastSegmentAtMs = null;
      lastSequenceAtMs = Date.now();
      lastTimeUpdateAtMs = Date.now();
      attachedAtMs = Date.now();
      lastObservedTime = video.currentTime;
      mediaRecoveryAttempts = 0;
      softRecoveryFailures = 0;
      publish({
        status: "connecting",
        mode: "pending",
        lastError: reason === "initial" ? null : reason,
        lastFallbackReason: reason === "initial" ? null : reason,
        nextRetryAtMs: null,
        autoplayBlocked: false
      });
      await resetMediaElement();
      if (!mounted) {
        reconnectPending = false;
        return;
      }
      if (source.protocol === "dash" && canUseDash()) {
        reconnectPending = false;
        await attachDashSource(url);
        return;
      }
      if (source.protocol === "hls" && Hls.isSupported()) {
        reconnectPending = false;
        attachHlsSource(source, url);
        return;
      }
      if (source.protocol === "hls" && canUseNativeHls(video)) {
        reconnectPending = false;
        attachNativeSource(source, url);
        return;
      }
      reconnectPending = false;
      scheduleReconnect(`Unsupported ${source.protocol.toUpperCase()} engine`, true);
    }

    function scheduleReconnect(reason: string, rotateSource = false) {
      // hls.js and Shaka can emit a burst of errors for one outage. Coalesce
      // them into one recovery attempt so they cannot keep restarting the timer
      // and inflating the exponential backoff.
      if (reconnectPending) return;
      if (!navigator.onLine) {
        publish({ status: "offline", lastError: "Browser is offline.", nextRetryAtMs: null });
        return;
      }
      reconnectPending = true;
      const rotate =
        rotateSource || shouldRotateMirror(consecutiveSourceFailures, sources.length, opts.mirrorFailureThreshold);
      if (rotate) {
        activeSourceIndex = chooseNextSourceIndex(activeSourceIndex, sources, mirrors);
        consecutiveSourceFailures = 0;
      }
      attempt += 1;
      recoveryCount += 1;
      const delayMs = retryDelayMs(attempt, { baseMs: opts.backoffBaseMs, maxMs: opts.backoffMaxMs, jitterRatio: opts.jitterRatio });
      const nextRetryAtMs = Date.now() + delayMs;
      publish({ status: "reconnecting", lastError: reason, lastFallbackReason: reason, nextRetryAtMs });
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void (async () => {
          // A same-source restart should be nearly immediate. Probe all routes
          // only when recovery has escalated to a source rotation.
          const freshest = rotate && sources.length > 1 ? await probeFreshSource() : null;
          if (!mounted) return;
          await attachSource(freshest?.mirrorIndex ?? activeSourceIndex, reason);
        })();
      }, delayMs);
    }

    /**
     * Decide what a frozen playhead actually means before rebuilding the pipeline.
     *
     * A re-attach costs the viewer a visible jump (resetMediaElement -> video.load()
     * restarts at the live edge), so it is only worth paying when it can plausibly
     * fix something. Ask the origin:
     *
     *  - probe fails            -> our route to the origin is broken. Rotate away.
     *  - sequence went BACKWARD -> the encoder restarted; the manifest, init segment
     *                              and availabilityStartTime are all new. Only a
     *                              re-attach recovers this, so do it immediately
     *                              rather than waiting out another stall timeout.
     *  - sequence ADVANCED      -> the origin is publishing fine and we are merely
     *                              behind. Rebuilding throws away the buffer and
     *                              CAUSES the skip. Let the engine recover: Shaka
     *                              re-reads the MPD every minimumUpdatePeriod (2s)
     *                              and has liveSync/panicMode for exactly this.
     *  - sequence UNCHANGED     -> the origin itself is stalled. A new pipeline hits
     *                              the same missing data, so re-attaching cannot
     *                              help either. Wait.
     *
     * The last two extend the stall window rather than ending it, bounded by
     * ORIGIN_ALIVE_STALL_EXTENSIONS so a genuinely wedged player still recovers.
     */
    const confirmStallAgainstOrigin = async (bufferAheadSeconds: number) => {
      if (stallProbeInFlight || reconnectPending) return;
      stallProbeInFlight = true;
      try {
        const source = sources[activeSourceIndex] ?? sources[0];
        if (!source) return;
        const probe = await probeSource(source, activeSourceIndex, (probeRun += 1));
        if (!mounted || reconnectPending) return;

        if (!probe.ok) {
          consecutiveSourceFailures += 1;
          lastStallProbeSequence = null;
          originAliveStallExtensions = 0;
          scheduleReconnect(`Playback stalled and ${source.label} is unreachable.`);
          return;
        }

        publish({ lastProbe: probeSnapshotFromResult(probe, sources) });
        targetDurationSeconds = probe.targetDurationSeconds || targetDurationSeconds;
        const sequence = probe.endSequence ?? probe.mediaSequence;
        const previous = lastStallProbeSequence;
        lastStallProbeSequence = sequence;

        if (sequence !== null && previous !== null && sequence < previous) {
          // The encoder restarted under us. Re-attach is the only cure.
          originAliveStallExtensions = 0;
          consecutiveSourceFailures = 0;
          scheduleReconnect("Stream restarted at the source.");
          return;
        }

        originAliveStallExtensions += 1;
        if (originAliveStallExtensions > ORIGIN_ALIVE_STALL_EXTENSIONS) {
          consecutiveSourceFailures += 1;
          originAliveStallExtensions = 0;
          lastStallProbeSequence = null;
          scheduleReconnect("Playback stalled at the live edge.");
          return;
        }

        // Give the engine another stall window to dig itself out.
        lastTimeUpdateAtMs = Date.now();
        lastObservedTime = video.currentTime;
        publish({
          status: "buffering",
          bufferAheadSeconds,
          lastError: null
        });
      } finally {
        stallProbeInFlight = false;
      }
    };

    const runHealthCheck = () => {
      const now = Date.now();
      const bufferAheadSeconds = getBufferedAhead(video.buffered, video.currentTime);

      // 1 Hz sample. getBufferedAhead returns 0 both when nothing is buffered and
      // when the playhead sits in a hole between ranges; those are different
      // faults, so detect the hole explicitly.
      const seekEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
      const seekStart = video.seekable.length ? video.seekable.start(0) : null;
      let inBufferGap = false;
      if (bufferAheadSeconds === 0 && video.buffered.length > 0 && !video.paused) {
        for (let i = 0; i < video.buffered.length; i += 1) {
          if (video.buffered.start(i) > video.currentTime) { inBufferGap = true; break; }
        }
      }
      metrics.sample({
        bufferAheadSeconds,
        liveLatencySeconds: seekEnd === null ? null : seekEnd - video.currentTime,
        playbackRate: video.playbackRate,
        seekRangeSpanSeconds: seekEnd !== null && seekStart !== null ? seekEnd - seekStart : null,
        inBufferGap
      });
      // getStats() walks Shaka's whole state/switch history and is not free.
      // At 1Hz on the same thread as decode it is a plausible source of jank,
      // and diagnostics must never be the reason playback hitches. Every 5s is
      // ample for bandwidth and frame counters.
      statsTick = (statsTick + 1) % 5;
      if (shakaPlayer && statsTick === 0) {
        try {
          const st = shakaPlayer.getStats() as {
            estimatedBandwidth?: number; corruptedFrames?: number;
            droppedFrames?: number; decodedFrames?: number;
          };
          metrics.frames({ decoded: st.decodedFrames, dropped: st.droppedFrames, corrupted: st.corruptedFrames });
          if (st.estimatedBandwidth) metrics.segmentLoaded({ bandwidthBps: st.estimatedBandwidth });
        } catch {
          /* stats are best-effort; never let diagnostics break playback */
        }
      }
      publish({ bufferAheadSeconds });
      // An attach empties the buffer and parks the playhead. Judging health inside
      // that window makes every recovery trigger the next one.
      //
      // The clocks must be carried forward through the window, not just left
      // frozen: lastTimeUpdateAtMs/lastSequenceAtMs are stamped at attach, so
      // skipping the checks alone means the stall and stale timers have already
      // run their full length by the moment the grace lifts, and fire on the very
      // next tick. That made the grace overlap the timeout instead of preceding
      // it, and a client too slow to start playing within the grace re-attached
      // forever on a fixed ~(grace + tick) cycle.
      if (withinAttachGrace(now, attachedAtMs, opts.attachGraceMs)) {
        lastTimeUpdateAtMs = now;
        lastSequenceAtMs = now;
        lastObservedTime = video.currentTime;
        return;
      }
      if (!video.paused && !video.ended) {
        const playheadMoved = Math.abs(video.currentTime - lastObservedTime) > 0.12;
        const source = sources[activeSourceIndex] ?? sources[0];
        if (source.protocol === "dash" && seekEnd !== null && targetDurationSeconds > 0) {
          // Shaka exposes no media-sequence event, so derive one: the seekable
          // edge in segment units is the same quantity, and it is what regresses
          // when a cache serves an older playlist.
          metrics.manifestSequence(Math.floor(seekEnd / targetDurationSeconds), targetDurationSeconds);
        }
        if (source.protocol === "dash" && (playheadMoved || bufferAheadSeconds > 1)) {
          lastSequenceAtMs = now;
          lastSegmentAtMs = now;
        }
        // hls.js reports the media sequence directly (LEVEL_UPDATED), so for HLS
        // this is a real "the manifest froze" signal. Shaka exposes no equivalent,
        // which is why the DASH branch above keeps the clock alive from playback
        // instead -- for DASH the stall path below is the one that fires.
        //
        // Either way this now goes through the origin check rather than tearing
        // down on the timer: a stale manifest is exactly the case where a rebuild
        // re-fetches the same frozen playlist and skips the viewer for nothing.
        if (
          source.protocol !== "dash" &&
          isPlaylistStale({
            nowMs: now,
            lastSequenceAtMs,
            targetDurationSeconds,
            staleTargetDurations: opts.staleTargetDurations
          })
        ) {
          void confirmStallAgainstOrigin(bufferAheadSeconds);
          return;
        }
        if (playheadMoved) {
          lastTimeUpdateAtMs = now;
          lastObservedTime = video.currentTime;
        } else if (
          isPlaybackStalled({
            nowMs: now,
            lastTimeUpdateAtMs,
            stallTimeoutMs: opts.stallTimeoutMs,
            playheadMoved,
            bufferAheadSeconds
          })
        ) {
          // Do not tear down on the timer alone -- see confirmStallAgainstOrigin.
          void confirmStallAgainstOrigin(bufferAheadSeconds);
        }
      }
    };

    const onPlaying = () => {
      metrics.stallEnd();
      diag.push("playing");
      lastTimeUpdateAtMs = Date.now();
      lastObservedTime = video.currentTime;
      mediaRecoveryAttempts = 0;
      softRecoveryFailures = 0;
      originAliveStallExtensions = 0;
      lastStallProbeSequence = null;
      lastSegmentAtMs = Date.now();
      publish({ status: "live", autoplayBlocked: false, lastError: null, nextRetryAtMs: null });
      markStableSoon();
    };
    // `waiting` and `stalled` shared one handler, so the snapshot could not tell
    // "ran out of buffered data" from "the network went quiet" -- different faults
    // with the same symptom. The accumulator coalesces a burst into one stall.
    const onWaiting = () => {
      metrics.stallBegin();
      diag.push("waiting", `buf=${getBufferedAhead(video.buffered, video.currentTime).toFixed(2)}s`);
      publish({ status: "buffering" });
    };
    const onStalled = () => {
      metrics.stallBegin();
      diag.push("stalled", `buf=${getBufferedAhead(video.buffered, video.currentTime).toFixed(2)}s`);
      publish({ status: "buffering" });
    };
    const onRateChange = () => diag.push("ratechange", video.playbackRate);
    const onSeeked = () => diag.push("seeked", video.currentTime.toFixed(2));
    const onVideoError = () => {
      consecutiveSourceFailures += 1;
      const code = video.error?.code ? `media code ${video.error.code}` : "media error";
      diag.push("videoerror", code);
      scheduleReconnect(code);
    };
    const onOnline = () => {
      publish({ isOnline: true });
      void attachSource(activeSourceIndex, "Browser came back online.");
    };
    const onOffline = () => {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      reconnectPending = false;
      publish({ status: "offline", isOnline: false, lastError: "Browser is offline.", nextRetryAtMs: null });
    };
    const onVisibilityChange = () => {
      if (!document.hidden) runHealthCheck();
    };

    actionsRef.current = {
      retryNow: () => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        softRecoveryFailures = 0;
        void attachSource(activeSourceIndex, "Manual retry.");
      },
      reload: () => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        softRecoveryFailures = 0;
        void attachSource(activeSourceIndex, "Manual reload.");
      },
      hardReconnect: () => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        softRecoveryFailures = 0;
        recoveryCount += 1;
        // attachSource does its own resetMediaElement under the reconnectPending
        // guard. Doing one out here first let removeAttribute("src") + load() fire
        // a media error that reached onVideoError and scheduled a competing
        // reconnect, racing the attach this was supposed to perform.
        void attachSource(activeSourceIndex, "Manual hard reconnect.");
      },
      collectDiagnostics: () => ({ metrics: metrics.collect(), events: diag.drain() }),
      enableAudio: async () => {
        video.muted = false;
        if (video.volume === 0) video.volume = 1;
        await maybePlay();
      },
      seekToLive: () => {
        if (video.seekable.length > 0) {
          const liveEdge = video.seekable.end(video.seekable.length - 1);
          // Landing 0.35s from the seekable end stalls immediately. Back off two
          // segments so there is something to play once we land.
          video.currentTime = Math.max(0, liveEdge - liveEdgeBackoffSeconds(targetDurationSeconds));
        }
        void maybePlay();
      },
      switchMirror: (index: number) => {
        if (index < 0 || index >= mirrors.length) return;
        const mirror = mirrors[index];
        const currentProtocol = (sources[activeSourceIndex] ?? sources[0])?.protocol;
        const sourceIndex = sources.findIndex((source) => source.mirrorId === mirror.id && source.protocol === currentProtocol);
        const fallbackSourceIndex = sources.findIndex((source) => source.mirrorId === mirror.id);
        const nextSourceIndex = sourceIndex >= 0 ? sourceIndex : fallbackSourceIndex;
        if (nextSourceIndex < 0) return;
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        softRecoveryFailures = 0;
        activeSourceIndex = nextSourceIndex;
        void attachSource(activeSourceIndex, "Mirror selected.");
      },
      switchProtocol: (protocol: StreamProtocol) => {
        const currentSource = sources[activeSourceIndex] ?? sources[0];
        const sourceIndex = sources.findIndex((source) => source.mirrorId === currentSource.mirrorId && source.protocol === protocol);
        if (sourceIndex < 0 || sourceIndex === activeSourceIndex) return;
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        softRecoveryFailures = 0;
        activeSourceIndex = sourceIndex;
        void attachSource(activeSourceIndex, `${protocol.toUpperCase()} selected.`);
      }
    };

    video.controls = nativeControls;
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    // No source maps and no console output in production, so a live browser was
    // impossible to inspect. This is the whole diagnostic surface behind one
    // global, read-only, and cheap enough to leave on.
    (window as unknown as { __obby?: unknown }).__obby = {
      events: () => diag.peek(),
      source: () => sources[activeSourceIndex] ?? sources[0],
      state: () => ({ attempt, recoveryCount, consecutiveSourceFailures, softRecoveryFailures,
                      originAliveStallExtensions, currentSequence, targetDurationSeconds,
                      lastSegmentAtMs, lastSequenceAtMs, attachedAtMs }),
      dropped: () => diag.droppedCount(),
      // Peeks the window WITHOUT resetting it, so poking around in devtools
      // cannot corrupt the heartbeat's accounting.
      metrics: () => createMetricsAccumulator().collect(),
      shakaStats: () => { try { return shakaPlayer?.getStats() ?? null; } catch { return null; } },
      hls: () => (hls ? { bandwidthEstimate: hls.bandwidthEstimate, currentLevel: hls.currentLevel, latency: (hls as unknown as { latency?: number }).latency } : null),
      video: () => ({
        currentTime: video.currentTime, playbackRate: video.playbackRate,
        readyState: video.readyState, paused: video.paused,
        buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
        seekable: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)])
      })
    };
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onVideoError);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void attachSource(activeSourceIndex, "initial");
    healthTimer = window.setInterval(runHealthCheck, opts.healthIntervalMs);

    return () => {
      mounted = false;
      abortActiveProbes();
      clearTimer(reconnectTimer);
      clearTimer(stableTimer);
      clearIntervalTimer(healthTimer);
      destroyHls();
      void destroyShaka();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      delete (window as unknown as { __obby?: unknown }).__obby;
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onVideoError);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [mirrors, opts, videoRef]);

  const activeMirror = mirrors[snapshot.activeMirrorIndex] ?? mirrors[0];
  const activeSource = activeSourceRef.current.url ? activeSourceRef.current : sourcesForMirror(activeMirror)[0] ?? emptySource;

  return {
    snapshot,
    activeMirror,
    activeSource,
    retryNow: useCallback(() => actionsRef.current.retryNow(), []),
    reload: useCallback(() => actionsRef.current.reload(), []),
    hardReconnect: useCallback(() => actionsRef.current.hardReconnect(), []),
    enableAudio: useCallback(() => actionsRef.current.enableAudio(), []),
    seekToLive: useCallback(() => actionsRef.current.seekToLive(), []),
    switchMirror: useCallback((index: number) => actionsRef.current.switchMirror(index), []),
    switchProtocol: useCallback((protocol: StreamProtocol) => actionsRef.current.switchProtocol(protocol), []),
    collectDiagnostics: useCallback(() => actionsRef.current.collectDiagnostics(), [])
  };
}
