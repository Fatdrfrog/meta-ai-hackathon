import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "airi-chat-browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: join(tmpdir(), "airi-chat-browser", "results"),
  use: {
    baseURL: "http://127.0.0.1:4181",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  webServer: {
    command: "node tests/airi-chat-browser-server.mjs",
    cwd: join(__dirname, ".."),
    url: "http://127.0.0.1:4181/airi-chat-browser.html",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
