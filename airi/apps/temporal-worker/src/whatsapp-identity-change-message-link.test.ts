import assert from "node:assert/strict";
import test from "node:test";

import { persistIdentityChangeMessageAndLink } from "./whatsapp-identity-change-message-link.js";

function identityMessageModel(existing: { _id: string } | null) {
  return {
    findOne() {
      return {
        select() {
          return {
            async exec() {
              return existing;
            },
          };
        },
      };
    },
    async create() {
      throw Object.assign(new Error("duplicate"), { code: 11000 });
    },
  };
}

test("identity-change duplicate repairs its canonical conversation link", async () => {
  const calls: unknown[][] = [];
  const result = await persistIdentityChangeMessageAndLink(
    {
      messageModel: identityMessageModel({ _id: "message-1" }),
      identityFilter: { messageId: "ws_numchg_1" },
      messageDocument: { messageId: "ws_numchg_1" },
      conversationId: "conversation-1",
      eventAt: new Date("2026-08-10T00:00:00.000Z"),
    },
    {
      appendMessage: async (...args) => {
        calls.push(args);
        return { appended: true };
      },
    },
  );

  assert.equal(result.created, false);
  assert.deepEqual(calls[0], [
    "conversation-1",
    "message-1",
    {
      lastMessageAt: new Date("2026-08-10T00:00:00.000Z"),
      direction: "inbound",
    },
  ]);
});

test("identity-change append failure propagates for webhook retry", async () => {
  const appendError = new Error("append unavailable");

  await assert.rejects(
    persistIdentityChangeMessageAndLink(
      {
        messageModel: identityMessageModel({ _id: "message-1" }),
        identityFilter: { messageId: "ws_numchg_1" },
        messageDocument: { messageId: "ws_numchg_1" },
        conversationId: "conversation-1",
        eventAt: new Date("2026-08-10T00:00:00.000Z"),
      },
      {
        appendMessage: async () => {
          throw appendError;
        },
      },
    ),
    appendError,
  );
});
