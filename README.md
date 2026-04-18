# ObbyWatcher

ObbyWatcher is the public React viewer for `live.obnoxious.lol` and
`fight.nswfiles.com`. It is a standalone frontend for watching the existing HLS
output and chat. It is not `obbystreams`, and it does not start, stop, manage,
or administer the transcoder.

## Features

- React + TypeScript frontend built with Vite.
- HLS playback through `hls.js`, with native HLS fallback for Safari and iOS.
- Automatic recovery for stale manifests, stalled playback, media errors, and
  network errors.
- Mirror failover between `live.obnoxious.lol` and `fight.nswfiles.com`.
- Embedded chat dock, pop-out chat, copy/open stream controls, and bookmark
  helper.
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

Optional browser smoke tests:

```sh
npm run test:e2e
```

## Deployment

Build the static frontend:

```sh
npm run build
```

Deploy the contents of `dist/` to `/var/www/live.obnoxious.lol`, preserving the
existing `/var/www/live.obnoxious.lol/stream` directory. The stream files are
produced by the existing pipeline and are intentionally outside this repository.

Smoke-test these URLs after deployment:

- `https://live.obnoxious.lol/`
- `https://fight.nswfiles.com/`
- `https://live.obnoxious.lol/stream/ufc.m3u8`
- `https://fight.nswfiles.com/stream/ufc.m3u8`
