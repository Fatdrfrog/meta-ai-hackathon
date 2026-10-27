import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "business-locations-browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  timeout: 90_000,
  outputDir: join(tmpdir(), "airi-business-locations-browser", "results"),
  use: {
    baseURL: "http://127.0.0.1:4180",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  webServer: {
    command: "node tests/business-locations-browser-server.mjs",
    cwd: join(__dirname, ".."),
    url: "http://127.0.0.1:4180/business-locations-browser.html",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
