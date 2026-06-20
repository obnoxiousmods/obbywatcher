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
  isPlaylistStale,
  nextMirrorIndex,
  parseDashManifest,
  parseHlsManifest,
  retryDelayMs,
  shouldRotateMirror,
  sourceWithCacheBust
} from "../lib/reconnect";
import type { ManifestProbe, ManifestProbeFailure, ManifestProbeResult } from "../lib/reconnect";

export type LivePlaybackStatus = "idle" | "connecting" | "live" | "buffering" | "reconnecting" | "offline" | "failed";
export type PlaybackEngine = "shaka" | "hls.js" | "native" | "unsupported" | "pending";

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
};

export type LiveHlsOptions = {
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
};

const defaultOptions: Required<LiveHlsOptions> = {
  autoPlay: true,
  forceAutoplayAudio: true,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  jitterRatio: 0.22,
  healthIntervalMs: 1_000,
  staleTargetDurations: 4,
  stallTimeoutMs: 8_000,
  mirrorFailureThreshold: 2,
  softRecoveryFailureThreshold: 1,
  probeTimeoutMs: 3_500
};

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
  lastProbe: null
};

type ControllerActions = {
  retryNow: () => void;
  reload: () => void;
  hardReconnect: () => void;
  enableAudio: () => Promise<void>;
  seekToLive: () => void;
  switchMirror: (index: number) => void;
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

function orderedSources(mirrors: readonly StreamMirror[], video: HTMLVideoElement): StreamSource[] {
  const all = mirrors.flatMap(sourcesForMirror);
  const dashSources = all.filter((source) => source.protocol === "dash");
  const hlsSources = all.filter((source) => source.protocol === "hls");

  // Apple browsers, including all iOS browsers, should stay on HLS. MSE-driven DASH remains the better
  // default for Chromium/Firefox class browsers where Shaka support is available and we can control live recovery.
  if (isAppleNativePath() && canUseNativeHls(video)) return hlsSources;
  if (canUseDash()) return [...dashSources, ...hlsSources];
  if (Hls.isSupported() || canUseNativeHls(video)) return hlsSources;
  return [];
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
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
    maxLiveSyncPlaybackRate: 1.1,
    backBufferLength: 90,
    maxBufferLength: 60,
    maxBufferHole: 0.5,
    manifestLoadingTimeOut: 8_000,
    manifestLoadingMaxRetry: 1,
    levelLoadingTimeOut: 8_000,
    levelLoadingMaxRetry: 1,
    fragLoadingTimeOut: 12_000,
    fragLoadingMaxRetry: 1
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
    switchMirror: () => undefined
  });

  useEffect(() => {
    const media = videoRef.current;
    if (!media || mirrors.length === 0) return undefined;
    const video: HTMLVideoElement = media;
    const sources = orderedSources(mirrors, video);
    if (sources.length === 0) return undefined;

    let mounted = true;
    let hls: Hls | null = null;
    let shakaPlayer: shaka.Player | null = null;
    let reconnectTimer: number | null = null;
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
    let lastObservedTime = 0;
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
        droppedFrames: frameStats.droppedFrames
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
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "AutoplayError";
        publish({
          status: "buffering",
          autoplayBlocked: true,
          soundEnabled: false,
          lastError: `${name}: browser blocked autoplay with sound. Press Enable sound.`
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
        if (sequence !== null && sequence !== currentSequence) {
          currentSequence = sequence;
          lastSequenceAtMs = Date.now();
        }
        publish({ status: video.paused ? "connecting" : "live", lastError: null, nextRetryAtMs: null });
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        lastSegmentAtMs = Date.now();
        softRecoveryFailures = 0;
        publish({ status: video.paused ? "connecting" : "live", lastError: null, nextRetryAtMs: null });
        markStableSoon();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const label = hlsErrorLabel(data);
        if (!data.fatal) {
          softRecoveryFailures += 1;
          if (softRecoveryFailures >= opts.softRecoveryFailureThreshold) {
            consecutiveSourceFailures += 1;
            scheduleReconnect(`${label}; hard reconnect after soft recovery failure`);
            return;
          }
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
        streaming: {
          bufferingGoal: 30,
          rebufferingGoal: 3,
          lowLatencyMode: false,
          retryParameters: { maxAttempts: 2, baseDelay: 500, backoffFactor: 1.6, fuzzFactor: 0.2 }
        }
      });
      shakaPlayer.addEventListener("error", (event) => {
        const detail = ("detail" in event ? event.detail : null) as { code?: number } | null;
        consecutiveSourceFailures += 1;
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
      activeSourceIndex = index;
      const source = sources[activeSourceIndex] ?? sources[0];
      const url = sourceWithCacheBust(source.url, `${Date.now()}-${attempt}`);
      currentSequence = null;
      lastSegmentAtMs = null;
      lastSequenceAtMs = Date.now();
      lastTimeUpdateAtMs = Date.now();
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
      if (!mounted) return;
      if (source.protocol === "dash" && canUseDash()) {
        await attachDashSource(url);
        return;
      }
      if (source.protocol === "hls" && Hls.isSupported()) {
        attachHlsSource(source, url);
        return;
      }
      if (source.protocol === "hls" && canUseNativeHls(video)) {
        attachNativeSource(source, url);
        return;
      }
      scheduleReconnect(`Unsupported ${source.protocol.toUpperCase()} engine`, true);
    }

    function scheduleReconnect(reason: string, rotateSource = false) {
      clearTimer(reconnectTimer);
      if (!navigator.onLine) {
        publish({ status: "offline", lastError: "Browser is offline.", nextRetryAtMs: null });
        return;
      }
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
        void (async () => {
          const freshest = sources.length > 1 ? await probeFreshSource() : null;
          if (!mounted) return;
          await attachSource(freshest?.mirrorIndex ?? activeSourceIndex, reason);
        })();
      }, delayMs);
    }

    const runHealthCheck = () => {
      const now = Date.now();
      const bufferAheadSeconds = getBufferedAhead(video.buffered, video.currentTime);
      publish({ bufferAheadSeconds });
      if (!video.paused && !video.ended) {
        const playheadMoved = Math.abs(video.currentTime - lastObservedTime) > 0.12;
        const source = sources[activeSourceIndex] ?? sources[0];
        if (source.protocol === "dash" && (playheadMoved || bufferAheadSeconds > 1)) {
          lastSequenceAtMs = now;
          lastSegmentAtMs = now;
        }
        if (
          source.protocol !== "dash" &&
          isPlaylistStale({
            nowMs: now,
            lastSequenceAtMs,
            targetDurationSeconds,
            staleTargetDurations: opts.staleTargetDurations
          })
        ) {
          consecutiveSourceFailures += 1;
          scheduleReconnect("Manifest stopped advancing.");
          return;
        }
        if (playheadMoved) {
          lastTimeUpdateAtMs = now;
          lastObservedTime = video.currentTime;
        } else if (now - lastTimeUpdateAtMs > opts.stallTimeoutMs && bufferAheadSeconds < 0.8) {
          consecutiveSourceFailures += 1;
          scheduleReconnect("Playback stalled at the live edge.");
        }
      }
    };

    const onPlaying = () => {
      lastTimeUpdateAtMs = Date.now();
      lastObservedTime = video.currentTime;
      mediaRecoveryAttempts = 0;
      softRecoveryFailures = 0;
      lastSegmentAtMs = Date.now();
      publish({ status: "live", autoplayBlocked: false, lastError: null, nextRetryAtMs: null });
      markStableSoon();
    };
    const onWaiting = () => publish({ status: "buffering" });
    const onVideoError = () => {
      consecutiveSourceFailures += 1;
      const code = video.error?.code ? `media code ${video.error.code}` : "media error";
      scheduleReconnect(code);
    };
    const onOnline = () => {
      publish({ isOnline: true });
      void attachSource(activeSourceIndex, "Browser came back online.");
    };
    const onOffline = () => {
      clearTimer(reconnectTimer);
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
        void (async () => {
          await resetMediaElement();
          if (!mounted) return;
          await attachSource(activeSourceIndex, "Manual hard reconnect.");
        })();
      },
      enableAudio: async () => {
        video.muted = false;
        if (video.volume === 0) video.volume = 1;
        await maybePlay();
      },
      seekToLive: () => {
        if (video.seekable.length > 0) {
          const liveEdge = video.seekable.end(video.seekable.length - 1);
          video.currentTime = Math.max(0, liveEdge - 0.35);
        }
        void maybePlay();
      },
      switchMirror: (index: number) => {
        if (index < 0 || index >= mirrors.length) return;
        const mirror = mirrors[index];
        const sourceIndex = sources.findIndex((source) => source.mirrorId === mirror.id);
        if (sourceIndex < 0) return;
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        softRecoveryFailures = 0;
        activeSourceIndex = sourceIndex;
        void attachSource(activeSourceIndex, "Mirror selected.");
      }
    };

    video.controls = nativeControls;
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
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
      video.removeEventListener("stalled", onWaiting);
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
    switchMirror: useCallback((index: number) => actionsRef.current.switchMirror(index), [])
  };
}
