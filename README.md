# ObbyWatcher

ObbyWatcher is the public React viewer for `fight.nswfiles.com`, with
`live.obnoxious.lol` as the mirror/static deployment host. It is a standalone
frontend for watching the existing HLS output and chat. It is not
`obbystreams`, and it does not start, stop, manage, or administer the
transcoder.

## Features

- React + TypeScript frontend built with Vite and Tailwind CSS.
- HLS playback through `hls.js`, with native HLS fallback for Safari and iOS.
- Dark pastel interface with purple accents and custom auto-hide player
  controls for play/pause, sound, volume, live edge, retry, settings, stats,
  fullscreen, and picture-in-picture.
- Theme picker with ten pastel dark themes, defaulting to pastel purple.
- Compatibility-first automatic recovery for stale manifests, persistent
  stalled playback, media errors, network errors, and browser offline/online
  transitions.
- Active HLS manifest probing to choose the freshest healthy mirror during
  reconnects.
- Mirror failover between `live.obnoxious.lol` and `fight.nswfiles.com`.
- Modular Server 1..N source switching backed by the Obbystreams cockpit API.
- Live total and per-source viewer counts through the cockpit viewer heartbeat
  API.
- Discord links in navigation and utility areas.
- UFC schedule panel, source links, command copy helpers for VLC/MPV, and
  embedded or pop-out chat.
- Static deployment compatible with the current nginx root at
  `/var/www/live.obnoxious.lol`.

## Development

```sh
npm install
npm run dev
```

## Checks

```sh
npm test
npm run build
```

Browser smoke tests:

```sh
npm run test:e2e
```

## Obbystreams Integration

`s.obby.ca` is the Obbystreams cockpit/control plane, not this frontend.
ObbyWatcher consumes these public cockpit APIs:

- `GET https://s.obby.ca/api/public-configured-sources`
- `GET https://s.obby.ca/api/live`
- `GET https://s.obby.ca/api/public-streams`
- `GET https://s.obby.ca/hls/ufc.m3u8`
- `GET https://s.obby.ca/api/public-source`
- `POST https://s.obby.ca/api/viewers`

Server 1/default stays on the primary managed stream. Public entries are
pasted internet sources loaded from `/api/public-streams` and played through
the returned proxied `playback_url`, so third-party CORS does not block the
browser.

The player keeps official Server 1 and public pasted sources visually separate.
If the active public source becomes fatal, stalls, or buffers out for the
watchdog window, ObbyWatcher switches to the next public source, then returns
to Server 1 when appropriate.

## Deployment

Build the static frontend:

```sh
npm run build
```

Preferred production deploy:

```sh
npm run deploy
```

Deploy the contents of `dist/` to `/var/www/live.obnoxious.lol`, preserving the
existing `/var/www/live.obnoxious.lol/stream` directory. The stream files are
produced by the existing pipeline and are intentionally outside this repository.
The deploy script enforces nginx-readable `0755` directory and `0644` file
permissions and fails if the stream directory is missing.

Smoke-test these URLs after deployment:

- `https://live.obnoxious.lol/`
- `https://fight.nswfiles.com/`
- `https://live.obnoxious.lol/stream/ufc.m3u8`
- `https://fight.nswfiles.com/stream/ufc.m3u8`
