import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "whatsapp-templates-browser.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "line",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: join(tmpdir(), "airi-whatsapp-templates-browser", "results"),
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    actionTimeout: 20_000,
  },
  webServer: {
    command: "node tests/whatsapp-flows-browser-server.mjs",
    env: { WHATSAPP_BROWSER_SURFACE: "templates" },
    cwd: join(__dirname, ".."),
    url: "http://127.0.0.1:4179/whatsapp-templates-browser.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
