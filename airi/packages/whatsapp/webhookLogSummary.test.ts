import assert from "node:assert/strict";
import test from "node:test";

import { buildWhatsAppWebhookLogSummary } from "./webhookLogSummary";

test("summarizes ad/referral and unsupported webhook context without PII", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-secret",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+7 708 260 9346",
                phone_number_id: "phone-secret",
              },
              contacts: [
                {
                  wa_id: "77082609346",
                  profile: { name: "Private Customer" },
                },
              ],
              messages: [
                {
                  from: "77082609346",
                  id: "wamid.private",
                  timestamp: "1780000000",
                  type: "unsupported",
                  unsupported: { type: "unknown" },
                  errors: [
                    {
                      code: 131060,
                      title: "Private error title",
                      message: "Private error message",
                    },
                  ],
                },
                {
                  from: "77082609346",
                  id: "wamid.private.referral",
                  timestamp: "1780000001",
                  type: "text",
                  text: { body: "Secret customer text" },
                  referral: {
                    source_type: "ad",
                    source_id: "ad-secret",
                    source_url: "https://www.instagram.com/p/private",
                    ctwa_clid: "clid-secret",
                    welcome_message: { text: "Secret welcome text" },
                  },
                },
              ],
              statuses: [
                {
                  id: "wamid.status.private",
                  recipient_id: "77082609346",
                  status: "read",
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const rawBody = JSON.stringify(payload);

  const summary = buildWhatsAppWebhookLogSummary({
    body: payload,
    rawBody,
  });

  assert.equal(summary.payloadObject, "whatsapp_business_account");
  assert.equal(summary.rawBodyBytes, rawBody.length);
  assert.equal(summary.entryCount, 1);
  assert.equal(summary.changeCount, 1);
  assert.deepEqual(summary.fieldCounts, { messages: 1 });
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.statusCount, 1);
  assert.equal(summary.contactCount, 1);
  assert.deepEqual(summary.messageTypeCounts, { text: 1, unsupported: 1 });
  assert.deepEqual(summary.statusCounts, { read: 1 });
  assert.equal(summary.unsupportedMessageCount, 1);
  assert.deepEqual(summary.unsupportedTypes, ["unknown"]);
  assert.deepEqual(summary.unsupportedErrorCodes, ["131060"]);
  assert.equal(summary.apiUnavailableUnsupportedCount, 1);
  assert.equal(summary.referralCount, 1);
  assert.deepEqual(summary.referralSourceTypes, ["ad"]);
  assert.deepEqual(summary.referralSourcePlatforms, ["instagram"]);
  assert.equal(summary.referralWithCtwaClidCount, 1);
  assert.equal(summary.referralWithWelcomeMessageCount, 1);
  assert.equal(summary.referralMissingOnUnsupportedCount, 1);
  for (const key of [
    "contacts",
    "messages",
    "metadata",
    "messaging_product",
    "statuses",
  ]) {
    assert.ok(summary.valueKeys.includes(key));
  }

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("Secret customer text"), false);
  assert.equal(serialized.includes("Secret welcome text"), false);
  assert.equal(serialized.includes("Private error title"), false);
  assert.equal(serialized.includes("Private error message"), false);
  assert.equal(serialized.includes("77082609346"), false);
  assert.equal(serialized.includes("phone-secret"), false);
  assert.equal(serialized.includes("wamid.private"), false);
  assert.equal(serialized.includes("ad-secret"), false);
  assert.equal(serialized.includes("clid-secret"), false);
  assert.equal(serialized.includes("private"), false);
});

test("normalizes direct co-existence events before summarizing history traffic", () => {
  const payload = {
    id: "direct-event-secret",
    event: "history",
    data: {
      metadata: { phone_number_id: "phone-secret" },
      history: [
        {
          metadata: { phase: 2, chunk_order: 1, progress: 100 },
          threads: [
            {
              id: "77082609346",
              messages: [
                {
                  id: "wamid.history.private",
                  from: "77082609346",
                  timestamp: "1780000000",
                  type: "text",
                  text: { body: "Private history body" },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const summary = buildWhatsAppWebhookLogSummary({
    body: payload,
    rawBody: JSON.stringify(payload),
  });

  assert.equal(summary.payloadObject, "whatsapp_business_account");
  assert.equal(summary.directEventName, "history");
  assert.equal(summary.entryCount, 1);
  assert.equal(summary.changeCount, 1);
  assert.deepEqual(summary.fieldCounts, { history: 1 });
  assert.equal(summary.historyCount, 1);
  assert.equal(summary.historyThreadCount, 1);
  assert.equal(summary.historyMessageCount, 1);
  assert.deepEqual(summary.messageTypeCounts, { text: 1 });

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("Private history body"), false);
  assert.equal(serialized.includes("77082609346"), false);
  assert.equal(serialized.includes("wamid.history.private"), false);
  assert.equal(serialized.includes("phone-secret"), false);
});
