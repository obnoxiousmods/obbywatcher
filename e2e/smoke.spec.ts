import { expect, test } from "@playwright/test";

test("loads the viewer shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Live Fight Stream" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hard reset" }).first()).toBeVisible();
  await expect(page.getByText("UFC schedule").first()).toBeVisible();
  await expect(page.getByText("Burns vs. Malott").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Primary live.obnoxious.lol" })).toBeVisible();
});

test("custom controls expose diagnostics and keyboard mute", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page.getByLabel("Advanced diagnostics")).toContainText("Shortcut map");

  await expect(page.getByRole("button", { name: "Mute" })).toBeVisible();
  await page.keyboard.press("KeyM");
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
});
