import { expect, test } from "@playwright/test";

test("loads the viewer shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Live Fight Stream" })).toBeVisible();
  await expect(page.getByText("UFC schedule").first()).toBeVisible();
  await expect(page.getByText("Burns vs. Malott").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Primary live.obnoxious.lol" })).toBeVisible();
});

test("custom controls expose diagnostics and keyboard mute", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByLabel("Player controls")).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  const menu = page.locator(".more-menu");
  await expect(menu.getByRole("button", { name: "Hard reconnect", exact: true })).toBeVisible();
  await expect(menu.getByText("Mirror", { exact: true })).toBeVisible();
  await menu.getByRole("button", { name: "Show stats" }).click();
  await expect(page.getByLabel("Advanced diagnostics")).toContainText("Shortcut map");

  await expect(page.getByRole("button", { name: "Mute" })).toBeVisible();
  await page.keyboard.press("KeyM");
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
});

test("desktop keeps chat beside the stream", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const watch = await page.locator(".watch").boundingBox();
  const chat = await page.locator(".chat-panel").boundingBox();
  expect(watch).not.toBeNull();
  expect(chat).not.toBeNull();
  expect(chat!.x).toBeGreaterThan(watch!.x + watch!.width - 2);
  expect(Math.abs(chat!.y - watch!.y)).toBeLessThan(4);
  expect(chat!.height).toBeGreaterThan(360);
});

test("mobile places chat immediately after the stream without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 960 });
  await page.goto("/");

  const watch = await page.locator(".watch").boundingBox();
  const chat = await page.locator(".chat-panel").boundingBox();
  expect(watch).not.toBeNull();
  expect(chat).not.toBeNull();
  expect(chat!.y).toBeGreaterThan(watch!.y + watch!.height - 2);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
