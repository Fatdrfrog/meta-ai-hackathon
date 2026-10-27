import assert from "node:assert/strict";
import test from "node:test";

import { persistWhatsAppMessageConversationLink } from "./whatsapp-message-conversation-link";

const params = {
  workspaceId: "workspace-1",
  messageId: "wamid-1",
  messageObjectId: "message-1",
  eventAt: new Date("2026-08-10T06:00:00.000Z"),
  conversationId: "conversation-1",
  direction: "inbound" as const,
  conversationSet: { workspaceId: "workspace-1" },
};

test("pending mutation failure rejects without attempting the conversation append", async () => {
  const operations: string[] = [];

  await assert.rejects(
    () =>
      persistWhatsAppMessageConversationLink(params, {
        applyPendingMutations: async () => {
          operations.push("pending-mutation");
          throw new Error("pending mutation unavailable");
        },
        appendMessage: async () => {
          operations.push("append");
        },
      }),
    /pending mutation unavailable/,
  );

  assert.deepEqual(operations, ["pending-mutation"]);
});

test("conversation append failure rejects after the pending mutation succeeds", async () => {
  const operations: string[] = [];

  await assert.rejects(
    () =>
      persistWhatsAppMessageConversationLink(params, {
        applyPendingMutations: async () => {
          operations.push("pending-mutation");
        },
        appendMessage: async () => {
          operations.push("append");
          throw new Error("conversation append unavailable");
        },
      }),
    /conversation append unavailable/,
  );

  assert.deepEqual(operations, ["pending-mutation", "append"]);
});

test("successful persistence applies pending mutations before the canonical append", async () => {
  const operations: Array<{ name: string; value: unknown }> = [];

  await persistWhatsAppMessageConversationLink(params, {
    applyPendingMutations: async (value) => {
      operations.push({ name: "pending-mutation", value });
    },
    appendMessage: async (conversationId, messageObjectId, options) => {
      operations.push({
        name: "append",
        value: { conversationId, messageObjectId, options },
      });
    },
  });

  assert.deepEqual(operations, [
    {
      name: "pending-mutation",
      value: {
        workspaceId: "workspace-1",
        messageId: "wamid-1",
        messageObjectId: "message-1",
        eventAt: new Date("2026-08-10T06:00:00.000Z"),
      },
    },
    {
      name: "append",
      value: {
        conversationId: "conversation-1",
        messageObjectId: "message-1",
        options: {
          lastMessageAt: new Date("2026-08-10T06:00:00.000Z"),
          direction: "inbound",
          set: { workspaceId: "workspace-1" },
        },
      },
    },
  ]);
});
