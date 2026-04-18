import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { streamConfig } from "./config/stream";
import { defaultThemeId, isThemeId, themeOptions } from "./config/themes";
import type { ThemeId } from "./config/themes";
import { ufcSchedule, ufcScheduleLastChecked } from "./config/ufcSchedule";
import { useLiveHls } from "./hooks/useLiveHls";
import type { LivePlaybackStatus } from "./hooks/useLiveHls";
import {
  clampVolume,
  eventStartMs,
  formatDuration,
  formatEventTime,
  formatSignedSeconds,
  getEventPhase,
  getScheduleBuckets,
  initialPlayerUiState,
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

type PlayerIconName = "play" | "pause" | "volume" | "muted" | "settings" | "pip" | "fullscreen" | "retry";

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

function percent(value: number | null, max: number) {
  if (value === null || !Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const now = useClock();
  const nowMs = now.getTime();
  const [notice, setNotice] = useState<string>(streamConfig.schedule);
  const [themeId, setThemeId] = useState<ThemeId>(loadInitialTheme);
  const [ui, dispatch] = useReducer(playerUiReducer, undefined, loadInitialPlayerState);
  const [playing, setPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const hideControlsTimer = useRef<number | null>(null);

  const playerOptions = useMemo(
    () => ({
      autoPlay: true,
      forceAutoplayAudio: true
    }),
    []
  );
  const { snapshot, activeMirror, retryNow, reload, hardReconnect, enableAudio, seekToLive, switchMirror } =
    useLiveHls(videoRef, streamConfig.mirrors, playerOptions);

  const activeStatus = statusCopy(snapshot.status);
  const scheduleBuckets = useMemo(() => getScheduleBuckets(ufcSchedule, nowMs), [nowMs]);
  const featuredEvent = scheduleBuckets.current ?? scheduleBuckets.next ?? ufcSchedule[0];
  const playerBusy =
    snapshot.autoplayBlocked ||
    snapshot.status === "buffering" ||
    snapshot.status === "connecting" ||
    snapshot.status === "reconnecting";
  const latencyMax = Math.max(12, snapshot.targetDurationSeconds * 5);
  const liveProgressPercent = Math.max(8, 100 - percent(snapshot.liveLatencySeconds, latencyMax));

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
    const video = videoRef.current;
    if (!video) return;
    video.volume = ui.volume;
    video.muted = ui.muted;
  }, [ui.volume, ui.muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const syncPlayback = () => setPlaying(!video.paused && !video.ended);
    const syncVolume = () => {
      dispatch({ type: "set-volume", volume: video.volume });
      dispatch({ type: "set-muted", muted: video.muted });
    };
    const onEnterPictureInPicture = () => setPictureInPicture(true);
    const onLeavePictureInPicture = () => setPictureInPicture(false);

    video.addEventListener("play", syncPlayback);
    video.addEventListener("playing", syncPlayback);
    video.addEventListener("pause", syncPlayback);
    video.addEventListener("ended", syncPlayback);
    video.addEventListener("volumechange", syncVolume);
    video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
    video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);

    return () => {
      video.removeEventListener("play", syncPlayback);
      video.removeEventListener("playing", syncPlayback);
      video.removeEventListener("pause", syncPlayback);
      video.removeEventListener("ended", syncPlayback);
      video.removeEventListener("volumechange", syncVolume);
      video.removeEventListener("enterpictureinpicture", onEnterPictureInPicture);
      video.removeEventListener("leavepictureinpicture", onLeavePictureInPicture);
    };
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === playerShellRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimer.current !== null) window.clearTimeout(hideControlsTimer.current);
    if (!playing || playerBusy || ui.moreMenuOpen) return;
    hideControlsTimer.current = window.setTimeout(() => setControlsVisible(false), 2500);
  }, [playerBusy, playing, ui.moreMenuOpen]);

  useEffect(() => {
    revealControls();
    return () => {
      if (hideControlsTimer.current !== null) window.clearTimeout(hideControlsTimer.current);
    };
  }, [revealControls]);

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
    const video = videoRef.current;
    if (!video) return;

    if (video.paused || video.ended) {
      try {
        await video.play();
      } catch {
        await enableAudio();
      }
      return;
    }

    video.pause();
  }, [enableAudio]);

  const setVolume = useCallback((volume: number) => {
    dispatch({ type: "set-volume", volume });
    const video = videoRef.current;
    if (video) {
      video.volume = clampVolume(volume);
      video.muted = volume <= 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = !ui.muted;
    dispatch({ type: "set-muted", muted: nextMuted });
    const video = videoRef.current;
    if (video) {
      video.muted = nextMuted;
      if (!nextMuted && video.volume === 0) {
        video.volume = ui.volume || 1;
      }
    }
  }, [ui.muted, ui.volume]);

  const toggleFullscreen = useCallback(async () => {
    const shell = playerShellRef.current;
    if (!shell) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await shell.requestFullscreen();
  }, []);

  const togglePictureInPicture = useCallback(async () => {
    const pipDocument = document as PictureInPictureDocument;
    const video = videoRef.current as PictureInPictureVideo | null;
    if (!video || !pipDocument.pictureInPictureEnabled || !video.requestPictureInPicture) return;

    if (pipDocument.pictureInPictureElement && pipDocument.exitPictureInPicture) {
      await pipDocument.exitPictureInPicture();
      return;
    }

    await video.requestPictureInPicture();
  }, []);

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
          seekToLive();
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
    seekToLive,
    setVolume,
    toggleFullscreen,
    toggleMute,
    togglePictureInPicture,
    togglePlayback,
    ui.volume
  ]);

  const copyStreamUrl = () => copyText("Stream URL", activeMirror.streamUrl);
  const copyVlcCommand = () => copyText("VLC command", `vlc ${activeMirror.streamUrl}`);
  const copyMpvCommand = () => copyText("MPV command", `mpv ${activeMirror.streamUrl}`);

  const playerClass = [
    "player-shell",
    controlsVisible || !playing || playerBusy || ui.moreMenuOpen ? "controls-visible" : "controls-hidden",
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
          <label className="theme-picker">
            <span>Theme</span>
            <select
              aria-label="Theme"
              value={themeId}
              onChange={(event) => {
                const nextTheme = event.currentTarget.value;
                if (isThemeId(nextTheme)) setThemeId(nextTheme);
              }}
            >
              {themeOptions.map((theme) => (
                <option value={theme.id} key={theme.id}>
                  {theme.label}
                </option>
              ))}
            </select>
          </label>
          <a className="chip chip-live" href={activeMirror.streamUrl} target="_blank" rel="noreferrer">
            Open HLS
          </a>
          <a className="chip" href={streamConfig.ufcScheduleUrl} target="_blank" rel="noreferrer">
            UFC schedule
          </a>
          <a className="chip" href={streamConfig.githubUrl} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="chip" href={streamConfig.twitterUrl} target="_blank" rel="noreferrer">
            Twitter
          </a>
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

              <div className={`status-badge status-${snapshot.status}`}>
                <span aria-hidden="true" />
                {activeStatus}
              </div>
            </div>

            <div
              ref={playerShellRef}
              className={playerClass}
              onMouseMove={revealControls}
              onPointerDown={revealControls}
              onFocus={revealControls}
            >
              <video
                ref={videoRef}
                className="player"
                autoPlay
                playsInline
                preload="auto"
                poster={streamConfig.imageUrl}
                onClick={() => void togglePlayback()}
              />

              <div className="player-topline">
                <span className={`signal-pill signal-${snapshot.status}`}>{activeStatus}</span>
                <span>{activeMirror.host}</span>
                <span>{formatSignedSeconds(snapshot.liveLatencySeconds)} behind</span>
              </div>

              {!playing || playerBusy ? (
                <button className="center-play" type="button" onClick={() => void togglePlayback()}>
                  {playing ? activeStatus : "Play"}
                </button>
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
                  <button className="live-chip" type="button" onClick={seekToLive} aria-label="Go live">
                    <span aria-hidden="true" />
                    LIVE
                  </button>
                  <div className="timeline-track" aria-label="Live edge">
                    <span className="timeline-fill" style={{ width: `${liveProgressPercent}%` }} />
                    <span className="timeline-thumb" style={{ left: `${liveProgressPercent}%` }} />
                  </div>
                  <span className="latency-readout">{formatSignedSeconds(snapshot.liveLatencySeconds)} behind</span>
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

                    <div className="volume-cluster">
                      <button
                        className="player-icon-button"
                        type="button"
                        onClick={toggleMute}
                        aria-label={ui.muted ? "Unmute" : "Mute"}
                        title={ui.muted ? "Unmute" : "Mute"}
                      >
                        <PlayerIcon name={ui.muted ? "muted" : "volume"} />
                      </button>
                      <input
                        aria-label="Volume"
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={ui.muted ? 0 : ui.volume}
                        onChange={(event) => setVolume(Number(event.currentTarget.value))}
                      />
                    </div>

                    <span className="control-readout">
                      Live stream · {formatSignedSeconds(snapshot.bufferAheadSeconds)} buffer
                    </span>
                  </div>

                  <div className="control-right">
                    <button
                      className="player-icon-button"
                      type="button"
                      onClick={retryNow}
                      aria-label="Retry"
                      title="Retry"
                    >
                      <PlayerIcon name="retry" />
                    </button>
                    <button
                      className={ui.moreMenuOpen ? "player-icon-button active" : "player-icon-button"}
                      type="button"
                      onClick={() => dispatch({ type: "toggle-more" })}
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

                {ui.moreMenuOpen ? (
                  <div className="more-menu" role="menu">
                    <label className="menu-field">
                      <span>Mirror</span>
                      <select
                        value={snapshot.activeMirrorIndex}
                        onChange={(event) => switchMirror(Number(event.currentTarget.value))}
                      >
                        {streamConfig.mirrors.map((mirror, index) => (
                          <option value={index} key={mirror.id}>
                            {mirror.label} - {mirror.host}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="menu-actions">
                      <button className="button" type="button" onClick={hardReconnect}>
                        Hard reconnect
                      </button>
                      <button className="button" type="button" onClick={copyStreamUrl}>
                        Copy HLS
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

                    {ui.statsOpen ? (
                      <div className="menu-stats" aria-label="Advanced diagnostics">
                        <div>
                          <span>Mode</span>
                          <strong>{snapshot.mode}</strong>
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
                          <span>Shortcut map</span>
                          <strong>Space, M, F, P, R</strong>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="signal-strip" aria-label="Playback health">
              <div>
                <span>Mode</span>
                <strong>{snapshot.mode}</strong>
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

        <section className="utility-panel" aria-label="Stream tools and links">
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
            <h2>Mirrors</h2>
            <div className="mirror-list">
              {streamConfig.mirrors.map((mirror, index) => (
                <div className="mirror-row" key={mirror.id}>
                  <button
                    className={index === snapshot.activeMirrorIndex ? "mirror-button active" : "mirror-button"}
                    type="button"
                    onClick={() => switchMirror(index)}
                  >
                    <span>{mirror.label}</span>
                    <strong>{mirror.host}</strong>
                  </button>
                  <a className="button button-small" href={mirror.pageUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </div>
              ))}
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
