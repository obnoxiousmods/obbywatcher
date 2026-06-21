import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
const previewPort = new URL(baseURL).port || "4173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `npm run preview -- --port ${previewPort}`,
    url: baseURL,
    reuseExistingServer: true
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ]
});
