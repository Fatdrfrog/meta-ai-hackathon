import assert from "node:assert/strict";
import test from "node:test";

import { createWhatsAppUserPreferencesWebhookHandler } from "./whatsapp-user-preferences-handler";
import { createRecordingLogger } from "./testing/recording-logger";

test("marks matching WhatsApp conversations as opted out of marketing", async () => {
  const { logger } = createRecordingLogger();
  const upserts: unknown[] = [];
  const tryHandleWhatsAppUserPreferencesWebhook =
    createWhatsAppUserPreferencesWebhookHandler({
      resolveWhatsAppSourceByAccountIdentifiers: async () => ({
        id: "source-1",
        workspace_id: "workspace-1",
      }),
      upsertWhatsAppMarketingConsent: async (params) => {
        upserts.push(params);
        return {
          eventKey: "workspace-1:phone-1:77018607783:1780487066:stop",
          matchedConversations: 1,
          modifiedConversations: 1,
        };
      },
    });

  const response = await tryHandleWhatsAppUserPreferencesWebhook({
    body: {
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [] }],
    },
    change: {
      field: "user_preferences",
      value: {
        metadata: {
          phone_number_id: "phone-1",
        },
        contacts: [{ wa_id: "77018607783" }],
        user_preferences: [
          {
            wa_id: "77018607783",
            user_id: "bsuid-1",
            category: "marketing_messages",
            detail: "User requested to stop marketing messages",
            signup_id: "signup-1",
            messaging_customer_base_id: "base-1",
            value: "stop",
            timestamp: 1780487066,
          },
        ],
      },
    },
    requestLogger: logger,
  });

  assert.ok(response);
  assert.equal(
    (upserts[0] as Record<string, unknown>).eventKey,
    "workspace-1:phone-1:77018607783:1780487066:stop",
  );
  assert.equal(
    (upserts[0] as Record<string, unknown>).workspaceId,
    "workspace-1",
  );
  assert.equal((upserts[0] as Record<string, unknown>).sourceId, "source-1");
  assert.equal((upserts[0] as Record<string, unknown>).wabaId, "waba-1");
  assert.equal(
    (upserts[0] as Record<string, unknown>).phoneNumberId,
    "phone-1",
  );
  assert.equal((upserts[0] as Record<string, unknown>).waId, "77018607783");
  assert.equal((upserts[0] as Record<string, unknown>).userId, "bsuid-1");
  assert.equal((upserts[0] as Record<string, unknown>).status, false);
  assert.equal(
    (upserts[0] as Record<string, unknown>).source,
    "whatsapp_user_preferences",
  );
  assert.equal(
    (upserts[0] as Record<string, unknown>).metaSignupId,
    "signup-1",
  );
  assert.equal(
    (upserts[0] as Record<string, unknown>).messagingCustomerBaseId,
    "base-1",
  );
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "user_preferences processed",
    updatedConversations: 1,
    skippedPreferences: 0,
  });
});

test("uses user_id in event keys when Meta omits wa_id", async () => {
  const { logger } = createRecordingLogger();
  const upserts: unknown[] = [];
  const tryHandleWhatsAppUserPreferencesWebhook =
    createWhatsAppUserPreferencesWebhookHandler({
      resolveWhatsAppSourceByAccountIdentifiers: async () => ({
        id: "source-1",
        workspace_id: "workspace-1",
      }),
      upsertWhatsAppMarketingConsent: async (params) => {
        upserts.push(params);
        return {
          eventKey: "workspace-1:phone-1:user:bsuid-2:1780487067:resume",
          matchedConversations: 1,
          modifiedConversations: 1,
        };
      },
    });

  const response = await tryHandleWhatsAppUserPreferencesWebhook({
    body: {
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [] }],
    },
    change: {
      field: "user_preferences",
      value: {
        metadata: { phone_number_id: "phone-1" },
        contacts: [{ user_id: "bsuid-2" }],
        user_preferences: [
          {
            user_id: "bsuid-2",
            category: "marketing_messages",
            value: "resume",
            timestamp: 1780487067,
          },
        ],
      },
    },
    requestLogger: logger,
  });

  assert.ok(response);
  assert.equal(
    (upserts[0] as Record<string, unknown>).eventKey,
    "workspace-1:phone-1:user:bsuid-2:1780487067:resume",
  );
  assert.equal((upserts[0] as Record<string, unknown>).waId, null);
  assert.equal((upserts[0] as Record<string, unknown>).userId, "bsuid-2");
  assert.equal((upserts[0] as Record<string, unknown>).status, true);
});

test("keeps the webhook successful when the audit write fails", async () => {
  const { errors, logger } = createRecordingLogger();
  const tryHandleWhatsAppUserPreferencesWebhook =
    createWhatsAppUserPreferencesWebhookHandler({
      resolveWhatsAppSourceByAccountIdentifiers: async () => ({
        id: "source-1",
        workspace_id: "workspace-1",
      }),
      upsertWhatsAppMarketingConsent: async () => {
        throw new Error("Supabase unavailable");
      },
    });

  const response = await tryHandleWhatsAppUserPreferencesWebhook({
    body: {
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [] }],
    },
    change: {
      field: "user_preferences",
      value: {
        metadata: { phone_number_id: "phone-1" },
        contacts: [{ wa_id: "77018607783" }],
        user_preferences: [
          {
            wa_id: "77018607783",
            category: "marketing_messages",
            value: "stop",
            timestamp: 1780487068,
          },
        ],
      },
    },
    requestLogger: logger,
  });

  assert.ok(response);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "user_preferences processed",
    updatedConversations: 0,
    skippedPreferences: 0,
  });
  assert.equal(errors[0]?.[0], "WhatsApp opt-in audit write failed");
  assert.deepEqual(errors[0]?.[1], {
    workspaceId: "workspace-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    waId: "77018607783",
    userId: null,
    parentUserId: null,
    error: "Supabase unavailable",
  });
});
