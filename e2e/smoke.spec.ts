import { expect, test } from "@playwright/test";

test("loads the viewer shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Live Fight Stream" })).toBeVisible();
  await expect(page.getByLabel("Theme")).toBeVisible();
  await expect(page.locator("select")).toHaveCount(0);
  await page.getByLabel("Theme").click();
  await expect(page.getByRole("listbox", { name: "Theme" }).getByRole("option")).toHaveCount(10);
  await page.keyboard.press("Escape");
  await expect(page.getByText("UFC schedule").first()).toBeVisible();
  await expect(page.locator(".featured-fight h3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  await expect(page.locator(".player-source-switcher")).toBeVisible();
  await expect(page.locator(".player-source-switcher .source-button").first()).toBeVisible();
});

test("renders accurate per-source viewer counts and status dots", async ({ page }) => {
  await page.route("https://s.obby.ca/api/public-streams", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        sources: [
          {
            id: "public-a",
            label: "Public A",
            url: "https://example.test/a.m3u8",
            playback_url: "/api/proxy-hls?url=https%3A%2F%2Fexample.test%2Fa.m3u8",
            enabled: true
          },
          {
            id: "public-b",
            label: "Public B",
            url: "https://example.test/b.m3u8",
            playback_url: "/api/proxy-hls?url=https%3A%2F%2Fexample.test%2Fb.m3u8",
            enabled: true
          },
          {
            id: "public-c",
            label: "Public C",
            url: "https://example.test/c.m3u8",
            playback_url: "/api/proxy-hls?url=https%3A%2F%2Fexample.test%2Fc.m3u8",
            enabled: true
          }
        ]
      })
    });
  });
  await page.route("https://s.obby.ca/api/public-source", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, sources: [] })
    });
  });
  await page.route("https://s.obby.ca/api/public-configured-sources", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        sources: [
          {
            id: "server-1",
            label: "Server 1 / Default",
            type: "managed-hls",
            index: 0,
            enabled: true,
            in_active_pool: true,
            in_process: true,
            preferred: true,
            state: "preferred",
            health: "green",
            viewer_count: 99,
            playback_url: "/hls/ufc.m3u8"
          }
        ],
        viewers: {
          total: 10,
          ttl_seconds: 45,
          by_source: {
            "server-1": 4,
            "public-a": 2,
            "public-b": 3,
            "public-c": 1
          },
          sources: [],
          updated_at: Date.now()
        }
      })
    });
  });
  await page.route("https://s.obby.ca/api/viewers", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        viewers: {
          total: 10,
          ttl_seconds: 45,
          by_source: {
            "server-1": 4,
            "public-a": 2,
            "public-b": 3,
            "public-c": 1
          },
          sources: [],
          updated_at: Date.now()
        }
      })
    });
  });
  await page.route("https://s.obby.ca/api/live", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: ""
    });
  });
  await page.route("https://s.obby.ca/api/proxy-hls**", async (route) => {
    await route.fulfill({
      contentType: "application/vnd.apple.mpegurl",
      body: "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4,\nseg1.ts\n"
    });
  });

  await page.goto("/");

  await expect(page.getByText("10 watching").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Server 1 \/ Default/ })).toContainText("4 watching");
  await expect(page.getByRole("button", { name: /Public A/ })).toContainText("2 watching");
  await expect(page.getByRole("button", { name: /Public B/ })).toContainText("3 watching");
  await expect(page.getByRole("button", { name: /Public C/ })).toContainText("1 watching");
  await expect(page.locator(".source-dots .source-dot")).toHaveCount(4);
});

test("theme picker applies pastel themes", async ({ page }) => {
  await page.goto("/");

  const defaultAccent = await page
    .locator(".app-shell")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--color-ow-lavender").trim());
  await page.getByLabel("Theme").click();
  await page.getByRole("option", { name: "Moon Mint" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "moonmint");
  const mintAccent = await page
    .locator(".app-shell")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--color-ow-lavender").trim());
  expect(mintAccent).not.toBe(defaultAccent);

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "moonmint");
});

test("custom controls expose diagnostics and keyboard mute", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByLabel("Player controls")).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  const menu = page.locator(".more-menu");
  await expect(menu.getByRole("button", { name: "Hard reconnect", exact: true })).toBeVisible();
  const mirrorPicker = menu.getByRole("button", { name: "Mirror", exact: true });
  await expect(mirrorPicker).toBeVisible();
  await mirrorPicker.click();
  await expect(menu.getByRole("listbox", { name: "Mirror" }).getByRole("option")).toHaveCount(3);
  await mirrorPicker.click();
  const protocolPicker = menu.getByRole("button", { name: "Protocol", exact: true });
  await expect(protocolPicker).toBeVisible();
  await protocolPicker.click();
  await expect(menu.getByRole("listbox", { name: "Protocol" }).getByRole("option")).toHaveCount(2);
  await expect(menu.getByRole("option", { name: /DASH/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /HLS/ })).toBeVisible();
  await protocolPicker.click();
  const diagnostics = page.getByLabel("Advanced diagnostics");
  const showStats = menu.getByRole("button", { name: "Show stats" });
  if (await showStats.isVisible()) await showStats.click();
  await expect(diagnostics).toContainText("Viewers");
  await expect(diagnostics).toContainText("Source");

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.locator(".player-shell").dispatchEvent("pointerdown");
  await page.getByRole("button", { name: "Volume" }).click();
  await expect(page.getByRole("group", { name: "Volume controls" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute" })).toBeVisible();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("KeyM");
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
});

test("double clicking the player toggles fullscreen", async ({ page }) => {
  await page.addInitScript(() => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: async function requestFullscreen() {
        fullscreenElement = this;
        Reflect.set(window, "__requestFullscreenCalls", Number(Reflect.get(window, "__requestFullscreenCalls") ?? 0) + 1);
        document.dispatchEvent(new Event("fullscreenchange"));
      }
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: async () => {
        fullscreenElement = null;
        Reflect.set(window, "__exitFullscreenCalls", Number(Reflect.get(window, "__exitFullscreenCalls") ?? 0) + 1);
        document.dispatchEvent(new Event("fullscreenchange"));
      }
    });
  });

  await page.goto("/");
  const player = page.locator(".player-shell");
  await expect(player).toBeVisible();
  const box = await player.boundingBox();
  expect(box).not.toBeNull();
  const doubleClickPoint = {
    x: Math.max(20, box!.width - 32),
    y: Math.max(24, Math.min(86, box!.height * 0.35))
  };

  await player.dblclick({ position: doubleClickPoint });
  await expect(player).toHaveClass(/is-fullscreen/);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__requestFullscreenCalls"))).toBe(1);
  await page.waitForTimeout(100);

  await player.dblclick({ position: doubleClickPoint });
  await expect(player).not.toHaveClass(/is-fullscreen/);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__exitFullscreenCalls"))).toBe(1);
});

test("fullscreen falls back to iOS video fullscreen APIs", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      value: false
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => null
    });
    Object.defineProperty(HTMLVideoElement.prototype, "webkitDisplayingFullscreen", {
      configurable: true,
      get() {
        return Boolean(Reflect.get(this, "__webkitFullscreen"));
      }
    });
    Object.defineProperty(HTMLVideoElement.prototype, "webkitPresentationMode", {
      configurable: true,
      get() {
        return Reflect.get(this, "__webkitPresentationMode") ?? "inline";
      }
    });
    Object.defineProperty(HTMLVideoElement.prototype, "webkitSetPresentationMode", {
      configurable: true,
      value(mode: string) {
        Reflect.set(this, "__webkitPresentationMode", mode);
        Reflect.set(this, "__webkitFullscreen", mode === "fullscreen");
        Reflect.set(
          window,
          "__webkitSetPresentationModeCalls",
          Number(Reflect.get(window, "__webkitSetPresentationModeCalls") ?? 0) + 1
        );
        this.dispatchEvent(new Event("webkitpresentationmodechanged"));
        this.dispatchEvent(new Event(mode === "fullscreen" ? "webkitbeginfullscreen" : "webkitendfullscreen"));
      }
    });
  });

  await page.goto("/");
  const player = page.locator(".player-shell");
  await expect(player).toBeVisible();

  await page.getByRole("button", { name: "Fullscreen" }).click();
  await expect(player).toHaveClass(/is-fullscreen/);
  await expect(page.getByRole("button", { name: "Exit fullscreen" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__webkitSetPresentationModeCalls"))).toBe(1);

  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect(player).not.toHaveClass(/is-fullscreen/);
  await expect(page.getByRole("button", { name: "Fullscreen" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__webkitSetPresentationModeCalls"))).toBe(2);
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
