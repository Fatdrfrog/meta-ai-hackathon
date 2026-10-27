import "server-only";

import { createHash } from "node:crypto";

import { compactEnv } from "@/lib/google/gcp-auth";
import { publishGooglePubSubJsonMessage } from "@/lib/google/pubsub-json-publisher";
import {
  isWhatsAppCustomerMessagePubSubMessage,
  isWhatsAppCallWebhookPubSubField,
  WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
  WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
  type WhatsAppWebhookPubSubMessage,
} from "@icecore/temporal";

type WhatsAppWebhookPubSubPublishResult = {
  ok: boolean;
  messageId?: string | null;
  errorMessage?: string | null;
};

function getWhatsAppWebhookPubSubTopic(): string {
  return (
    compactEnv("WHATSAPP_WEBHOOK_PUBSUB_TOPIC") ||
    WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_TOPIC
  );
}

function getWhatsAppCallPubSubTopic(): string {
  return (
    compactEnv("WHATSAPP_CALL_PUBSUB_TOPIC") ||
    WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC
  );
}

function getWhatsAppFastWebhookPubSubTopic(): string | null {
  return compactEnv("WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC") || null;
}

function getWhatsAppWebhookPubSubTarget(message: WhatsAppWebhookPubSubMessage) {
  if (isWhatsAppCallWebhookPubSubField(message.field)) {
    return {
      projectIdEnvName: "WHATSAPP_CALL_PUBSUB_PROJECT_ID",
      topic: getWhatsAppCallPubSubTopic(),
    };
  }

  if (isWhatsAppCustomerMessagePubSubMessage(message)) {
    const topic = getWhatsAppFastWebhookPubSubTopic();
    if (topic) {
      return {
        projectIdEnvName: "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
        topic,
      };
    }
  }

  return {
    projectIdEnvName: "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
    topic: getWhatsAppWebhookPubSubTopic(),
  };
}

function buildAttributes(message: WhatsAppWebhookPubSubMessage) {
  return {
    field: message.field,
    itemKind: message.itemKind || "unknown",
    dedupeKeyHash: createHash("sha256").update(message.dedupeKey).digest("hex"),
  };
}

export async function publishWhatsAppWebhookEventToPubSub(
  message: WhatsAppWebhookPubSubMessage
): Promise<WhatsAppWebhookPubSubPublishResult> {
  try {
    const target = getWhatsAppWebhookPubSubTarget(message);
    return await publishGooglePubSubJsonMessage({
      projectIdEnvName: target.projectIdEnvName,
      topic: target.topic,
      message,
      orderingKey: message.orderingKey,
      attributes: buildAttributes(message),
    });
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
