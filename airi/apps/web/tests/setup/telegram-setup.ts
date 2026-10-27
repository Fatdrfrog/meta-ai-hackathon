/**
 * Global setup for Telegram Business E2E tests
 */

import {
  cleanupTestBusinessConnection,
  setupTestBusinessConnection,
} from "../fixtures/telegram-api-helpers";
import { validateTestEnvironment } from "../fixtures/telegram-test-data";

async function globalSetup() {
  try {
    validateTestEnvironment();
  } catch (error) {
    throw error;
  }

  await setupTestBusinessConnection();

  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`
    );

    if (!response.ok) {
      throw new Error(`Telegram bot not accessible: ${response.statusText}`);
    }
  } catch (error) {
    throw error;
  }

  try {
    const baseURL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const response = await fetch(`${baseURL}/api/health`);

    if (!response.ok) {
      throw new Error(`Application not accessible: ${response.statusText}`);
    }
  } catch (error) {
    throw error;
  }
}

async function globalTeardown() {
  await cleanupTestBusinessConnection();
}

export { globalSetup, globalTeardown };
