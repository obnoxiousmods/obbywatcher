# ObbyWatcher Design Notes

## Role

ObbyWatcher is the public watcher/client for `https://fight.nswfiles.com/`. It is not the `s.obby.ca` cockpit.

## Current Contents

This codebase contains the static React/Vite viewer, stream player, public source/server selection, viewer heartbeat integration, e2e tests, and deployment tooling for the public site.

## Intended Behavior

The app should load Server 1/default from the normal primary stream URL, load pasted public internet sources from `https://s.obby.ca/api/public-streams`, subscribe to `https://s.obby.ca/api/live` where possible, and report selected-source viewer heartbeats to `https://s.obby.ca/api/viewers`.

Public pasted source browsing belongs here. Cockpit source management, sour-signal recovery, public source inventory, proxying, ffmpeg process control, and private source headers belong in `/home/joey/obbystreams`.

## Auto Source Fallback Spec

The watcher must treat source selection as a state machine, not a simple button list.

- `primary`: Server 1/default from the official managed output. This is the source to return to after it is genuinely stable.
- `configured`: additional public configured outputs reported by the cockpit, excluding the preferred Server 1 row.
- `public`: pasted internet public sources from `GET https://s.obby.ca/api/public-streams`, always played through `playback_url` or `/api/proxy-hls`.
- `custom`: viewer-entered URL, proxied through the cockpit scraper/proxy.

Health rules:

- Server 1 is degraded when the official playback hook reports `buffering`, `reconnecting`, `failed`, `offline`, or has almost no buffer before reaching live playback.
- Server 1 is healthy only when it is live, has useful buffer, and is close enough to the live edge.
- Overlay sources (`public`, `configured`, `custom`) are degraded when the video element reports a fatal error, repeated fatal HLS.js failure, or no playhead/buffer progress for more than the stall window.
- Public sources are also probed out-of-band by fetching the proxied HLS playlist. A live media playlist with segments or a live master playlist with variants is green; malformed, ended, or failed playlists are red; empty but parseable live playlists are yellow.

Decision rules:

- Never switch on a single transient error. A source must remain degraded for `10s`.
- Never switch more than once every `4s`.
- A failed source gets an escalating cooldown starting at `30s`; repeated failures stretch that cooldown. Manual user selection clears the cooldown for that selected source.
- If Server 1 fails, prefer the best healthy configured fallback, then the best public source.
- If a public source fails, try the next ranked public source before configured fallbacks or Server 1.
- If a configured source fails, try the next configured source, then public fallback, then Server 1 only if Server 1 is healthy.
- If a custom source fails, fall back automatically after confirmed degradation; if it is healthy, do not silently return to Server 1.
- Return to Server 1 only after it has been healthy for `18s` while the active fallback is not degraded.

Ranking rules:

- Red and disabled sources are excluded.
- Green beats yellow.
- Sources in cooldown are avoided unless every clean option is unavailable.
- Repeated failures reduce priority.
- Higher active viewer counts modestly improve priority because they indicate real clients are succeeding.
- The active source is penalized when choosing a replacement so the app does not retry the same failing source immediately.

Implementation ownership:

- The pure decision policy lives in `src/lib/sourceFallback.ts` and must stay covered by unit tests.
- React code in `src/App.tsx` should only translate DOM/player/cockpit state into policy inputs and apply the returned decision.
- Manifest parsing/probing helpers live in `src/lib/reconnect.ts`.
- Proxy caching, third-party request headers, and public source URL inventory remain Obbystreams responsibilities.

## Tradeoffs

The watcher trusts the cockpit public API for official Server 1 status and pasted public source inventory. Public stream playback must use the `playback_url` proxy so third-party CORS never blocks the browser. The source URLs and required request headers are owned by Obbystreams and documented in `/home/joey/obbystreams/public_srcs.md`.

Client-side failover should be visible and reversible. If a public source fails, the watcher can move to the next pasted public source, then Server 1 when it is healthy.

The browser cannot fully prove that a third-party stream is semantically correct; it can only prove that the proxied playlist is live-shaped and playback is making progress. Deeper content validation, request header handling, playlist refresh, and upstream restream capacity belong in Obbystreams where the proxy has server-side visibility.

## Verification

Run:

```sh
npm run build
npm test
npm run test:e2e
```

After deploy, verify `https://fight.nswfiles.com/` renders official Server 1 and pasted public source controls separately, uses proxied playback URLs, and reports viewer counts.
