import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveConversationReplySourceId,
  resolveWorkspaceChatSourceId,
} from "./conversation-reply-source";

const conversation = { workspaceId: "ws-a", sourceId: "src-a" };

test("uses the chat's live source while the chat is on this workspace", () => {
  const chat = { workspaceId: "ws-a", sourceId: "src-a-reconnected" };

  assert.equal(
    resolveConversationReplySourceId({
      workspaceId: "ws-a",
      conversation,
      chat,
    }),
    "src-a-reconnected",
  );
});

test("ignores a chat that another workspace's inbound message took over", () => {
  const chat = { workspaceId: "ws-b", sourceId: "src-b" };

  assert.equal(
    resolveWorkspaceChatSourceId({ workspaceId: "ws-a", conversation, chat }),
    null,
  );
  assert.equal(
    resolveConversationReplySourceId({
      workspaceId: "ws-a",
      conversation,
      chat,
    }),
    "src-a",
  );
});

test("compares against the conversation's workspace when none is given", () => {
  assert.equal(
    resolveConversationReplySourceId({
      conversation,
      chat: { workspaceId: "ws-b", sourceId: "src-b" },
    }),
    "src-a",
  );
});

test("returns null instead of another workspace's source", () => {
  assert.equal(
    resolveConversationReplySourceId({
      workspaceId: "ws-a",
      conversation: { workspaceId: "ws-a" },
      chat: { workspaceId: "ws-b", sourceId: "src-b" },
    }),
    null,
  );
});

test("keeps the chat's source when the chat has no workspace yet", () => {
  assert.equal(
    resolveConversationReplySourceId({
      workspaceId: "ws-a",
      conversation,
      chat: { sourceId: "src-legacy" },
    }),
    "src-legacy",
  );
});

test("falls back to the conversation's source without a chat source", () => {
  assert.equal(
    resolveConversationReplySourceId({
      workspaceId: "ws-a",
      conversation,
      chat: { workspaceId: "ws-a", sourceId: "  " },
    }),
    "src-a",
  );
  assert.equal(
    resolveConversationReplySourceId({ workspaceId: "ws-a", conversation }),
    "src-a",
  );
});
