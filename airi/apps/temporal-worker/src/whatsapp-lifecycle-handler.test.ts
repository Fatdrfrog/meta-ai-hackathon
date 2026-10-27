import assert from "node:assert/strict";
import test from "node:test";

import {
  createWhatsAppLifecycleWebhookHandler,
  type WhatsAppLifecycleWebhookHandlerDependencies,
} from "@icecore/airi-runtime/whatsapp-lifecycle-handler";
import { createRecordingLogger } from "@icecore/airi-runtime/testing/recording-logger";

function createDependencies(
  overrides: Partial<WhatsAppLifecycleWebhookHandlerDependencies> = {},
) {
  const calls = {
    username: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{
      sourceId: string;
      workspaceId: string;
      currentCredentials: Record<string, unknown>;
      credentials: Record<string, unknown>;
    }>,
  };
  const noop = async () => undefined;
  const deps: WhatsAppLifecycleWebhookHandlerDependencies = {
    handleBusinessCapabilityUpdate: noop,
    handlePhoneNumberQualityUpdate: noop,
    handlePhoneNumberUsernameUpdate: async (params) => {
      calls.username.push(params);
    },
    handleTemplateCategoryUpdate: noop,
    handleTemplateComponentsUpdate: noop,
    handleTemplateQualityUpdate: noop,
    handleTemplateStatusUpdate: noop,
    mergeWhatsAppAccountHealthCredentials: (credentials) => ({
      ...credentials,
      mergedByHealthHelper: true,
    }),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    resolveWhatsAppSourcesByAccountIdentifiers: async () => [
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          phone_number_id: "phone-1",
          waba_id: "waba-1",
        },
      },
    ],
    updateSourceCredentials: async (params) => {
      calls.updates.push(params);
      return { error: null };
    },
    ...overrides,
  };

  return { calls, deps };
}

function webhookBody() {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [],
      },
    ],
  };
}

test("routes Meta business_username_updates webhooks to the business username handler", async () => {
  const { calls, deps } = createDependencies();
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppLifecycleWebhook =
    createWhatsAppLifecycleWebhookHandler(deps);
  const value = {
    business_username: "airi_support",
    metadata: {
      display_phone_number: "+15551234567",
      phone_number_id: "phone-1",
    },
    phone_number_id: "phone-1",
    status: "approved",
  };

  const response = await tryHandleWhatsAppLifecycleWebhook({
    body: webhookBody(),
    change: {
      field: "business_username_updates",
      value,
    },
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "business_username_updates processed",
  });
  assert.deepEqual(calls.username, [
    {
      wabaId: "waba-1",
      value,
    },
  ]);
  assert.deepEqual(calls.updates, []);
});

test("persists informational Meta lifecycle status events", async () => {
  const { calls, deps } = createDependencies();
  const { infos, logger } = createRecordingLogger();
  const tryHandleWhatsAppLifecycleWebhook =
    createWhatsAppLifecycleWebhookHandler(deps);
  const value = {
    event: "ACCOUNT_RESTRICTED",
    message: "Business requires attention",
    severity: "warning",
  };

  const response = await tryHandleWhatsAppLifecycleWebhook({
    body: webhookBody(),
    change: {
      field: "account_alerts",
      value,
    },
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "account_alerts processed",
  });
  assert.equal(calls.updates.length, 1);
  assert.deepEqual(calls.updates[0], {
    sourceId: "source-1",
    workspaceId: "workspace-1",
    currentCredentials: {
      phone_number_id: "phone-1",
      waba_id: "waba-1",
    },
    credentials: {
      account_alerts_last_event: "ACCOUNT_RESTRICTED",
      account_alerts_last_message: "Business requires attention",
      diagnostics_last_checked_at: "2026-01-02T03:04:05.000Z",
      mergedByHealthHelper: true,
      phone_number_id: "phone-1",
      waba_id: "waba-1",
      whatsapp_lifecycle_events: {
        account_alerts: {
          event: "ACCOUNT_RESTRICTED",
          field: "account_alerts",
          receivedAt: "2026-01-02T03:04:05.000Z",
          value,
        },
      },
      whatsapp_lifecycle_last_event_at: "2026-01-02T03:04:05.000Z",
      whatsapp_lifecycle_last_event_field: "account_alerts",
    },
  });
  assert.ok(
    infos.some(
      ([message, context]) =>
        message === "WhatsApp informational webhook persisted" &&
        context?.updated === 1,
    ),
  );
});

test("normalizes payment configuration events before persistence", async () => {
  const { calls, deps } = createDependencies();
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppLifecycleWebhook =
    createWhatsAppLifecycleWebhookHandler(deps);

  await tryHandleWhatsAppLifecycleWebhook({
    body: webhookBody(),
    change: {
      field: "payment_configuration_update",
      value: {
        event: "PAYMENT_METHOD_MISSING",
        message: "Business eligibility payment issue",
        status: "missing",
      },
    },
    requestLogger: logger,
  });

  assert.equal(calls.updates.length, 1);
  assert.equal(
    calls.updates[0]?.credentials.payment_configuration_status,
    "missing",
  );
  assert.equal(
    calls.updates[0]?.credentials.payment_configuration_last_event,
    "PAYMENT_METHOD_MISSING",
  );
  assert.equal(
    calls.updates[0]?.credentials.payment_configuration_message,
    "Business eligibility payment issue",
  );
});

test("returns null for non-lifecycle fields", async () => {
  const { deps } = createDependencies();
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppLifecycleWebhook =
    createWhatsAppLifecycleWebhookHandler(deps);

  const response = await tryHandleWhatsAppLifecycleWebhook({
    body: webhookBody(),
    change: {
      field: "messages",
      value: {},
    },
    requestLogger: logger,
  });

  assert.equal(response, null);
});

test("does not claim WhatsApp group webhook fields", async () => {
  const { calls, deps } = createDependencies();
  const { logger } = createRecordingLogger();
  const tryHandleWhatsAppLifecycleWebhook =
    createWhatsAppLifecycleWebhookHandler(deps);

  const response = await tryHandleWhatsAppLifecycleWebhook({
    body: webhookBody(),
    change: {
      field: "group_participants_update",
      value: {
        groups: [{ group_id: "group-1", type: "participants_added" }],
      },
    },
    requestLogger: logger,
  });

  assert.equal(response, null);
  assert.deepEqual(calls.updates, []);
});
