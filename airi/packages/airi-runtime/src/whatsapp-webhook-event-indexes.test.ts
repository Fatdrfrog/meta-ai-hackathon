import assert from "node:assert/strict";
import test from "node:test";

import WhatsAppWebhookEvent from "./whatsapp-webhook-event-model";
import { ensureWhatsAppWebhookEventIndexes } from "./whatsapp-webhook-event-indexes";

test("managed webhook indexes retain the schema definitions and retry failed provisioning once for concurrent callers", async (t) => {
  let fail = true;
  const created: Array<{
    key: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  t.mock.method(
    WhatsAppWebhookEvent.collection,
    "createIndex",
    async (key: Record<string, unknown>, options: Record<string, unknown>) => {
      if (fail) {
        fail = false;
        throw new Error("provisioning unavailable");
      }
      created.push({ key, options });
      return "index";
    },
  );
  await assert.rejects(
    ensureWhatsAppWebhookEventIndexes(),
    /provisioning unavailable/,
  );
  await Promise.all([
    ensureWhatsAppWebhookEventIndexes(),
    ensureWhatsAppWebhookEventIndexes(),
  ]);
  await ensureWhatsAppWebhookEventIndexes();
  assert.deepEqual(
    created.map(
      ({ key, options }) =>
        options.name || Object.entries(key).flat().join("_"),
    ),
    [
      "whatsapp_history_capacity_paused",
      "whatsapp_history_import_receipts",
      "dedupeKey_1",
      "status_1_nextRetryAt_1",
      "whatsapp_webhook_events_payload_compaction",
      "whatsapp_webhook_events_stale_queued",
      "whatsapp_webhook_events_stale_processing",
      "phoneNumberId_1_field_1_createdAt_-1",
      "wabaId_1_field_1_createdAt_-1",
      "waacId_1_field_1_createdAt_-1",
    ],
  );
  const schemaIndexes = WhatsAppWebhookEvent.schema.indexes();
  // Retired after zero reads: nothing filters these fields.
  for (const retired of [
    { orderingKey: 1, createdAt: 1 },
    { messagingAccountId: 1, field: 1, createdAt: -1 },
    { orderingKey: 1 },
    { provider: 1 },
    { object: 1 },
  ]) {
    assert.equal(
      schemaIndexes.some(
        ([schemaKey]) => JSON.stringify(schemaKey) === JSON.stringify(retired),
      ),
      false,
    );
  }
  for (const { key, options } of created) {
    const schemaIndex = schemaIndexes.find(
      ([schemaKey]) =>
        JSON.stringify(Object.entries(schemaKey)) ===
        JSON.stringify(Object.entries(key)),
    );
    assert.ok(schemaIndex);
    assert.deepEqual(options, { ...schemaIndex[1], background: true });
  }
  assert.equal(
    created.find(({ key }) => "dedupeKey" in key)?.options.unique,
    true,
  );
});
