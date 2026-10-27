import assert from "node:assert/strict";
import test from "node:test";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";

import {
  createTemplateMirrorRefresher,
  createWhatsAppTemplateLifecycleHandlers,
  type TemplateLifecycleDependencies,
  type TemplateMirrorRefresh,
} from "./whatsapp-template-lifecycle.js";

function createHarness(overrides: Partial<TemplateLifecycleDependencies> = {}) {
  const alerts: unknown[] = [];
  const audits: unknown[] = [];
  const refreshes: unknown[] = [];
  const infos: unknown[] = [];
  const retired: unknown[] = [];
  const updates: unknown[] = [];
  const warnings: unknown[] = [];

  const deps: TemplateLifecycleDependencies = {
    connectDB: async () => undefined,
    createTemplateAudit: async (params) => {
      audits.push(params);
    },
    findTemplateSnapshot: async () => ({
      _id: "template-row-1",
      components: [
        { type: "HEADER", text: "Old header" },
        { type: "BODY", text: "Old body" },
      ],
    }),
    logger: {
      info: (message, context) => infos.push({ message, context }),
      warn: (message, context) => warnings.push({ message, context }),
    },
    now: () => new Date("2026-07-08T10:00:00.000Z"),
    publishWorkspaceAlert: async (params) => {
      alerts.push(params);
    },
    refreshTemplateMirrors: async (params) => {
      refreshes.push(params);
      throw new Error("Meta unavailable");
    },
    resolveWhatsAppSourcesByAccountIdentifiers: async () => [
      {
        id: "source-1",
        workspace_id: "workspace-1",
      },
    ],
    retirePendingCampaignTasks: async (params) => {
      retired.push(params);
      return 2;
    },
    updateTemplateSnapshot: async (params) => {
      updates.push(params);
    },
    ...overrides,
  };

  return {
    alerts,
    audits,
    handlers: createWhatsAppTemplateLifecycleHandlers(deps),
    infos,
    refreshes,
    retired,
    updates,
    warnings,
  };
}

function createCatalogHarness(overrides: Partial<TemplateLifecycleDependencies> = {}) {
  const template: Record<string, unknown> = {
    id: "template-1",
    name: "promo",
    language: "en_US",
    status: "PENDING",
    category: "UTILITY",
    quality_rating: "GREEN",
    components: [{ type: "BODY", text: "Old body" }],
  };
  const identities: unknown[] = [];
  const harness = createHarness({
    patchTemplateCatalog: async params => {
      const { patch, remove, ...identity } = params;
      identities.push(identity);
      Object.assign(template, typeof patch === "function" ? patch(template as unknown as WhatsAppTemplate) : patch);
      if (remove) template.deleted = true;
    },
    ...overrides,
  });
  return { ...harness, template, identities };
}

for (const status of ["APPROVED", "PAUSED"]) {
  test(`patches the shared catalog immediately for ${status} even when Meta cannot be read`, async () => {
    const { handlers, identities, template } = createCatalogHarness();
    await handlers.handleTemplateStatusUpdate({
      wabaId: "waba-1",
      value: {
        event: status,
        message_template_id: "template-1",
        message_template_name: "promo",
        message_template_language: "en_US",
      },
    });
    assert.equal(template.status, status);
    assert.deepEqual(identities, [{
      workspaceId: "workspace-1", sourceId: "source-1", wabaId: "waba-1",
      templateId: "template-1", name: "promo", language: "en_US",
    }]);
  });
}

test("removes an unusable deleted template from the shared catalog", async () => {
  const { handlers, template, retired } = createCatalogHarness();
  await handlers.handleTemplateStatusUpdate({
    wabaId: "waba-1",
    value: { event: "DELETED", message_template_id: "template-1", message_template_name: "promo" },
  });
  assert.equal(template.deleted, true);
  assert.equal(retired.length, 1);
});

test("patches shared catalog content from the successful canonical mirror refresh", async () => {
  const components = [{ type: "BODY", text: "Full Meta body" }, { type: "FOOTER", text: "Meta footer" }];
  const { handlers, template } = createCatalogHarness({
    refreshTemplateMirrors: async () => ({ components }),
  });
  await handlers.handleTemplateComponentsUpdate({
    wabaId: "waba-1",
    value: { message_template_id: "template-1", message_template_name: "promo", message_template_element: "Partial event body" },
  });
  assert.deepEqual(template.components, components);
});

test("patches the shared catalog body from the authoritative event when the mirror cannot refresh", async () => {
  const { handlers, template } = createCatalogHarness();
  await handlers.handleTemplateComponentsUpdate({
    wabaId: "waba-1",
    value: { message_template_id: "template-1", message_template_name: "promo", message_template_element: "New body" },
  });
  assert.deepEqual(template.components, [{ type: "BODY", text: "New body" }]);
});

test("patches category and quality events in the shared catalog without changing approval", async () => {
  const { handlers, template } = createCatalogHarness();
  await handlers.handleTemplateCategoryUpdate({
    wabaId: "waba-1",
    value: { message_template_id: "template-1", message_template_name: "promo", new_category: "MARKETING" },
  });
  await handlers.handleTemplateQualityUpdate({
    wabaId: "waba-1",
    value: { message_template_id: "template-1", message_template_name: "promo", new_quality_score: "YELLOW" },
  });
  assert.equal(template.category, "MARKETING");
  assert.equal(template.quality_rating, "YELLOW");
  assert.equal(template.status, "PENDING");
});

test("does not patch the shared catalog for an ambiguous name without an id or language", async () => {
  const { handlers, identities, template } = createCatalogHarness();
  await handlers.handleTemplateStatusUpdate({
    wabaId: "waba-1",
    value: { event: "APPROVED", message_template_name: "promo" },
  });
  assert.deepEqual(identities, []);
  assert.equal(template.status, "PENDING");
});

test("preserves lifecycle updates and alerts when shared catalog coordination fails", async () => {
  const { handlers, updates, alerts, warnings } = createCatalogHarness({
    patchTemplateCatalog: async () => { throw new Error("Redis unavailable"); },
  });
  await handlers.handleTemplateStatusUpdate({
    wabaId: "waba-1",
    value: { event: "PAUSED", message_template_id: "template-1", message_template_name: "promo" },
  });
  assert.equal((updates[0] as { set: { status: string } }).set.status, "PAUSED");
  assert.equal(alerts.length, 1);
  assert.ok(warnings.some(warning => (warning as { message: string }).message === "WhatsApp template catalog patch failed"));
});

test("patches cached template BODY component text when Meta can't be read", async () => {
  const { audits, handlers, updates } = createHarness();

  await handlers.handleTemplateComponentsUpdate({
    wabaId: "waba-1",
    value: {
      message_template_id: 123,
      message_template_name: "promo",
      message_template_language: "en_US",
      message_template_element: "New body",
    },
  });

  assert.deepEqual(updates[0], {
    filter: { _id: "template-row-1" },
    set: {
      components: [
        { type: "HEADER", text: "Old header" },
        { type: "BODY", text: "New body" },
      ],
      lastSyncedAt: new Date("2026-07-08T10:00:00.000Z"),
    },
  });
  assert.deepEqual(audits[0], {
    workspaceId: "workspace-1",
    templateId: "123",
    templateName: "promo",
    action: "UPDATE",
    userId: "system:webhook",
    changes: {
      kind: "components_update",
      templateLanguage: "en_US",
      bodyTextChanged: true,
      refreshedFromMeta: false,
      raw: {
        message_template_id: 123,
        message_template_name: "promo",
        message_template_language: "en_US",
        message_template_element: "New body",
      },
    },
  });
});

test("retires pending campaign tasks and alerts on unusable template statuses", async () => {
  const { alerts, audits, handlers, retired, updates } = createHarness();

  await handlers.handleTemplateStatusUpdate({
    wabaId: "waba-1",
    value: {
      event: "REJECTED",
      message_template_id: "template-1",
      message_template_name: "promo",
      message_template_language: "en_US",
      reason: "INVALID_FORMAT",
    },
  });

  assert.deepEqual(updates[0], {
    filter: { workspaceId: "workspace-1", templateId: "template-1" },
    set: {
      status: "REJECTED",
      lastSyncedAt: new Date("2026-07-08T10:00:00.000Z"),
      rejected_reason: "INVALID_FORMAT",
    },
  });
  assert.deepEqual(retired, [
    {
      workspaceId: "workspace-1",
      templateName: "promo",
      templateLanguage: "en_US",
      reason: "template_rejected:INVALID_FORMAT",
    },
  ]);
  assert.equal((alerts[0] as { type?: string }).type, "critical");
  assert.equal(
    (alerts[0] as { metadata?: { retiredCampaignTasks?: number } }).metadata
      ?.retiredCampaignTasks,
    2,
  );
  assert.equal(
    (audits[0] as { changes?: { kind?: string } }).changes?.kind,
    "status_update",
  );
});

const META_COMPONENTS = [
  { type: "BODY", text: "Old body" },
  {
    type: "BUTTONS",
    buttons: [{ type: "QUICK_REPLY", text: "Choose" }],
  },
];

test("re-reads a template from Meta when its components change", async () => {
  const refreshes: unknown[] = [];
  const { audits, handlers, updates, warnings } = createHarness({
    refreshTemplateMirrors: async (params) => {
      refreshes.push(params);
      return { components: META_COMPONENTS };
    },
  });

  await handlers.handleTemplateComponentsUpdate({
    wabaId: "waba-1",
    value: {
      message_template_id: 123,
      message_template_name: "promo",
      message_template_language: "en_US",
      message_template_element: "Old body",
    },
  });

  assert.deepEqual(refreshes, [
    {
      keepStoredStatus: true,
      overrides: {},
      sourceId: "source-1",
      templateId: "123",
      wabaId: "waba-1",
      workspaceId: "workspace-1",
    },
  ]);
  // Meta's whole version is written, so the body-only patch is not.
  assert.deepEqual(updates, []);
  assert.deepEqual(warnings, []);
  const changes = (audits[0] as { changes: Record<string, unknown> }).changes;
  // A button-only edit keeps the body: the audit must not claim it changed.
  assert.equal(changes.bodyTextChanged, false);
  assert.equal(changes.refreshedFromMeta, true);
});

test("marks the body changed only when its text differs", async () => {
  const { audits, handlers } = createHarness({
    refreshTemplateMirrors: async () => ({
      components: [{ type: "BODY", text: "New body" }],
    }),
  });

  await handlers.handleTemplateComponentsUpdate({
    wabaId: "waba-1",
    value: {
      message_template_id: 123,
      message_template_name: "promo",
      message_template_element: "New body",
    },
  });

  assert.equal(
    (audits[0] as { changes: { bodyTextChanged?: boolean } }).changes
      .bodyTextChanged,
    true,
  );
});

test("writes the event's status over Meta's read-back on a status update", async () => {
  const refreshes: unknown[] = [];
  const { handlers, updates } = createHarness({
    refreshTemplateMirrors: async (params) => {
      refreshes.push(params);
      return {};
    },
  });

  await handlers.handleTemplateStatusUpdate({
    wabaId: "waba-1",
    value: {
      event: "APPROVED",
      message_template_id: "template-1",
      message_template_name: "promo",
      message_template_language: "en_US",
    },
  });

  assert.deepEqual(refreshes, [
    {
      keepStoredStatus: false,
      overrides: { status: "APPROVED" },
      sourceId: "source-1",
      templateId: "template-1",
      wabaId: "waba-1",
      workspaceId: "workspace-1",
    },
  ]);
  // The cache update still runs, so a failed read-back loses nothing.
  assert.equal(
    (updates[0] as { set: { status?: string } }).set.status,
    "APPROVED",
  );
});

test("keeps the cache status update when Meta can't be read", async () => {
  const { handlers, updates, warnings } = createHarness();

  await handlers.handleTemplateStatusUpdate({
    wabaId: "waba-1",
    value: {
      event: "APPROVED",
      message_template_id: "template-1",
      message_template_name: "promo",
    },
  });

  assert.equal(
    (updates[0] as { set: { status?: string } }).set.status,
    "APPROVED",
  );
  assert.equal(
    (warnings[0] as { message: string }).message,
    "template_status_update: template refresh from Meta failed",
  );
});

test("passes the new category to the refresh on a category update", async () => {
  const refreshes: unknown[] = [];
  const { handlers } = createHarness({
    refreshTemplateMirrors: async (params) => {
      refreshes.push(params);
      return {};
    },
  });

  await handlers.handleTemplateCategoryUpdate({
    wabaId: "waba-1",
    value: {
      message_template_id: 77,
      message_template_name: "promo",
      previous_category: "UTILITY",
      new_category: "MARKETING",
    },
  });

  assert.deepEqual(refreshes, [
    {
      keepStoredStatus: true,
      overrides: { category: "MARKETING", previous_category: "UTILITY" },
      sourceId: "source-1",
      templateId: "77",
      wabaId: "waba-1",
      workspaceId: "workspace-1",
    },
  ]);
});

test("does not read Meta for a webhook without a template id", async () => {
  const refreshes: unknown[] = [];
  const { handlers } = createHarness({
    refreshTemplateMirrors: async (params) => {
      refreshes.push(params);
      return {};
    },
  });

  await handlers.handleTemplateStatusUpdate({
    wabaId: "waba-1",
    value: { event: "APPROVED", message_template_name: "promo" },
  });

  assert.deepEqual(refreshes, []);
});

function createRefresherHarness(
  overrides: Partial<Parameters<typeof createTemplateMirrorRefresher>[0]> = {},
) {
  const fetched: unknown[] = [];
  const mirrored: unknown[] = [];
  const warnings: unknown[] = [];
  const refresh = createTemplateMirrorRefresher({
    fetchTemplate: async (params) => {
      fetched.push(params);
      return {
        id: "template-1",
        name: "promo",
        status: "PENDING",
        components: META_COMPONENTS,
      };
    },
    logger: {
      info: () => undefined,
      warn: (message, context) => warnings.push({ message, context }),
    },
    mirrorTemplate: async (params) => {
      mirrored.push(params);
      return { errors: [], snapshotUpdated: true };
    },
    readAccessToken: (credentials) =>
      (credentials as { token?: string } | undefined)?.token,
    resolveWhatsAppSourcesByAccountIdentifiers: async () => [
      {
        id: "source-0",
        workspace_id: "workspace-1",
        credentials: { token: "t0" },
      },
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: { token: "t1" },
      },
    ],
    ...overrides,
  });
  return { fetched, mirrored, refresh, warnings };
}

const REFRESH: TemplateMirrorRefresh = {
  keepStoredStatus: false,
  overrides: { status: "APPROVED" },
  sourceId: "source-1",
  templateId: "template-1",
  wabaId: "waba-1",
  workspaceId: "workspace-1",
};

test("reads the template with the token of the webhook's own source", async () => {
  const { fetched, mirrored, refresh } = createRefresherHarness();

  await refresh(REFRESH);

  assert.deepEqual(fetched, [{ accessToken: "t1", templateId: "template-1" }]);
  // The status event is newer than Meta's read-back.
  assert.equal(
    (mirrored[0] as { template: { status?: string } }).template.status,
    "APPROVED",
  );
});

test("leaves the stored status alone on events that are not about status", async () => {
  const { mirrored, refresh } = createRefresherHarness();

  await refresh({ ...REFRESH, keepStoredStatus: true, overrides: {} });

  assert.equal(
    "status" in (mirrored[0] as { template: object }).template,
    false,
  );
});

test("throws when the source has no token, so the handler falls back", async () => {
  const { refresh } = createRefresherHarness({
    resolveWhatsAppSourcesByAccountIdentifiers: async () => [
      { id: "source-1", workspace_id: "workspace-1", credentials: {} },
    ],
  });

  await assert.rejects(refresh(REFRESH), /access token not found/);
});

test("logs a copy it could not write but still reports Meta's version", async () => {
  const { refresh, warnings } = createRefresherHarness({
    mirrorTemplate: async () => ({
      errors: ["supabase down"],
      snapshotUpdated: true,
    }),
  });

  const template = await refresh(REFRESH);

  assert.deepEqual(template.components, META_COMPONENTS);
  assert.deepEqual(warnings, [
    {
      message: "WhatsApp template mirror write failed",
      context: {
        workspaceId: "workspace-1",
        templateId: "template-1",
        errors: ["supabase down"],
      },
    },
  ]);
});

test("reports an unknown body change when the cache held no snapshot", async () => {
  const { audits, handlers, infos } = createHarness({
    findTemplateSnapshot: async () => null,
    refreshTemplateMirrors: async () => ({
      components: META_COMPONENTS,
      snapshotUpdated: false,
    }),
  });

  await handlers.handleTemplateComponentsUpdate({
    wabaId: "waba-1",
    value: { message_template_id: 123, message_template_name: "promo" },
  });

  assert.equal(
    (audits[0] as { changes: { bodyTextChanged?: unknown } }).changes
      .bodyTextChanged,
    null,
  );
  const processed = infos.find(
    (entry) =>
      (entry as { message: string }).message ===
      "template_components_update processed",
  ) as { context: { updatedSnapshot?: boolean } };
  assert.equal(processed.context.updatedSnapshot, false);
});
