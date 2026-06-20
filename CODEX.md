# Codex Notes

ObbyWatcher is the public client/watcher for `https://fight.nswfiles.com/`.

The cockpit/control plane is separate: `/home/joey/obbystreams`, served at `https://s.obby.ca/`.

Keep public viewer features here:

- Player UI and source/server switching.
- Public pasted source selection from `https://s.obby.ca/api/public-streams`.
- Viewer heartbeats to `https://s.obby.ca/api/viewers`.
- SSE/polling from `https://s.obby.ca/api/live`.
- Official Server 1 status from `https://s.obby.ca/api/public-configured-sources`.
- Public stream playback through proxied `playback_url` values only.

Do not add cockpit configuration writes, ffmpeg management, private source headers, public source request headers, or dashboard/admin controls to this repo. Those belong in Obbystreams. Keep official managed Server 1 separate from pasted public internet sources. The public source inventory is documented in `/home/joey/obbystreams/public_srcs.md`.

Source fallback is critical client behavior. Follow `DESIGN.md`; change `src/lib/sourceFallback.ts` first for decision logic and add tests for every new branch. The React app should not grow ad hoc fallback branches that bypass cooldowns, source ranking, or the Server 1 recovery window.

Run before finishing meaningful changes:

```sh
npm run build
npm test
npm run test:e2e
```
