import { test as base, expect, type Page } from "@playwright/test";

export { expect };

export type QrE2eEnv = {
  appUrl: string;
  workspaceId: string;
  managerEmail: string;
  managerPassword: string;
  scenarioId: string;
};

const REQUIRED_QR_E2E_ENV = [
  "TEST_WORKSPACE_ID",
  "TEST_MANAGER_EMAIL",
  "TEST_MANAGER_PASSWORD",
  "TEST_WHATSAPP_QR_SCENARIO_ID",
] as const;

export function readQrE2eEnv(env: NodeJS.ProcessEnv = process.env): QrE2eEnv {
  const workspaceId = env.TEST_WORKSPACE_ID?.trim() || "";
  const managerEmail = env.TEST_MANAGER_EMAIL?.trim() || "";
  const managerPassword = env.TEST_MANAGER_PASSWORD?.trim() || "";
  const scenarioId = env.TEST_WHATSAPP_QR_SCENARIO_ID?.trim() || "";
  const missing = REQUIRED_QR_E2E_ENV.filter(name => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      "WhatsApp QR E2E requires TEST_WORKSPACE_ID, TEST_MANAGER_EMAIL, " +
        "TEST_MANAGER_PASSWORD, and TEST_WHATSAPP_QR_SCENARIO_ID. " +
        `Missing: ${missing.join(", ")}`
    );
  }
  return {
    appUrl: env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000",
    workspaceId,
    managerEmail,
    managerPassword,
    scenarioId,
  };
}

export const test = base.extend<{
  authenticatedPage: Page;
  qrEnv: QrE2eEnv;
}>({
  qrEnv: async ({}, use) => {
    const env = readQrE2eEnv();
    // Playwright fixture callback — not a React Hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright `use`
    await use(env);
  },

  authenticatedPage: async ({ page, qrEnv }, use) => {
    await page.goto("/login");
    await page.fill('input[name="email"]', qrEnv.managerEmail);
    await page.fill('input[name="password"]', qrEnv.managerPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/panel/);
    // Playwright fixture callback — not a React Hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright `use`
    await use(page);
  },
});

// Deployment A observers must reuse the authenticated manager fixture and never
// accept a raw token from a workflow environment.
export function assertAuthenticatedQrFixtureContract(): true {
  if (!REQUIRED_QR_E2E_ENV.every(name => name.startsWith("TEST_"))) {
    throw new Error("QR fixture credentials must be test-scoped");
  }
  return true;
}
