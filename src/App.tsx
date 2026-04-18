import { useEffect, useMemo, useRef, useState } from "react";
import { streamConfig } from "./config/stream";
import { useLiveHls } from "./hooks/useLiveHls";
import type { LivePlaybackStatus } from "./hooks/useLiveHls";

function useClock() {
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return clock.toLocaleTimeString([], { hour12: false });
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

function secondsLabel(value: number) {
  if (!Number.isFinite(value)) return "0.0s";
  return `${value.toFixed(1)}s`;
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

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clock = useClock();
  const [notice, setNotice] = useState<string>(streamConfig.schedule);
  const playerOptions = useMemo(
    () => ({
      autoPlay: true,
      mirrorFailureThreshold: 2,
      staleTargetDurations: 3.5,
      stallTimeoutMs: 8_000
    }),
    []
  );
  const { snapshot, activeMirror, retryNow, reload, switchMirror } = useLiveHls(
    videoRef,
    streamConfig.mirrors,
    playerOptions
  );

  const primaryStream = streamConfig.mirrors[0].streamUrl;
  const activeStatus = statusCopy(snapshot.status);

  const copyStreamUrl = async () => {
    try {
      await navigator.clipboard.writeText(activeMirror.streamUrl);
      setNotice("Copied stream URL");
      window.setTimeout(() => setNotice(streamConfig.schedule), 1600);
    } catch {
      window.prompt("Copy stream URL:", activeMirror.streamUrl);
    }
  };

  const bookmark = () => {
    const title = document.title;
    const url = window.location.href;
    const legacyExternal = window.external as { AddFavorite?: (url: string, title: string) => void } | undefined;

    try {
      if (legacyExternal?.AddFavorite) {
        legacyExternal.AddFavorite(url, title);
        return;
      }
    } catch {
      // Browser bookmark APIs are inconsistent; the keyboard shortcut fallback is clearer.
    }

    const isMac = navigator.platform.toUpperCase().includes("MAC");
    window.alert(`Use ${isMac ? "Cmd + D" : "Ctrl + D"} to bookmark this stream.`);
  };

  return (
    <div className="app-shell">
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
          <a className="chip" href={streamConfig.twitterUrl} target="_blank" rel="noreferrer">
            Twitter
          </a>
          <a className="chip chip-live" href={primaryStream} target="_blank" rel="noreferrer">
            Open .m3u8
          </a>
          <a className="chip chip-mono" href={streamConfig.ircUrl}>
            IRC
          </a>
          <button className="chip" type="button" onClick={bookmark}>
            Bookmark
          </button>
        </nav>
      </header>

      <main className="layout">
        <section className="watch">
          <div className="watch-heading">
            <div>
              <p className="kicker">Live signal</p>
              <h1>{streamConfig.title}</h1>
              <p className="lead">If playback stalls, the player repairs itself and moves to a mirror when needed.</p>
            </div>

            <div className={`status-badge status-${snapshot.status}`}>
              <span aria-hidden="true" />
              {activeStatus}
            </div>
          </div>

          <div className="player-frame">
            <video
              ref={videoRef}
              className="player"
              controls
              playsInline
              preload="auto"
              poster={streamConfig.imageUrl}
            />
          </div>

          <div className="control-strip">
            <div className="signal-copy">
              <span>Source</span>
              <strong>{activeMirror.host}</strong>
              <code>ufc.m3u8</code>
            </div>

            <div className="player-actions">
              <button className="button button-primary" type="button" onClick={reload}>
                Reload stream
              </button>
              <button className="button" type="button" onClick={retryNow}>
                Retry now
              </button>
              <button className="button" type="button" onClick={copyStreamUrl}>
                Copy URL
              </button>
            </div>
          </div>

          <div className="telemetry" aria-label="Playback health">
            <div>
              <span>Mode</span>
              <strong>{snapshot.mode}</strong>
            </div>
            <div>
              <span>Buffer</span>
              <strong>{secondsLabel(snapshot.bufferAheadSeconds)}</strong>
            </div>
            <div>
              <span>Attempts</span>
              <strong>{snapshot.attempt}</strong>
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

          {snapshot.lastError ? <p className="status-note">{snapshot.lastError}</p> : null}
        </section>

        <aside className="side-rail">
          <section className="chat-panel" aria-label="Chat">
            <div className="panel-heading">
              <h2>Chat</h2>
              <a className="button button-small" href={streamConfig.chatUrl} target="_blank" rel="noreferrer">
                Pop out
              </a>
            </div>
            <iframe title="Chat" src={streamConfig.chatUrl} loading="lazy" referrerPolicy="no-referrer" />
          </section>

          <section className="mirror-panel" aria-label="Mirrors">
            <div className="panel-heading">
              <h2>Mirrors</h2>
              <span>{clock}</span>
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

          <section className="event-panel">
            <img src={streamConfig.imageUrl} alt="" loading="lazy" />
            <div>
              <h2>Fight night</h2>
              <p>Public chat. Public room. Keep personal info out of it.</p>
              <small>{streamConfig.imageCredit}</small>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
