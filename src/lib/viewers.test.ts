import { describe, expect, it } from "vitest";
import { totalViewerCount, viewerCountForSource } from "./viewers";

describe("viewer count helpers", () => {
  it("prefers per-source counts from by_source", () => {
    const viewers = {
      total: 8,
      by_source: { "server-1": 4 },
      sources: [{ id: "server-1", viewer_count: 12 }]
    };

    expect(viewerCountForSource(viewers, "server-1", 33)).toBe(4);
  });

  it("falls back to source entries, then provided fallback", () => {
    const viewers = {
      sources: [{ id: "public-a", viewer_count: 3 }]
    };

    expect(viewerCountForSource(viewers, "public-a", 0)).toBe(3);
    expect(viewerCountForSource(viewers, "missing", 7)).toBe(7);
  });

  it("uses explicit total when present", () => {
    expect(totalViewerCount({ total: 5, by_source: { a: 2, b: 2 } })).toBe(5);
  });

  it("sums by_source when total is missing", () => {
    expect(totalViewerCount({ by_source: { a: 2, b: 3 } })).toBe(5);
  });

  it("rejects invalid and negative counts", () => {
    expect(viewerCountForSource({ by_source: { a: -1 }, sources: [{ id: "a", viewer_count: 2 }] }, "a")).toBe(2);
    expect(totalViewerCount({ total: Number.NaN, by_source: { a: 1 } })).toBe(1);
  });
});
