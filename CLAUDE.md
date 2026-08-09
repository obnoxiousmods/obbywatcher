# ObbyWatcher Context

This repository is the public React/Vite frontend for `fight.nswfiles.com`.

`s.obby.ca` is not this app. It is the Obbystreams cockpit API/control panel. Use it only as an API dependency for stream metadata, source proxying, live status, and viewer counts.

Current public integration:

- Server 1/default is the primary managed stream from `src/config/stream.ts`.
- Pasted public internet streams come from `https://s.obby.ca/api/public-streams`.
- Live source/viewer updates come from `https://s.obby.ca/api/live`.
- Viewer heartbeats go to `https://s.obby.ca/api/viewers`.
- Discord URL is `https://discord.gg/moddingcartel` and belongs in normal navigation/utility UI, not intrusive popups.
- UFC schedule rows live in `src/config/ufcSchedule.ts` and should be regenerated with `npm run update:schedule`.

Keep user-facing source switching in this frontend. Keep official Server 1 and pasted public streams separate in the UI. Public streams must use the proxied `playback_url` from Obbystreams, not raw third-party HLS URLs. Obbystreams owns the exact public URLs and headers documented in `/home/joey/obbystreams/public_srcs.md`.
See `DESIGN.md` before changing public source switching or cockpit API integration.

The automatic source fallback state machine is documented in `DESIGN.md` and lives in `src/lib/sourceFallback.ts`. Keep fallback choices deterministic, cooldown-aware, and covered by tests; do not add one-off React branches that can loop failed sources.

Schedule automation lives in `scripts/update-ufc-schedule.mjs` plus
`.github/workflows/update-ufc-schedule.yml`. The script parses the public
Paramount+ UFC schedule, converts ET/PT card times to UTC, preserves date order
for TBA cards with `dateIso`, and falls back to the embedded seed if the source
page changes.
