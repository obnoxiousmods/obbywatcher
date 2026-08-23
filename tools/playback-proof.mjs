#!/usr/bin/env node
/**
 * Playback proof harness.
 *
 * Drives a real browser against the live player and measures what a viewer
 * actually experiences: does the playhead advance smoothly, does the buffer ever
 * run dry, does the player freeze, and does the live edge stay put.
 *
 * This exists because every server-side health check reads the ORIGIN, and the
 * 2026-08-22 freeze bug (nginx open_file_cache serving a 30s-stale playlist)
 * was invisible from there -- the origin was perfect the whole time. The only
 * way to catch that class of fault is to measure from a client.
 *
 *   node tools/playback-proof.mjs [--url URL] [--seconds N] [--browser chromium|firefox]
 *
 * Exits non-zero if playback froze, so it can gate a deploy.
 */
import { chromium, firefox } from "@playwright/test";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_ = arg("url", "https://fight.nswfiles.com/");
const SECONDS = Number(arg("seconds", "180"));
const BROWSER = arg("browser", "firefox");
// Startup buffering is not a viewer-visible freeze -- every player has it, and
// counting it would mask the thing we actually care about, which is whether
// steady-state playback ever stops. Reported separately, excluded from the verdict.
const WARMUP_MS = Number(arg("warmup", "15")) * 1000;
// A freeze shorter than this is a decode hiccup, not something a viewer notices.
const FREEZE_THRESHOLD_MS = 500;
// 100ms: a freeze shorter than a few frames is not viewer-visible, but sampling
// at 250ms made the shortest detectable stall a quarter second wide and left the
// onset conditions too coarse to attribute.
const SAMPLE_MS = 100;

const launcher = BROWSER === "chromium" ? chromium : firefox;

const browser = await launcher.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

console.log(`[proof] ${BROWSER} -> ${URL_}  (${SECONDS}s)`);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForSelector("video", { timeout: 60_000 });

// Autoplay with sound is rejected; mute first or the element never starts.
await page.evaluate(() => {
  const v = document.querySelector("video");
  v.muted = true;
  v.play().catch(() => {});
});

await page.evaluate((sampleMs) => {
  const v = document.querySelector("video");
  const P = {
    t0: Date.now(), samples: [], events: [],
    lastT: null, lastAt: null, freezeStart: null, freezeAt: null, freezes: [],
  };
  window.__proof = P;
  for (const k of ["waiting", "stalled", "seeking", "seeked", "ratechange", "error", "emptied", "pause"]) {
    v.addEventListener(k, () => P.events.push({ t: Date.now() - P.t0, k, ct: +v.currentTime.toFixed(2) }));
  }
  P.iv = setInterval(() => {
    const now = Date.now() - P.t0;
    let ahead = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) >= v.currentTime) {
        ahead = v.buffered.end(i) - v.currentTime;
      }
    }
    const lat = v.seekable.length ? v.seekable.end(v.seekable.length - 1) - v.currentTime : null;
    // A freeze is the playhead failing to keep up with WALL CLOCK, measured
    // against the real gap between samples rather than the nominal interval.
    // Timers coalesce and fire late; assuming a fixed 250ms spacing meant two
    // callbacks landing milliseconds apart looked identical to a stall.
    if (P.lastT !== null && P.lastAt !== null && !v.paused) {
      const wallDelta = (now - P.lastAt) / 1000;
      const mediaDelta = v.currentTime - P.lastT;
      // Below 5% of real time the playhead is effectively stopped, and this stays
      // correct whatever the playback rate happens to be.
      const stalled = wallDelta > 0.02 && mediaDelta < wallDelta * 0.05;
      if (stalled) {
        if (P.freezeStart === null) {
          P.freezeStart = now;
          // The conditions AT ONSET are what attribute the freeze. Recording them
          // after the fact -- or only as window-wide minima -- is what left the
          // 955ms event on 2026-08-22 unexplained.
          P.freezeAt = {
            bufferAhead: +ahead.toFixed(2),
            latency: lat === null ? null : +lat.toFixed(2),
            readyState: v.readyState,
            networkState: v.networkState,
            rate: v.playbackRate,
            bufferedRanges: v.buffered.length,
            recentEvents: P.events.slice(-4).map((e) => e.k)
          };
        }
      } else if (P.freezeStart !== null) {
        P.freezes.push({ start: P.freezeStart, ms: now - P.freezeStart, at: P.freezeAt });
        P.freezeStart = null;
        P.freezeAt = null;
      }
    }
    P.lastT = v.currentTime;
    P.lastAt = now;
    P.samples.push({
      t: now, ct: +v.currentTime.toFixed(3), ahead: +ahead.toFixed(2),
      lat: lat === null ? null : +lat.toFixed(2), rate: v.playbackRate,
      rs: v.readyState, paused: v.paused,
    });
  }, sampleMs);
}, SAMPLE_MS);

await page.waitForTimeout(SECONDS * 1000);

const P = await page.evaluate(() => {
  clearInterval(window.__proof.iv);
  const p = window.__proof;
  return { samples: p.samples, events: p.events, freezes: p.freezes };
});
await browser.close();

const played = P.samples.filter((s) => !s.paused && s.rs >= 2);
if (played.length < 10) {
  console.log(`[proof] FAIL: playback never started (samples=${P.samples.length}, ready=${played.length}).`);
  console.log(`[proof] readyState seen: ${[...new Set(P.samples.map((s) => s.rs))].join(",")}`);
  if (consoleErrors.length) console.log(`[proof] console errors: ${consoleErrors.slice(0, 5).join(" | ")}`);
  process.exit(2);
}

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const startupMs = played[0].t;
const steady = played.filter((s) => s.t >= WARMUP_MS);
if (steady.length < 10) {
  console.log(`[proof] FAIL: not enough steady-state samples after ${WARMUP_MS / 1000}s warmup.`);
  process.exit(2);
}
const first = steady[0], last = steady[steady.length - 1];
const wall = (last.t - first.t) / 1000;
const media = last.ct - first.ct;
const aheads = steady.map((s) => s.ahead);
const lats = steady.map((s) => s.lat).filter((x) => x !== null);
const rates = [...new Set(steady.map((s) => s.rate))];
const startupFreezes = P.freezes.filter((f) => f.start < WARMUP_MS && f.ms >= FREEZE_THRESHOLD_MS);
const real = P.freezes.filter((f) => f.start >= WARMUP_MS && f.ms >= FREEZE_THRESHOLD_MS);
const steadyEvents = P.events.filter((e) => e.t >= WARMUP_MS);
console.log(`\n=== PLAYBACK PROOF (${BROWSER}) ===`);
console.log(`  startup: first frame at ${(startupMs / 1000).toFixed(2)}s, ${startupFreezes.length} startup buffer event(s) [excluded from verdict]`);
console.log(`  --- steady state, after ${WARMUP_MS / 1000}s warmup ---`);
console.log(`  wall ${wall.toFixed(1)}s -> media advanced ${media.toFixed(1)}s  = ${(media / wall).toFixed(3)}x  (1.000 = perfect)`);
console.log(`  buffer ahead   min=${Math.min(...aheads).toFixed(2)}s  p50=${pct(aheads, 0.5).toFixed(2)}s  max=${Math.max(...aheads).toFixed(2)}s`);
if (lats.length) console.log(`  live latency   min=${Math.min(...lats).toFixed(2)}s  p50=${pct(lats, 0.5).toFixed(2)}s  max=${Math.max(...lats).toFixed(2)}s`);
console.log(`  playback rates seen: ${rates.join(", ")}  (1 only = no catch-up warping)`);
// Live-sync is a control loop: it corrects until latency reaches target, then
// stops. A correction that is CONVERGING is a startup transient; one that never
// releases is a standing lag. Splitting the window in half distinguishes them.
{
  const mid = Math.floor(steady.length / 2);
  const half = (arr) => {
    const a = arr[0], b = arr[arr.length - 1];
    return (b.ct - a.ct) / ((b.t - a.t) / 1000);
  };
  const h1 = steady.slice(0, mid), h2 = steady.slice(mid);
  const atOne = (arr) => (100 * arr.filter((x) => x.rate === 1).length / arr.length).toFixed(0);
  console.log(`  rate 1st half=${half(h1).toFixed(4)}x (${atOne(h1)}% at 1.0x)  2nd half=${half(h2).toFixed(4)}x (${atOne(h2)}% at 1.0x)`);
  console.log(`  latency 1st half p50=${pct(h1.map((x) => x.lat).filter((x) => x !== null), 0.5)}s  2nd half p50=${pct(h2.map((x) => x.lat).filter((x) => x !== null), 0.5)}s`);
}
console.log(`  FREEZES >= ${FREEZE_THRESHOLD_MS}ms: ${real.length}`);
for (const f of real.slice(0, 8)) {
  const c = f.at ?? {};
  // buffer==0 => starved (upstream or delivery). buffer>0 => the data was there
  // and the decoder or compositor stalled, which is a different bug entirely.
  const verdict = c.bufferAhead === 0 ? "STARVED (no buffered data)"
    : c.bufferAhead < 1 ? `nearly starved (${c.bufferAhead}s buffered)`
    : `buffer was FINE (${c.bufferAhead}s) -> decode/render stall, not delivery`;
  console.log(`    t=${(f.start / 1000).toFixed(1)}s  ${f.ms}ms  ${verdict}`);
  console.log(`      readyState=${c.readyState} networkState=${c.networkState} rate=${c.rate} ranges=${c.bufferedRanges} latency=${c.latency}s recent=[${(c.recentEvents ?? []).join(",")}]`);
}
console.log(`  total frozen: ${(P.freezes.filter((f) => f.start >= WARMUP_MS).reduce((a, f) => a + f.ms, 0) / 1000).toFixed(2)}s of ${wall.toFixed(0)}s`);
const counts = {};
for (const e of steadyEvents) counts[e.k] = (counts[e.k] || 0) + 1;
console.log(`  media events: ${Object.keys(counts).length ? JSON.stringify(counts) : "none"}`);
if (consoleErrors.length) console.log(`  console errors: ${consoleErrors.length} (${consoleErrors.slice(0, 3).join(" | ")})`);

const ok = real.length === 0 && media / wall > 0.99;
console.log(`\n  RESULT: ${ok
  ? `PASS - zero freezes in ${wall.toFixed(0)}s of steady playback, playhead tracked real time`
  : `FAIL - ${real.length} freeze(s), rate ${(media / wall).toFixed(3)}x`}`);
process.exit(ok ? 0 : 1);
