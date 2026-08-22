import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import Hls from "hls.js";
import { streamConfig } from "./config/stream";
import { defaultThemeId, isThemeId, themeOptions } from "./config/themes";
import type { ThemeId } from "./config/themes";
import { ufcSchedule, ufcScheduleLastChecked } from "./config/ufcSchedule";
import { createStableHlsConfig, useLiveHls } from "./hooks/useLiveHls";
import type { LivePlaybackStatus } from "./hooks/useLiveHls";
import { liveEdgeBackoffSeconds, parseHlsManifest, sourceWithCacheBust } from "./lib/reconnect";
import {
  decideAutoFallback,
  nextFailureRecord,
  type CandidateSource,
  type FallbackDecision
} from "./lib/sourceFallback";
import { qoeDelta, totalViewerCount, viewerCountForSource } from "./lib/viewers";
import {
  clampVolume,
  eventStartMs,
  formatDuration,
  formatEventTime,
  formatSignedSeconds,
  getEventPhase,
  getScheduleBuckets,
  initialPlayerUiState,
  playWithMutedFallback,
  playerUiReducer
} from "./lib/playerControls";
import type { PlayerUiState } from "./lib/playerControls";

type PictureInPictureDocument = Document & {
  pictureInPictureElement?: Element | null;
  pictureInPictureEnabled?: boolean;
  exitPictureInPicture?: () => Promise<void>;
};

type PictureInPictureVideo = HTMLVideoElement & {
  requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
};

type WebKitPresentationMode = "inline" | "fullscreen" | "picture-in-picture";

type WebKitFullscreenVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitPresentationMode?: WebKitPresentationMode;
  webkitSetPresentationMode?: (mode: WebKitPresentationMode) => void;
  webkitSupportsFullscreen?: boolean;
};

type PlayerIconName = "play" | "pause" | "volume" | "muted" | "settings" | "pip" | "fullscreen" | "retry" | "cast";
type OpenDropdown = "theme" | "mirror" | "protocol" | null;
type AutoMode = "primary" | "public" | "configured" | "custom";
type SourceTone = "green" | "yellow" | "red";

type ConfiguredSource = {
  id: string;
  label: string;
  type: string;
  index: number;
  enabled: boolean;
  in_active_pool: boolean;
  in_process: boolean;
  preferred: boolean;
  state: "preferred" | "active" | "ready" | "standby" | "disabled" | string;
  health?: SourceTone | null;
  health_checked_at?: number | null;
  health_error?: string | null;
  viewer_count: number;
  playback_url: string;
};

type PublicSource = {
  id: string;
  label: string;
  url: string;
  playback_url?: string;
  enabled?: boolean;
};

type ViewerSourceCount = {
  id: string;
  label: string;
  viewer_count: number;
};

type ViewerCounts = {
  total: number;
  ttl_seconds: number;
  by_source: Record<string, number>;
  sources: ViewerSourceCount[];
  updated_at: number;
};

type WatcherNewsEntry = {
  id: string;
  title: string;
  body: string;
  tone?: SourceTone | "info" | "neutral" | string;
  visible?: boolean;
  pinned?: boolean;
  created_at?: number;
  updated_at?: number;
  link_url?: string;
  link_label?: string;
};

type OverlaySource = {
  kind: "public" | "configured" | "custom";
  id: string;
  label: string;
};

type SourceFailureRecord = {
  failureCount: number;
  lastFailureAtMs: number | null;
  cooldownUntilMs: number | null;
};

type PublicProbeRecord = {
  tone: SourceTone;
  checkedAtMs: number;
  reason: string;
};

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: any;
    chrome?: any;
  }
}

function PlayerIcon({ name }: { name: PlayerIconName }) {
  const commonProps = {
    className: "player-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  switch (name) {
    case "play":
      return (
        <svg {...commonProps}>
          <path d="M8 5v14l11-7-11-7z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "pause":
      return (
        <svg {...commonProps}>
          <path d="M8 5v14" />
          <path d="M16 5v14" />
        </svg>
      );
    case "volume":
      return (
        <svg {...commonProps}>
          <path d="M4 10v4h4l5 4V6l-5 4H4z" />
          <path d="M16 9.5a4 4 0 0 1 0 5" />
          <path d="M18.5 7a7 7 0 0 1 0 10" />
        </svg>
      );
    case "muted":
      return (
        <svg {...commonProps}>
          <path d="M4 10v4h4l5 4V6l-5 4H4z" />
          <path d="M17 9l4 4" />
          <path d="M21 9l-4 4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...commonProps}>
          <path d="M4 7h16" />
          <path d="M4 17h16" />
          <path d="M9 7a2 2 0 1 0 0 .01" />
          <path d="M15 17a2 2 0 1 0 0 .01" />
        </svg>
      );
    case "pip":
      return (
        <svg {...commonProps}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <rect x="12" y="11" width="6" height="4" rx="1" />
        </svg>
      );
    case "fullscreen":
      return (
        <svg {...commonProps}>
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M16 3h3a2 2 0 0 1 2 2v3" />
          <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      );
    case "cast":
      return (
        <svg {...commonProps}>
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3" />
          <path d="M4 17v2" />
          <path d="M4 13a6 6 0 0 1 6 6" />
          <path d="M4 9a10 10 0 0 1 10 10" />
        </svg>
      );
    case "retry":
      return (
        <svg {...commonProps}>
          <path d="M20 12a8 8 0 1 1-2.34-5.66" />
          <path d="M20 4v6h-6" />
        </svg>
      );
    default:
      return null;
  }
}

function useClock() {
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return clock;
}

function loadInitialPlayerState(): PlayerUiState {
  if (typeof window === "undefined") return initialPlayerUiState;

  try {
    const saved = window.localStorage.getItem("obbywatcher:player-ui");
    if (!saved) return initialPlayerUiState;
    const parsed = JSON.parse(saved) as Partial<PlayerUiState>;

    return {
      ...initialPlayerUiState,
      volume: clampVolume(Number(parsed.volume ?? initialPlayerUiState.volume)),
      muted: Boolean(parsed.muted ?? initialPlayerUiState.muted),
      statsOpen: Boolean(parsed.statsOpen ?? initialPlayerUiState.statsOpen),
      moreMenuOpen: false
    };
  } catch {
    return initialPlayerUiState;
  }
}

function loadInitialTheme(): ThemeId {
  if (typeof window === "undefined") return defaultThemeId;
  const saved = window.localStorage.getItem("obbywatcher:theme");
  return saved && isThemeId(saved) ? saved : defaultThemeId;
}

function statusCopy(status: LivePlaybackStatus) {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "live":
      return "Live";
    case "buffering":
      return "Buffering";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "failed":
      return "Needs attention";
    default:
      return "Standing by";
  }
}

function relativeTime(valueMs: number | null) {
  if (!valueMs) return "No segment yet";
  const deltaSeconds = Math.max(0, Math.round((Date.now() - valueMs) / 1000));
  if (deltaSeconds < 2) return "Just now";
  return `${deltaSeconds}s ago`;
}

function retryEta(valueMs: number | null) {
  if (!valueMs) return "Manual";
  const deltaSeconds = Math.max(0, Math.ceil((valueMs - Date.now()) / 1000));
  return `${deltaSeconds}s`;
}

function countdownLabel(startMs: number, nowMs: number) {
  if (!Number.isFinite(startMs)) return "Time TBA";
  const deltaMs = startMs - nowMs;
  if (deltaMs <= 0) return "Live window";

  const totalMinutes = Math.ceil(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

function castContentType(protocol: "dash" | "hls") {
  return protocol === "dash" ? "application/dash+xml" : "application/vnd.apple.mpegurl";
}

function percent(value: number | null, max: number) {
  if (value === null || !Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

function bufferedAheadForVideo(video: HTMLVideoElement | null) {
  if (!video || video.buffered.length === 0) return 0;
  return Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime);
}

function liveLatencyForVideo(video: HTMLVideoElement | null) {
  if (!video || video.seekable.length === 0) return null;
  const liveEdge = video.seekable.end(video.seekable.length - 1);
  return Math.max(0, liveEdge - video.currentTime);
}

function useOverlayVideoMetrics(videoRef: React.RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const [metrics, setMetrics] = useState({ bufferAheadSeconds: 0, liveLatencySeconds: null as number | null });
  useEffect(() => {
    if (!enabled) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    // These feed a readout that a human reads a few times a second. A rAF loop
    // allocating a fresh object every frame meant ~60 React re-renders/sec for
    // the whole tree while the overlay was up, which is its own source of lag.
    const update = () => {
      const next = {
        bufferAheadSeconds: bufferedAheadForVideo(video),
        liveLatencySeconds: liveLatencyForVideo(video)
      };
      setMetrics((current) =>
        current.bufferAheadSeconds === next.bufferAheadSeconds &&
        current.liveLatencySeconds === next.liveLatencySeconds
          ? current
          : next
      );
    };
    const intervalId = window.setInterval(update, 250);
    update();
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, videoRef]);
  return metrics;
}

function cockpitUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${OBBY_COCKPIT}${path.startsWith("/") ? path : `/${path}`}`;
}

function publicProxyUrl(rawUrl: string) {
  return `${OBBY_COCKPIT}/api/proxy-hls?url=${encodeURIComponent(rawUrl)}`;
}

function publicPlaybackUrl(source: PublicSource) {
  if (source.playback_url) return cockpitUrl(source.playback_url);
  return publicProxyUrl(source.url);
}

function publicSourceId(source: PublicSource, index: number) {
  return source.id || `public-${index + 1}`;
}

function hostLabelForUrl(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "custom";
  }
}

function sourceTone(source: Pick<ConfiguredSource, "state" | "enabled" | "health">): SourceTone {
  if (!source.enabled || source.state === "disabled") return "red";
  if (source.health) return source.health;
  if (source.state === "preferred" || source.state === "active" || source.state === "ready") return "green";
  return "yellow";
}

function configuredSourceTone(source: ConfiguredSource, primaryTone: SourceTone): SourceTone {
  if (source.preferred) return primaryTone;
  return sourceTone(source);
}

function publicCockpitSources(sources: ConfiguredSource[]) {
  return sources.filter((source) => source.id === "server-1" || source.type === "managed-hls" || source.playback_url === "/hls/ufc.m3u8");
}

function getViewerCount(viewers: ViewerCounts | null, sourceId: string, fallback = 0) {
  return viewerCountForSource(viewers, sourceId, fallback);
}

async function probePublicPlaybackUrl(url: string, signal: AbortSignal): Promise<PublicProbeRecord> {
  const resp = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*" },
    signal
  });
  if (!resp.ok) {
    return { tone: "red", checkedAtMs: Date.now(), reason: `HTTP ${resp.status}` };
  }

  const body = await resp.text();
  const parsed = parseHlsManifest(body);
  if (!parsed) {
    return { tone: "red", checkedAtMs: Date.now(), reason: "not an HLS playlist" };
  }
  if (!parsed.isLive) {
    return { tone: "red", checkedAtMs: Date.now(), reason: "playlist ended" };
  }
  if (parsed.segmentCount <= 0) {
    return { tone: "yellow", checkedAtMs: Date.now(), reason: "playlist has no variants or segments yet" };
  }

  return { tone: "green", checkedAtMs: Date.now(), reason: "playlist available" };
}

function isWebKitFullscreen(video: WebKitFullscreenVideo | null) {
  return Boolean(video?.webkitDisplayingFullscreen || video?.webkitPresentationMode === "fullscreen");
}

function enterWebKitFullscreen(video: WebKitFullscreenVideo | null) {
  if (!video) return false;

  if (video.webkitSetPresentationMode) {
    try {
      video.webkitSetPresentationMode("fullscreen");
      return true;
    } catch {
      // Try the older iOS Safari API below.
    }
  }

  if (video.webkitEnterFullscreen) {
    try {
      video.webkitEnterFullscreen();
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function exitWebKitFullscreen(video: WebKitFullscreenVideo | null) {
  if (!video) return false;

  if (video.webkitSetPresentationMode && video.webkitPresentationMode === "fullscreen") {
    try {
      video.webkitSetPresentationMode("inline");
      return true;
    } catch {
      // Try the older iOS Safari API below.
    }
  }

  if (video.webkitExitFullscreen) {
    try {
      video.webkitExitFullscreen();
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

const OBBY_COCKPIT = "https://s.obby.ca";

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const customVideoRef = useRef<HTMLVideoElement | null>(null);
  const customHlsRef = useRef<Hls | null>(null);
  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const now = useClock();
  const nowMs = now.getTime();
  const [notice, setNotice] = useState<string>(streamConfig.schedule);
  const [themeId, setThemeId] = useState<ThemeId>(loadInitialTheme);
  const [customSrc, setCustomSrc] = useState<string | null>(null);
  const [customSrcBusy, setCustomSrcBusy] = useState(false);
  const [customSrcMsg, setCustomSrcMsg] = useState<string | null>(null);
  const [customPlayerBusy, setCustomPlayerBusy] = useState(false);
  const [scInput, setScInput] = useState("");
  // Public pasted sources are hosted by the cockpit separately from the official
  // ffmpeg source. Static config is only a local/dev fallback.
  const [publicSources, setPublicSources] = useState<PublicSource[]>(
    () => streamConfig.publicSources.filter((source) => source.enabled)
  );
  const [publicSourceIdx, setPublicSourceIdx] = useState(0);
  const [configuredSources, setConfiguredSources] = useState<ConfiguredSource[]>([]);
  const [configuredSourceId, setConfiguredSourceId] = useState<string | null>(null);
  const [viewerCounts, setViewerCounts] = useState<ViewerCounts | null>(null);
  const [watcherNews, setWatcherNews] = useState<WatcherNewsEntry[]>([]);
  type HighscoreEntry = { rank: number; codename: string; ip_masked: string; watch_seconds: number; favorite_source: string | null; flag: string; location: string; country: string };
  type SourcePerf = { source_id: string; label?: string; watch_hours: number; smoothness: number; buffering_minutes: number; stalls: number; viewers: number };
  type HighscoreData = { leaderboard: HighscoreEntry[]; top_countries: { country: string; flag: string; watch_hours: number; viewers: number }[]; top_sources: { source_id: string; watch_hours: number }[]; source_performance: SourcePerf[]; best_sources: SourcePerf[]; viewers_tracked: number; total_watch_hours: number };
  const prettySource = (id: string) => id.replace(/^private-iptv-/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const [highscores, setHighscores] = useState<HighscoreData | null>(null);
  const formatWatch = (seconds: number) => {
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds}s`;
  };
  const [overlaySource, setOverlaySource] = useState<OverlaySource | null>(null);
  const [autoMode, setAutoMode] = useState<AutoMode>("primary");
  const primaryBadSince = useRef<number | null>(null);
  const publicBadSince = useRef<number | null>(null);
  const primaryRecoveredSince = useRef<number | null>(null);
  const lastAutoSwitchAt = useRef(0);
  const sourceFailuresRef = useRef<Record<string, SourceFailureRecord>>({});
  const overlayFatalSince = useRef<number | null>(null);
  const publicProgressRef = useRef({ timeMs: 0, currentTime: 0, bufferedAhead: 0, readyState: 0 });
  const AUTO_SWITCH_DELAY = 10_000;
  const AUTO_RETURN_DELAY = 18_000;
  const AUTO_SWITCH_COOLDOWN = 4_000;
  const AUTO_SOURCE_COOLDOWN = 30_000;
  const [publicDotStatus, setPublicDotStatus] = useState<"green" | "yellow" | "red">("yellow");
  const [publicProbeState, setPublicProbeState] = useState<Record<string, PublicProbeRecord>>({});
  const [ui, dispatch] = useReducer(playerUiReducer, undefined, loadInitialPlayerState);
  const [playing, setPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [castAvailable, setCastAvailable] = useState(false);
  const [castStatus, setCastStatus] = useState<"idle" | "connecting" | "casting" | "failed">("idle");
  const [openDropdown, setOpenDropdown] = useState<OpenDropdown>(null);
  const [volumePanelOpen, setVolumePanelOpen] = useState(false);
  const [playerNotice, setPlayerNotice] = useState<string | null>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const playerClickTimer = useRef<number | null>(null);
  const lastPlayerSurfaceClick = useRef<{ time: number; x: number; y: number } | null>(null);
  const lastFullscreenToggleAt = useRef(0);
  const customReloadNonce = useRef(0);
  const overlayReconnectAttempts = useRef(0);
  const overlayPlaybackIdentity = useRef<string | null>(null);
  const playerNoticeTimer = useRef<number | null>(null);

  const playerOptions = useMemo(
    () => ({
      // Suspend the managed pipeline whenever a public/custom source is active so it
      // can't auto-recover and play behind the overlay (double audio).
      active: !customSrc,
      autoPlay: true,
      forceAutoplayAudio: true
    }),
    [customSrc]
  );
  const { snapshot, activeMirror, activeSource, retryNow, reload, hardReconnect, enableAudio, seekToLive, switchMirror, switchProtocol } =
    useLiveHls(videoRef, streamConfig.mirrors, playerOptions);
  const overlayActive = Boolean(customSrc);
  const activeSourceId = overlaySource?.id ?? "server-1";
  const activeSourceLabel = overlaySource?.label ?? "Server 1 / Default";
  const activePlaybackUrl = customSrc ?? activeSource.url;
  const activePlaybackProtocol = customSrc ? "hls" : activeSource.protocol;
  const activePlaybackHost = customSrc ? hostLabelForUrl(activePlaybackUrl) : activeMirror.host;

  const activeTheme = themeOptions.find((theme) => theme.id === themeId) ?? themeOptions[0];
  const scheduleBuckets = getScheduleBuckets(ufcSchedule, nowMs);
  const featuredEvent = scheduleBuckets.current ?? scheduleBuckets.next ?? ufcSchedule[0];
  const playerBusy =
    snapshot.autoplayBlocked ||
    snapshot.status === "buffering" ||
    snapshot.status === "connecting" ||
    snapshot.status === "reconnecting";
  const activePlayerBusy = overlayActive ? customPlayerBusy : playerBusy;
  // QoE: accumulate buffering/stall time so the heartbeat can report per-source
  // playback quality (used server-side to rank best-performing sources).
  const bufferAccumMsRef = useRef(0);
  const bufferStartRef = useRef<number | null>(null);
  const stallCountRef = useRef(0);
  // The player already knows how far behind live it is and how many times it has
  // torn itself down and re-attached — a re-attach restarts the playhead at live,
  // so each one is a skip the viewer sees. None of it was ever reported, so
  // diagnosing "it's skipping" meant counting init-segment refetches in the
  // origin's access log. Mirrored into a ref so the 15s heartbeat can read the
  // latest values without taking the fast-changing snapshot as an effect dep.
  const qoeSnapshotRef = useRef({ recoveryCount: 0, droppedFrames: 0, liveLatencySeconds: null as number | null });
  // recoveryCount/droppedFrames are cumulative and reset when the player is
  // rebuilt, so report deltas and never a negative one.
  const lastRecoveryCountRef = useRef(0);
  const lastDroppedFramesRef = useRef(0);
  useEffect(() => {
    if (activePlayerBusy) {
      if (bufferStartRef.current == null) {
        bufferStartRef.current = Date.now();
        stallCountRef.current += 1;
      }
    } else if (bufferStartRef.current != null) {
      bufferAccumMsRef.current += Date.now() - bufferStartRef.current;
      bufferStartRef.current = null;
    }
  }, [activePlayerBusy]);
  const customVideoMetrics = useOverlayVideoMetrics(customVideoRef, overlayActive);
  const customLiveLatencySeconds = overlayActive ? customVideoMetrics.liveLatencySeconds : null;
  const customBufferAheadSeconds = overlayActive ? customVideoMetrics.bufferAheadSeconds : 0;
  qoeSnapshotRef.current = {
    recoveryCount: snapshot.recoveryCount,
    droppedFrames: snapshot.droppedFrames ?? 0,
    // Report whichever element is actually on screen.
    liveLatencySeconds: overlayActive ? customLiveLatencySeconds : snapshot.liveLatencySeconds
  };
  const activePlaybackStatus: LivePlaybackStatus = overlayActive
    ? customPlayerBusy ? (playing ? "buffering" : "connecting") : playing ? "live" : "idle"
    : snapshot.status;
  const activeStatus = overlayActive
    ? activePlaybackStatus === "live" ? `${activeSourceLabel} live` :
      activePlaybackStatus === "buffering" ? `${activeSourceLabel} buffering` :
      activePlaybackStatus === "connecting" ? `${activeSourceLabel} connecting` :
      `${activeSourceLabel} ready`
    : statusCopy(snapshot.status);
  const activeLiveLatencySeconds = overlayActive ? customLiveLatencySeconds : snapshot.liveLatencySeconds;
  const activeBufferAheadSeconds = overlayActive ? customBufferAheadSeconds : snapshot.bufferAheadSeconds;
  const latencyMax = Math.max(12, snapshot.targetDurationSeconds * 5);
  const liveProgressPercent = Math.max(8, 100 - percent(activeLiveLatencySeconds, latencyMax));
  const primaryDot: "green" | "yellow" | "red" =
    snapshot.status === "live" ? "green" :
    snapshot.status === "failed" ? "red" : "yellow";
  const totalViewers = totalViewerCount(viewerCounts);

  useEffect(() => {
    window.localStorage.setItem(
      "obbywatcher:player-ui",
      JSON.stringify({
        volume: ui.volume,
        muted: ui.muted,
        statsOpen: ui.statsOpen
      })
    );
  }, [ui.muted, ui.statsOpen, ui.volume]);

  useEffect(() => {
    window.localStorage.setItem("obbywatcher:theme", themeId);
  }, [themeId]);

  useEffect(() => {
    const closeOpenDropdown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-custom-select]")) return;
      setOpenDropdown(null);
    };

    window.addEventListener("pointerdown", closeOpenDropdown);
    return () => window.removeEventListener("pointerdown", closeOpenDropdown);
  }, []);

  useEffect(() => {
    const closeVolumePanel = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-volume-control]")) return;
      setVolumePanelOpen(false);
    };

    window.addEventListener("pointerdown", closeVolumePanel);
    return () => window.removeEventListener("pointerdown", closeVolumePanel);
  }, []);

  useEffect(() => {
    for (const video of [videoRef.current, customVideoRef.current]) {
      if (!video) continue;
      video.volume = ui.volume;
      video.muted = ui.muted;
    }
  }, [ui.volume, ui.muted]);

  useEffect(() => {
    window.__onGCastApiAvailable = (available: boolean) => {
      setCastAvailable(available);
      if (!available || !window.chrome?.cast || !window.cast?.framework) return;
      const sessionRequest = new window.chrome.cast.SessionRequest(window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID);
      const apiConfig = new window.chrome.cast.ApiConfig(sessionRequest, () => undefined, (availability: string) => {
        setCastAvailable(availability === window.chrome.cast.ReceiverAvailability.AVAILABLE);
      });
      window.chrome.cast.initialize(apiConfig, () => undefined, () => setCastAvailable(false));
    };

    let script: HTMLScriptElement | null = null;
    if (!document.querySelector('script[src*="cast_sender.js"]')) {
      script = document.createElement("script");
      script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      script.async = true;
      document.head.appendChild(script);
    }

    return () => {
      window.__onGCastApiAvailable = undefined;
      if (script && script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };
  }, []);

  useEffect(() => {
    const videos = [videoRef.current, customVideoRef.current].filter((video): video is HTMLVideoElement => Boolean(video));
    if (videos.length === 0) return undefined;

    const syncPlayback = (event?: Event) => {
      const video = (event?.currentTarget as HTMLVideoElement | null) ?? (overlayActive ? customVideoRef.current : videoRef.current);
      if (!video || video !== (overlayActive ? customVideoRef.current : videoRef.current)) return;
      setPlaying(!video.paused && !video.ended);
    };
    const syncVolume = () => {
      const video = overlayActive ? customVideoRef.current : videoRef.current;
      if (!video) return;
      dispatch({ type: "set-volume", volume: video.volume });
      dispatch({ type: "set-muted", muted: video.muted });
    };
    const onEnterPictureInPicture = () => setPictureInPicture(true);
    const onLeavePictureInPicture = () => setPictureInPicture(false);

    for (const video of videos) {
      video.addEventListener("play", syncPlayback);
      video.addEventListener("playing", syncPlayback);
      video.addEventListener("pause", syncPlayback);
      video.addEventListener("ended", syncPlayback);
      video.addEventListener("volumechange", syncVolume);
      video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
      video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
    }

    syncPlayback();
    syncVolume();

    return () => {
      for (const video of videos) {
        video.removeEventListener("play", syncPlayback);
        video.removeEventListener("playing", syncPlayback);
        video.removeEventListener("pause", syncPlayback);
        video.removeEventListener("ended", syncPlayback);
        video.removeEventListener("volumechange", syncVolume);
        video.removeEventListener("enterpictureinpicture", onEnterPictureInPicture);
        video.removeEventListener("leavepictureinpicture", onLeavePictureInPicture);
      }
    };
  }, [overlayActive]);

  useEffect(() => {
    const videos = [videoRef.current, customVideoRef.current].filter((video): video is WebKitFullscreenVideo => Boolean(video));
    const syncFullscreen = () => {
      const active = (overlayActive ? customVideoRef.current : videoRef.current) as WebKitFullscreenVideo | null;
      setFullscreen(document.fullscreenElement === playerShellRef.current || isWebKitFullscreen(active));
    };

    document.addEventListener("fullscreenchange", syncFullscreen);
    for (const video of videos) {
      video.addEventListener("webkitbeginfullscreen", syncFullscreen);
      video.addEventListener("webkitendfullscreen", syncFullscreen);
      video.addEventListener("webkitpresentationmodechanged", syncFullscreen);
    }

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      for (const video of videos) {
        video.removeEventListener("webkitbeginfullscreen", syncFullscreen);
        video.removeEventListener("webkitendfullscreen", syncFullscreen);
        video.removeEventListener("webkitpresentationmodechanged", syncFullscreen);
      }
    };
  }, [overlayActive]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimer.current !== null) window.clearTimeout(hideControlsTimer.current);
    if (!playing || activePlayerBusy || ui.moreMenuOpen || volumePanelOpen) return;
    hideControlsTimer.current = window.setTimeout(() => setControlsVisible(false), 1100);
  }, [activePlayerBusy, playing, ui.moreMenuOpen, volumePanelOpen]);

  useEffect(() => {
    revealControls();
    return () => {
      if (hideControlsTimer.current !== null) window.clearTimeout(hideControlsTimer.current);
    };
  }, [revealControls]);

  useEffect(() => {
    return () => {
      if (playerClickTimer.current !== null) window.clearTimeout(playerClickTimer.current);
      if (playerNoticeTimer.current !== null) window.clearTimeout(playerNoticeTimer.current);
    };
  }, []);

  const showPlayerNotice = useCallback((message: string, durationMs = 2400) => {
    setPlayerNotice(message);
    if (playerNoticeTimer.current !== null) window.clearTimeout(playerNoticeTimer.current);
    playerNoticeTimer.current = window.setTimeout(() => {
      setPlayerNotice(null);
      playerNoticeTimer.current = null;
    }, durationMs);
  }, []);

  // Attach hls.js to the overlay video when customSrc is set
  useEffect(() => {
    const video = customVideoRef.current;
    publicProgressRef.current = { timeMs: Date.now(), currentTime: 0, bufferedAhead: 0, readyState: 0 };

    const playbackIdentity = customSrc
      ? (() => {
          try {
            const url = new URL(customSrc, OBBY_COCKPIT);
            url.searchParams.delete("ow");
            url.searchParams.delete("owr");
            return url.toString();
          } catch {
            return customSrc;
          }
        })()
      : null;
    if (overlayPlaybackIdentity.current !== playbackIdentity) {
      overlayPlaybackIdentity.current = playbackIdentity;
      overlayReconnectAttempts.current = 0;
      overlayFatalSince.current = null;
    }

    // Destroy previous instance
    if (customHlsRef.current) {
      customHlsRef.current.destroy();
      customHlsRef.current = null;
    }

    if (!customSrc || !video) {
      setCustomPlayerBusy(false);
      return;
    }

    video.autoplay = true;
    video.controls = false;
    video.playsInline = true;
    video.volume = ui.volume;
    video.muted = ui.muted;
    setCustomPlayerBusy(true);

    const markBusy = () => setCustomPlayerBusy(true);
    let reconnectTimer: number | null = null;
    const markReady = () => {
      overlayFatalSince.current = null;
      overlayReconnectAttempts.current = 0;
      setCustomPlayerBusy(false);
    };
    const markFatal = () => {
      if (overlayFatalSince.current === null) overlayFatalSince.current = Date.now();
      publicProgressRef.current.timeMs = Date.now() - 8_000;
      setCustomPlayerBusy(true);
      if (reconnectTimer === null && overlayReconnectAttempts.current < 2) {
        const attempt = (overlayReconnectAttempts.current += 1);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          setCustomSrc((current) => current ? sourceWithCacheBust(current, `overlay-${Date.now()}-${attempt}`) : current);
        }, attempt === 1 ? 300 : 800);
      }
    };
    video.addEventListener("waiting", markBusy);
    video.addEventListener("stalled", markBusy);
    video.addEventListener("seeking", markBusy);
    video.addEventListener("error", markFatal);
    video.addEventListener("emptied", markFatal);
    video.addEventListener("canplay", markReady);
    video.addEventListener("playing", markReady);
    video.addEventListener("seeked", markReady);

    if (Hls.isSupported()) {
      const hls = new Hls({ ...createStableHlsConfig(), enableWorker: true, backBufferLength: 30 });
      customHlsRef.current = hls;
      hls.loadSource(customSrc);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setCustomPlayerBusy(false);
        void playWithMutedFallback(video);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          markFatal();
          hls.destroy();
          customHlsRef.current = null;
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = customSrc;
      video.load();
      void playWithMutedFallback(video);
    }

    return () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      video.removeEventListener("waiting", markBusy);
      video.removeEventListener("stalled", markBusy);
      video.removeEventListener("seeking", markBusy);
      video.removeEventListener("error", markFatal);
      video.removeEventListener("emptied", markFatal);
      video.removeEventListener("canplay", markReady);
      video.removeEventListener("playing", markReady);
      video.removeEventListener("seeked", markReady);
      if (customHlsRef.current) {
        customHlsRef.current.destroy();
        customHlsRef.current = null;
      }
      // Detach the media element so decoding stops cleanly when the overlay closes.
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [customSrc]);

  // Mute/pause hook video when custom source overlay is active
  useEffect(() => {
    const hookVideo = videoRef.current;
    if (!hookVideo) return;
    if (customSrc) {
      hookVideo.muted = true;
      hookVideo.pause();
    } else {
      hookVideo.muted = ui.muted;
      void hookVideo.play().catch(() => undefined);
    }
  }, [customSrc, ui.muted]);

  const primaryHealth = useCallback(() => {
    const degradedStates: LivePlaybackStatus[] = ["buffering", "reconnecting", "failed", "offline"];
    const degraded = degradedStates.includes(snapshot.status) || (snapshot.bufferAheadSeconds < 0.35 && snapshot.status !== "live");
    return {
      degraded,
      healthy:
        snapshot.status === "live" &&
        snapshot.bufferAheadSeconds >= 0.75 &&
        snapshot.liveLatencySeconds !== null &&
        snapshot.liveLatencySeconds <= Math.max(14, snapshot.targetDurationSeconds * 3),
    };
  }, [snapshot.bufferAheadSeconds, snapshot.liveLatencySeconds, snapshot.status, snapshot.targetDurationSeconds]);

  const publicHealth = useCallback(() => {
    const video = customVideoRef.current;
    if (!video || !customSrc) {
      return { degraded: true, healthy: false, ready: false };
    }

    const nowTimeMs = Date.now();
    const bufferedAhead =
      video.buffered.length > 0 ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime) : 0;
    const previous = publicProgressRef.current;
    const currentTimeAdvanced = video.currentTime > previous.currentTime + 0.2;
    const readyStateImproved = video.readyState > previous.readyState;

    if (currentTimeAdvanced || bufferedAhead > previous.bufferedAhead + 0.4 || readyStateImproved) {
      publicProgressRef.current = {
        timeMs: nowTimeMs,
        currentTime: video.currentTime,
        bufferedAhead,
        readyState: video.readyState,
      };
    }

    const stalledForMs = nowTimeMs - publicProgressRef.current.timeMs;
    const ready = video.readyState >= 2 || bufferedAhead > 0.25;
    const fatalForMs = overlayFatalSince.current ? nowTimeMs - overlayFatalSince.current : 0;
    const degraded = Boolean(video.error) || fatalForMs > 2500 || (ready && stalledForMs > 7000 && bufferedAhead < 0.4);
    const healthy = !degraded && (video.readyState >= 3 || bufferedAhead >= 1.25);
    return { degraded, healthy, ready };
  }, [customSrc]);

  const primaryHealthRef = useRef(primaryHealth);
  const publicHealthRef = useRef(publicHealth);
  useEffect(() => {
    primaryHealthRef.current = primaryHealth;
    publicHealthRef.current = publicHealth;
  });

  // Refresh pasted public source inventory from the cockpit. These are separate
  // from the official managed Server 1 source and always use proxied playback.
  useEffect(() => {
    async function fetchPublicSources() {
      let merged: PublicSource[] = [];
      try {
        const resp = await fetch(`${OBBY_COCKPIT}/api/public-streams`);
        const data = await resp.json() as { ok: boolean; sources?: PublicSource[] };
        if (data.ok && Array.isArray(data.sources)) {
          merged = data.sources.filter((source) => source.url && source.enabled !== false);
        }
      } catch {
        // Static file fallback below keeps the public switcher usable in local/dev.
      }
      try {
        const inventory = await fetch("/public-sources.json", { cache: "no-store" });
        if (inventory.ok) {
          const data = await inventory.json() as { sources?: PublicSource[] };
          for (const source of data.sources || []) {
            if (source?.url && source.enabled !== false && !merged.some((item) => item.url === source.url)) {
              merged.push(source);
            }
          }
        }
      } catch {
        // Static config below remains a final local fallback.
      }
      for (const source of streamConfig.publicSources.filter((source) => source.enabled)) {
        if (!merged.some((item) => item.url === source.url)) merged.push(source);
      }
      try {
        const resp = await fetch(`${OBBY_COCKPIT}/api/public-source`);
        const data = await resp.json() as { ok: boolean; sources: string[] };
        if (data.ok && data.sources?.length) {
          data.sources.forEach((raw, index) => {
            const url = raw.startsWith("/") ? `${OBBY_COCKPIT}${raw}` : raw;
            if (!merged.some((source) => source.url === url)) {
              merged.push({ id: `auto-public-${index + 1}`, label: `Auto public ${index + 1}`, url });
            }
          });
        }
      } catch {
        // Silently ignore: pasted public source inventory stays authoritative.
      }
      setPublicSources(merged);
    }
    void fetchPublicSources();
    const t = window.setInterval(fetchPublicSources, 3 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchConfiguredSources() {
      try {
        const resp = await fetch(`${OBBY_COCKPIT}/api/public-configured-sources`);
        const data = await resp.json() as { ok: boolean; sources: ConfiguredSource[]; viewers?: ViewerCounts };
        if (!cancelled && data.ok) {
          setConfiguredSources(Array.isArray(data.sources) ? publicCockpitSources(data.sources) : []);
          if (data.viewers) setViewerCounts(data.viewers);
        }
      } catch {
        // The primary stream remains usable if the cockpit metadata API is unavailable.
      }
    }

    void fetchConfiguredSources();
    const interval = window.setInterval(fetchConfiguredSources, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchWatcherNews() {
      try {
        const resp = await fetch(`${OBBY_COCKPIT}/api/news`, { cache: "no-store" });
        const data = await resp.json() as { ok: boolean; entries?: WatcherNewsEntry[] };
        if (!cancelled && data.ok) {
          setWatcherNews(Array.isArray(data.entries) ? data.entries : []);
        }
      } catch {
        // News is advisory; the stream UI should remain usable if the feed is unavailable.
      }
    }

    void fetchWatcherNews();
    const interval = window.setInterval(fetchWatcherNews, 3 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchHighscores() {
      try {
        const resp = await fetch(`${OBBY_COCKPIT}/api/highscores?limit=15`, { cache: "no-store" });
        const data = await resp.json();
        if (!cancelled && data.ok) setHighscores(data as HighscoreData);
      } catch {
        // Highscores are advisory; never block playback on them.
      }
    }
    void fetchHighscores();
    const interval = window.setInterval(fetchHighscores, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const events = new EventSource(`${OBBY_COCKPIT}/api/live`);
    events.addEventListener("status", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          ok: boolean;
          sources?: ConfiguredSource[];
          viewers?: ViewerCounts;
          news?: WatcherNewsEntry[];
        };
        if (!data.ok) return;
        if (Array.isArray(data.sources)) setConfiguredSources(publicCockpitSources(data.sources));
        if (data.viewers) setViewerCounts(data.viewers);
        if (Array.isArray(data.news)) setWatcherNews(data.news);
      } catch {
        // Ignore malformed live event payloads and wait for the next update.
      }
    });
    events.onerror = () => {
      // EventSource automatically reconnects; polling above remains the fallback.
    };
    return () => events.close();
  }, []);

  useEffect(() => {
    const sessionKey = "obbywatcher:viewer-session";
    let sessionId = window.localStorage.getItem(sessionKey);
    if (!sessionId) {
      sessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.localStorage.setItem(sessionKey, sessionId);
    }

    let cancelled = false;
    async function heartbeat() {
      if (cancelled || !sessionId) return;
      let bufferingMs = bufferAccumMsRef.current;
      if (bufferStartRef.current != null) {
        const nowTs = Date.now();
        bufferingMs += nowTs - bufferStartRef.current;
        bufferStartRef.current = nowTs; // keep counting an in-progress stall
      }
      bufferAccumMsRef.current = 0;
      const stalls = stallCountRef.current;
      stallCountRef.current = 0;
      const qoe = qoeSnapshotRef.current;
      const qoeReport = qoeDelta(qoe, {
        recoveryCount: lastRecoveryCountRef.current,
        droppedFrames: lastDroppedFramesRef.current
      });
      lastRecoveryCountRef.current = qoe.recoveryCount;
      lastDroppedFramesRef.current = qoe.droppedFrames;
      try {
        const resp = await fetch(`${OBBY_COCKPIT}/api/viewers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            source_id: activeSourceId,
            source_label: activeSourceLabel,
            page: window.location.href,
            playback: customSrc ? "overlay-hls" : activeSource.protocol,
            buffering_ms: Math.round(bufferingMs),
            stalls,
            ...qoeReport
          })
        });
        const data = await resp.json() as { ok: boolean; viewers?: ViewerCounts };
        if (data.ok && data.viewers) setViewerCounts(data.viewers);
      } catch {
        // Viewer counts are advisory; playback should never depend on this heartbeat.
      }
    }

    void heartbeat();
    const interval = window.setInterval(heartbeat, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeSource.protocol, activeSourceId, activeSourceLabel, customSrc]);

  // Load public source into overlay when autoMode switches to "public"
  useEffect(() => {
    if (autoMode === "public" && publicSources.length > 0) {
      const source = publicSources[publicSourceIdx % publicSources.length];
      const label = source.label || `Public ${publicSourceIdx + 1}`;
      showPlayerNotice(
        `Switched to ${label}${publicSources.length > 1 ? ` ${((publicSourceIdx % publicSources.length) + 1).toString()}/${publicSources.length.toString()}` : ""}`,
        2600
      );
      setOverlaySource({ kind: "public", id: publicSourceId(source, publicSourceIdx), label });
      setCustomSrc(publicPlaybackUrl(source)); // hls.js effect picks this up
    } else if (autoMode === "primary") {
      if (customSrc) showPlayerNotice("Back on primary source", 2200);
      setConfiguredSourceId(null);
      setOverlaySource(null);
      setCustomSrc(null);
    }
  }, [autoMode, customSrc, publicSourceIdx, publicSources, showPlayerNotice]);

  // Quality watchdog: detect bad active playback and rotate to the next healthy source.
  useEffect(() => {
    if (configuredSources.length === 0 && publicSources.length === 0) return;

    const tick = window.setInterval(() => {
      const now = Date.now();

      const primary = primaryHealthRef.current();
      const active = autoMode === "primary" ? primary : publicHealthRef.current();
      const failures = sourceFailuresRef.current;
      const configuredCandidates: CandidateSource[] = configuredSources.map((source) => ({
        id: source.id,
        label: source.label,
        kind: "configured",
        index: source.index,
        enabled: source.enabled && !source.preferred && source.state !== "disabled",
        preferred: source.preferred,
        tone: sourceTone(source),
        viewerCount: getViewerCount(viewerCounts, source.id, source.viewer_count),
        ...failures[source.id]
      }));
      const publicCandidates: CandidateSource[] = publicSources.map((source, index) => {
        const id = `public-${index}`;
        const probe = publicProbeState[id];
        return {
          id,
          label: source.label || `Public ${index + 1}`,
          kind: "public",
          index,
          enabled: source.enabled !== false,
          tone: probe?.tone ?? "yellow",
          viewerCount: getViewerCount(viewerCounts, publicSourceId(source, index), 0),
          ...failures[id]
        };
      });

      const noteFailure = (sourceId?: string) => {
        if (!sourceId) return;
        sourceFailuresRef.current = {
          ...sourceFailuresRef.current,
          [sourceId]: nextFailureRecord(sourceFailuresRef.current[sourceId], now, AUTO_SOURCE_COOLDOWN)
        };
      };

      const patchDecisionState = (decision: FallbackDecision) => {
        if (!decision.statePatch) return;
        if ("primaryBadSinceMs" in decision.statePatch) primaryBadSince.current = decision.statePatch.primaryBadSinceMs ?? null;
        if ("activeBadSinceMs" in decision.statePatch) publicBadSince.current = decision.statePatch.activeBadSinceMs ?? null;
        if ("primaryRecoveredSinceMs" in decision.statePatch) {
          primaryRecoveredSince.current = decision.statePatch.primaryRecoveredSinceMs ?? null;
        }
      };

      const switchConfigured = (source: ConfiguredSource, reason: string, failedSourceId?: string) => {
        noteFailure(failedSourceId);
        lastAutoSwitchAt.current = now;
        publicBadSince.current = null;
        primaryBadSince.current = null;
        primaryRecoveredSince.current = null;
        setPublicSourceIdx(0);
        setConfiguredSourceId(source.id);
        setOverlaySource({ kind: "configured", id: source.id, label: source.label });
        setAutoMode("configured");
        setCustomSrc(cockpitUrl(source.playback_url));
        setCustomSrcMsg(`${source.label} active`);
        showPlayerNotice(reason, 3000);
      };

      const switchPrimary = (reason: string, failedSourceId?: string) => {
        noteFailure(failedSourceId);
        lastAutoSwitchAt.current = now;
        publicBadSince.current = null;
        primaryBadSince.current = null;
        primaryRecoveredSince.current = null;
        setPublicSourceIdx(0);
        setConfiguredSourceId(null);
        setOverlaySource(null);
        setAutoMode("primary");
        setCustomSrc(null);
        setCustomSrcMsg(null);
        showPlayerNotice(reason, 2600);
      };

      const switchPublic = (index: number, reason: string, failedSourceId?: string) => {
        if (index < 0 || index >= publicSources.length) return false;
        noteFailure(failedSourceId);
        lastAutoSwitchAt.current = now;
        publicBadSince.current = null;
        primaryBadSince.current = null;
        primaryRecoveredSince.current = null;
        setConfiguredSourceId(null);
        setPublicSourceIdx(index);
        setAutoMode("public");
        showPlayerNotice(reason, 2600);
        return true;
      };

      const decision = decideAutoFallback(
        {
          mode: autoMode,
          publicIndex: publicSourceIdx,
          configuredId: configuredSourceId,
          nowMs: now,
          lastSwitchAtMs: lastAutoSwitchAt.current,
          primaryBadSinceMs: primaryBadSince.current,
          activeBadSinceMs: publicBadSince.current,
          primaryRecoveredSinceMs: primaryRecoveredSince.current
        },
        primary,
        active,
        configuredCandidates,
        publicCandidates,
        {
          switchDelayMs: AUTO_SWITCH_DELAY,
          returnDelayMs: AUTO_RETURN_DELAY,
          switchCooldownMs: AUTO_SWITCH_COOLDOWN,
          sourceCooldownMs: AUTO_SOURCE_COOLDOWN
        }
      );

      patchDecisionState(decision);
      if (decision.action === "stay") return;

      if (decision.action === "primary") {
        switchPrimary(decision.reason, decision.failedSourceId);
        return;
      }

      if (decision.action === "configured") {
        const source = configuredSources.find((item) => item.id === decision.id);
        if (source) switchConfigured(source, decision.reason, decision.failedSourceId);
        return;
      }

      if (decision.action === "public") {
        switchPublic(decision.index, decision.reason, decision.failedSourceId);
      }
    }, 1000);

    return () => window.clearInterval(tick);
  }, [
    AUTO_RETURN_DELAY,
    AUTO_SOURCE_COOLDOWN,
    AUTO_SWITCH_COOLDOWN,
    AUTO_SWITCH_DELAY,
    autoMode,
    configuredSourceId,
    configuredSources,
    publicProbeState,
    publicSourceIdx,
    publicSources,
    showPlayerNotice,
    viewerCounts,
  ]);

  // Probe public source independently so its dot stays current regardless of active mode
  useEffect(() => {
    if (publicSources.length === 0) {
      setPublicDotStatus("red");
      setPublicProbeState({});
      return;
    }

    let cancelled = false;
    const probe = async () => {
      const updates: Record<string, PublicProbeRecord> = {};
      await Promise.all(
        publicSources.map(async (source, index) => {
          const id = `public-${index}`;
          if (autoMode === "public" && index === publicSourceIdx) {
            const fallback = publicHealth();
            updates[id] = {
              tone: fallback.degraded ? "red" : fallback.healthy ? "green" : "yellow",
              checkedAtMs: Date.now(),
              reason: fallback.degraded ? "active playback degraded" : fallback.healthy ? "active playback healthy" : "active playback warming up"
            };
            return;
          }

          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 6500);
          try {
            updates[id] = await probePublicPlaybackUrl(publicPlaybackUrl(source), controller.signal);
          } catch (error) {
            updates[id] = {
              tone: "red",
              checkedAtMs: Date.now(),
              reason: error instanceof Error ? error.message : "probe failed"
            };
          } finally {
            window.clearTimeout(timeout);
          }
        })
      );

      if (cancelled) return;
      setPublicProbeState((current) => ({ ...current, ...updates }));
      const active = updates[`public-${publicSourceIdx}`];
      if (active) {
        setPublicDotStatus(active.tone);
      }
    };
    void probe();
    const id = window.setInterval(() => void probe(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [autoMode, publicHealth, publicSources, publicSourceIdx]);

  const watchCustomSource = useCallback(async (url: string) => {
    setCustomSrcBusy(true);
    setCustomSrcMsg(null);
      try {
        primaryBadSince.current = null;
        publicBadSince.current = null;
        primaryRecoveredSince.current = null;
      setAutoMode("custom");
      setConfiguredSourceId(null);
      setOverlaySource({ kind: "custom", id: "custom", label: "Custom source" });
      const isDirectStream = url.split("?")[0].endsWith(".m3u8") || url.includes("load-playlist");
      let streamUrl = url;
      if (!isDirectStream) {
        const resp = await fetch(`${OBBY_COCKPIT}/api/scrape`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = await resp.json() as { ok: boolean; links: string[]; count: number };
        if (!data.ok || !data.links?.length) {
          setCustomSrcMsg("No streams found — try a direct stream URL");
          return;
        }
        streamUrl = data.links[0];
      }
      const proxied = `${OBBY_COCKPIT}/api/proxy-hls?url=${encodeURIComponent(streamUrl)}`;
      setCustomSrc(proxied); // hls.js effect handles loading
      setCustomSrcMsg("Custom source active");
      showPlayerNotice("Custom source loaded", 2200);
    } catch {
      setCustomSrcMsg("Failed to load source — check the URL");
      showPlayerNotice("Failed to load source", 2800);
    } finally {
      setCustomSrcBusy(false);
    }
  }, [showPlayerNotice]);

  const clearCustomSource = useCallback(() => {
    if (autoMode !== "primary") {
      primaryBadSince.current = null;
      publicBadSince.current = null;
      primaryRecoveredSince.current = null;
      setPublicSourceIdx(0);
      setAutoMode("primary");
    }
    setConfiguredSourceId(null);
    setOverlaySource(null);
    setCustomSrc(null);
    setCustomSrcMsg(null);
    setScInput("");
    // hls.js cleanup is handled in the customSrc effect
  }, [autoMode]);

  const returnToPrimaryPlayback = useCallback(() => {
    const { ["server-1"]: _server1, ...remainingFailures } = sourceFailuresRef.current;
    sourceFailuresRef.current = remainingFailures;
    primaryBadSince.current = null;
    publicBadSince.current = null;
    primaryRecoveredSince.current = null;
    setPublicSourceIdx(0);
    setAutoMode("primary");
    setConfiguredSourceId(null);
    setOverlaySource(null);
    setCustomSrc(null);
    setCustomSrcMsg(null);
    showPlayerNotice("Back on primary source", 2200);
  }, [showPlayerNotice]);

  const switchToPublicSource = useCallback((index: number) => {
    if (index < 0 || index >= publicSources.length) return;
    const { [`public-${index}`]: _publicSource, ...remainingFailures } = sourceFailuresRef.current;
    sourceFailuresRef.current = remainingFailures;
    primaryBadSince.current = null;
    publicBadSince.current = null;
    primaryRecoveredSince.current = null;
    setCustomSrcMsg(null);
    setPublicSourceIdx(index);
    setAutoMode("public");
    setConfiguredSourceId(null);
    showPlayerNotice(`Switched to public ${index + 1}`, 2200);
  }, [publicSources.length, showPlayerNotice]);

  const switchToConfiguredSource = useCallback((source: ConfiguredSource) => {
    const { [source.id]: _configuredSource, ...remainingFailures } = sourceFailuresRef.current;
    sourceFailuresRef.current = remainingFailures;
    primaryBadSince.current = null;
    publicBadSince.current = null;
    primaryRecoveredSince.current = null;
    setPublicSourceIdx(0);
    setCustomSrcMsg(null);

    if (source.preferred || source.playback_url === "/hls/ufc.m3u8") {
      setConfiguredSourceId(null);
      setOverlaySource(null);
      setAutoMode("primary");
      setCustomSrc(null);
      showPlayerNotice("Back on Server 1 / Default", 2200);
      return;
    }

    setConfiguredSourceId(source.id);
    setOverlaySource({ kind: "configured", id: source.id, label: source.label });
    setAutoMode("configured");
    setCustomSrc(cockpitUrl(source.playback_url));
    setCustomSrcMsg(`${source.label} active`);
    showPlayerNotice(`Switched to ${source.label}`, 2400);
  }, [showPlayerNotice]);

  const seekActiveToLive = useCallback(() => {
    const video = customSrc ? customVideoRef.current : videoRef.current;
    if (!video) return;
    if (customSrc) {
      if (video.seekable.length > 0) {
        const liveEdge = video.seekable.end(video.seekable.length - 1);
        // Overlay sources have no parsed target duration here, so use the same
        // two-segment default the managed player lands on.
        video.currentTime = Math.max(0, liveEdge - liveEdgeBackoffSeconds(0));
      }
      void video.play().catch(() => undefined);
      return;
    }
    seekToLive();
  }, [customSrc, seekToLive]);

  const reloadActivePlayback = useCallback(() => {
    if (!customSrc) {
      retryNow();
      return;
    }
    customReloadNonce.current += 1;
    const stamp = customReloadNonce.current;
    setCustomSrc((current) => {
      if (!current) return current;
      return sourceWithCacheBust(current, `manual-${Date.now()}-${stamp}`);
    });
  }, [customSrc, retryNow]);

  const copyText = useCallback((label: string, value: string) => {
    if (!navigator.clipboard?.writeText) {
      window.prompt(label, value);
      return;
    }

    void navigator.clipboard.writeText(value).then(
      () => {
        setNotice(`${label} copied`);
        window.setTimeout(() => setNotice(streamConfig.schedule), 1800);
      },
      () => {
        window.prompt(label, value);
      }
    );
  }, []);

  const togglePlayback = useCallback(async () => {
    const video = customSrc ? customVideoRef.current : videoRef.current;
    if (!video) return;

    if (video.paused || video.ended) {
      try {
        await video.play();
      } catch {
        if (customSrc) {
          video.muted = false;
          if (video.volume === 0) video.volume = ui.volume || 1;
          await video.play().catch(() => undefined);
        } else {
          await enableAudio();
        }
      }
      return;
    }

    video.pause();
  }, [customSrc, enableAudio, ui.volume]);

  const setVolume = useCallback((volume: number) => {
    const nextVolume = clampVolume(volume);
    dispatch({ type: "set-volume", volume: nextVolume });
    for (const video of [videoRef.current, customVideoRef.current]) {
      if (!video) continue;
      video.volume = nextVolume;
      video.muted = nextVolume <= 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = !ui.muted;
    dispatch({ type: "set-muted", muted: nextMuted });
    for (const video of [videoRef.current, customVideoRef.current]) {
      if (!video) continue;
      video.muted = nextMuted;
      if (!nextMuted && video.volume === 0) {
        video.volume = ui.volume || 1;
      }
    }
  }, [ui.muted, ui.volume]);

  const toggleFullscreen = useCallback(async () => {
    const shell = playerShellRef.current;
    const video = (customSrc ? customVideoRef.current : videoRef.current) as WebKitFullscreenVideo | null;
    if (!shell) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    if (isWebKitFullscreen(video)) {
      if (exitWebKitFullscreen(video)) setFullscreen(false);
      return;
    }

    if (document.fullscreenEnabled !== false && shell.requestFullscreen) {
      try {
        await shell.requestFullscreen();
        return;
      } catch {
        // iOS Safari may reject element fullscreen while still allowing video fullscreen below.
      }
    }

    if (enterWebKitFullscreen(video)) setFullscreen(true);
  }, [customSrc]);

  const clearPlayerClickTimer = useCallback(() => {
    if (playerClickTimer.current === null) return;
    window.clearTimeout(playerClickTimer.current);
    playerClickTimer.current = null;
  }, []);

  const toggleFullscreenFromSurface = useCallback(() => {
    const now = Date.now();
    if (now - lastFullscreenToggleAt.current < 80) return;
    lastFullscreenToggleAt.current = now;
    clearPlayerClickTimer();
    void toggleFullscreen();
  }, [clearPlayerClickTimer, toggleFullscreen]);

  const handlePlayerSurfaceClick = useCallback(
    (event: MouseEvent<HTMLVideoElement>) => {
      const now = Date.now();
      const previous = lastPlayerSurfaceClick.current;
      const distance = previous
        ? Math.hypot(event.clientX - previous.x, event.clientY - previous.y)
        : Number.POSITIVE_INFINITY;
      const isDoubleClick = event.detail > 1 || (previous !== null && now - previous.time < 320 && distance < 48);

      if (isDoubleClick) {
        event.preventDefault();
        lastPlayerSurfaceClick.current = null;
        toggleFullscreenFromSurface();
        return;
      }

      lastPlayerSurfaceClick.current = { time: now, x: event.clientX, y: event.clientY };
      clearPlayerClickTimer();
      playerClickTimer.current = window.setTimeout(() => {
        playerClickTimer.current = null;
        lastPlayerSurfaceClick.current = null;
        void togglePlayback();
      }, 300);
    },
    [clearPlayerClickTimer, toggleFullscreenFromSurface, togglePlayback]
  );

  const handlePlayerSurfaceDoubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button,a,input,[data-custom-select],.more-menu,.audio-prompt")
      ) {
        return;
      }

      event.preventDefault();
      toggleFullscreenFromSurface();
    },
    [toggleFullscreenFromSurface]
  );

  const togglePictureInPicture = useCallback(async () => {
    const pipDocument = document as PictureInPictureDocument;
    const video = (customSrc ? customVideoRef.current : videoRef.current) as PictureInPictureVideo | null;
    if (!video || !pipDocument.pictureInPictureEnabled || !video.requestPictureInPicture) return;

    if (pipDocument.pictureInPictureElement && pipDocument.exitPictureInPicture) {
      await pipDocument.exitPictureInPicture();
      return;
    }

    await video.requestPictureInPicture();
  }, [customSrc]);

  const startCasting = useCallback(async () => {
    if (!window.cast?.framework || !window.chrome?.cast) return;
    setCastStatus("connecting");
    try {
      const context = window.cast.framework.CastContext.getInstance();
      context.setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
      });
      const session = context.getCurrentSession() ?? (await context.requestSession());
      const mediaInfo = new window.chrome.cast.media.MediaInfo(activePlaybackUrl, castContentType(activePlaybackProtocol));
      mediaInfo.streamType = window.chrome.cast.media.StreamType.LIVE;
      mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata();
      mediaInfo.metadata.title = streamConfig.title;
      mediaInfo.metadata.subtitle = `${activePlaybackProtocol.toUpperCase()} via ${activePlaybackHost}`;
      const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
      await session.loadMedia(request);
      setCastStatus("casting");
    } catch {
      if (activePlaybackProtocol === "dash") {
        try {
          const context = window.cast.framework.CastContext.getInstance();
          const session = context.getCurrentSession() ?? (await context.requestSession());
          const mediaInfo = new window.chrome.cast.media.MediaInfo(activeMirror.hlsUrl, castContentType("hls"));
          mediaInfo.streamType = window.chrome.cast.media.StreamType.LIVE;
          mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata();
          mediaInfo.metadata.title = streamConfig.title;
          mediaInfo.metadata.subtitle = `HLS fallback via ${activeMirror.host}`;
          await session.loadMedia(new window.chrome.cast.media.LoadRequest(mediaInfo));
          setCastStatus("casting");
          return;
        } catch {
          // Fall through to failed status below.
        }
      }
      setCastStatus("failed");
    }
  }, [activeMirror.hlsUrl, activeMirror.host, activePlaybackHost, activePlaybackProtocol, activePlaybackUrl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      switch (event.key.toLowerCase()) {
        case " ":
          event.preventDefault();
          void togglePlayback();
          break;
        case "m":
          event.preventDefault();
          toggleMute();
          break;
        case "f":
          event.preventDefault();
          void toggleFullscreen();
          break;
        case "p":
          event.preventDefault();
          void togglePictureInPicture();
          break;
        case "r":
          event.preventDefault();
          if (event.shiftKey) {
            hardReconnect();
          } else {
            retryNow();
          }
          break;
        case "escape":
          dispatch({ type: "set-more", open: false });
          setOpenDropdown(null);
          setVolumePanelOpen(false);
          break;
        case "arrowup":
          event.preventDefault();
          setVolume(ui.volume + 0.05);
          break;
        case "arrowdown":
          event.preventDefault();
          setVolume(ui.volume - 0.05);
          break;
        case "arrowright":
          event.preventDefault();
          seekActiveToLive();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    hardReconnect,
    retryNow,
    seekActiveToLive,
    setVolume,
    toggleFullscreen,
    toggleMute,
    togglePictureInPicture,
    togglePlayback,
    ui.volume
  ]);

  const copyStreamUrl = () => copyText("Stream URL", activePlaybackUrl);
  const copyVlcCommand = () => copyText("VLC command", `vlc ${activePlaybackUrl}`);
  const copyMpvCommand = () => copyText("MPV command", `mpv ${activePlaybackUrl}`);
  const toggleVolumePanel = () => {
    setOpenDropdown(null);
    dispatch({ type: "set-more", open: false });
    setVolumePanelOpen((open) => !open);
  };
  const toggleVolumePanelFromPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    toggleVolumePanel();
  };
  const toggleVolumePanelFromClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail !== 0) return;
    toggleVolumePanel();
  };
  const toggleMoreMenu = () => {
    setVolumePanelOpen(false);
    dispatch({ type: "toggle-more" });
  };

  const playbackProtocolLabel = activePlaybackProtocol.toUpperCase();
  const playbackHostLabel = customSrc ? activeSourceLabel : activePlaybackHost;
  const showCenterPlay = !playing && !activePlayerBusy;
  const showCenterNotice = Boolean(playerNotice) || activePlayerBusy;
  const centerNoticeText = playerNotice ?? activeStatus;

  const playerClass = [
    "player-shell",
    controlsVisible || !playing || activePlayerBusy || ui.moreMenuOpen || volumePanelOpen
      ? "controls-visible"
      : "controls-hidden",
    fullscreen ? "is-fullscreen" : "",
    snapshot.autoplayBlocked ? "needs-audio" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="app-shell" data-theme={themeId}>
      <header className="topbar">
        <a className="brand" href={streamConfig.canonicalUrl} aria-label="ObbyWatcher home">
          <span className="brand-mark" aria-hidden="true">
            OW
          </span>
          <span>
            <strong>{streamConfig.appName}</strong>
            <small>{notice}</small>
          </span>
        </a>

        <nav className="top-actions" aria-label="Stream links">
          <div className="theme-picker custom-select" data-custom-select>
            <span className="custom-select-label">Theme</span>
            <button
              className="custom-select-trigger"
              type="button"
              aria-label="Theme"
              aria-haspopup="listbox"
              aria-expanded={openDropdown === "theme"}
              onClick={() => {
                setOpenDropdown((current) => (current === "theme" ? null : "theme"));
              }}
            >
              <span>{activeTheme.label}</span>
              <span className="custom-select-chevron" aria-hidden="true" />
            </button>
            {openDropdown === "theme" ? (
              <div className="custom-select-menu theme-menu" role="listbox" aria-label="Theme">
                {themeOptions.map((theme) => (
                  <button
                    className={theme.id === themeId ? "custom-select-option selected" : "custom-select-option"}
                    type="button"
                    role="option"
                    aria-selected={theme.id === themeId}
                    key={theme.id}
                    onClick={() => {
                      setThemeId(theme.id);
                      setOpenDropdown(null);
                    }}
                  >
                    <span className={`theme-dot theme-dot-${theme.id}`} aria-hidden="true" />
                    <span>{theme.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <a className="chip chip-live" href={activeSource.url} target="_blank" rel="noreferrer">
            Open {activeSource.protocol.toUpperCase()}
          </a>
          <a className="chip chip-discord" href={streamConfig.discordUrl} target="_blank" rel="noreferrer">
            Discord
          </a>
          <a className="chip" href={streamConfig.chatUrl} target="_blank" rel="noreferrer">
            Chat
          </a>
          <span className="viewer-chip" title="Live viewers reported by s.obby.ca">
            {totalViewers} watching
          </span>
        </nav>
      </header>

      <main className="page-layout">
        <section className="watch-row">
          <section className="watch" aria-label="Live stream">
            <div className="watch-titlebar">
              <div>
                <p className="kicker">Live fight signal</p>
                <h1>{streamConfig.title}</h1>
              </div>

              <div className={`status-badge status-${activePlaybackStatus}`}>
                <span aria-hidden="true" />
                {activeStatus}
              </div>
            </div>

            <div className="player-source-switcher" aria-label="Playback source">
              {configuredSources.length > 0 ? (
                configuredSources.map((source) => {
                  const active = source.preferred ? autoMode === "primary" : autoMode === "configured" && configuredSourceId === source.id;
                  const viewers = getViewerCount(viewerCounts, source.id, source.viewer_count);
                  return (
                    <button
                      className={active ? "source-button active" : "source-button"}
                      type="button"
                      key={source.id}
                      onClick={() => switchToConfiguredSource(source)}
                      title={`${source.label}: ${source.state}`}
                    >
                      <span
                        className={`source-dot source-dot-${configuredSourceTone(source, primaryDot)}`}
                        aria-hidden="true"
                      />
                      <strong>{source.label}</strong>
                      <small>{viewers} watching</small>
                    </button>
                  );
                })
              ) : (
                <button
                  className={!customSrc ? "source-button active" : "source-button"}
                  type="button"
                  onClick={returnToPrimaryPlayback}
                >
                  <span className={`source-dot source-dot-${primaryDot}`} aria-hidden="true" />
                  <strong>Server 1 / Default</strong>
                  <small>{totalViewers} watching</small>
                </button>
              )}
              {publicSources.map((source, index) => {
                const active = autoMode === "public" && publicSourceIdx === index;
                const probe = publicProbeState[`public-${index}`];
                const tone = active ? publicDotStatus : probe?.tone ?? "yellow";
                const reason = probe?.reason ?? "probe pending";
                const viewers = getViewerCount(viewerCounts, publicSourceId(source, index), 0);
                return (
                  <button
                    className={active ? "source-button active" : "source-button"}
                    type="button"
                    key={source.id || `public-source-${index}`}
                    onClick={() => switchToPublicSource(index)}
                    title={`${source.label || `Public ${index + 1}`}: ${reason}`}
                    >
                    <span className={`source-dot source-dot-${tone}`} aria-hidden="true" />
                    <strong>{source.label || `Public ${index + 1}`}</strong>
                    <small>{viewers} watching</small>
                  </button>
                );
              })}
            </div>

            <div
              ref={playerShellRef}
              className={playerClass}
              onMouseMove={revealControls}
              onPointerDown={revealControls}
              onFocus={revealControls}
              onDoubleClick={handlePlayerSurfaceDoubleClick}
            >
              <video
                ref={videoRef}
                className="player"
                autoPlay
                playsInline
                preload="auto"
                poster={streamConfig.imageUrl}
                onClick={handlePlayerSurfaceClick}
              />
              {customSrc ? (
                <video
                  ref={customVideoRef}
                  className="player custom-src-overlay"
                  playsInline
                  preload="auto"
                  poster={streamConfig.imageUrl}
                  onClick={handlePlayerSurfaceClick}
                />
              ) : null}

              <div className="player-topline">
                <span className={`signal-pill signal-${activePlaybackStatus}`}>{activeStatus}</span>
                {overlaySource ? (
                  <span className="signal-pill signal-public">
                    {overlaySource.label}
                  </span>
                ) : null}
                {customSrc ? (
                  <button className="button button-small topline-action" type="button" onClick={returnToPrimaryPlayback}>
                    Back to primary
                  </button>
                ) : null}
                <span>{playbackProtocolLabel} · {playbackHostLabel}</span>
                <span>{totalViewers} watching</span>
                <span>{formatSignedSeconds(activeLiveLatencySeconds)} behind</span>
              </div>

              {showCenterPlay ? (
                <button className="center-play" type="button" onClick={() => void togglePlayback()}>
                  Play
                </button>
              ) : null}

              {showCenterNotice ? (
                <div className="player-notice" role="status" aria-live="polite">
                  {centerNoticeText}
                </div>
              ) : null}

              {snapshot.autoplayBlocked ? (
                <div className="audio-prompt" role="status">
                  <strong>Sound needs one click</strong>
                  <span>Browser policy blocked unmuted autoplay.</span>
                  <button className="button button-primary" type="button" onClick={() => void enableAudio()}>
                    Enable sound
                  </button>
                </div>
              ) : null}

              <div className="player-controls" aria-label="Player controls">
                <div className="timeline-row">
                  <button className="live-chip" type="button" onClick={seekActiveToLive} aria-label="Go live">
                    <span aria-hidden="true" />
                    LIVE
                  </button>
                  <div className="timeline-track" aria-label="Live edge">
                    <span className="timeline-fill" style={{ width: `${liveProgressPercent}%` }} />
                    <span className="timeline-thumb" style={{ left: `${liveProgressPercent}%` }} />
                  </div>
                  <span className="latency-readout">{formatSignedSeconds(activeLiveLatencySeconds)} behind</span>
                </div>

                <div className="control-bar">
                  <div className="control-left">
                    <button
                      className="player-icon-button primary-control"
                      type="button"
                      onClick={() => void togglePlayback()}
                      aria-label={playing ? "Pause" : "Play"}
                      title={playing ? "Pause" : "Play"}
                    >
                      <PlayerIcon name={playing ? "pause" : "play"} />
                    </button>

                    <div
                      className={volumePanelOpen ? "volume-cluster volume-open" : "volume-cluster"}
                      data-volume-control
                    >
                      <button
                        className={volumePanelOpen ? "player-icon-button volume-toggle active" : "player-icon-button volume-toggle"}
                        type="button"
                        onPointerDown={toggleVolumePanelFromPointer}
                        onClick={toggleVolumePanelFromClick}
                        aria-expanded={volumePanelOpen}
                        aria-controls="volume-panel"
                        aria-label="Volume"
                        title="Volume"
                      >
                        <PlayerIcon name={ui.muted ? "muted" : "volume"} />
                      </button>
                      {volumePanelOpen ? (
                        <div className="volume-panel" id="volume-panel" role="group" aria-label="Volume controls">
                          <button
                            className="volume-mute-button"
                            type="button"
                            onClick={toggleMute}
                            aria-label={ui.muted ? "Unmute" : "Mute"}
                          >
                            <PlayerIcon name={ui.muted ? "muted" : "volume"} />
                            <span>{ui.muted ? "Unmute" : "Mute"}</span>
                          </button>
                          <div className="volume-slider-row">
                            <input
                              aria-label="Volume"
                              type="range"
                              min="0"
                              max="1"
                              step="0.01"
                              value={ui.muted ? 0 : ui.volume}
                              onChange={(event) => setVolume(Number(event.currentTarget.value))}
                            />
                            <span>{Math.round((ui.muted ? 0 : ui.volume) * 100)}%</span>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <span className="control-readout">
                      Live stream · {formatSignedSeconds(activeBufferAheadSeconds)} buffer
                    </span>

                    <div className="source-dots" aria-label="Source status">
                      {configuredSources.length > 0 ? (
                        configuredSources.map((source) => {
                          const active = source.preferred ? autoMode === "primary" : autoMode === "configured" && configuredSourceId === source.id;
                          return (
                            <span
                              className={`source-dot source-dot-${configuredSourceTone(source, primaryDot)}${active ? " source-dot-active" : ""}`}
                              title={`${source.label}: ${source.state} · ${getViewerCount(viewerCounts, source.id, source.viewer_count)} watching`}
                              aria-label={`${source.label} ${source.state}`}
                              key={`dot-${source.id}`}
                            />
                          );
                        })
                      ) : (
                        <span
                          className={`source-dot source-dot-${primaryDot}${autoMode === "primary" ? " source-dot-active" : ""}`}
                          title={`Server 1 / Default: ${snapshot.status}`}
                          aria-label={`Server 1 source ${snapshot.status}`}
                        />
                      )}
                      {publicSources.map((source, index) => {
                        const active = autoMode === "public" && publicSourceIdx === index;
                        const probe = publicProbeState[`public-${index}`];
                        const tone = active ? publicDotStatus : probe?.tone ?? "yellow";
                        const label = source.label || `Public ${index + 1}`;
                        const viewers = getViewerCount(viewerCounts, publicSourceId(source, index), 0);
                        return (
                          <span
                            className={`source-dot source-dot-${tone}${active ? " source-dot-active" : ""}`}
                            title={`${label}: ${probe?.reason ?? tone} · ${viewers} watching`}
                            aria-label={`${label} ${tone} ${viewers} watching`}
                            key={`dot-public-${publicSourceId(source, index)}`}
                          />
                        );
                      })}
                    </div>
                  </div>

                  <div className="control-right">
                    <button
                      className={castStatus === "casting" ? "player-icon-button active" : "player-icon-button"}
                      type="button"
                      onClick={() => void startCasting()}
                      disabled={!castAvailable}
                      aria-label={castStatus === "casting" ? "Casting" : "Cast"}
                      title={castAvailable ? "Cast" : "Cast unavailable"}
                    >
                      <PlayerIcon name="cast" />
                    </button>
                    <button
                      className="player-icon-button"
                      type="button"
                      onClick={reloadActivePlayback}
                      aria-label="Retry"
                      title="Retry"
                    >
                      <PlayerIcon name="retry" />
                    </button>
                    <button
                      className={ui.moreMenuOpen ? "player-icon-button active" : "player-icon-button"}
                      type="button"
                      onClick={toggleMoreMenu}
                      aria-expanded={ui.moreMenuOpen}
                      aria-label="More"
                      title="More"
                    >
                      <PlayerIcon name="settings" />
                    </button>
                    <button
                      className="player-icon-button"
                      type="button"
                      onClick={() => void togglePictureInPicture()}
                      aria-label={pictureInPicture ? "Close PiP" : "PiP"}
                      title={pictureInPicture ? "Close PiP" : "PiP"}
                    >
                      <PlayerIcon name="pip" />
                    </button>
                    <button
                      className="player-icon-button"
                      type="button"
                      onClick={() => void toggleFullscreen()}
                      aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                      title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                    >
                      <PlayerIcon name="fullscreen" />
                    </button>
                  </div>
                </div>

              </div>

              {ui.moreMenuOpen ? (
                <div className="more-menu" role="menu">
                  <div className="menu-field custom-select mirror-select-control" data-custom-select>
                    <span className="custom-select-label">Mirror</span>
                    <button
                      className="custom-select-trigger"
                      type="button"
                      aria-label="Mirror"
                      aria-haspopup="listbox"
                      aria-expanded={openDropdown === "mirror"}
                      onClick={() => {
                        setOpenDropdown((current) => (current === "mirror" ? null : "mirror"));
                      }}
                    >
                      <span>
                        {activeMirror.label} - {activeMirror.host}
                      </span>
                      <span className="custom-select-chevron" aria-hidden="true" />
                    </button>
                    {openDropdown === "mirror" ? (
                      <div className="custom-select-menu mirror-menu" role="listbox" aria-label="Mirror">
                        {streamConfig.mirrors.map((mirror, index) => (
                          <button
                            className={
                              index === snapshot.activeMirrorIndex
                                ? "custom-select-option selected"
                                : "custom-select-option"
                            }
                            type="button"
                            role="option"
                            aria-selected={index === snapshot.activeMirrorIndex}
                            key={mirror.id}
                            onClick={() => {
                              switchMirror(index);
                              setOpenDropdown(null);
                            }}
                          >
                            <span>{mirror.label}</span>
                            <small>{mirror.host}</small>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="menu-field custom-select protocol-select-control" data-custom-select>
                    <span className="custom-select-label">Protocol</span>
                    <button
                      className="custom-select-trigger"
                      type="button"
                      aria-label="Protocol"
                      aria-haspopup="listbox"
                      aria-expanded={openDropdown === "protocol"}
                      disabled={overlayActive}
                      onClick={() => {
                        setOpenDropdown((current) => (current === "protocol" ? null : "protocol"));
                      }}
                    >
                      <span>{activeSource.protocol.toUpperCase()}</span>
                      <span className="custom-select-chevron" aria-hidden="true" />
                    </button>
                    {openDropdown === "protocol" ? (
                      <div className="custom-select-menu mirror-menu" role="listbox" aria-label="Protocol">
                        {(["dash", "hls"] as const).map((protocol) => (
                          <button
                            className={protocol === activeSource.protocol ? "custom-select-option selected" : "custom-select-option"}
                            type="button"
                            role="option"
                            aria-selected={protocol === activeSource.protocol}
                            key={protocol}
                            onClick={() => {
                              switchProtocol(protocol);
                              setOpenDropdown(null);
                            }}
                          >
                            <span>{protocol.toUpperCase()}</span>
                            <small>{protocol === "dash" ? "Shaka MPEG-DASH" : "HLS native/hls.js"}</small>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="menu-actions">
                    <button className="button" type="button" onClick={hardReconnect}>
                      Hard reconnect
                    </button>
                    {publicSources.length > 0 && autoMode === "primary" ? (
                      <button className="button" type="button" onClick={() => { primaryBadSince.current = null; setAutoMode("public"); }}>
                        Use public src
                      </button>
                    ) : null}
                    {customSrc ? (
                      <button className="button" type="button" onClick={returnToPrimaryPlayback}>
                        Back to primary
                      </button>
                    ) : null}
                    <button className="button" type="button" onClick={copyStreamUrl}>
                      Copy {activeSource.protocol.toUpperCase()}
                    </button>
                    <button className="button" type="button" onClick={copyVlcCommand}>
                      Copy VLC
                    </button>
                    <button className="button" type="button" onClick={copyMpvCommand}>
                      Copy MPV
                    </button>
                    <button className="button" type="button" onClick={() => dispatch({ type: "toggle-stats" })}>
                      {ui.statsOpen ? "Hide stats" : "Show stats"}
                    </button>
                  </div>

                  <form
                    className="source-changer-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const url = scInput.trim();
                      if (!url) return;
                      void watchCustomSource(url);
                    }}
                  >
                    <span className="menu-field-label">Custom source</span>
                    <div className="source-changer-row">
                      <input
                        className="source-changer-input"
                        type="url"
                        value={scInput}
                        onChange={(e) => setScInput(e.target.value)}
                        placeholder="SportSurge or stream URL"
                        disabled={customSrcBusy}
                      />
                      <button className="button" type="submit" disabled={customSrcBusy || !scInput.trim()}>
                        {customSrcBusy ? "Loading…" : "Watch"}
                      </button>
                      {customSrc ? (
                        <button className="button button-danger" type="button" onClick={clearCustomSource}>
                          Stop
                        </button>
                      ) : null}
                    </div>
                    {customSrcMsg ? <span className="source-changer-msg">{customSrcMsg}</span> : null}
                  </form>

                  {ui.statsOpen ? (
                    <div className="menu-stats" aria-label="Advanced diagnostics">
                      <div>
                        <span>Mode</span>
                        <strong>{snapshot.activeProtocol.toUpperCase()} / {snapshot.mode}</strong>
                      </div>
                      <div>
                        <span>Latency</span>
                        <strong>{formatSignedSeconds(snapshot.liveLatencySeconds)}</strong>
                      </div>
                      <div>
                        <span>Sequence</span>
                        <strong>{snapshot.currentSequence ?? "--"}</strong>
                      </div>
                      <div>
                        <span>Target</span>
                        <strong>{formatDuration(snapshot.targetDurationSeconds)}</strong>
                      </div>
                      <div>
                        <span>Frames</span>
                        <strong>
                          {snapshot.decodedFrames ?? "--"} / {snapshot.droppedFrames ?? "--"}
                        </strong>
                      </div>
                      <div>
                        <span>Retry</span>
                        <strong>{retryEta(snapshot.nextRetryAtMs)}</strong>
                      </div>
                      <div>
                        <span>Cast</span>
                        <strong>{castAvailable ? castStatus : "unavailable"}</strong>
                      </div>
                      <div>
                        <span>Viewers</span>
                        <strong>{totalViewers}</strong>
                      </div>
                      <div>
                        <span>Source</span>
                        <strong>{activeSourceLabel}</strong>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="signal-strip" aria-label="Playback health">
              <div>
                <span>Mode</span>
                <strong>{snapshot.activeProtocol.toUpperCase()} / {snapshot.mode}</strong>
              </div>
              <div>
                <span>Buffer</span>
                <strong>{formatSignedSeconds(snapshot.bufferAheadSeconds)}</strong>
              </div>
              <div>
                <span>Recoveries</span>
                <strong>{snapshot.recoveryCount}</strong>
              </div>
              <div>
                <span>Segment</span>
                <strong>{relativeTime(snapshot.lastSegmentAtMs)}</strong>
              </div>
              <div>
                <span>Viewers</span>
                <strong>{totalViewers}</strong>
              </div>
            </div>

            {snapshot.lastError ? <p className="status-note">{snapshot.lastError}</p> : null}
          </section>

          <aside className="chat-panel" aria-label="Chat">
            <div className="panel-heading">
              <h2>Chat</h2>
              <a className="button button-small" href={streamConfig.chatUrl} target="_blank" rel="noreferrer">
                Pop out
              </a>
            </div>
            <iframe title="Chat" src={streamConfig.chatUrl} loading="lazy" referrerPolicy="no-referrer" />
          </aside>
        </section>

        {watcherNews.length > 0 ? (
          <section className="news-panel" aria-label="Stream news">
            <div className="panel-heading">
              <div>
                <p className="kicker">Updates</p>
                <h2>Stream news</h2>
              </div>
              <span>{watcherNews.length} item{watcherNews.length === 1 ? "" : "s"}</span>
            </div>
            <div className="news-list">
              {watcherNews.map((entry) => (
                <article className={`news-card news-card-${entry.tone || "info"}${entry.pinned ? " news-card-pinned" : ""}`} key={entry.id}>
                  <div className="news-card-top">
                    <strong>{entry.title || "Update"}</strong>
                    <span>{entry.pinned ? "Pinned" : entry.tone || "Info"}</span>
                  </div>
                  {entry.body ? <p>{entry.body}</p> : null}
                  <div className="news-card-meta">
                    <span>{entry.updated_at ? new Date(entry.updated_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Just posted"}</span>
                    {entry.link_url ? (
                      <a href={entry.link_url} target="_blank" rel="noreferrer">
                        {entry.link_label || "Open"}
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="schedule-panel" aria-label="UFC schedule">
          <div className="panel-heading">
            <div>
              <p className="kicker">UFC schedule</p>
              <h2>{featuredEvent.shortTitle}</h2>
            </div>
            <span>{countdownLabel(eventStartMs(featuredEvent), nowMs)}</span>
          </div>

          <div className="schedule-body">
            <div className="featured-fight">
              <img src={streamConfig.imageUrl} alt="" loading="lazy" />
              <div>
                <span className="phase">{getEventPhase(featuredEvent, nowMs)}</span>
                <h3>{featuredEvent.title}</h3>
                <p>
                  {featuredEvent.venue}, {featuredEvent.city}
                </p>
                <a className="button button-small" href={featuredEvent.sourceUrl} target="_blank" rel="noreferrer">
                  Event page
                </a>
              </div>
            </div>

            <div className="slot-list">
              {featuredEvent.slots.length > 0 ? (
                featuredEvent.slots.map((slot) => (
                  <div className="slot-row" key={`${featuredEvent.id}-${slot.label}`}>
                    <span>{slot.label}</span>
                    <strong>{formatEventTime(slot.iso)}</strong>
                  </div>
                ))
              ) : (
                <div className="slot-row">
                  <span>{featuredEvent.note ?? "Start time"}</span>
                  <strong>TBA</strong>
                </div>
              )}
            </div>

            <div className="upcoming-list">
              {scheduleBuckets.upcoming.slice(0, 5).map((event) => (
                <a className="upcoming-row" href={event.sourceUrl} target="_blank" rel="noreferrer" key={event.id}>
                  <span>{event.dateLabel}</span>
                  <strong>{event.shortTitle}</strong>
                  <small>{event.venue}</small>
                </a>
              ))}
            </div>
          </div>

          <p className="source-note">Schedule checked {ufcScheduleLastChecked}. Fight cards and times can change.</p>
        </section>

        {highscores && highscores.leaderboard.length > 0 && (
          <section className="highscore-panel" aria-label="Viewer highscores">
            <div className="highscore-head">
              <h2>🏆 Viewer Highscores</h2>
              <span className="highscore-sub">
                {highscores.viewers_tracked.toLocaleString()} watchers · {highscores.total_watch_hours}h watched
              </span>
            </div>
            <ol className="highscore-list">
              {highscores.leaderboard.map((viewer) => (
                <li className={`highscore-row rank-${viewer.rank <= 3 ? viewer.rank : "n"}`} key={viewer.rank}>
                  <span className="hs-rank">{viewer.rank <= 3 ? ["🥇", "🥈", "🥉"][viewer.rank - 1] : viewer.rank}</span>
                  <span className="hs-flag" title={viewer.country}>{viewer.flag}</span>
                  <span className="hs-name">
                    <strong>{viewer.codename}</strong>
                    <small>{viewer.location || viewer.ip_masked}</small>
                  </span>
                  <span className="hs-time">{formatWatch(viewer.watch_seconds)}</span>
                </li>
              ))}
            </ol>
            {highscores.top_countries.length > 0 && (
              <div className="highscore-countries">
                {highscores.top_countries.slice(0, 6).map((country) => (
                  <span className="hs-country" key={country.country}>
                    {country.flag} {country.country} <b>{country.watch_hours}h</b>
                  </span>
                ))}
              </div>
            )}
            {highscores.source_performance && highscores.source_performance.length > 0 && (
              <div className="perf-block">
                <div className="perf-head">📡 Stream performance <small>most-watched · buffering-free</small></div>
                <div className="perf-list">
                  {highscores.source_performance.slice(0, 6).map((src) => {
                    const tone = src.smoothness >= 97 ? "ok" : src.smoothness >= 90 ? "warn" : "bad";
                    return (
                      <div className={`perf-row perf-${tone}`} key={src.source_id}>
                        <span className="perf-name" title={src.source_id}>{src.label || prettySource(src.source_id)}</span>
                        <span className="perf-bar" aria-hidden="true"><i style={{ width: `${src.smoothness}%` }} /></span>
                        <span className="perf-smooth">{src.smoothness}%</span>
                        <span className="perf-meta">{formatWatch(Math.round(src.watch_hours * 3600))} · {src.viewers}👤{src.stalls > 0 ? ` · ${src.stalls} stalls` : ""}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <p className="source-note">Watchers are anonymised — codenames &amp; coarse location only, never full IPs. Stream quality is reported by viewers' players.</p>
          </section>
        )}

        <section className="utility-panel" aria-label="Stream tools and links">
          <div className="utility-group discord-group">
            <h2>Community</h2>
            <p>Join Discord for stream notices, source reports, and chat when the embedded chat is busy.</p>
            <a className="button button-primary" href={streamConfig.discordUrl} target="_blank" rel="noreferrer">
              Open Discord
            </a>
          </div>

          <div className="utility-group">
            <h2>Stream tools</h2>
            <div className="tool-grid">
              <button className="tool-button" type="button" onClick={reload}>
                <strong>Reload stream</strong>
                <span>Soft source refresh</span>
              </button>
              <button className="tool-button" type="button" onClick={hardReconnect}>
                <strong>Hard reconnect</strong>
                <span>Rebuild playback</span>
              </button>
              <button className="tool-button" type="button" onClick={copyVlcCommand}>
                <strong>Copy VLC</strong>
                <span>External player</span>
              </button>
              <button className="tool-button" type="button" onClick={copyMpvCommand}>
                <strong>Copy MPV</strong>
                <span>External player</span>
              </button>
            </div>
          </div>

          <div className="utility-group">
            <h2>Links</h2>
            <div className="link-list">
              {streamConfig.watchLinks.map((link) => (
                <a href={link.href} target="_blank" rel="noreferrer" key={link.href}>
                  <strong>{link.label}</strong>
                  <span>{link.description}</span>
                </a>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
