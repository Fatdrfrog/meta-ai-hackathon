import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordWhatsAppMessageDeliveryStatus,
  type DeliveryEventUpsertParams,
  type LeanMessageForDelivery,
} from "./whatsapp-message-delivery.js";

function createHarness(message: LeanMessageForDelivery | null) {
  const deliveryEvents: DeliveryEventUpsertParams[] = [];
  const engagementRefreshes: Array<{
    conversationId: string;
    workspaceId: string;
    messageObjectId: string;
  }> = [];
  const messageUpdates: Array<{
    messageObjectId: string;
    update: Record<string, unknown>;
  }> = [];

  const recordWhatsAppMessageDeliveryStatus =
    createRecordWhatsAppMessageDeliveryStatus({
      connectDB: async () => undefined,
      findMessageByWhatsAppMessageId: async () => message,
      refreshConversationEngagement: async (params) => {
        engagementRefreshes.push(params);
      },
      updateMessageDelivery: async (params) => {
        messageUpdates.push(params);
        return true;
      },
      upsertDeliveryEvent: async (params) => {
        deliveryEvents.push(params);
      },
    });

  return {
    deliveryEvents,
    engagementRefreshes,
    messageUpdates,
    recordWhatsAppMessageDeliveryStatus,
  };
}

test("persists played status, infers missing delivery timestamps, and keeps group metadata", async () => {
  const eventAt = new Date("2026-06-22T10:15:00.000Z");
  const {
    deliveryEvents,
    engagementRefreshes,
    messageUpdates,
    recordWhatsAppMessageDeliveryStatus,
  } = createHarness({
    _id: "message-1",
    conversationId: "conversation-1",
    delivery: {},
  });

  const result = await recordWhatsAppMessageDeliveryStatus({
    workspaceId: "workspace_1",
    messageId: "wamid.voice-1",
    status: "played",
    eventAt,
    recipientId: "120363000000000000@g.us",
    recipientType: "group",
    recipientParticipantId: "15551234567",
    recipientIdentityKeyHash: "identity_hash_1",
    pricing: {
      category: "marketing_lite",
      type: "regular",
      pricing_model: "PMP",
    },
    conversation: undefined,
    rawStatus: { status: "played" },
  });

  assert.deepEqual(deliveryEvents[0], {
    workspaceId: "workspace_1",
    messageId: "wamid.voice-1",
    channel: "whatsapp",
    status: "played",
    eventAt,
    recipientId: "120363000000000000@g.us",
    recipientWaId: null,
    recipientUserId: null,
    recipientParentUserId: null,
    recipientUsername: null,
    recipientType: "group",
    recipientParticipantId: "15551234567",
    campaignId: null,
    phoneNumberId: null,
    sourceId: null,
    conversationId: "conversation-1",
    messageObjectId: "message-1",
    pricing: {
      category: "marketing_lite",
      type: "regular",
      pricing_model: "PMP",
    },
    conversation: null,
    errors: null,
    rawStatus: { status: "played" },
    providerStatus: "played",
    structured: {
      pricingBillable: null,
      pricingCategory: "marketing_lite",
      pricingType: "regular",
      pricingModel: "PMP",
      conversationCategory: null,
      conversationProviderId: null,
      conversationExpiresAt: null,
    },
    bizOpaqueCallbackData: null,
    recipientIdentityKeyHash: "identity_hash_1",
    errorCode: null,
    errorMessage: null,
  });
  assert.deepEqual(messageUpdates[0], {
    messageObjectId: "message-1",
    expectedStatus: null,
    expectedLastEventAt: null,
    update: {
      "delivery.status": "played",
      "delivery.lastEventAt": eventAt,
      "delivery.recipientId": "120363000000000000@g.us",
      "delivery.recipientWaId": null,
      "delivery.recipientUserId": null,
      "delivery.recipientParentUserId": null,
      "delivery.recipientUsername": null,
      "delivery.recipientType": "group",
      "delivery.recipientParticipantId": "15551234567",
      "delivery.recipientIdentityKeyHash": "identity_hash_1",
      "delivery.pricingCategory": "marketing_lite",
      "delivery.pricingType": "regular",
      "delivery.pricingModel": "PMP",
      "delivery.playedAt": eventAt,
      "delivery.readAt": eventAt,
      "delivery.deliveredAt": eventAt,
      "delivery.sentAt": eventAt,
    },
  });
  assert.deepEqual(engagementRefreshes, [
    { conversationId: "conversation-1", workspaceId: "workspace_1", messageObjectId: "message-1" },
  ]);
  assert.deepEqual(result, {
    recorded: true,
    status: "played",
    eventStatus: "played",
    messageFound: true,
    messageDeliveryUpdated: true,
    conversationId: "conversation-1",
    messageObjectId: "message-1",
    delivery: {
      status: "played",
      lastEventAt: eventAt,
      recipientId: "120363000000000000@g.us",
      recipientWaId: null,
      recipientUserId: null,
      recipientParentUserId: null,
      recipientUsername: null,
      recipientType: "group",
      recipientParticipantId: "15551234567",
      recipientIdentityKeyHash: "identity_hash_1",
      pricingCategory: "marketing_lite",
      pricingType: "regular",
      pricingModel: "PMP",
      playedAt: eventAt,
      readAt: eventAt,
      deliveredAt: eventAt,
      sentAt: eventAt,
    },
    chatId: null,
  });
});

test("returns the stored message's chat for BSUID enrichment", async () => {
  const { recordWhatsAppMessageDeliveryStatus } = createHarness({
    _id: "message-1",
    conversationId: "conversation-1",
    chatId: "wa_15551234567",
    delivery: {
      status: "delivered",
      lastEventAt: new Date("2026-06-22T10:00:00.000Z"),
      recipientUserId: "KZ.1234567890",
    },
  });

  const result = await recordWhatsAppMessageDeliveryStatus({
    workspaceId: "workspace_1",
    messageId: "wamid.campaign-1",
    status: "read",
    eventAt: new Date("2026-06-22T10:05:00.000Z"),
    recipientUserId: "KZ.1234567890",
  });

  assert.equal(result.chatId, "wa_15551234567");
  assert.equal(result.delivery?.recipientUserId, "KZ.1234567890");
});

test("stores unknown provider statuses without mutating the message delivery state", async () => {
  const eventAt = new Date("2026-06-22T10:16:00.000Z");
  const {
    deliveryEvents,
    messageUpdates,
    recordWhatsAppMessageDeliveryStatus,
  } = createHarness({
    _id: "message-1",
    conversationId: "conversation-1",
    delivery: { status: "read", readAt: eventAt },
  });

  const result = await recordWhatsAppMessageDeliveryStatus({
    workspaceId: "workspace_1",
    messageId: "wamid.future-1",
    status: "displayed",
    eventAt,
    rawStatus: { status: "displayed" },
  });

  assert.equal(deliveryEvents[0]?.status, "unknown");
  assert.equal(deliveryEvents[0]?.providerStatus, "displayed");
  assert.deepEqual(deliveryEvents[0]?.rawStatus, { status: "displayed" });
  assert.equal(messageUpdates.length, 0);
  assert.equal(result.status, null);
  assert.equal(result.eventStatus, "unknown");
  assert.equal(result.messageDeliveryUpdated, false);
  assert.deepEqual(result.delivery, { status: "read", readAt: eventAt });
});

test("records a late failed event without replacing a successful delivery state", async () => {
  const readAt = new Date("2026-06-22T10:17:00.000Z");
  const failedAt = new Date("2026-06-22T10:18:00.000Z");
  const {
    deliveryEvents,
    messageUpdates,
    recordWhatsAppMessageDeliveryStatus,
  } = createHarness({
    _id: "message-1",
    conversationId: "conversation-1",
    delivery: { status: "played", readAt },
  });

  const result = await recordWhatsAppMessageDeliveryStatus({
    workspaceId: "workspace_1",
    messageId: "wamid.failed-1",
    status: "failed",
    eventAt: failedAt,
    errors: [{ code: 131047, message: "Window expired" }],
  });

  assert.equal(deliveryEvents[0]?.status, "failed");
  assert.equal(deliveryEvents[0]?.errorCode, 131047);
  assert.deepEqual(messageUpdates, []);
  assert.equal(result.messageDeliveryUpdated, false);
  assert.deepEqual(result.delivery, { status: "played", readAt });
});

test("preserves the latest event time when an older event advances delivery state", async () => {
  const lastEventAt = new Date("2026-06-22T10:20:00.000Z");
  const deliveredAt = new Date("2026-06-22T10:19:00.000Z");
  const { messageUpdates, recordWhatsAppMessageDeliveryStatus } = createHarness(
    {
      _id: "message-1",
      conversationId: "conversation-1",
      delivery: { status: "sent", lastEventAt },
    },
  );

  const result = await recordWhatsAppMessageDeliveryStatus({
    workspaceId: "workspace_1",
    messageId: "wamid.delivered-older",
    status: "delivered",
    eventAt: deliveredAt,
  });

  assert.equal(messageUpdates[0]?.update["delivery.lastEventAt"], lastEventAt);
  assert.equal(result.delivery?.lastEventAt, lastEventAt);
  assert.equal(result.delivery?.deliveredAt, deliveredAt);
});

test("re-reads after a compare-and-set conflict instead of overwriting a concurrent read", async () => {
  const deliveredAt = new Date("2026-06-22T10:19:00.000Z");
  const readAt = new Date("2026-06-22T10:20:00.000Z");
  let current: LeanMessageForDelivery = {
    _id: "message-1",
    conversationId: "conversation-1",
    delivery: { status: "sent", lastEventAt: deliveredAt },
  };
  let updateAttempts = 0;

  const recordWhatsAppMessageDeliveryStatus =
    createRecordWhatsAppMessageDeliveryStatus({
      connectDB: async () => undefined,
      findMessageByWhatsAppMessageId: async () => current,
      updateMessageDelivery: async () => {
        updateAttempts += 1;
        current = {
          ...current,
          delivery: { status: "read", lastEventAt: readAt, readAt },
        };
        return false;
      },
      upsertDeliveryEvent: async () => undefined,
    });

  const result = await recordWhatsAppMessageDeliveryStatus({
    workspaceId: "workspace_1",
    messageId: "wamid.concurrent-delivery",
    status: "delivered",
    eventAt: deliveredAt,
  });

  assert.equal(updateAttempts, 1);
  assert.equal(result.messageDeliveryUpdated, false);
  assert.deepEqual(result.delivery, current.delivery);
});

test("retries a valid forward transition after a compare-and-set conflict", async () => {
  const sentAt = new Date("2026-06-22T10:18:00.000Z");
  const deliveredAt = new Date("2026-06-22T10:19:00.000Z");
  const readAt = new Date("2026-06-22T10:20:00.000Z");
  let current: LeanMessageForDelivery = {
    _id: "message-1",
    conversationId: "conversation-1",
    delivery: { status: "sent", lastEventAt: sentAt, sentAt },
  };
  let updateAttempts = 0;

  const recordWhatsAppMessageDeliveryStatus =
    createRecordWhatsAppMessageDeliveryStatus({
      connectDB: async () => undefined,
      findMessageByWhatsAppMessageId: async () => current,
      updateMessageDelivery: async () => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          current = {
            ...current,
            delivery: {
              ...current.delivery,
              status: "delivered",
              lastEventAt: deliveredAt,
              deliveredAt,
            },
          };
          return false;
        }
        return true;
      },
      upsertDeliveryEvent: async () => undefined,
    });

  const result = await recordWhatsAppMessageDeliveryStatus({
    workspaceId: "workspace_1",
    messageId: "wamid.concurrent-read",
    status: "read",
    eventAt: readAt,
  });

  assert.equal(updateAttempts, 2);
  assert.equal(result.messageDeliveryUpdated, true);
  assert.equal(result.delivery?.status, "read");
  assert.equal(result.delivery?.readAt, readAt);
});
