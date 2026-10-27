import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationEventData } from "./conversation-lifecycle-webhook";

function currentReadyConversation() {
  return {
    _id: { toString: () => "507f1f77bcf86cd799439011" },
    createdAt: new Date("2026-08-10T17:00:00.000Z"),
    is_classified: true,
    classification_revision: 7,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 7,
      appliedRevision: 7,
    },
    classification_meta: {
      source_revision: 7,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-revision-7",
    },
    classification: { category: "Support", priority: "high" },
  };
}

test("builds the payload from the conversation and the event fields", () => {
  const before = Date.now();
  const payload = buildConversationEventData(currentReadyConversation(), {
    status: "closed",
    previous_status: "in_progress",
    channel: "web_widget",
    customer_phone: "visitor-1",
    resolution_kind: "customer_csat",
    resolution_time_seconds: 42,
  });
  const { updated_at: updatedAt, ...stable } = payload;

  assert.deepEqual(stable, {
    conversation_id: "507f1f77bcf86cd799439011",
    status: "closed",
    previous_status: "in_progress",
    channel: "web_widget",
    customer_phone: "visitor-1",
    classification: { category: "Support", priority: "high" },
    resolution_kind: "customer_csat",
    resolution_time_seconds: 42,
    created_at: "2026-08-10T17:00:00.000Z",
  });
  assert.equal(typeof updatedAt, "string");
  assert.ok(Date.parse(updatedAt ?? "") >= before - 1);
});

test("omits the classification own property unless it is current", () => {
  const conversation = currentReadyConversation();
  conversation.classification_state.status = "pending";

  const payload = buildConversationEventData(conversation, {
    status: "open",
    previous_status: "closed",
    channel: "instagram",
  });

  assert.equal(Object.hasOwn(payload, "classification"), false);
});

test("falls back to the build time when the conversation has no creation time", () => {
  const payload = buildConversationEventData(
    { _id: "conversation-1" },
    { status: "open", channel: "telegram" },
  );

  assert.equal(payload.conversation_id, "conversation-1");
  assert.equal(payload.created_at, payload.updated_at);
  assert.ok(!Number.isNaN(Date.parse(payload.created_at)));
});
