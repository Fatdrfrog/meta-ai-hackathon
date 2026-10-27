import type { Message } from "@google-cloud/pubsub";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";

import {
  deliverWhatsAppOtpChallenge,
  installDefaultOtpRuntime,
} from "@icecore/otp-runtime";

import {
  compactEnv,
  createPubSubSubscription,
  parseEnabledFlag,
} from "./pubsub-consumer-runtime.js";

type PubSubPayload = {
  workspaceId?: string;
  challengeId?: string;
  correlationId?: string;
  queuedAt?: string;
};

const DEFAULT_SUBSCRIPTION = "icecore-whatsapp-otp-delivery-worker";

function getSubscriptionName(): string {
  return compactEnv("WHATSAPP_OTP_PUBSUB_SUBSCRIPTION") || DEFAULT_SUBSCRIPTION;
}

function isConsumerEnabled(): boolean {
  return parseEnabledFlag(process.env.WHATSAPP_OTP_PUBSUB_ENABLED);
}

function parseMessage(message: Message): PubSubPayload {
  const raw = message.data.toString("utf8");
  const parsed = JSON.parse(raw) as PubSubPayload;
  if (!parsed.workspaceId || !parsed.challengeId || !parsed.correlationId) {
    throw new Error("Pub/Sub WhatsApp OTP message is missing required ids.");
  }
  return parsed;
}

export async function startWhatsAppOtpDeliveryConsumer(): Promise<
  () => Promise<void>
> {
  if (!isConsumerEnabled()) {
    airiWorkerLogger.info("whatsapp.otp.pubsub.consumer", {
      note: "disabled",
    });
    return async () => undefined;
  }

  const subscriptionName = getSubscriptionName();
  const { projectId, subscription } = createPubSubSubscription({
    projectIdEnvName: "WHATSAPP_OTP_PUBSUB_PROJECT_ID",
    subscriptionName,
    maxMessagesEnvName: "WHATSAPP_OTP_PUBSUB_MAX_MESSAGES",
    defaultMaxMessages: 50,
  });

  try {
    // Verify the runtime identity can consume before reporting startup readiness.
    const [permissions] = await subscription.iam.testPermissions([
      "pubsub.subscriptions.consume",
    ]);
    if (permissions["pubsub.subscriptions.consume"] !== true) {
      throw new Error(
        `WhatsApp OTP subscription '${subscriptionName}' requires pubsub.subscriptions.consume`,
      );
    }
  } catch (error) {
    await Promise.allSettled([subscription.close()]);
    throw error;
  }

  const onMessage = async (message: Message) => {
    let payload: PubSubPayload | null = null;
    try {
      payload = parseMessage(message);
      installDefaultOtpRuntime();
      const result = await deliverWhatsAppOtpChallenge({
        workspaceId: payload.workspaceId!,
        challengeId: payload.challengeId!,
      });

      message.ack();
      airiWorkerLogger.info("whatsapp.otp.pubsub.consumer", {
        note: "acked",
        workspaceId: payload.workspaceId,
        challengeId: payload.challengeId,
        correlationId: payload.correlationId,
        deliveryStatus: result.status,
      });
    } catch (error) {
      airiWorkerLogger.error("whatsapp.otp.pubsub.consumer", error, {
        note: "message_failed",
        workspaceId: payload?.workspaceId || null,
        challengeId: payload?.challengeId || null,
        correlationId: payload?.correlationId || null,
      });
      message.nack();
    }
  };

  const onError = (error: Error) => {
    airiWorkerLogger.error("whatsapp.otp.pubsub.consumer", error, {
      note: "subscription_error",
      subscription: subscriptionName,
    });
  };

  subscription.on("message", onMessage);
  subscription.on("error", onError);

  airiWorkerLogger.info("whatsapp.otp.pubsub.consumer", {
    note: "started",
    projectId: projectId || null,
    subscription: subscriptionName,
  });

  return async () => {
    subscription.removeListener("message", onMessage);
    subscription.removeListener("error", onError);
    await subscription.close();
  };
}
