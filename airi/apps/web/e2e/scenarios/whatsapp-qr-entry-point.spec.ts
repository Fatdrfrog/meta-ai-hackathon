import { devices, type Page } from "@playwright/test";
import { expect, test } from "../fixtures/auth";
import {
  openScenarioEditor,
  openWhatsAppQrDrawerFromCompact,
  trackWhatsAppQrProvisioningPosts,
} from "../fixtures/whatsapp-qr-network";

/**
 * Requires a Scenario that already contains a WhatsApp QR trigger node.
 * Env: TEST_WORKSPACE_ID, TEST_MANAGER_EMAIL, TEST_MANAGER_PASSWORD,
 * TEST_WHATSAPP_QR_SCENARIO_ID.
 */

type QrArtworkFormat = "png" | "svg";

async function downloadAndDecodeQrArtwork(
  page: Page,
  format: QrArtworkFormat
): Promise<string[]> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId(`whatsapp-qr-download-${format}`).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) {
    throw new Error(
      `WhatsApp QR ${format.toUpperCase()} download has no local path`
    );
  }

  const bytes = await (await import("node:fs/promises")).readFile(path);
  const image =
    format === "svg"
      ? await (await import("sharp")).default(bytes).png().toBuffer()
      : bytes;
  const { readBarcodes } = await import("zxing-wasm/reader");
  const symbols = await readBarcodes(image, {
    formats: ["QRCode"],
    maxNumberOfSymbols: 1,
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
  });
  return symbols.map(symbol => symbol.text);
}

test.describe("WhatsApp QR entry-point drawer", () => {
  test("desktop: mount/open drawer never POSTs ensure or commands", async ({
    authenticatedPage,
    qrEnv,
  }) => {
    const tracker = trackWhatsAppQrProvisioningPosts(authenticatedPage);
    try {
      await openScenarioEditor(authenticatedPage, qrEnv);
      expect(tracker.posts).toEqual([]);

      await openWhatsAppQrDrawerFromCompact(authenticatedPage);
      expect(tracker.posts).toEqual([]);

      await authenticatedPage.reload();
      await authenticatedPage.waitForLoadState("networkidle");
      expect(tracker.posts).toEqual([]);

      await openWhatsAppQrDrawerFromCompact(authenticatedPage);
      await expect(
        authenticatedPage.getByTestId("whatsapp-qr-entry-point-drawer")
      ).toBeVisible();
      expect(tracker.posts).toEqual([]);
    } finally {
      tracker.stop();
    }
  });

  test("mobile sheet: open drawer never POSTs ensure or commands", async ({
    browser,
    qrEnv,
  }) => {
    const context = await browser.newContext({
      ...devices["Pixel 5"],
      baseURL: qrEnv.appUrl,
    });
    const page = await context.newPage();
    try {
      await page.goto("/login");
      await page.fill('input[name="email"]', qrEnv.managerEmail);
      await page.fill('input[name="password"]', qrEnv.managerPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/panel/);

      const tracker = trackWhatsAppQrProvisioningPosts(page);
      try {
        await openScenarioEditor(page, qrEnv);
        await openWhatsAppQrDrawerFromCompact(page);
        await expect(
          page.getByTestId("whatsapp-qr-entry-point-drawer")
        ).toBeVisible();
        expect(tracker.posts).toEqual([]);
      } finally {
        tracker.stop();
      }
    } finally {
      await context.close();
    }
  });

  test("ready state: PNG/SVG downloads re-decode to matching deep link", async ({
    authenticatedPage,
    qrEnv,
  }) => {
    await openScenarioEditor(authenticatedPage, qrEnv);
    await openWhatsAppQrDrawerFromCompact(authenticatedPage);

    const ready = authenticatedPage.getByTestId("whatsapp-qr-drawer-ready");
    const empty = authenticatedPage.getByTestId("whatsapp-qr-drawer-empty");
    const codeState = await Promise.race([
      ready
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "ready" as const)
        .catch(() => "unavailable" as const),
      empty
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "empty" as const)
        .catch(() => "unavailable" as const),
    ]);
    if (codeState !== "ready") {
      throw new Error(
        "WhatsApp QR E2E fixture requires a CURRENT code; provision the scenario QR placement before running this command"
      );
    }

    const expectedLink = (
      await authenticatedPage
        .getByTestId("whatsapp-qr-test-link")
        .getAttribute("data-deep-link")
    )?.trim();
    if (!expectedLink) {
      throw new Error(
        "WhatsApp QR E2E fixture exposes a CURRENT code without a nonempty deep link"
      );
    }

    await expect(
      downloadAndDecodeQrArtwork(authenticatedPage, "png")
    ).resolves.toEqual([expectedLink]);
    await expect(
      downloadAndDecodeQrArtwork(authenticatedPage, "svg")
    ).resolves.toEqual([expectedLink]);
  });
});
