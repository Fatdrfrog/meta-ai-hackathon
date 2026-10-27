import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldQueueWhatsAppAiriIngress,
  shouldSuppressGeneralWhatsAppAiriReply,
} from "./webhook-automation-eligibility.js";

test("queues Airi ingress only for new inbound messages with chat and conversation", () => {
  assert.equal(
    shouldQueueWhatsAppAiriIngress({
      direction: "inbound",
      hasChat: true,
      hasConversation: true,
      messageType: "text",
      messageWasNew: true,
    }),
    true,
  );

  assert.equal(
    shouldQueueWhatsAppAiriIngress({
      direction: "outbound",
      hasChat: true,
      hasConversation: true,
      messageType: "text",
      messageWasNew: true,
    }),
    false,
  );

  assert.equal(
    shouldQueueWhatsAppAiriIngress({
      direction: "inbound",
      hasChat: true,
      hasConversation: true,
      messageType: "text",
      messageWasNew: false,
    }),
    false,
  );

  assert.equal(
    shouldQueueWhatsAppAiriIngress({
      direction: "inbound",
      hasChat: false,
      hasConversation: true,
      messageType: "text",
      messageWasNew: true,
    }),
    false,
  );

  assert.equal(
    shouldQueueWhatsAppAiriIngress({
      direction: "inbound",
      hasChat: true,
      hasConversation: false,
      messageType: "text",
      messageWasNew: true,
    }),
    false,
  );
});

test("does not queue Airi ingress for unsupported inbound messages", () => {
  assert.equal(
    shouldQueueWhatsAppAiriIngress({
      direction: "inbound",
      hasChat: true,
      hasConversation: true,
      messageType: "unsupported",
      messageWasNew: true,
    }),
    false,
  );
});

test("queues unavailable first-contact messages for scenario evaluation", () => {
  assert.equal(
    shouldQueueWhatsAppAiriIngress({
      direction: "inbound",
      hasChat: true,
      hasConversation: true,
      messageType: "unsupported",
      messageWasNew: true,
      messageErrors: [{ code: 131060 }],
      unsupportedType: "unknown",
    }),
    true,
  );
});

test("keeps unsupported mutations, other errors, duplicates and echoes out of ingress", () => {
  const unavailable = {
    direction: "inbound",
    hasChat: true,
    hasConversation: true,
    messageType: "unsupported",
    messageWasNew: true,
    messageErrors: [{ code: 131060 }],
    unsupportedType: "unknown",
  };
  for (const override of [
    { messageErrors: [{ code: 131051 }] },
    { messageErrors: [] },
    { unsupportedType: "edit" },
    { unsupportedType: "reaction" },
    { unsupportedType: "poll_update" },
    { messageWasNew: false },
    { direction: "outbound" },
    { hasChat: false },
    { hasConversation: false },
  ]) {
    assert.equal(
      shouldQueueWhatsAppAiriIngress({ ...unavailable, ...override }),
      false,
    );
  }
});

test("suppresses general AI replies only for unsupported messages", () => {
  assert.equal(
    shouldSuppressGeneralWhatsAppAiriReply({
      messageType: "unsupported",
    }),
    true,
  );

  assert.equal(
    shouldSuppressGeneralWhatsAppAiriReply({
      messageType: "text",
    }),
    false,
  );
});
