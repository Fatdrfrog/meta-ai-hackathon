import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testDir: "./tests/telegram",
  // Telegram Business E2E cases share one real chat and connection fixture.
  // Serial execution prevents one case from overwriting another case's Chat row.
  fullyParallel: false,
  workers: 1,
  globalSetup: "./tests/setup/telegram-global-setup",
  globalTeardown: "./tests/setup/telegram-global-teardown",
});
