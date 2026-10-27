import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhatsAppInboundDedupeKey,
  buildWhatsAppReplyTextPreview,
  buildWhatsAppStoredReplyMeta,
  extractWhatsAppWamidFingerprint,
  findWhatsAppContextMessage,
  findWhatsAppMessageByWamidFingerprint,
  listWhatsAppMessageIdLookupKeys,
  normalizeWhatsAppMessageId,
  sanitizeWhatsAppUserFacingText,
  stripWhatsAppMessageIdPrefix,
  toWhatsAppGraphMessageId,
  type WhatsAppContextMessageModel,
} from "./message-id";

const PHONE_WAMID =
  "ws_wamid.HBgLNzc3NzM4NTk4MzAVAgASGBQyQTVGMkMxQUE0NzI3NTQzRjgzQQA=";
const BSUID_WAMID =
  "wamid.HBgTS1ouMTY5MjA3NDMzNTMzNzM3OBUUABIYFDJBNUYyQzFBQTQ3Mjc1NDNGODNBAA==";

test("normalizeWhatsAppMessageId adds ws_ prefix once", () => {
  assert.equal(normalizeWhatsAppMessageId("wamid.abc"), "ws_wamid.abc");
  assert.equal(normalizeWhatsAppMessageId("ws_wamid.abc"), "ws_wamid.abc");
});

test("new inbound dedupe enrollment uses the same normalized key for model and raw writers", () => {
  const base = {
    channel: "whatsapp",
    direction: "inbound",
    workspaceId: "workspace",
  };
  for (const messageId of ["wamid.abc", "ws_wamid.abc", "  wamid.abc  "]) {
    assert.equal(
      buildWhatsAppInboundDedupeKey({ ...base, messageId }),
      "ws_wamid.abc",
    );
  }
  for (const override of [
    { channel: "telegram" },
    { direction: "outbound" },
    { workspaceId: "" },
    { messageId: "" },
  ]) {
    assert.equal(
      buildWhatsAppInboundDedupeKey({
        ...base,
        messageId: "wamid.abc",
        ...override,
      }),
      undefined,
    );
  }
});

test("listWhatsAppMessageIdLookupKeys returns prefix variants", () => {
  assert.deepEqual(listWhatsAppMessageIdLookupKeys("wamid.abc"), [
    "wamid.abc",
    "ws_wamid.abc",
  ]);
});

test("extractWhatsAppWamidFingerprint matches phone and BSUID twins", () => {
  const phoneFingerprint = extractWhatsAppWamidFingerprint(PHONE_WAMID);
  const bsuidFingerprint = extractWhatsAppWamidFingerprint(BSUID_WAMID);
  assert.equal(phoneFingerprint, "2A5F2C1AA4727543F83A");
  assert.equal(bsuidFingerprint, phoneFingerprint);
});

test("findWhatsAppMessageByWamidFingerprint matches phone twin from BSUID context", () => {
  const parent = findWhatsAppMessageByWamidFingerprint(
    [
      { messageId: "ws_wamid.other", text: "nope" },
      { messageId: PHONE_WAMID, text: "140560. AP TREID" },
    ],
    BSUID_WAMID
  );
  assert.equal(parent?.text, "140560. AP TREID");
  assert.equal(
    findWhatsAppMessageByWamidFingerprint(
      [{ messageId: "ws_wamid.other" }],
      BSUID_WAMID
    ),
    null
  );
});

function recordingMessageModel(result: unknown) {
  const calls: Array<{ filter: Record<string, unknown>; fields: string }> = [];
  const Message: WhatsAppContextMessageModel = {
    findOne: (filter) => ({
      select: (fields) => {
        calls.push({ filter, fields });
        return { lean: async () => result };
      },
    }),
  };
  return { Message, calls };
}

test("findWhatsAppContextMessage matches the cited id, its prefix twin, or its wamid fingerprint", async () => {
  const outbound = { messageId: PHONE_WAMID, groundedReplyOptions: null };
  const { Message, calls } = recordingMessageModel(outbound);

  const found = await findWhatsAppContextMessage({
    Message,
    conversationId: "conversation-1",
    contextMessageId: ` ${BSUID_WAMID} `,
    direction: "outbound",
    select: "groundedReplyOptions",
  });

  assert.equal(found, outbound);
  assert.deepEqual(calls, [
    {
      filter: {
        conversation: "conversation-1",
        channel: "whatsapp",
        direction: "outbound",
        $or: [
          { messageId: { $in: [BSUID_WAMID, `ws_${BSUID_WAMID}`] } },
          { whatsappWamidFingerprint: "2A5F2C1AA4727543F83A" },
        ],
      },
      fields: "groundedReplyOptions",
    },
  ]);
});

test("findWhatsAppContextMessage skips the query without an id or a conversation", async () => {
  const { Message, calls } = recordingMessageModel({ messageId: "unused" });
  for (const params of [
    { conversationId: "conversation-1", contextMessageId: "  " },
    { conversationId: "conversation-1", contextMessageId: null },
    { conversationId: null, contextMessageId: "wamid.abc" },
  ]) {
    assert.equal(
      await findWhatsAppContextMessage({ Message, select: "text", ...params }),
      null,
    );
  }
  assert.equal(calls.length, 0);

  const missing = recordingMessageModel(undefined);
  assert.equal(
    await findWhatsAppContextMessage({
      Message: missing.Message,
      conversationId: "conversation-1",
      contextMessageId: "wamid.not-a-fingerprint",
      select: "text",
    }),
    null,
  );
  assert.deepEqual(missing.calls[0]?.filter, {
    conversation: "conversation-1",
    channel: "whatsapp",
    $or: [
      {
        messageId: {
          $in: ["wamid.not-a-fingerprint", "ws_wamid.not-a-fingerprint"],
        },
      },
    ],
  });
});

test("stripWhatsAppMessageIdPrefix and toWhatsAppGraphMessageId", () => {
  assert.equal(stripWhatsAppMessageIdPrefix("ws_wamid.abc"), "wamid.abc");
  assert.equal(toWhatsAppGraphMessageId("ws_wamid.abc"), "wamid.abc");
  assert.equal(toWhatsAppGraphMessageId("  "), undefined);
  assert.equal(toWhatsAppGraphMessageId(null), undefined);
});

test("buildWhatsAppReplyTextPreview prefers text then media placeholder", () => {
  assert.equal(
    buildWhatsAppReplyTextPreview({ text: " 140560. AP TREID " }),
    "140560. AP TREID"
  );
  assert.equal(
    buildWhatsAppReplyTextPreview({ text: " ", mediaType: "document" }),
    "[document attachment]"
  );
  assert.equal(buildWhatsAppReplyTextPreview({ text: null }), null);
  assert.equal(
    buildWhatsAppReplyTextPreview({
      text: '[Template: 1] with variables: ["stb:node-1"]',
    }),
    null
  );
  assert.equal(
    buildWhatsAppReplyTextPreview({
      text: "[Location] 51.1, 71.3",
    }),
    "51.1, 71.3"
  );
});

test("sanitizeWhatsAppUserFacingText strips storage markers", () => {
  assert.equal(
    sanitizeWhatsAppUserFacingText(
      '[Template: 1] with variables: ["stb:node-1782659071569-7-949:0"]',
    ),
    "",
  );
  assert.equal(
    sanitizeWhatsAppUserFacingText(" [Template: welcome] Hello "),
    "Hello",
  );
  assert.equal(
    sanitizeWhatsAppUserFacingText("[Location] 51.106003, 71.396172"),
    "51.106003, 71.396172",
  );
  assert.equal(sanitizeWhatsAppUserFacingText("stb:node-17:0"), "");
  assert.equal(sanitizeWhatsAppUserFacingText(null), "");
});

test("buildWhatsAppStoredReplyMeta snapshots normalized id + preview", () => {
  assert.deepEqual(
    buildWhatsAppStoredReplyMeta({
      replyToMessageId: "wamid.abc",
      parent: { text: "hello", mediaType: null },
    }),
    {
      replyToWhatsAppMessageId: "ws_wamid.abc",
      replyToTextPreview: "hello",
    }
  );
});
