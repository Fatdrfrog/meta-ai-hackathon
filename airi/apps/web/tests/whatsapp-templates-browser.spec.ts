import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import en from "../messages/templates/en/page.json";
import ru from "../messages/templates/ru/page.json";
import kz from "../messages/templates/kz/page.json";

const template = {
  id: "browser-template",
  name: "boutique_saved_offer",
  language: "en",
  category: "MARKETING",
  status: "APPROVED",
  components: [
    { type: "BODY", text: "Boutique's saved offer is still visible." },
  ],
};
const catalog = {
  source: "live",
  stale: false,
  fetchedAt: "2026-10-06T10:00:00.000Z",
  wabaId: "browser-waba",
  refreshOutcome: "succeeded",
  retryAt: null,
};

async function boundaries(
  page: Page,
  options: { coldLimit?: boolean; empty?: boolean } = {}
) {
  const counts = { lists: 0, syncs: 0 };
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (
      message.type() === "error" &&
      !(
        options.coldLimit &&
        message.text() ===
          "Failed to load resource: the server responded with a status of 429 (Too Many Requests)"
      )
    )
      errors.push(message.text());
  });
  await page.route("**/api/whatsapp/templates?**", async route => {
    counts.lists++;
    await route.fulfill({
      status: options.coldLimit ? 429 : 200,
      json: options.coldLimit
        ? {
            code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
            providerCode: 80008,
            retryAt: new Date(Date.now() + 300_000).toISOString(),
            error: "Meta is limiting template refreshes.",
          }
        : {
            templates: options.empty ? [] : [template],
            catalog,
            wabaId: "browser-waba",
          },
    });
  });
  await page.route("**/__browser/templates/actions", async route => {
    const { operation } = route.request().postDataJSON();
    if (operation === "list") {
      await route.fulfill({
        json: {
          success: true,
          data: {
            templates: !options.empty
              ? [
                  {
                    id: "stored-row",
                    workspace_id: "browser-workspace",
                    name: template.name,
                    channel: "whatsapp",
                    status: "APPROVED",
                    whatsapp_template_id: template.id,
                    whatsapp_status: "APPROVED",
                    whatsapp_waba_id: "browser-waba",
                    whatsapp_data: {
                      language: "en",
                      status: "APPROVED",
                      category: "MARKETING",
                      metaTemplateId: template.id,
                      wabaId: "browser-waba",
                      components: template.components,
                    },
                  },
                ]
              : [],
          },
        },
      });
    } else if (operation === "sync") {
      counts.syncs++;
      await route.fulfill({
        json: {
          success: true,
          data: {
            synced: 0,
            errors: 0,
            templates: [template],
            wabaId: "browser-waba",
            catalog: {
              ...catalog,
              source: "cache",
              stale: true,
              refreshOutcome: "cooldown",
              retryAt: new Date(Date.now() + 300_000).toISOString(),
              providerCode: 80008,
            },
          },
        },
      });
    } else {
      await route.fulfill({
        json: {
          success: true,
          data: { id: template.id, status: "PENDING", success: true },
        },
      });
    }
  });
  await page.route("**/__browser/templates/database?**", route =>
    route.fulfill({ json: { data: [], error: null } })
  );
  await page.route("**/api/workspaces/**/otp/whatsapp-bindings", route =>
    route.fulfill({ json: { bindings: [] } })
  );
  return { counts, errors };
}

async function captureAndCheck(page: Page, name: string) {
  const directory = join(
    tmpdir(),
    "airi-whatsapp-templates-browser",
    "screenshots"
  );
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${name}.png`),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    )
  ).toBe(true);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} keeps the scenario picker usable with a cached catalog during cooldown`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { counts, errors } = await boundaries(page);
    await page.route("**/api/whatsapp/templates?**", async route => {
      counts.lists++;
      expect(new URL(route.request().url()).searchParams.has("_refresh")).toBe(
        false
      );
      await route.fulfill({
        json: {
          templates: [template],
          catalog: {
            ...catalog,
            source: "cache",
            stale: true,
            refreshOutcome: "cooldown",
            retryAt: new Date(Date.now() + 300_000).toISOString(),
          },
          wabaId: "browser-waba",
        },
      });
    });
    await page.goto("/whatsapp-templates-browser.html?surface=scenario");
    const picker = page.getByTestId("whatsapp-template-picker");
    await picker.click();
    const option = page.getByRole("option").filter({ hasText: template.name });
    await expect(option).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh", exact: true })
    ).toBeDisabled();
    await captureAndCheck(page, `${viewport.name}-scenario-picker`);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await picker.click();
    await expect(option).toBeVisible();
    await option.click();
    await expect(picker).toContainText(template.name);
    await expect(
      page.getByText(en.templates.alerts.savedTemplates, { exact: true })
    ).toBeVisible();
    expect(counts.lists).toBe(1);
    expect(errors).toEqual([]);
  });

  test(`${viewport.name} keeps a clear loading state until the catalog arrives`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { errors } = await boundaries(page);
    let release!: () => void;
    const ready = new Promise<void>(resolve => {
      release = resolve;
    });
    await page.route("**/api/whatsapp/templates?**", async route => {
      await ready;
      await route.fulfill({
        json: { templates: [template], catalog, wabaId: "browser-waba" },
      });
    });
    await page.goto("/whatsapp-templates-browser.html");
    await expect(page.locator("main .animate-pulse").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: en.templates.sync, exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByText(en.templates.noTemplates, { exact: true })
    ).toHaveCount(0);
    await captureAndCheck(page, `${viewport.name}-loading`);
    release();
    await expect(
      page.getByText(template.name, { exact: true }).first()
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`${viewport.name} preserves saved rows, local filters and the editor during a cooldown`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { counts, errors } = await boundaries(page);
    await page.goto("/whatsapp-templates-browser.html");
    await expect(
      page.getByText(template.name, { exact: true }).first()
    ).toBeVisible();
    const search = page.getByPlaceholder(en.templates.search);
    await search.fill("missing-template");
    await expect(
      page.getByText(en.templates.noTemplates, { exact: true })
    ).toBeVisible();
    await search.fill("");
    await page
      .getByRole("button", { name: en.templates.sync, exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: en.templates.alerts.savedTemplates })
    ).toBeVisible();
    await expect(
      page.getByText(template.name, { exact: true }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: en.templates.sync, exact: true })
    ).toBeDisabled();
    expect(counts).toEqual({ lists: 1, syncs: 1 });
    await page
      .getByRole("button", { name: new RegExp(`^${template.name}`) })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("dialog").getByRole("textbox").first()
    ).toBeVisible({ timeout: 30_000 });
    await captureAndCheck(page, `${viewport.name}-saved-template-editor`);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: en.templates.alerts.savedTemplates })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: en.templates.sync, exact: true })
    ).toBeDisabled();
    expect(counts).toEqual({ lists: 1, syncs: 1 });
    await captureAndCheck(page, `${viewport.name}-cooldown`);
    expect(errors).toEqual([]);
  });

  test(`${viewport.name} keeps locally stored rows on a cold rate limit`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { counts, errors } = await boundaries(page, { coldLimit: true });
    await page.goto("/whatsapp-templates-browser.html");
    await expect(
      page.getByText(template.name, { exact: true }).first()
    ).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: en.templates.alerts.savedTemplates })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: en.templates.create, exact: true })
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: en.templates.sync, exact: true })
    ).toBeDisabled();
    await captureAndCheck(page, `${viewport.name}-cold-limit`);
    expect(counts.lists).toBe(1);
    expect(errors).toEqual([]);
  });

  test(`${viewport.name} preserves the genuine empty state and keyboard access`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { errors } = await boundaries(page, { empty: true });
    await page.goto("/whatsapp-templates-browser.html");
    await expect(
      page.getByText(en.templates.noTemplates, { exact: true })
    ).toBeVisible();
    const search = page.getByPlaceholder(en.templates.search);
    await search.focus();
    await expect(search).toBeFocused();
    await page.keyboard.type("test");
    await expect(search).toHaveValue("test");
    await captureAndCheck(page, `${viewport.name}-empty`);
    expect(errors).toEqual([]);
  });
}

for (const [locale, messages] of [
  ["ru", ru],
  ["kz", kz],
] as const) {
  test(`${locale} localizes the saved-template warning`, async ({ page }) => {
    const { errors } = await boundaries(page, { coldLimit: true });
    await page.goto(`/whatsapp-templates-browser.html?locale=${locale}`);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: messages.templates.alerts.savedTemplates })
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
