import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhatsAppWebhookProcessorRoutingKey,
  isWhatsAppCallWebhookPubSubField,
  parseWhatsAppWebhookPubSubMessage,
} from "./webhook-contracts";

test("keeps partitioned processor routing keys idempotent", () => {
  assert.equal(
    buildWhatsAppWebhookProcessorRoutingKey({
      baseKey: "phone-1:status:0123456789abcdef01234567",
      itemKind: "status",
    }),
    "phone-1:status:0123456789abcdef01234567",
  );
});

test("parses WhatsApp webhook Pub/Sub messages with required ids", () => {
  assert.deepEqual(
    parseWhatsAppWebhookPubSubMessage({
      eventId: "event-1",
      dedupeKey: "dedupe-1",
      field: "messages",
      orderingKey: "phone-1",
      receivedAt: "2026-06-19T10:00:00.000Z",
    }),
    {
      eventId: "event-1",
      dedupeKey: "dedupe-1",
      field: "messages",
      orderingKey: "phone-1",
      receivedAt: "2026-06-19T10:00:00.000Z",
      itemKind: null,
    },
  );
});

test("rejects WhatsApp webhook Pub/Sub messages without required ids", () => {
  assert.throws(
    () =>
      parseWhatsAppWebhookPubSubMessage({
        eventId: "event-1",
        field: "messages",
      }),
    /dedupeKey/,
  );
});

test("routes only calls field to the call Pub/Sub pipeline", () => {
  assert.equal(isWhatsAppCallWebhookPubSubField("calls"), true);
  assert.equal(isWhatsAppCallWebhookPubSubField("messages"), false);
  assert.equal(isWhatsAppCallWebhookPubSubField("statuses"), false);
});
