import assert from "node:assert/strict";
import test from "node:test";

import {
  createWhatsAppBusinessCapabilityUpdateHandler,
  type WhatsAppBusinessCapabilityUpdateDependencies,
} from "@icecore/airi-runtime/whatsapp-business-capability";
import { createRecordingLogger } from "@icecore/airi-runtime/testing/recording-logger";

function createDependencies(
  overrides: Partial<WhatsAppBusinessCapabilityUpdateDependencies> = {},
) {
  const updates: Array<{
    sourceId: string;
    workspaceId: string;
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }> = [];
  const { infos, logger, warnings } = createRecordingLogger();
  const deps: WhatsAppBusinessCapabilityUpdateDependencies = {
    logger,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    resolveWhatsAppSourcesByAccountIdentifiers: async () => [
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          waba_id: "waba-1",
        },
      },
    ],
    updateSourceCredentials: async (params) => {
      updates.push(params);
      return { error: null };
    },
    ...overrides,
  };

  return { deps, infos, updates, warnings };
}

test("persists business and phone limits on all resolved WhatsApp sources", async () => {
  const { deps, infos, updates } = createDependencies();
  const handleBusinessCapabilityUpdate =
    createWhatsAppBusinessCapabilityUpdateHandler(deps);

  const result = await handleBusinessCapabilityUpdate({
    wabaId: "waba-1",
    value: {
      max_daily_conversations_per_business: "TIER_250",
      max_daily_conversation_per_phone: 250,
      max_phone_numbers_per_business: 2,
    },
  });

  assert.deepEqual(result, { updated: 1 });
  assert.deepEqual(updates, [
    {
      sourceId: "source-1",
      workspaceId: "workspace-1",
      currentCredentials: { waba_id: "waba-1" },
      credentials: {
        business_capability_last_event_at: "2026-01-02T03:04:05.000Z",
        business_capability_raw: {
          max_daily_conversation_per_phone: 250,
          max_daily_conversations_per_business: "TIER_250",
          max_phone_numbers_per_business: 2,
        },
        max_phone_numbers_per_business: 2,
        phone_messaging_limit: 250,
        waba_id: "waba-1",
        whatsapp_business_manager_messaging_limit: "TIER_250",
      },
    },
  ]);
  assert.ok(
    infos.some(
      ([message, context]) =>
        message === "business_capability_update processed" &&
        context?.sourceId === "source-1",
    ),
  );
});

test("skips empty WABA ids without resolving sources", async () => {
  let resolved = false;
  const { deps, warnings } = createDependencies({
    resolveWhatsAppSourcesByAccountIdentifiers: async () => {
      resolved = true;
      return [];
    },
  });
  const handleBusinessCapabilityUpdate =
    createWhatsAppBusinessCapabilityUpdateHandler(deps);

  const result = await handleBusinessCapabilityUpdate({
    wabaId: "",
    value: {},
  });

  assert.deepEqual(result, { updated: 0 });
  assert.equal(resolved, false);
  assert.equal(
    warnings[0]?.[0],
    "business_capability_update skipped (missing WABA id)",
  );
});

test("continues when one source update fails", async () => {
  const { deps, updates, warnings } = createDependencies({
    resolveWhatsAppSourcesByAccountIdentifiers: async () => [
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {},
      },
      {
        id: "source-2",
        workspace_id: "workspace-1",
        credentials: {},
      },
    ],
    updateSourceCredentials: async (params) => {
      updates.push(params);
      return params.sourceId === "source-1"
        ? { error: { message: "write failed" } }
        : { error: null };
    },
  });
  const handleBusinessCapabilityUpdate =
    createWhatsAppBusinessCapabilityUpdateHandler(deps);

  const result = await handleBusinessCapabilityUpdate({
    wabaId: "waba-1",
    value: {
      max_daily_conversations_per_business: "TIER_1K",
    },
  });

  assert.deepEqual(result, { updated: 1 });
  assert.equal(updates.length, 2);
  assert.deepEqual(warnings[0]?.[1], {
    error: "write failed",
    sourceId: "source-1",
    wabaId: "waba-1",
    workspaceId: "workspace-1",
  });
});
