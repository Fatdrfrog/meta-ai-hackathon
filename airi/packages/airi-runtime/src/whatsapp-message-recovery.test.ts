import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhatsAppMessageRecovery,
  hasWhatsAppReferralContent,
  mergeWhatsAppReferral,
  recoverWhatsAppMessage,
} from "./whatsapp-message-recovery";

test("treats the stored all-null referral default as empty", () => {
  assert.equal(hasWhatsAppReferralContent(null), false);
  assert.equal(
    hasWhatsAppReferralContent({
      sourceId: null,
      sourceType: " ",
      campaignLabels: [],
      capturedAt: "2026-10-15T10:15:03.000Z",
    }),
    false,
  );
  assert.equal(hasWhatsAppReferralContent({ ctwaClid: "clid" }), true);
  assert.equal(hasWhatsAppReferralContent({ campaignLabels: ["a"] }), true);
});

const unavailable = {
  id: "wamid-1",
  type: "unsupported",
  unsupported: { type: "unknown" },
  errors: [{ code: 131060 }],
};
const text = { id: "wamid-1", type: "text", text: { body: "Medal please" } };
const raw = (message: unknown, eventType = "message") => ({
  provider: "whatsapp",
  eventType,
  payload: { message, direction: "inbound" },
});
const original = () => ({
  _id: "message-1",
  workspaceId: "workspace-1",
  direction: "inbound",
  text: "[WhatsApp message unavailable: open WhatsApp Business app to view]",
  rawSourcePayload: raw(unavailable),
});
const incoming = (eventType = "message") => ({
  text: "Medal please",
  rawSourcePayload: raw(text, eventType),
  whatsappReferral: {
    sourceId: "ad-1",
    ctwaClid: "click-1",
    campaignLabelStatus: "present",
    campaignLabels: [{ id: "medal" }],
  },
});

test("recovers the actual persisted live webhook envelope shape", () => {
  const livePayload = (message: unknown) => ({
    provider: "whatsapp",
    eventType: "message",
    payload: {
      object: "whatsapp_business_account",
      entry: {
        id: "waba-1",
        changes: [{ field: "messages", value: { messages: [message] } }],
      },
      direction: "inbound",
    },
  });
  const update = buildWhatsAppMessageRecovery(
    { ...original(), rawSourcePayload: livePayload(unavailable) },
    { text: "Medal please", rawSourcePayload: livePayload(text) },
  );
  assert.equal(update?.text, "Medal please");
  assert.deepEqual(update?.rawSourcePayload, livePayload(text));
});

test("recovers legacy payload.messages without depending on the current envelope writer", () => {
  const update = buildWhatsAppMessageRecovery(
    {
      ...original(),
      rawSourcePayload: { payload: { messages: [unavailable] } },
    },
    {
      text: "Medal please",
      rawSourcePayload: { payload: { messages: [text] } },
    },
  );
  assert.equal(update?.text, "Medal please");
});

for (const eventType of ["message", "history_message"]) {
  test(`upgrades an unavailable placeholder from ${eventType} without changing its identity`, () => {
    const update = buildWhatsAppMessageRecovery(
      original(),
      incoming(eventType),
    );
    assert.equal(update?.text, "Medal please");
    assert.deepEqual(update?.rawSourcePayload, raw(text, eventType));
    assert.equal((update?.whatsappReferral as any)?.sourceId, "ad-1");
    assert.match(String(update?.whatsappRecoveryRevision), /^[a-f0-9]{64}$/);
    assert.equal(update?._id, undefined);
  });
}

test("identical retries preserve the recovery revision and never downgrade to a late placeholder", () => {
  const recovered = {
    ...original(),
    ...buildWhatsAppMessageRecovery(original(), incoming()),
  };
  assert.equal(buildWhatsAppMessageRecovery(recovered, incoming()), null);
  assert.equal(buildWhatsAppMessageRecovery(recovered, original()), null);
});

test("Mongoose referral defaults do not turn ordinary duplicates into recovered events", () => {
  const stored = {
    ...original(),
    rawSourcePayload: raw(text),
    text: "Medal please",
  };
  assert.equal(
    buildWhatsAppMessageRecovery(stored, {
      ...stored,
      whatsappReferral: {
        sourceId: null,
        ctwaClid: null,
        sourceType: null,
        adAccountId: null,
      },
    }),
    null,
  );
  const referral = { sourceId: "ad-1", ctwaClid: null };
  assert.equal(
    buildWhatsAppMessageRecovery(
      { ...stored, whatsappReferral: referral },
      { ...stored, whatsappReferral: referral },
    ),
    null,
  );
});

test("a richer referral can recover routing without replacing already usable or edited text", () => {
  const stored = {
    ...original(),
    text: "The edited text",
    rawSourcePayload: raw(text),
    editMeta: { kind: "edit" },
  };
  const update = buildWhatsAppMessageRecovery(stored, incoming());
  assert.equal(update?.text, undefined);
  assert.equal((update?.whatsappReferral as any)?.sourceId, "ad-1");
  assert.ok(update?.whatsappRecoveryRevision);
});

test("does not resurrect a revoked message", () => {
  assert.equal(
    buildWhatsAppMessageRecovery(
      { ...original(), editMeta: { kind: "revoke" } },
      incoming(),
    ),
    null,
  );
});

test("preserves the first ad when its click id is missing", () => {
  const first = {
    sourceId: "first-ad",
    ctwaClid: null,
    campaignLabelStatus: "present",
    campaignLabels: [{ id: "first-label" }],
  };
  assert.deepEqual(
    mergeWhatsAppReferral(first, {
      sourceId: "second-ad",
      ctwaClid: "second-click",
    }),
    first,
  );
});

test("preserves confirmed labels on unavailable metadata while filling same-source missing fields", () => {
  const merged = mergeWhatsAppReferral(
    {
      sourceId: "ad-1",
      campaignLabelStatus: "present",
      campaignLabels: [{ id: "medal" }],
      adAccountId: "act-1",
      ctwaClid: null,
    },
    {
      sourceId: "ad-1",
      campaignLabelStatus: "unavailable",
      campaignLabels: [],
      adAccountId: null,
      ctwaClid: "click-1",
    },
  );
  assert.equal(merged?.campaignLabelStatus, "present");
  assert.deepEqual(merged?.campaignLabels, [{ id: "medal" }]);
  assert.equal(merged?.adAccountId, "act-1");
  assert.equal(merged?.ctwaClid, "click-1");
});

test("does not pair a known click with an unrelated ad", () => {
  assert.deepEqual(
    mergeWhatsAppReferral(
      { sourceId: null, ctwaClid: "first-click" },
      { sourceId: "ad-2", ctwaClid: "other-click" },
    ),
    { sourceId: null, ctwaClid: "first-click" },
  );
});

test("a concurrent winning upgrade is returned on retry without a second canonical write", async () => {
  let stored: Record<string, any> = original();
  let writes = 0;
  let raced = false;
  const result = await recoverWhatsAppMessage(stored, incoming(), {
    compareAndSwap: async (previous, set) => {
      if (!raced) {
        raced = true;
        stored = { ...stored, ...set };
        writes++;
        return null;
      }
      assert.fail("An identical winning revision must be a no-op");
    },
    read: async () => stored,
  });
  assert.equal(result.text, "Medal please");
  assert.equal(writes, 1);
  assert.ok(result.whatsappRecoveryRevision);
});

test("content and attribution races merge both improvements instead of overwriting either", async () => {
  let stored: Record<string, any> = original();
  let attempts = 0;
  const result = await recoverWhatsAppMessage(stored, incoming(), {
    compareAndSwap: async (_previous, set) => {
      attempts++;
      if (attempts === 1) {
        stored = {
          ...stored,
          text: "Medal please",
          rawSourcePayload: raw(text),
        };
        return null;
      }
      stored = { ...stored, ...set };
      return stored;
    },
    read: async () => stored,
  });
  assert.equal(result.text, "Medal please");
  assert.equal(result.whatsappReferral.sourceId, "ad-1");
  assert.equal(attempts, 2);
});

test("failed canonical persistence rejects so the durable event is retried", async () => {
  await assert.rejects(
    recoverWhatsAppMessage(original(), incoming(), {
      compareAndSwap: async () => {
        throw new Error("Mongo unavailable");
      },
      read: async () => original(),
    }),
    /Mongo unavailable/,
  );
});
