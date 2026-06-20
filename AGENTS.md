# ObbyWatcher Agent Notes

## Project Role

ObbyWatcher is the public client frontend for the fight stream. It is the site users visit at `https://fight.nswfiles.com/`, with `https://live.obnoxious.lol/` treated as a mirror/static deployment host.

Do not treat `s.obby.ca` as this frontend. `s.obby.ca` is the Obbystreams cockpit/control-plane service.

## Responsibilities

- Render the public viewer, player controls, chat, source/server switching UI, Discord links, schedule, and viewer-facing diagnostics.
- Play Server 1/default through the normal primary stream URLs in `src/config/stream.ts`.
- Load pasted public internet sources from `https://s.obby.ca/api/public-streams` and play them through the returned proxied `playback_url`.
- Keep official Server 1 and public pasted sources visually and behaviorally separate.
- Report viewer heartbeats to `https://s.obby.ca/api/viewers` with the selected source id and label.
- Subscribe to `https://s.obby.ca/api/live` for source status and viewer-count updates, with polling fallback.

## Integration Contract

ObbyWatcher consumes these public Obbystreams APIs:

- `GET /api/public-configured-sources`: official Server 1/default managed output status.
- `GET /api/public-streams`: pasted public internet streams with CORS-safe proxied playback URLs.
- `GET /api/live`: server-sent event stream for source status, health, and viewer counts.
- `GET /hls/ufc.m3u8`: Server 1/default managed output.
- `GET /api/public-source`: legacy auto-scraped public fallback supplement.
- `POST /api/viewers`: viewer heartbeat and selected-source telemetry.

ObbyWatcher should not manage ffmpeg, write cockpit config, expose secrets, or administer the transcoder.

The source switcher is both manual and automatic. Keep official Server 1 and pasted public sources visible as separate choices with status dots and viewer counts. Public streams must use proxied playback URLs; do not point the browser directly at third-party HLS URLs.

## Deployment

Build with:

```sh
npm run build
```

Deploy the contents of `dist/` to `/var/www/live.obnoxious.lol`, preserving `/var/www/live.obnoxious.lol/stream`. Both `fight.nswfiles.com` and `live.obnoxious.lol` serve this static frontend through nginx.

Use the deploy script instead of manual copy:

```sh
npm run deploy
```

The script builds, rsyncs `dist/`, preserves `/stream`, sets directories to
`0755`, files to `0644`, and checks the local nginx vhost. Do not deploy with
plain `cp -a`; it can preserve unreadable local file modes and cause 403s.

## Testing

Run at minimum:

```sh
npm run build
npm test
npm run test:e2e
```

After deployment, smoke-test `https://fight.nswfiles.com/` and verify Server 1, pasted public source buttons, status dots, Discord link, and viewer counts render from the cockpit APIs.

See `DESIGN.md` for the watcher design notes, current/intended behavior, and ownership tradeoffs.
