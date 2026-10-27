import type { Page, Request } from "@playwright/test";

function isQrEnsureDraftPost(request: Request): boolean {
  if (request.method() !== "POST") return false;
  try {
    const { pathname } = new URL(request.url());
    return /\/api\/scenarios\/[^/]+\/whatsapp-qr\/[^/]+$/.test(pathname);
  } catch {
    return false;
  }
}

function isQrCommandPost(request: Request): boolean {
  if (request.method() !== "POST") return false;
  return request.url().includes("/api/whatsapp/qr-entry-points/commands");
}

/** Tracks Meta/local provisioning POSTs that must stay off mount/open/select paths. */
export function trackWhatsAppQrProvisioningPosts(page: Page): {
  posts: string[];
  stop: () => void;
} {
  const posts: string[] = [];
  const onRequest = (request: Request) => {
    if (isQrCommandPost(request) || isQrEnsureDraftPost(request)) {
      posts.push(`${request.method()} ${request.url()}`);
    }
  };
  page.on("request", onRequest);
  return {
    posts,
    stop: () => page.off("request", onRequest),
  };
}

export async function openScenarioEditor(
  page: Page,
  params: { workspaceId: string; scenarioId: string }
): Promise<void> {
  await page.goto(
    `/panel/w/${params.workspaceId}/scenarios?scenarioId=${params.scenarioId}`
  );
  await page.waitForLoadState("networkidle");
}

export async function openWhatsAppQrDrawerFromCompact(page: Page): Promise<void> {
  const settings = page.locator(
    '[data-testid="scenario-trigger-node-compact"][data-entry-point-type="whatsapp_qr"] [data-testid="scenario-trigger-node-settings"]'
  );
  await settings.waitFor({ state: "visible", timeout: 30_000 });
  await settings.click();
  await page
    .locator('[data-testid="whatsapp-qr-entry-point-drawer"]')
    .waitFor({ state: "visible", timeout: 15_000 });
}
