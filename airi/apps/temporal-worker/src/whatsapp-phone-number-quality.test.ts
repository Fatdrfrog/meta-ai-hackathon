import assert from "node:assert/strict";
import test from "node:test";

import { createPhoneNumberQualityUpdateHandler } from "./whatsapp-phone-number-quality.js";

function createHarness(options?: { updateErrorMessage?: string | null }) {
  const alerts: unknown[] = [];
  const infos: unknown[] = [];
  const updates: Array<{
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
    sourceId: string;
    workspaceId: string;
  }> = [];
  const warnings: unknown[] = [];
  const handlePhoneNumberQualityUpdate = createPhoneNumberQualityUpdateHandler({
    logger: {
      info: (message, context) => infos.push({ message, context }),
      warn: (message, context) => warnings.push({ message, context }),
    },
    now: () => new Date("2026-06-25T10:00:00.000Z"),
    publishWorkspaceAlert: async (params) => {
      alerts.push(params);
    },
    resolveWhatsAppSourcesByAccountIdentifiers: async () => [
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          waba_id: "waba-1",
          display_phone_number: "+15551234567",
        },
      },
    ],
    updateSourceCredentials: async (params) => {
      updates.push(params);
      return { errorMessage: options?.updateErrorMessage ?? null };
    },
  });

  return { alerts, handlePhoneNumberQualityUpdate, infos, updates, warnings };
}

test("does not emit processed side effects when source credential persistence fails", async () => {
  const { alerts, handlePhoneNumberQualityUpdate, infos, updates, warnings } =
    createHarness({ updateErrorMessage: "permission denied" });

  await handlePhoneNumberQualityUpdate({
    wabaId: "waba-1",
    value: {
      event: "DOWNGRADE",
      display_phone_number: "+1 555 123 4567",
      current_limit: "TIER_1K",
    },
  });

  assert.equal(alerts.length, 0);
  assert.equal(infos.length, 0);
  assert.equal(updates.length, 1);
  assert.deepEqual(warnings[0], {
    message: "phone_number_quality_update: source update failed",
    context: {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      event: "DOWNGRADE",
      error: "permission denied",
    },
  });
});

test("persists the current portfolio messaging limit from v25 webhook payloads", async () => {
  const { alerts, handlePhoneNumberQualityUpdate, updates } = createHarness();

  await handlePhoneNumberQualityUpdate({
    wabaId: "waba-1",
    value: {
      event: "UPGRADE",
      display_phone_number: "+1 555 123 4567",
      max_daily_conversations_per_business: "2000",
    },
  });

  assert.deepEqual(updates[0], {
    sourceId: "source-1",
    workspaceId: "workspace-1",
    currentCredentials: {
      waba_id: "waba-1",
      display_phone_number: "+15551234567",
    },
    credentials: {
      waba_id: "waba-1",
      display_phone_number: "+15551234567",
      phone_quality_last_event: "UPGRADE",
      phone_quality_last_event_at: "2026-06-25T10:00:00.000Z",
      whatsapp_business_manager_messaging_limit: "2000",
      phone_messaging_limit: "2000",
    },
  });
  assert.equal(alerts.length, 1);
});
