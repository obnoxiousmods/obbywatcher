import { describe, expect, it } from "vitest";
import { ufcSchedule, ufcScheduleLastChecked, type UfcEvent } from "./ufcSchedule";

describe("ufcSchedule data integrity", () => {
  it("is a non-empty list", () => {
    expect(Array.isArray(ufcSchedule)).toBe(true);
    expect(ufcSchedule.length).toBeGreaterThan(0);
  });

  it("has a valid last-checked date", () => {
    expect(ufcScheduleLastChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(ufcScheduleLastChecked))).toBe(false);
  });

  it("has unique event ids", () => {
    const ids = ufcSchedule.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every event carries required fields with parseable ISO slot times", () => {
    for (const event of ufcSchedule as UfcEvent[]) {
      expect(event.id).toBeTruthy();
      expect(event.title).toBeTruthy();
      expect(Array.isArray(event.slots)).toBe(true);
      // Slots are optional (TBA cards may have none), but any present slot must
      // carry a label and a parseable ISO time.
      for (const slot of event.slots) {
        expect(slot.label).toBeTruthy();
        expect(Number.isNaN(Date.parse(slot.iso))).toBe(false);
      }
      if (event.mainCardIso) {
        expect(Number.isNaN(Date.parse(event.mainCardIso))).toBe(false);
      }
      if (event.dateIso) {
        expect(Number.isNaN(Date.parse(event.dateIso))).toBe(false);
      }
    }
  });
});
