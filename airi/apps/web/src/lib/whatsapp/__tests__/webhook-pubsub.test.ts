const mockPublishGooglePubSubJsonMessage = jest.fn();

jest.mock("@/lib/google/pubsub-json-publisher", () => ({
  publishGooglePubSubJsonMessage: (input: unknown) =>
    mockPublishGooglePubSubJsonMessage(input),
}));

import { publishWhatsAppWebhookEventToPubSub } from "@/lib/whatsapp/webhook-pubsub";
import {
  WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
  WHATSAPP_FAST_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
  WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
} from "@icecore/temporal";
import { useCleanEnv } from "@/test-support/env-test-utils";

describe("WhatsApp webhook Pub/Sub publisher", () => {
  useCleanEnv([
    "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
    "WHATSAPP_WEBHOOK_PUBSUB_TOPIC",
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC",
    "WHATSAPP_CALL_PUBSUB_PROJECT_ID",
    "WHATSAPP_CALL_PUBSUB_TOPIC",
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockPublishGooglePubSubJsonMessage.mockResolvedValue({
      ok: true,
      messageId: "pubsub-message-1",
    });
  });

  it("keeps normal WhatsApp webhook events on the generic webhook topic", async () => {
    await publishWhatsAppWebhookEventToPubSub({
      eventId: "event-1",
      dedupeKey: "dedupe-1",
      field: "messages",
      orderingKey: "phone-1",
      receivedAt: "2026-06-19T10:00:00.000Z",
    });

    expect(mockPublishGooglePubSubJsonMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIdEnvName: "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
        topic: WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
        orderingKey: "phone-1",
      })
    );
  });

  it("routes customer inbound messages to the configured priority topic", async () => {
    process.env.WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC =
      WHATSAPP_FAST_WEBHOOK_PUBSUB_DEFAULT_TOPIC;

    await publishWhatsAppWebhookEventToPubSub({
      eventId: "event-inbound-1",
      dedupeKey: "dedupe-inbound-1",
      field: "messages",
      itemKind: "message",
      orderingKey: "phone-1:message:chat-1",
      receivedAt: "2026-07-22T10:00:00.000Z",
    });

    expect(mockPublishGooglePubSubJsonMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIdEnvName: "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
        topic: WHATSAPP_FAST_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
        orderingKey: "phone-1:message:chat-1",
        attributes: expect.objectContaining({ itemKind: "message" }),
      })
    );
  });

  it("routes WhatsApp Calling API events to the dedicated call topic", async () => {
    await publishWhatsAppWebhookEventToPubSub({
      eventId: "event-call-1",
      dedupeKey: "dedupe-call-1",
      field: "calls",
      orderingKey: "phone-1:call",
      receivedAt: "2026-06-19T10:00:00.000Z",
    });

    expect(mockPublishGooglePubSubJsonMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIdEnvName: "WHATSAPP_CALL_PUBSUB_PROJECT_ID",
        topic: WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
        orderingKey: "phone-1:call",
      })
    );
  });
});
