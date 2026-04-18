import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { streamConfig } from "./config/stream";
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
      theater: Boolean(parsed.theater ?? initialPlayerUiState.theater),
      statsOpen: Boolean(parsed.statsOpen ?? initialPlayerUiState.statsOpen),
      chatOpen: parsed.chatOpen === undefined ? initialPlayerUiState.chatOpen : Boolean(parsed.chatOpen),
      controlsPinned: Boolean(parsed.controlsPinned ?? initialPlayerUiState.controlsPinned)
    };
  } catch {
    return initialPlayerUiState;
  }
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
  const [ui, dispatch] = useReducer(playerUiReducer, undefined, loadInitialPlayerState);
  const [playing, setPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const hideControlsTimer = useRef<number | null>(null);

  const playerOptions = useMemo(
    () => ({
      autoPlay: true,
      forceAutoplayAudio: true,
      mirrorFailureThreshold: 1,
      staleTargetDurations: 1.75,
      stallTimeoutMs: 2_500,
      healthIntervalMs: 750,
      backoffBaseMs: 150,
      backoffMaxMs: 8_000
    }),
    []
  );
  const { snapshot, activeMirror, retryNow, reload, hardReconnect, enableAudio, seekToLive, switchMirror } =
    useLiveHls(videoRef, streamConfig.mirrors, playerOptions);

  const activeStatus = statusCopy(snapshot.status);
  const scheduleBuckets = useMemo(() => getScheduleBuckets(ufcSchedule, nowMs), [nowMs]);
  const featuredEvent = scheduleBuckets.current ?? scheduleBuckets.next ?? ufcSchedule[0];
  const latencyMax = Math.max(8, snapshot.targetDurationSeconds * 4);
  const latencyPercent = percent(snapshot.liveLatencySeconds, latencyMax);

  useEffect(() => {
    window.localStorage.setItem(
      "obbywatcher:player-ui",
      JSON.stringify({
        volume: ui.volume,
        muted: ui.muted,
        theater: ui.theater,
        statsOpen: ui.statsOpen,
        chatOpen: ui.chatOpen,
        controlsPinned: ui.controlsPinned
      })
    );
  }, [ui]);

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
    if (ui.controlsPinned || !playing) return;
    hideControlsTimer.current = window.setTimeout(() => setControlsVisible(false), 2600);
  }, [playing, ui.controlsPinned]);

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
        case "t":
          event.preventDefault();
          dispatch({ type: "toggle-theater" });
          break;
        case "r":
          event.preventDefault();
          if (event.shiftKey) {
            hardReconnect();
          } else {
            retryNow();
          }
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
    controlsVisible || ui.controlsPinned ? "controls-visible" : "controls-hidden",
    fullscreen ? "is-fullscreen" : "",
    snapshot.autoplayBlocked ? "needs-audio" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={ui.theater ? "app-shell theater-mode" : "app-shell"}>
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

      <main className="layout">
        <section className="watch">
          <div className="watch-heading">
            <div>
              <p className="kicker">Live fight signal</p>
              <h1>{streamConfig.title}</h1>
              <p className="lead">
                Unmuted autoplay, fresh mirror probing, hard resets, live-edge seeking, and manual controls for
                stubborn browsers.
              </p>
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
            />

            <div className="player-topline">
              <span className={`signal-pill signal-${snapshot.status}`}>{activeStatus}</span>
              <span>{activeMirror.host}</span>
              <span>{formatSignedSeconds(snapshot.liveLatencySeconds)} behind</span>
            </div>

            <button className="center-play" type="button" onClick={() => void togglePlayback()}>
              {playing ? "Pause" : "Play"}
            </button>

            {snapshot.autoplayBlocked ? (
              <div className="audio-prompt" role="status">
                <strong>Sound needs one click</strong>
                <span>Browser policy blocked unmuted autoplay.</span>
                <button className="button button-primary" type="button" onClick={() => void enableAudio()}>
                  Enable sound
                </button>
              </div>
            ) : null}

            <div className="control-dock" aria-label="Player controls">
              <div className="live-meter">
                <button className="live-button" type="button" onClick={seekToLive}>
                  LIVE
                </button>
                <div className="live-track" aria-label="Live latency">
                  <span style={{ width: `${latencyPercent}%` }} />
                </div>
                <span>{formatSignedSeconds(snapshot.bufferAheadSeconds)} buffer</span>
              </div>

              <div className="control-row">
                <button className="control-button primary-control" type="button" onClick={() => void togglePlayback()}>
                  {playing ? "Pause" : "Play"}
                </button>

                <button className="control-button" type="button" onClick={toggleMute}>
                  {ui.muted ? "Unmute" : "Mute"}
                </button>

                <label className="volume-control">
                  <span>Volume</span>
                  <input
                    aria-label="Volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={ui.muted ? 0 : ui.volume}
                    onChange={(event) => setVolume(Number(event.currentTarget.value))}
                  />
                </label>

                <button className="control-button" type="button" onClick={seekToLive}>
                  Go live
                </button>
                <button className="control-button" type="button" onClick={retryNow}>
                  Retry
                </button>
                <button className="control-button" type="button" onClick={hardReconnect}>
                  Hard reset
                </button>

                <label className="mirror-select">
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

                <button className="control-button" type="button" onClick={copyStreamUrl}>
                  Copy HLS
                </button>
                <button className="control-button" type="button" onClick={() => dispatch({ type: "toggle-stats" })}>
                  {ui.statsOpen ? "Hide stats" : "Stats"}
                </button>
                <button className="control-button" type="button" onClick={() => dispatch({ type: "toggle-pinned" })}>
                  {ui.controlsPinned ? "Unpin" : "Pin"}
                </button>
                <button className="control-button" type="button" onClick={() => dispatch({ type: "toggle-theater" })}>
                  {ui.theater ? "Normal" : "Theater"}
                </button>
                <button className="control-button" type="button" onClick={() => void togglePictureInPicture()}>
                  {pictureInPicture ? "Close PiP" : "PiP"}
                </button>
                <button className="control-button" type="button" onClick={() => void toggleFullscreen()}>
                  {fullscreen ? "Exit full" : "Fullscreen"}
                </button>
              </div>
            </div>
          </div>

          <div className="signal-grid" aria-label="Playback health">
            <div>
              <span>Mode</span>
              <strong>{snapshot.mode}</strong>
            </div>
            <div>
              <span>Latency</span>
              <strong>{formatSignedSeconds(snapshot.liveLatencySeconds)}</strong>
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
              <span>Retry</span>
              <strong>{retryEta(snapshot.nextRetryAtMs)}</strong>
            </div>
          </div>

          {ui.statsOpen ? (
            <div className="diagnostics" aria-label="Advanced diagnostics">
              <div>
                <span>Sequence</span>
                <strong>{snapshot.currentSequence ?? "--"}</strong>
              </div>
              <div>
                <span>Target duration</span>
                <strong>{formatDuration(snapshot.targetDurationSeconds)}</strong>
              </div>
              <div>
                <span>Decoded frames</span>
                <strong>{snapshot.decodedFrames ?? "--"}</strong>
              </div>
              <div>
                <span>Dropped frames</span>
                <strong>{snapshot.droppedFrames ?? "--"}</strong>
              </div>
              <div>
                <span>Probe</span>
                <strong>
                  {snapshot.lastProbe
                    ? `${snapshot.lastProbe.host} ${snapshot.lastProbe.ok ? "seq" : "fail"} ${
                        snapshot.lastProbe.sequence ?? snapshot.lastProbe.error ?? "--"
                      }`
                    : "--"}
                </strong>
              </div>
              <div>
                <span>Shortcut map</span>
                <strong>Space, M, F, P, T, R, Shift+R</strong>
              </div>
            </div>
          ) : null}

          {snapshot.lastError ? <p className="status-note">{snapshot.lastError}</p> : null}
        </section>

        <aside className="side-rail">
          <section className="schedule-panel" aria-label="UFC schedule">
            <div className="panel-heading">
              <div>
                <p className="kicker">UFC schedule</p>
                <h2>{featuredEvent.shortTitle}</h2>
              </div>
              <span>{countdownLabel(eventStartMs(featuredEvent), nowMs)}</span>
            </div>

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

            <p className="source-note">Schedule checked {ufcScheduleLastChecked}. Fight cards and times can change.</p>
          </section>

          <section className="tools-panel" aria-label="Stream tools">
            <div className="panel-heading">
              <h2>Stream tools</h2>
              <span>{now.toLocaleTimeString([], { hour12: false })}</span>
            </div>

            <div className="tool-grid">
              <button className="tool-button" type="button" onClick={reload}>
                <strong>Reload stream</strong>
                <span>Soft source refresh</span>
              </button>
              <button className="tool-button" type="button" onClick={hardReconnect}>
                <strong>Hard reconnect</strong>
                <span>Destroy and rebuild playback</span>
              </button>
              <button className="tool-button" type="button" onClick={copyVlcCommand}>
                <strong>Copy VLC</strong>
                <span>External player command</span>
              </button>
              <button className="tool-button" type="button" onClick={copyMpvCommand}>
                <strong>Copy MPV</strong>
                <span>External player command</span>
              </button>
            </div>

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
          </section>

          <section className="links-panel" aria-label="Links">
            <div className="panel-heading">
              <h2>Links</h2>
              <a className="button button-small" href={streamConfig.ircUrl}>
                IRC
              </a>
            </div>
            <div className="link-list">
              {streamConfig.watchLinks.map((link) => (
                <a href={link.href} target="_blank" rel="noreferrer" key={link.href}>
                  <strong>{link.label}</strong>
                  <span>{link.description}</span>
                </a>
              ))}
            </div>
          </section>

          <section className={ui.chatOpen ? "chat-panel" : "chat-panel collapsed"} aria-label="Chat">
            <div className="panel-heading">
              <h2>Chat</h2>
              <div className="heading-actions">
                <button className="button button-small" type="button" onClick={() => dispatch({ type: "toggle-chat" })}>
                  {ui.chatOpen ? "Hide" : "Show"}
                </button>
                <a className="button button-small" href={streamConfig.chatUrl} target="_blank" rel="noreferrer">
                  Pop out
                </a>
              </div>
            </div>
            {ui.chatOpen ? (
              <iframe title="Chat" src={streamConfig.chatUrl} loading="lazy" referrerPolicy="no-referrer" />
            ) : null}
          </section>
        </aside>
      </main>
    </div>
  );
}
