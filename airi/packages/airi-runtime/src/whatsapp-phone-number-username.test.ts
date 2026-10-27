import assert from "node:assert/strict";
import test from "node:test";

import { createWhatsAppPhoneNumberUsernameUpdateHandler } from "./whatsapp-phone-number-username";

function createLogger() {
  const entries: Array<{
    level: string;
    message: string;
    context?: Record<string, unknown>;
  }> = [];

  return {
    entries,
    logger: {
      info: (message: string, context?: Record<string, unknown>) => {
        entries.push({ level: "info", message, context });
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        entries.push({ level: "warn", message, context });
      },
      error: (
        message: string,
        _error?: Error | unknown,
        context?: Record<string, unknown>,
      ) => {
        entries.push({ level: "error", message, context });
      },
    },
  };
}

test("persists Meta business username aliases into source credentials", async () => {
  const { logger } = createLogger();
  const updates: unknown[] = [];
  const handlePhoneNumberUsernameUpdate =
    createWhatsAppPhoneNumberUsernameUpdateHandler({
      findWhatsAppSourceByDisplayPhoneNumber: async () => null,
      logger,
      now: () => new Date("2026-07-08T12:00:00.000Z"),
      resolveWhatsAppSourceByAccountIdentifiers: async () => ({
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          waba_id: "waba-1",
          business_username: {
            username: "old_username",
            status: "pending",
          },
        },
      }),
      updateSourceCredentials: async (params) => {
        updates.push(params);
        return { error: null };
      },
    });

  const result = await handlePhoneNumberUsernameUpdate({
    wabaId: "waba-1",
    value: {
      phone_number_id: "phone-1",
      business_username: "airi_support",
      requested_business_username: "airi_support",
      username_review_status: "approved",
    },
  });

  assert.deepEqual(result, { updated: true, sourceId: "source-1" });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    sourceId: "source-1",
    workspaceId: "workspace-1",
    currentCredentials: {
      waba_id: "waba-1",
      business_username: {
        username: "old_username",
        status: "pending",
      },
    },
    credentials: {
      waba_id: "waba-1",
      business_username: {
        username: "airi_support",
        status: "approved",
        event: null,
        phone_number_id: "phone-1",
        cs_id: null,
        display_phone_number: null,
        requested_username: "airi_support",
        rejection_reason: null,
        rejection_reasons: null,
        last_webhook_at: "2026-07-08T12:00:00.000Z",
        raw: {
          phone_number_id: "phone-1",
          business_username: "airi_support",
          requested_business_username: "airi_support",
          username_review_status: "approved",
        },
      },
    },
  });
});

test("falls back to display phone lookup when account identifiers are missing", async () => {
  const { logger } = createLogger();
  const lookups: string[] = [];
  const updates: unknown[] = [];
  const handlePhoneNumberUsernameUpdate =
    createWhatsAppPhoneNumberUsernameUpdateHandler({
      findWhatsAppSourceByDisplayPhoneNumber: async (displayPhoneNumber) => {
        lookups.push(displayPhoneNumber);
        return {
          id: "source-2",
          workspace_id: "workspace-2",
          credentials: {},
        };
      },
      logger,
      now: () => new Date("2026-07-08T12:00:00.000Z"),
      resolveWhatsAppSourceByAccountIdentifiers: async () => null,
      updateSourceCredentials: async (params) => {
        updates.push(params);
        return { error: null };
      },
    });

  const result = await handlePhoneNumberUsernameUpdate({
    value: {
      display_phone_number: "+7 701 111 2233",
      username: "airi_support",
      status: "reserved",
    },
  });

  assert.deepEqual(result, { updated: true, sourceId: "source-2" });
  assert.deepEqual(lookups, ["+7 701 111 2233"]);
  assert.equal(updates.length, 1);
});
