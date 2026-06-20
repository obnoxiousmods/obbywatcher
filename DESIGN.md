# ObbyWatcher Design Notes

## Role

ObbyWatcher is the public watcher/client for `https://fight.nswfiles.com/`. It is not the `s.obby.ca` cockpit.

## Current Contents

This codebase contains the static React/Vite viewer, stream player, public source/server selection, viewer heartbeat integration, e2e tests, and deployment tooling for the public site.

## Intended Behavior

The app should load Server 1/default from the normal primary stream URL, load pasted public internet sources from `https://s.obby.ca/api/public-streams`, subscribe to `https://s.obby.ca/api/live` where possible, and report selected-source viewer heartbeats to `https://s.obby.ca/api/viewers`.

Public pasted source browsing belongs here. Cockpit source management, sour-signal recovery, public source inventory, proxying, ffmpeg process control, and private source headers belong in `/home/joey/obbystreams`.

## Tradeoffs

The watcher trusts the cockpit public API for official Server 1 status and pasted public source inventory. Public stream playback must use the `playback_url` proxy so third-party CORS never blocks the browser.

Client-side failover should be visible and reversible. If a public source fails, the watcher can move to the next pasted public source, then Server 1 when it is healthy.

## Verification

Run:

```sh
npm run build
npm test
npm run test:e2e
```

After deploy, verify `https://fight.nswfiles.com/` renders official Server 1 and pasted public source controls separately, uses proxied playback URLs, and reports viewer counts.
