import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import type { StreamMirror } from "../config/stream";
import {
  chooseFreshestProbe,
  getBufferedAhead,
  isPlaylistStale,
  nextMirrorIndex,
  parseHlsManifest,
  retryDelayMs,
  shouldRotateMirror,
  sourceWithCacheBust
} from "../lib/reconnect";
import type { ManifestProbe, ManifestProbeFailure, ManifestProbeResult } from "../lib/reconnect";

export type LivePlaybackStatus =
  | "idle"
  | "connecting"
  | "live"
  | "buffering"
  | "reconnecting"
  | "offline"
  | "failed";

export type LiveProbeSnapshot = {
  ok: boolean;
  mirrorIndex: number;
  host: string;
  sequence: number | null;
  fetchedAtMs: number;
  error: string | null;
};

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
  autoplayBlocked: boolean;
  soundEnabled: boolean;
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
  probeTimeoutMs?: number;
};

export type LiveHlsController = {
  snapshot: LiveHlsSnapshot;
  activeMirror: StreamMirror;
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
  backoffBaseMs: 150,
  backoffMaxMs: 8_000,
  jitterRatio: 0.18,
  healthIntervalMs: 750,
  staleTargetDurations: 1.75,
  stallTimeoutMs: 2_500,
  mirrorFailureThreshold: 1,
  probeTimeoutMs: 2_200
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
  isOnline: typeof navigator === "undefined" ? true : navigator.onLine,
  autoplayBlocked: false,
  soundEnabled: true,
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

function hlsErrorLabel(data: { type?: string; details?: string; fatal?: boolean }) {
  const fatality = data.fatal ? "fatal" : "recoverable";
  return [fatality, data.type, data.details].filter(Boolean).join(" ");
}

function canUseNativeHls(video: HTMLVideoElement) {
  return video.canPlayType("application/vnd.apple.mpegurl") !== "";
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

function probeSnapshotFromResult(probe: ManifestProbe, mirrors: readonly StreamMirror[]): LiveProbeSnapshot {
  const mirror = mirrors[probe.mirrorIndex] ?? mirrors[0];

  if (!probe.ok) {
    return {
      ok: false,
      mirrorIndex: probe.mirrorIndex,
      host: mirror?.host ?? "unknown",
      sequence: null,
      fetchedAtMs: probe.fetchedAtMs,
      error: probe.error
    };
  }

  return {
    ok: true,
    mirrorIndex: probe.mirrorIndex,
    host: mirror?.host ?? "unknown",
    sequence: probe.endSequence ?? probe.mediaSequence,
    fetchedAtMs: probe.fetchedAtMs,
    error: null
  };
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
    hardReconnect: () => undefined,
    enableAudio: async () => undefined,
    seekToLive: () => undefined,
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
    let probeRun = 0;
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
      const bufferAheadSeconds = getBufferedAhead(video.buffered, video.currentTime);
      const frameStats = getFrameStats(video);

      setSnapshot((current) => ({
        ...current,
        ...partial,
        activeMirrorIndex,
        attempt,
        recoveryCount,
        bufferAheadSeconds,
        targetDurationSeconds,
        currentSequence,
        lastSegmentAtMs,
        lastSequenceAtMs,
        isOnline: navigator.onLine,
        soundEnabled: !video.muted && video.volume > 0,
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

    const markStableSoon = () => {
      clearTimer(stableTimer);
      stableTimer = window.setTimeout(() => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        mediaRecoveryAttempts = 0;
        publish({ attempt: 0, lastError: null, nextRetryAtMs: null });
      }, 12_000);
    };

    const destroyHls = () => {
      if (!hls) return;
      hls.destroy();
      hls = null;
    };

    const resetMediaElement = () => {
      destroyHls();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };

    const maybePlay = async () => {
      if (!opts.autoPlay) return;

      video.autoplay = true;
      video.playsInline = true;

      if (opts.forceAutoplayAudio) {
        video.muted = false;
        if (video.volume === 0) video.volume = 1;
      }

      try {
        await video.play();
        publish({
          autoplayBlocked: false,
          soundEnabled: !video.muted && video.volume > 0,
          lastError: null
        });
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

    const probeMirror = async (mirror: StreamMirror, index: number, run: number): Promise<ManifestProbe> => {
      const fetchedAtMs = Date.now();
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), opts.probeTimeoutMs);
      const url = sourceWithCacheBust(mirror.streamUrl, `probe-${fetchedAtMs}-${run}`);

      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal
        });

        if (!response.ok) {
          return {
            ok: false,
            mirrorIndex: index,
            url,
            fetchedAtMs,
            error: `probe HTTP ${response.status}`
          } satisfies ManifestProbeFailure;
        }

        const parsed = parseHlsManifest(await response.text());
        if (!parsed) {
          return {
            ok: false,
            mirrorIndex: index,
            url,
            fetchedAtMs,
            error: "probe returned a non-HLS response"
          } satisfies ManifestProbeFailure;
        }

        return {
          ...parsed,
          ok: true,
          mirrorIndex: index,
          url,
          fetchedAtMs
        } satisfies ManifestProbeResult;
      } catch (error) {
        const label = error instanceof Error ? error.message : "probe failed";
        return {
          ok: false,
          mirrorIndex: index,
          url,
          fetchedAtMs,
          error: label
        } satisfies ManifestProbeFailure;
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const probeFreshMirror = async () => {
      const run = (probeRun += 1);
      const probes = await Promise.all(mirrors.map((mirror, index) => probeMirror(mirror, index, run)));
      if (!mounted || run !== probeRun) return null;

      const freshest = chooseFreshestProbe(probes);
      const probeForSnapshot = freshest ?? probes[activeMirrorIndex] ?? probes[0];

      if (freshest) {
        targetDurationSeconds = freshest.targetDurationSeconds || targetDurationSeconds;
        publish({
          lastProbe: probeSnapshotFromResult(freshest, mirrors)
        });
        return freshest;
      }

      if (probeForSnapshot) {
        publish({
          lastProbe: probeSnapshotFromResult(probeForSnapshot, mirrors)
        });
      }

      return null;
    };

    function attachNativeSource(source: string) {
      destroyHls();
      video.src = source;
      video.load();
      publish({
        mode: "native",
        status: "connecting",
        nextRetryAtMs: null
      });
      void maybePlay();
    }

    function attachHlsSource(source: string) {
      destroyHls();

      hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        maxLiveSyncPlaybackRate: 1.5,
        backBufferLength: 30,
        maxBufferLength: 20,
        maxBufferHole: 0.25,
        manifestLoadingTimeOut: 3_500,
        manifestLoadingMaxRetry: 0,
        levelLoadingTimeOut: 3_500,
        levelLoadingMaxRetry: 0,
        fragLoadingTimeOut: 5_000,
        fragLoadingMaxRetry: 1
      });

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls?.loadSource(source);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        publish({
          mode: "hls.js",
          status: "connecting",
          autoplayBlocked: false,
          lastError: null,
          nextRetryAtMs: null
        });
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
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            consecutiveSourceFailures += 1;
            scheduleReconnect(label);
            return;
          }

          publish({
            status: "connecting",
            lastError: label
          });
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hls && mediaRecoveryAttempts < 1) {
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
    }

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
        autoplayBlocked: false
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

    function scheduleReconnect(reason: string, rotateMirror = false) {
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
        void (async () => {
          const freshest = mirrors.length > 1 ? await probeFreshMirror() : null;
          const selectedIndex = freshest?.mirrorIndex ?? activeMirrorIndex;
          attachSource(selectedIndex, reason);
        })();
      }, delayMs);
    }

    const runHealthCheck = () => {
      const now = Date.now();
      const bufferAheadSeconds = getBufferedAhead(video.buffered, video.currentTime);

      publish({ bufferAheadSeconds });

      if (
        isPlaylistStale({
          nowMs: now,
          lastSequenceAtMs,
          targetDurationSeconds,
          staleTargetDurations: opts.staleTargetDurations
        })
      ) {
        consecutiveSourceFailures += 1;
        scheduleReconnect("Playlist stopped advancing.");
        return;
      }

      if (!video.paused && !video.ended) {
        const playheadMoved = Math.abs(video.currentTime - lastObservedTime) > 0.12;
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
      publish({
        status: "live",
        autoplayBlocked: false,
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
        consecutiveSourceFailures = 0;
        attachSource(activeMirrorIndex, "Manual retry.");
      },
      reload: () => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        attachSource(activeMirrorIndex, "Manual reload.");
      },
      hardReconnect: () => {
        attempt = 0;
        consecutiveSourceFailures = 0;
        recoveryCount += 1;
        resetMediaElement();
        attachSource(activeMirrorIndex, "Manual hard reconnect.");
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
    hardReconnect: useCallback(() => actionsRef.current.hardReconnect(), []),
    enableAudio: useCallback(() => actionsRef.current.enableAudio(), []),
    seekToLive: useCallback(() => actionsRef.current.seekToLive(), []),
    switchMirror: useCallback((index: number) => actionsRef.current.switchMirror(index), [])
  };
}
