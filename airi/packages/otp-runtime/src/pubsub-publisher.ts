import { createHash } from "crypto";

import { readEnvOrEmpty as compactEnv } from "@icecore/shared/lib/env";

export type WhatsAppOtpDeliveryPubSubMessage = {
  workspaceId: string;
  challengeId: string;
  correlationId: string;
  queuedAt: string;
};

export type WhatsAppOtpDeliveryPubSubPublishResult = {
  ok: boolean;
  messageId?: string | null;
  errorMessage?: string | null;
};

const DEFAULT_TOPIC = "icecore-whatsapp-otp-delivery";

export function getWhatsAppOtpPubSubTopic(): string {
  return compactEnv("WHATSAPP_OTP_PUBSUB_TOPIC") || DEFAULT_TOPIC;
}

function buildAttributes(message: WhatsAppOtpDeliveryPubSubMessage) {
  return {
    workspaceId: message.workspaceId,
    challengeIdHash: createHash("sha256")
      .update(message.challengeId)
      .digest("hex"),
  };
}

export async function publishWhatsAppOtpDeliveryToPubSub(
  message: WhatsAppOtpDeliveryPubSubMessage
): Promise<WhatsAppOtpDeliveryPubSubPublishResult> {
  try {
    const projectId =
      compactEnv("WHATSAPP_OTP_PUBSUB_PROJECT_ID") ||
      compactEnv("GOOGLE_CLOUD_PROJECT") ||
      compactEnv("GCP_PROJECT_ID");
    if (!projectId) {
      throw new Error("WHATSAPP_OTP_PUBSUB_PROJECT_ID is required");
    }

    const { PubSub } = await import("@google-cloud/pubsub");
    const pubsub = new PubSub({ projectId });
    const messageId = await pubsub
      .topic(getWhatsAppOtpPubSubTopic(), { messageOrdering: true })
      .publishMessage({
        json: message,
        orderingKey: message.workspaceId,
        attributes: buildAttributes(message),
      });

    return { ok: true, messageId };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
