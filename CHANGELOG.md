# Changelog

All notable ObbyWatcher changes are tracked here. ObbyWatcher is the public
React/Vite viewer for `fight.nswfiles.com`; it depends on the Obbystreams cockpit
(`s.obby.ca`) for stream metadata, source proxying, live status, and viewer
counts.

## Unreleased

### Added

- Vitest coverage for the previously-untested config modules: `config/stream.ts`
  (`sourcesForMirror`, mirror invariants) and `config/ufcSchedule.ts` (schedule
  data integrity).

### Changed

- Made the `playerControls` schedule-helper tests deterministic by asserting
  against a synthetic schedule fixture instead of the live `ufcSchedule` data, so
  they no longer break when `npm run update:schedule` regenerates the calendar.
