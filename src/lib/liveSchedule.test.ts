import { describe, expect, it } from "vitest";
import { activeSegmentIndex, boutsRemaining, parseLiveSchedule, type LiveCardSegment } from "./liveSchedule";

const seg = (label: string, start: string, bouts = 3, completed = 0): LiveCardSegment => ({
  label, start, bouts: Array.from({ length: bouts }, (_, i) => `A${i} vs. B${i}`),
  bout_count: bouts, completed_bouts: completed, all_final: completed >= bouts
});

describe("parseLiveSchedule", () => {
  it("reads a full card with per-bout listings", () => {
    const parsed = parseLiveSchedule({
      ok: true,
      event: {
        id: "600060493", name: "UFC Fight Night: Hernandez vs. Rodrigues",
        short_name: "UFC Fight Night", venue: "Golden 1 Center", city: "Sacramento, USA",
        main_event: "Anthony Hernandez vs. Gregory Rodrigues", winner: null, is_final: false,
        first_card_start: "2026-08-22T21:00:00+00:00",
        cards: [
          { label: "Prelims", start: "2026-08-22T21:00:00+00:00",
            bouts: ["Elise Reed vs. Shanelle Dyer"], bout_count: 7, completed_bouts: 7, all_final: true },
          { label: "Main card", start: "2026-08-23T00:00:00+00:00",
            bouts: ["Anthony Wint vs. Terrance Chatman"], bout_count: 6, completed_bouts: 2, all_final: false }
        ]
      },
      upcoming: [{ label: "UFC 331", start: "2026-08-30T22:00:00+00:00" }]
    });
    expect(parsed?.event?.cards).toHaveLength(2);
    expect(parsed?.event?.cards[0].all_final).toBe(true);
    expect(parsed?.event?.cards[1].bouts[0]).toBe("Anthony Wint vs. Terrance Chatman");
    expect(parsed?.upcoming[0].label).toBe("UFC 331");
  });

  it("returns null for a non-object payload rather than throwing", () => {
    // A malformed response must not blank the panel or crash the page.
    expect(parseLiveSchedule(null)).toBeNull();
    expect(parseLiveSchedule("nope")).toBeNull();
  });

  it("drops an event with no name instead of rendering a blank card", () => {
    const parsed = parseLiveSchedule({ ok: true, event: { id: "x", cards: [] }, upcoming: [] });
    expect(parsed?.event).toBeNull();
  });

  it("survives missing and malformed fields", () => {
    const parsed = parseLiveSchedule({
      ok: true,
      event: { name: "UFC 999", cards: [{ label: "Main card" }, null, "junk"] },
      upcoming: [{ label: "ok", start: "2026-01-01T00:00:00Z" }, { label: "" }, null]
    });
    expect(parsed?.event?.cards).toHaveLength(1);
    expect(parsed?.event?.cards[0].bouts).toEqual([]);
    expect(parsed?.upcoming).toHaveLength(1);
  });

  it("reports a scheduler-down response as not ok but still usable", () => {
    const parsed = parseLiveSchedule({ ok: false, event: null, upcoming: [] });
    expect(parsed?.ok).toBe(false);
    expect(parsed?.event).toBeNull();
  });
});

describe("activeSegmentIndex", () => {
  const cards = [
    seg("Early prelims", "2026-08-22T19:00:00Z"),
    seg("Prelims", "2026-08-22T21:00:00Z"),
    seg("Main card", "2026-08-23T00:00:00Z")
  ];

  it("holds a segment until the NEXT one starts, not just at its opening minute", () => {
    expect(activeSegmentIndex(cards, Date.parse("2026-08-22T22:30:00Z"))).toBe(1);
    expect(activeSegmentIndex(cards, Date.parse("2026-08-23T01:30:00Z"))).toBe(2);
  });

  it("points at the first segment before the card opens", () => {
    expect(activeSegmentIndex(cards, Date.parse("2026-08-22T12:00:00Z"))).toBe(0);
  });

  it("stays on the last segment after the card ends", () => {
    expect(activeSegmentIndex(cards, Date.parse("2026-08-25T00:00:00Z"))).toBe(2);
  });

  it("returns -1 with no segments", () => {
    expect(activeSegmentIndex([], Date.now())).toBe(-1);
  });

  it("skips segments with an unparseable start", () => {
    const broken = [seg("Bad", "not-a-date"), seg("Main card", "2026-08-23T00:00:00Z")];
    expect(activeSegmentIndex(broken, Date.parse("2026-08-23T01:00:00Z"))).toBe(1);
  });
});

describe("boutsRemaining", () => {
  it("counts what is left across the whole card", () => {
    expect(boutsRemaining([seg("Prelims", "x", 7, 7), seg("Main card", "y", 6, 2)])).toBe(4);
  });

  it("never goes negative when more bouts complete than were listed", () => {
    expect(boutsRemaining([seg("Prelims", "x", 3, 5)])).toBe(0);
  });
});
