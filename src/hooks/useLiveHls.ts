import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import type { StreamMirror } from "../config/stream";
import {
  getBufferedAhead,
  isPlaylistStale,
  nextMirrorIndex,
  retryDelayMs,
  shouldRotateMirror,
  sourceWithCacheBust
} from "../lib/reconnect";

export type LivePlaybackStatus =
  | "idle"
  | "connecting"
  | "live"
  | "buffering"
  | "reconnecting"
  | "offline"
  | "failed";

export type LiveHlsSnapshot = {
  status: LivePlaybackStatus;
  mode: "hls.js" | "native" | "unsupported" | "pending";
  activeMirrorIndex: number;
  attempt: number;
  recoveryCount: number;
  bufferAheadSeconds: number;
  targetDurationSeconds: number;
  currentSequence: number | null;
  lastSegmentAtMs: number | null;
  lastSequenceAtMs: number | null;
  lastError: string | null;
  nextRetryAtMs: number | null;
  isOnline: boolean;
};

export type LiveHlsOptions = {
  autoPlay?: boolean;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitterRatio?: number;
  healthIntervalMs?: number;
  staleTargetDurations?: number;
  stallTimeoutMs?: number;
  mirrorFailureThreshold?: number;
};

export type LiveHlsController = {
  snapshot: LiveHlsSnapshot;
  activeMirror: StreamMirror;
  retryNow: () => void;
  reload: () => void;
  switchMirror: (index: number) => void;
};

const defaultOptions: Required<LiveHlsOptions> = {
  autoPlay: true,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  jitterRatio: 0.25,
  healthIntervalMs: 1_500,
  staleTargetDurations: 3.5,
  stallTimeoutMs: 8_000,
  mirrorFailureThreshold: 2
};

const initialSnapshot: LiveHlsSnapshot = {
  status: "idle",
  mode: "pending",
  activeMirrorIndex: 0,
  attempt: 0,
  recoveryCount: 0,
  bufferAheadSeconds: 0,
  targetDurationSeconds: 4,
  currentSequence: null,
  lastSegmentAtMs: null,
  lastSequenceAtMs: null,
  lastError: null,
  nextRetryAtMs: null,
  isOnline: typeof navigator === "undefined" ? true : navigator.onLine
};

type ControllerActions = {
  retryNow: () => void;
  reload: () => void;
  switchMirror: (index: number) => void;
};

function hlsErrorLabel(data: { type?: string; details?: string; fatal?: boolean }) {
  const fatality = data.fatal ? "fatal" : "recoverable";
  return [fatality, data.type, data.details].filter(Boolean).join(" ");
}

function canUseNativeHls(video: HTMLVideoElement) {
  return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

export function useLiveHls(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  mirrors: readonly StreamMirror[],
  options: LiveHlsOptions = {}
): LiveHlsController {
  const opts = useMemo(() => ({ ...defaultOptions, ...options }), [options]);
  const [snapshot, setSnapshot] = useState<LiveHlsSnapshot>(initialSnapshot);
  const actionsRef = useRef<ControllerActions>({
    retryNow: () => undefined,
    reload: () => undefined,
    switchMirror: () => undefined
  });

  useEffect(() => {
    const media = videoRef.current;
    if (!media || mirrors.length === 0) return undefined;
    const video: HTMLVideoElement = media;

    let mounted = true;
    let hls: Hls | null = null;
    let reconnectTimer: number | null = null;
    let healthTimer: number | null = null;
    let stableTimer: number | null = null;
    let activeMirrorIndex = 0;
    let attempt = 0;
    let recoveryCount = 0;
    let consecutiveSourceFailures = 0;
    let mediaRecoveryAttempts = 0;
    let currentSequence: number | null = null;
    let lastSegmentAtMs: number | null = null;
    let lastSequenceAtMs: number | null = null;
    let lastTimeUpdateAtMs = Date.now();
    let lastObservedTime = 0;
    let targetDurationSeconds = 4;

    const publish = (partial: Partial<LiveHlsSnapshot>) => {
      if (!mounted) return;
      setSnapshot((current) => ({
        ...current,
        ...partial,
        activeMirrorIndex,
        attempt,
        recoveryCount,
        targetDurationSeconds,
        currentSequence,
        lastSegmentAtMs,
        lastSequenceAtMs,
        isOnline: navigator.onLine
      }));
    };

    const clearTimer = (timer: number | null) => {
      if (timer !== null) window.clearTimeout(timer);
    };

    const clearIntervalTimer = (timer: number | null) => {
      if (timer !== null) window.clearInterval(timer);
    };

    const markStableSoon = () => {
      clearTimer(stableTimer);
      stableTimer = window.setTimeout(() => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        publish({ attempt: 0, lastError: null, nextRetryAtMs: null });
      }, 20_000);
    };

    const destroyHls = () => {
      if (!hls) return;
      hls.destroy();
      hls = null;
    };

    const resetMediaElement = () => {
      video.removeAttribute("src");
      video.load();
    };

    const maybePlay = () => {
      if (!opts.autoPlay) return;
      void video.play().catch(() => {
        publish({
          status: "buffering",
          lastError: "Autoplay blocked. Press play to continue."
        });
      });
    };

    const scheduleReconnect = (reason: string, rotateMirror = false) => {
      clearTimer(reconnectTimer);

      if (!navigator.onLine) {
        publish({
          status: "offline",
          lastError: "Browser is offline.",
          nextRetryAtMs: null
        });
        return;
      }

      const rotate =
        rotateMirror ||
        shouldRotateMirror(consecutiveSourceFailures, mirrors.length, opts.mirrorFailureThreshold);

      if (rotate) {
        activeMirrorIndex = nextMirrorIndex(activeMirrorIndex, mirrors.length);
        consecutiveSourceFailures = 0;
      }

      attempt += 1;
      recoveryCount += 1;

      const delayMs = retryDelayMs(attempt, {
        baseMs: opts.backoffBaseMs,
        maxMs: opts.backoffMaxMs,
        jitterRatio: opts.jitterRatio
      });
      const nextRetryAtMs = Date.now() + delayMs;

      publish({
        status: "reconnecting",
        lastError: reason,
        nextRetryAtMs
      });

      reconnectTimer = window.setTimeout(() => {
        attachSource(activeMirrorIndex, reason);
      }, delayMs);
    };

    const attachNativeSource = (source: string) => {
      destroyHls();
      video.src = source;
      video.load();
      publish({
        mode: "native",
        status: "connecting",
        nextRetryAtMs: null
      });
      maybePlay();
    };

    const attachHlsSource = (source: string) => {
      destroyHls();

      hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8,
        maxLiveSyncPlaybackRate: 1.25,
        backBufferLength: 90,
        maxBufferLength: 60,
        manifestLoadingTimeOut: 8_000,
        manifestLoadingMaxRetry: 1,
        levelLoadingTimeOut: 8_000,
        levelLoadingMaxRetry: 1,
        fragLoadingTimeOut: 12_000,
        fragLoadingMaxRetry: 2
      });

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls?.loadSource(source);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        publish({
          mode: "hls.js",
          status: "connecting",
          lastError: null,
          nextRetryAtMs: null
        });
        maybePlay();
      });

      hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
        const details = data.details;
        const sequence = typeof details.endSN === "number" ? details.endSN : null;
        targetDurationSeconds = details.targetduration || targetDurationSeconds;

        if (sequence !== null && sequence !== currentSequence) {
          currentSequence = sequence;
          lastSequenceAtMs = Date.now();
        }

        publish({
          status: video.paused ? "connecting" : "live",
          lastError: null,
          nextRetryAtMs: null
        });
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        lastSegmentAtMs = Date.now();
        publish({
          status: video.paused ? "connecting" : "live",
          lastError: null,
          nextRetryAtMs: null
        });
        markStableSoon();
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        const label = hlsErrorLabel(data);

        if (!data.fatal) {
          publish({
            status: data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ? "buffering" : "connecting",
            lastError: label
          });
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hls && mediaRecoveryAttempts < 2) {
          mediaRecoveryAttempts += 1;
          recoveryCount += 1;
          hls.recoverMediaError();
          publish({
            status: "reconnecting",
            lastError: `${label}; recovering media pipeline`
          });
          return;
        }

        consecutiveSourceFailures += 1;
        scheduleReconnect(label);
      });

      publish({
        mode: "hls.js",
        status: "connecting",
        nextRetryAtMs: null
      });

      hls.attachMedia(video);
    };

    function attachSource(index: number, reason: string) {
      clearTimer(reconnectTimer);
      activeMirrorIndex = index;
      const mirror = mirrors[activeMirrorIndex] ?? mirrors[0];
      const source = sourceWithCacheBust(mirror.streamUrl, `${Date.now()}-${attempt}`);

      currentSequence = null;
      lastSegmentAtMs = null;
      lastSequenceAtMs = Date.now();
      lastTimeUpdateAtMs = Date.now();
      lastObservedTime = video.currentTime;

      publish({
        status: "connecting",
        mode: "pending",
        lastError: reason === "initial" ? null : reason,
        nextRetryAtMs: null,
        bufferAheadSeconds: 0
      });

      resetMediaElement();

      if (Hls.isSupported()) {
        attachHlsSource(source);
        return;
      }

      if (canUseNativeHls(video)) {
        attachNativeSource(source);
        return;
      }

      publish({
        status: "failed",
        mode: "unsupported",
        lastError: "This browser cannot play HLS streams."
      });
    }

    const runHealthCheck = () => {
      const now = Date.now();
      const bufferAheadSeconds = getBufferedAhead(video.buffered, video.currentTime);

      publish({ bufferAheadSeconds });

      if (isPlaylistStale({ nowMs: now, lastSequenceAtMs, targetDurationSeconds, staleTargetDurations: opts.staleTargetDurations })) {
        consecutiveSourceFailures += 1;
        scheduleReconnect("Playlist stopped advancing.");
        return;
      }

      if (!video.paused && !video.ended) {
        const playheadMoved = Math.abs(video.currentTime - lastObservedTime) > 0.15;
        if (playheadMoved) {
          lastTimeUpdateAtMs = now;
          lastObservedTime = video.currentTime;
        } else if (now - lastTimeUpdateAtMs > opts.stallTimeoutMs && bufferAheadSeconds < 1) {
          consecutiveSourceFailures += 1;
          scheduleReconnect("Playback stalled at the live edge.");
        }
      }
    };

    const onPlaying = () => {
      lastTimeUpdateAtMs = Date.now();
      lastObservedTime = video.currentTime;
      publish({
        status: "live",
        lastError: null,
        nextRetryAtMs: null
      });
      markStableSoon();
    };

    const onWaiting = () => {
      publish({ status: "buffering" });
    };

    const onVideoError = () => {
      consecutiveSourceFailures += 1;
      const code = video.error?.code ? `media code ${video.error.code}` : "media error";
      scheduleReconnect(code);
    };

    const onOnline = () => {
      publish({ isOnline: true });
      attachSource(activeMirrorIndex, "Browser came back online.");
    };

    const onOffline = () => {
      clearTimer(reconnectTimer);
      publish({
        status: "offline",
        isOnline: false,
        lastError: "Browser is offline.",
        nextRetryAtMs: null
      });
    };

    const onVisibilityChange = () => {
      if (!document.hidden) runHealthCheck();
    };

    actionsRef.current = {
      retryNow: () => {
        attempt = 0;
        attachSource(activeMirrorIndex, "Manual retry.");
      },
      reload: () => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        attachSource(activeMirrorIndex, "Manual reload.");
      },
      switchMirror: (index: number) => {
        if (index < 0 || index >= mirrors.length) return;
        attempt = 0;
        consecutiveSourceFailures = 0;
        activeMirrorIndex = index;
        attachSource(activeMirrorIndex, "Mirror selected.");
      }
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("error", onVideoError);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);

    attachSource(activeMirrorIndex, "initial");
    healthTimer = window.setInterval(runHealthCheck, opts.healthIntervalMs);

    return () => {
      mounted = false;
      clearTimer(reconnectTimer);
      clearTimer(stableTimer);
      clearIntervalTimer(healthTimer);
      destroyHls();
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

  return {
    snapshot,
    activeMirror,
    retryNow: useCallback(() => actionsRef.current.retryNow(), []),
    reload: useCallback(() => actionsRef.current.reload(), []),
    switchMirror: useCallback((index: number) => actionsRef.current.switchMirror(index), [])
  };
}
