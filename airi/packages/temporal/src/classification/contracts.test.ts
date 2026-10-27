import assert from "node:assert/strict";
import test from "node:test";

import * as classificationContracts from "./contracts.ts";

type WakeData = {
  schemaVersion: 1;
  eventId: string;
  conversationId: string;
  requestedRevision: number;
  generation: number;
  requestedAt: string;
};

const contracts = classificationContracts as typeof classificationContracts & {
  CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION?: number;
  CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC_DEFAULT?: string;
  CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION_DEFAULT?: string;
  CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_TOPIC_DEFAULT?: string;
  CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_SUBSCRIPTION_DEFAULT?: string;
  buildConversationClassificationWakeEventId?: (input: {
    conversationId: string;
    requestedRevision: number;
    generation: number;
  }) => string;
  normalizeConversationClassificationWakeData?: (value: unknown) => WakeData;
};

const VALID_WAKE_DATA = {
  schemaVersion: 1,
  eventId: "conversation-classification:v1:conversation-1:r2:g3",
  conversationId: "conversation-1",
  requestedRevision: 2,
  generation: 3,
  requestedAt: "2026-08-10T10:15:30.000Z",
} as const;

test("exports the v1 classification wake defaults", () => {
  assert.equal(contracts.CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION, 1);
  assert.equal(
    contracts.CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC_DEFAULT,
    "icecore-conversation-classification-events",
  );
  assert.equal(
    contracts.CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION_DEFAULT,
    "icecore-conversation-classification-events-worker",
  );
  assert.equal(
    contracts.CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_TOPIC_DEFAULT,
    "icecore-conversation-classification-events-dlq",
  );
  assert.equal(
    contracts.CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_SUBSCRIPTION_DEFAULT,
    "icecore-conversation-classification-events-dlq-worker",
  );
});

test("normalizes only the exact classification wake payload", () => {
  const normalize = contracts.normalizeConversationClassificationWakeData;

  assert.equal(typeof normalize, "function");
  assert.deepEqual(normalize?.(VALID_WAKE_DATA), VALID_WAKE_DATA);
  assert.throws(
    () => normalize?.({ ...VALID_WAKE_DATA, workspaceId: "workspace-1" }),
    /fields/,
  );
  assert.throws(
    () => normalize?.({ ...VALID_WAKE_DATA, schemaVersion: 2 }),
    /schemaVersion/,
  );
});

test("rejects invalid classification wake identities and request time", () => {
  const normalize = contracts.normalizeConversationClassificationWakeData;

  for (const [field, value] of [
    ["conversationId", ""],
    ["conversationId", " conversation-1"],
    ["eventId", ""],
    ["eventId", "wrong-event-id"],
    ["requestedRevision", 0],
    ["requestedRevision", 1.5],
    ["generation", -1],
    ["generation", 2.5],
    ["requestedAt", "not-a-date"],
    ["requestedAt", "2026-08-10"],
  ] as const) {
    assert.throws(
      () => normalize?.({ ...VALID_WAKE_DATA, [field]: value }),
      new RegExp(field),
    );
  }
});

test("builds a deterministic event ID from version and durable identity", () => {
  const buildEventId = contracts.buildConversationClassificationWakeEventId;

  assert.equal(typeof buildEventId, "function");
  assert.equal(
    buildEventId?.({
      conversationId: "conversation-1",
      requestedRevision: 2,
      generation: 3,
    }),
    VALID_WAKE_DATA.eventId,
  );
  assert.notEqual(
    buildEventId?.({
      conversationId: "conversation-1",
      requestedRevision: 3,
      generation: 3,
    }),
    VALID_WAKE_DATA.eventId,
  );
  assert.notEqual(
    buildEventId?.({
      conversationId: "conversation-1",
      requestedRevision: 2,
      generation: 4,
    }),
    VALID_WAKE_DATA.eventId,
  );
});
