import { expect, test } from "@playwright/test";

test("serves complete primary SEO metadata", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("ObbyWatcher | Live Fight Stream, Chat & HLS Mirror Player");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://live.obnoxious.lol/");
  await expect(page.locator('link[rel="alternate"]')).toHaveAttribute("href", "https://fight.nswfiles.com/");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /HLS playback, mirror failover, chat/
  );
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute("content", /boxing ring/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");

  const structuredData = await page.locator('script[type="application/ld+json"]').textContent();
  expect(structuredData).toContain('"@graph"');
  expect(structuredData).toContain('"WebApplication"');
  expect(structuredData).toContain('"ObbyWatcher"');
});

test("serves crawl support files", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain("Sitemap: https://live.obnoxious.lol/sitemap.xml");

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain("<loc>https://live.obnoxious.lol/</loc>");

  const manifest = await request.get("/site.webmanifest");
  expect(manifest.ok()).toBe(true);
  const manifestJson = await manifest.json();
  expect(manifestJson.name).toBe("ObbyWatcher");
  expect(manifestJson.categories).toContain("video");
});
