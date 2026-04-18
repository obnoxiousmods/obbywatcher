import { expect, test } from "@playwright/test";

const layoutViewports = [
  { name: "small phone", width: 320, height: 720 },
  { name: "standard phone", width: 360, height: 740 },
  { name: "modern phone", width: 390, height: 844 },
  { name: "large phone", width: 430, height: 932 },
  { name: "small tablet", width: 540, height: 960 },
  { name: "phablet landscape width", width: 720, height: 960 },
  { name: "tablet portrait", width: 768, height: 1024 },
  { name: "large tablet portrait", width: 820, height: 1180 },
  { name: "tablet landscape", width: 900, height: 900 },
  { name: "small laptop", width: 1024, height: 768 },
  { name: "wide laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 1000 },
  { name: "wide desktop", width: 1920, height: 1080 },
  { name: "ultrawide canvas", width: 2560, height: 1440 }
];

const pickerViewports = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 1000 }
];

test.describe("responsive layout matrix", () => {
  for (const viewport of layoutViewports) {
    test(`${viewport.name} ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/");

      await expect(page.getByRole("heading", { name: "Live Fight Stream" })).toBeVisible();
      await expect(page.locator(".player-shell")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();

      const metrics = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing ${selector}`);
          const box = element.getBoundingClientRect();
          return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            right: box.right,
            bottom: box.bottom
          };
        };

        return {
          viewportWidth: document.documentElement.clientWidth,
          horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          topbar: rect(".topbar"),
          watch: rect(".watch"),
          player: rect(".player-shell"),
          controls: rect(".player-controls"),
          chat: rect(".chat-panel")
        };
      });

      expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1);
      expect(metrics.player.width).toBeGreaterThan(280);
      expect(metrics.player.height).toBeGreaterThan(160);
      expect(metrics.controls.x).toBeGreaterThanOrEqual(metrics.player.x - 1);
      expect(metrics.controls.right).toBeLessThanOrEqual(metrics.player.right + 1);
      expect(metrics.controls.bottom).toBeLessThanOrEqual(metrics.player.bottom + 1);

      if (viewport.width <= 720) {
        expect(metrics.topbar.height).toBeLessThanOrEqual(132);
      } else if (viewport.width < 900) {
        expect(metrics.topbar.height).toBeLessThanOrEqual(82);
      } else {
        expect(metrics.topbar.height).toBeLessThanOrEqual(76);
      }

      if (viewport.width >= 900) {
        expect(metrics.chat.x).toBeGreaterThan(metrics.watch.x + metrics.watch.width - 2);
        expect(Math.abs(metrics.chat.y - metrics.watch.y)).toBeLessThan(4);
      } else {
        expect(metrics.chat.y).toBeGreaterThan(metrics.watch.y + metrics.watch.height - 2);
      }
    });
  }

  for (const viewport of pickerViewports) {
    test(`theme picker stays inside viewport at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/");

      await page.getByLabel("Theme").click();
      const menu = page.getByRole("listbox", { name: "Theme" });
      await expect(menu.getByRole("option")).toHaveCount(10);

      const bounds = await menu.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          viewportWidth: document.documentElement.clientWidth,
          viewportHeight: window.innerHeight
        };
      });

      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    });
  }
});
