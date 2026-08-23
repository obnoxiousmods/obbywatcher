/**
 * Live UFC card data from the cockpit.
 *
 * The site used to ship `src/config/ufcSchedule.ts`, a file scraped from the
 * public Paramount+ page at build time and updated by hand. On 2026-08-22 it was
 * still advertising UFC 329 from July 11 -- six weeks stale -- while the cockpit
 * was actively streaming a different card. The two sources of truth could drift
 * apart indefinitely and nothing noticed.
 *
 * The cockpit already tracks the real card from the ESPN scoreboard, per bout,
 * because the auto-scheduler needs it to arm the encode. That is the same data,
 * live, and it is what actually drives the stream -- so the site cannot silently
 * disagree with the thing running it.
 *
 * The static file stays as a seed: if the cockpit is unreachable the page still
 * renders something rather than an empty panel.
 */

export type LiveCardSegment = {
  label: string;
  start: string;
  bouts: string[];
  bout_count: number;
  completed_bouts: number;
  all_final: boolean;
};

export type LiveEvent = {
  id: string;
  name: string;
  short_name: string;
  venue: string;
  city: string;
  main_event: string | null;
  winner: string | null;
  is_final: boolean;
  first_card_start: string | null;
  cards: LiveCardSegment[];
};

export type LiveScheduleUpcoming = { label: string; start: string };

export type LiveSchedule = {
  ok: boolean;
  event: LiveEvent | null;
  upcoming: LiveScheduleUpcoming[];
  phase?: string;
  countdown_seconds?: number | null;
  updated_at?: number;
};

/** Narrow an unknown payload; a malformed response must not blank the panel. */
export function parseLiveSchedule(value: unknown): LiveSchedule | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const rawEvent = body.event;
  let event: LiveEvent | null = null;
  if (rawEvent && typeof rawEvent === "object") {
    const e = rawEvent as Record<string, unknown>;
    const cards = Array.isArray(e.cards) ? e.cards : [];
    event = {
      id: String(e.id ?? ""),
      name: String(e.name ?? ""),
      short_name: String(e.short_name ?? e.name ?? ""),
      venue: String(e.venue ?? ""),
      city: String(e.city ?? ""),
      main_event: typeof e.main_event === "string" ? e.main_event : null,
      winner: typeof e.winner === "string" ? e.winner : null,
      is_final: Boolean(e.is_final),
      first_card_start: typeof e.first_card_start === "string" ? e.first_card_start : null,
      cards: cards
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c) => ({
          label: String(c.label ?? ""),
          start: String(c.start ?? ""),
          bouts: Array.isArray(c.bouts) ? c.bouts.map((b) => String(b)) : [],
          bout_count: Number(c.bout_count ?? 0) || 0,
          completed_bouts: Number(c.completed_bouts ?? 0) || 0,
          all_final: Boolean(c.all_final)
        }))
    };
    if (!event.name) event = null;
  }
  const upcoming = Array.isArray(body.upcoming) ? body.upcoming : [];
  return {
    ok: Boolean(body.ok),
    event,
    upcoming: upcoming
      .filter((u): u is Record<string, unknown> => Boolean(u) && typeof u === "object")
      .map((u) => ({ label: String(u.label ?? ""), start: String(u.start ?? "") }))
      .filter((u) => u.label && u.start),
    phase: typeof body.phase === "string" ? body.phase : undefined,
    countdown_seconds: typeof body.countdown_seconds === "number" ? body.countdown_seconds : null,
    updated_at: typeof body.updated_at === "number" ? body.updated_at : undefined
  };
}

/** Which segment is on air now, or the next one due. -1 when the card is done. */
export function activeSegmentIndex(cards: readonly LiveCardSegment[], nowMs: number) {
  if (!cards.length) return -1;
  // A segment is "current" from its start until the NEXT segment begins, so the
  // main card is highlighted for its whole duration rather than only at its
  // opening minute.
  for (let i = 0; i < cards.length; i += 1) {
    const start = Date.parse(cards[i].start);
    if (!Number.isFinite(start)) continue;
    const nextStart = i + 1 < cards.length ? Date.parse(cards[i + 1].start) : Number.POSITIVE_INFINITY;
    if (nowMs >= start && nowMs < nextStart) return i;
  }
  const firstStart = Date.parse(cards[0].start);
  if (Number.isFinite(firstStart) && nowMs < firstStart) return 0;
  return cards.length - 1;
}

/** Bouts remaining across the whole card, for an at-a-glance "how much is left". */
export function boutsRemaining(cards: readonly LiveCardSegment[]) {
  return cards.reduce((total, card) => total + Math.max(0, card.bout_count - card.completed_bouts), 0);
}
