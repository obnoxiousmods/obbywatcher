import { expect, test } from "@playwright/test";

test("loads the viewer shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Live Fight Stream" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload stream" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Primary live.obnoxious.lol" })).toBeVisible();
});
