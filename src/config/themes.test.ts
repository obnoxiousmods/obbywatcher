import { describe, expect, it } from "vitest";
import { defaultThemeId, isThemeId, themeOptions } from "./themes";

describe("theme options", () => {
  it("keeps the pastel purple theme as the default with at least ten choices", () => {
    expect(defaultThemeId).toBe("lavender");
    expect(themeOptions).toHaveLength(10);
    expect(isThemeId("lavender")).toBe(true);
    expect(isThemeId("not-a-theme")).toBe(false);
  });
});
