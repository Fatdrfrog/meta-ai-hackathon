import assert from "node:assert/strict";
import test from "node:test";

import {
  persistReplayWhatsAppMessageAndLink,
  recoverReplayWhatsAppMessageLinkIfExisting,
} from "./replay-whatsapp-message-link.js";

function messageQuery(results: Array<Record<string, unknown> | null>) {
  const filters: Record<string, unknown>[] = [];
  return {
    filters,
    findOne(filter: Record<string, unknown>) {
      filters.push(filter);
      return {
        select() {
          return {
            async lean() {
              return results.shift() ?? null;
            },
          };
        },
      };
    },
    collection: {
      async insertOne(_document?: Record<string, unknown>): Promise<unknown> {
        throw Object.assign(new Error("duplicate"), { code: 11000 });
      },
    },
  };
}

test("pre-context replay recovery links the persisted owner before skipping", async () => {
  const persisted = {
    _id: "message-1",
    conversation: "conversation-1",
    date: new Date("2026-08-01T00:00:00.000Z"),
    direction: "inbound",
    workspaceId: "workspace-1",
    sourceId: "source-1",
  };
  const appendCalls: unknown[][] = [];
  const messageModel = messageQuery([persisted]);

  const result = await recoverReplayWhatsAppMessageLinkIfExisting(
    {
      messageModel,
      normalizedMessageId: "ws_wamid.1",
      providerMessageId: "wamid.1",
      fallbackDate: new Date("2026-08-02T00:00:00.000Z"),
      fallbackWorkspaceId: "workspace-1",
      fallbackSourceId: "source-1",
    },
    {
      appendMessage: async (...args) => {
        appendCalls.push(args);
        return { appended: true };
      },
    },
  );

  assert.ok(result);
  assert.equal(messageModel.filters[0]?.workspaceId, "workspace-1");
  assert.equal(result.linkResult.appended, true);
  assert.deepEqual(appendCalls[0], [
    "conversation-1",
    "message-1",
    {
      lastMessageAt: new Date("2026-08-01T00:00:00.000Z"),
      direction: "inbound",
      historicalUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
      set: {
        workspaceId: "workspace-1",
        sourceId: "source-1",
      },
    },
  ]);
});

for (const direction of ["inbound", "outbound"]) {
  test(`raw ${direction} history insert enrolls dedupe and engagement recovery atomically`, async () => {
    const inserted: Record<string, unknown>[] = [];
    const messageModel = messageQuery([]);
    messageModel.collection.insertOne = async (
      document?: Record<string, unknown>,
    ) => {
      inserted.push(document!);
    };
    const messageDocument = {
      _id: "message-new",
      conversation: "conversation-1",
      workspaceId: "workspace-1",
      channel: "whatsapp",
      direction,
      messageId: "wamid.1",
      date: new Date("2026-08-01T00:00:00.000Z"),
    };
    await persistReplayWhatsAppMessageAndLink(
      {
        messageModel,
        messageDocument,
        normalizedMessageId: "ws_wamid.1",
        providerMessageId: "wamid.1",
        fallbackDate: messageDocument.date,
        fallbackWorkspaceId: "workspace-1",
        fallbackSourceId: "source-1",
        existingMessageKnownMissing: true,
      },
      { appendMessage: async () => ({ appended: true }) },
    );
    assert.equal(inserted.length, 1);
    assert.equal(
      inserted[0]?.whatsappInboundDedupeKey,
      direction === "inbound" ? "ws_wamid.1" : undefined,
    );
    assert.equal("whatsappInboundDedupeKey" in messageDocument, false);
    assert.equal(inserted[0]?.engagementRefreshPending, true);
    assert.equal("engagementRefreshPending" in messageDocument, false);
  });
}

for (const metadata of [
  { conversation: undefined, direction: "inbound" },
  { conversation: "conversation-1", direction: "invalid" },
]) {
  test(`raw history without canonical link metadata does not enroll engagement recovery: ${JSON.stringify(metadata)}`, async () => {
    const inserted: Record<string, unknown>[] = [];
    const messageModel = messageQuery([]);
    messageModel.collection.insertOne = async (document) => {
      inserted.push(document!);
    };
    await assert.rejects(
      persistReplayWhatsAppMessageAndLink(
        {
          messageModel,
          messageDocument: { _id: "message-new", ...metadata },
          normalizedMessageId: "ws_wamid.1",
          providerMessageId: "wamid.1",
          fallbackDate: new Date("2026-08-01T00:00:00.000Z"),
          fallbackWorkspaceId: "workspace-1",
          fallbackSourceId: "source-1",
          existingMessageKnownMissing: true,
        },
        { appendMessage: async () => ({ appended: true }) },
      ),
      /missing canonical link metadata/,
    );
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]?.engagementRefreshPending, undefined);
  });
}

test("post-insert duplicate race remains retryable when canonical link fails", async () => {
  const appendError = new Error("append unavailable");

  await assert.rejects(
    persistReplayWhatsAppMessageAndLink(
      {
        messageModel: messageQuery([
          {
            _id: "message-1",
            conversation: "conversation-1",
            date: new Date("2026-08-01T00:00:00.000Z"),
            direction: "outbound",
            workspaceId: "workspace-1",
            sourceId: "source-1",
          },
        ]),
        normalizedMessageId: "ws_wamid.1",
        providerMessageId: "wamid.1",
        messageDocument: { _id: "new-message" },
        existingMessageKnownMissing: true,
        fallbackDate: new Date("2026-08-02T00:00:00.000Z"),
        fallbackWorkspaceId: "workspace-1",
        fallbackSourceId: "source-1",
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
