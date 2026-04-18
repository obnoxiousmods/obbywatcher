import { describe, expect, it } from "vitest";
import { getEventPhase, getScheduleBuckets, initialPlayerUiState, playerUiReducer } from "./playerControls";
import { ufcSchedule } from "../config/ufcSchedule";

describe("player controls", () => {
  it("clamps volume and unmutes when volume is restored", () => {
    const muted = playerUiReducer(initialPlayerUiState, { type: "set-volume", volume: 0 });
    expect(muted.volume).toBe(0);
    expect(muted.muted).toBe(true);

    const audible = playerUiReducer(muted, { type: "set-volume", volume: 2 });
    expect(audible.volume).toBe(1);
    expect(audible.muted).toBe(false);
  });

  it("toggles theater, stats, chat, and pinned controls independently", () => {
    const theater = playerUiReducer(initialPlayerUiState, { type: "toggle-theater" });
    const stats = playerUiReducer(theater, { type: "toggle-stats" });
    const chat = playerUiReducer(stats, { type: "toggle-chat" });
    const pinned = playerUiReducer(chat, { type: "toggle-pinned" });

    expect(pinned.theater).toBe(true);
    expect(pinned.statsOpen).toBe(true);
    expect(pinned.chatOpen).toBe(false);
    expect(pinned.controlsPinned).toBe(true);
  });
});

describe("UFC schedule helpers", () => {
  it("detects a live event window", () => {
    expect(getEventPhase(ufcSchedule[0], Date.parse("2026-04-18T22:00:00Z"))).toBe("Now");
    expect(getEventPhase(ufcSchedule[1], Date.parse("2026-04-18T22:00:00Z"))).toBe("Next");
  });

  it("returns current and upcoming events", () => {
    const buckets = getScheduleBuckets(ufcSchedule, Date.parse("2026-04-18T22:00:00Z"));

    expect(buckets.current?.id).toBe("ufc-fn-burns-malott");
    expect(buckets.next?.id).toBe("ufc-fn-sterling-zalal");
    expect(buckets.upcoming.length).toBeGreaterThan(2);
  });
});
