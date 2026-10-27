import "server-only";

import { createHash } from "crypto";
import { compactEnv } from "@/lib/google/gcp-auth";
import { publishGooglePubSubJsonMessage } from "@/lib/google/pubsub-json-publisher";

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
    return await publishGooglePubSubJsonMessage({
      projectIdEnvName: "WHATSAPP_OTP_PUBSUB_PROJECT_ID",
      topic: getWhatsAppOtpPubSubTopic(),
      message,
      orderingKey: message.workspaceId,
      attributes: buildAttributes(message),
    });
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
