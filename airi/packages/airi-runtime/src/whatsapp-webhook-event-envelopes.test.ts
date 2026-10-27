import assert from "node:assert/strict";
import test from "node:test";

import { buildWhatsAppWebhookEventEnvelopes } from "./whatsapp-webhook-event-envelopes";
import WhatsAppWebhookEvent from "./whatsapp-webhook-event-model";

function buildMessagesPayload(messages: Array<Record<string, unknown>>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              messages,
            },
          },
        ],
      },
    ],
  };
}

test("partitions messages by hashed chat identity without exposing customer ids", () => {
  const body = buildMessagesPayload([
    { id: "wamid.1", from: "15550001", type: "text" },
    { id: "wamid.2", from: "15550001", type: "text" },
    { id: "wamid.3", from: "15550002", type: "text" },
  ]);
  const envelopes = buildWhatsAppWebhookEventEnvelopes({
    body,
    rawBody: JSON.stringify(body),
  });
  const keys = envelopes.map((event) => event.orderingKey);

  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.ok(keys.every((key) => /^phone-1:message:[a-f0-9]{24}$/.test(key)));
  assert.doesNotMatch(keys.join(" "), /1555000[12]/);
});

test("keeps delivery statuses for one provider message in one partition", () => {
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              statuses: [
                { id: "wamid.1", status: "sent" },
                { id: "wamid.1", status: "delivered" },
                { id: "wamid.2", status: "sent" },
              ],
            },
          },
        ],
      },
    ],
  };
  const envelopes = buildWhatsAppWebhookEventEnvelopes({
    body,
    rawBody: JSON.stringify(body),
  });
  const keys = envelopes.map((event) => event.orderingKey);

  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.ok(keys.every((key) => /^phone-1:status:[a-f0-9]{24}$/.test(key)));
  assert.doesNotMatch(keys.join(" "), /wamid/);
});

test("indexes stale processing recovery without scanning the event store", () => {
  const indexes = WhatsAppWebhookEvent.schema.indexes();
  const staleProcessingIndex = indexes.find(
    ([, options]) =>
      options.name === "whatsapp_webhook_events_stale_processing",
  );

  assert.deepEqual(staleProcessingIndex?.[0], {
    status: 1,
    processingStartedAt: 1,
  });
  assert.deepEqual(staleProcessingIndex?.[1]?.partialFilterExpression, {
    status: "processing",
    completedAt: null,
  });
});
