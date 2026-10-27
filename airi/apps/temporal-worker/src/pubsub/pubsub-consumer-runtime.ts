import {
  Duration,
  PubSub,
  type Subscription,
  type SubscriberOptions,
} from "@google-cloud/pubsub";

import { compactEnv, parseEnabledFlag } from "../runtime-env.js";

export { compactEnv, parseEnabledFlag } from "../runtime-env.js";

/** Snapshot at callback entry; handler duration and durable receipt age are separate hops. */
export function getPubSubDeliveryTiming(
  message: { publishTime?: Date; deliveryAttempt?: number; received?: number },
  callbackStartedAt: number,
) {
  const publishedAt = message.publishTime?.getTime();
  const hasPublishTime =
    publishedAt !== undefined && Number.isFinite(publishedAt);
  const brokerPublishTimeInFuture =
    hasPublishTime && publishedAt > callbackStartedAt;
  // The SDK stamps `received` when the stream hands it the message. Splitting
  // there separates broker/stream wait from the exactly-once receipt ModAck
  // that must succeed before the callback runs.
  const receivedAt =
    Number.isFinite(message.received) &&
    (message.received as number) <= callbackStartedAt
      ? (message.received as number)
      : null;
  return {
    brokerPublishedAt: hasPublishTime
      ? new Date(publishedAt).toISOString()
      : null,
    callbackStartedAt: new Date(callbackStartedAt).toISOString(),
    brokerToCallbackMs:
      hasPublishTime && !brokerPublishTimeInFuture
        ? callbackStartedAt - publishedAt
        : null,
    brokerPublishTimeInFuture,
    pubsubDeliveryAttempt:
      Number.isInteger(message.deliveryAttempt) &&
      Number(message.deliveryAttempt) > 0
        ? message.deliveryAttempt!
        : null,
    clientReceivedAt:
      receivedAt === null ? null : new Date(receivedAt).toISOString(),
    brokerToReceiptMs:
      receivedAt !== null && hasPublishTime && publishedAt <= receivedAt
        ? receivedAt - publishedAt
        : null,
    receiptToCallbackMs:
      receivedAt === null ? null : callbackStartedAt - receivedAt,
  };
}

export function getGoogleCloudProjectId(
  primaryEnvName: string,
): string | undefined {
  return (
    compactEnv(primaryEnvName) ||
    compactEnv("GOOGLE_CLOUD_PROJECT") ||
    compactEnv("GCP_PROJECT_ID") ||
    undefined
  );
}

// Cloud Run sends SIGKILL 10 s after SIGTERM. Closing stops the stream, gives
// in-flight handlers this long to ack, then nacks the rest so another
// instance gets them at once instead of after their lease expires.
export const PUBSUB_SUBSCRIPTION_CLOSE_TIMEOUT_SECONDS = 7;

export function buildPubSubSubscriptionOptions(
  maxMessagesValue: string | undefined,
  defaultMaxMessages: number,
): Required<Pick<SubscriberOptions, "flowControl" | "closeOptions">> {
  const parsed = Number.parseInt(String(maxMessagesValue || ""), 10);
  return {
    flowControl: {
      maxMessages:
        Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMaxMessages,
    },
    closeOptions: {
      behavior: "WAIT",
      timeout: Duration.from({
        seconds: PUBSUB_SUBSCRIPTION_CLOSE_TIMEOUT_SECONDS,
      }),
    },
  };
}

export function createPubSubSubscription(input: {
  projectIdEnvName: string;
  subscriptionName: string;
  maxMessagesEnvName?: string;
  defaultMaxMessages: number;
}): {
  projectId: string | undefined;
  subscription: Subscription;
} {
  const projectId = getGoogleCloudProjectId(input.projectIdEnvName);
  const pubsub = new PubSub({ projectId });
  return {
    projectId,
    subscription: pubsub.subscription(
      input.subscriptionName,
      buildPubSubSubscriptionOptions(
        input.maxMessagesEnvName
          ? process.env[input.maxMessagesEnvName]
          : undefined,
        input.defaultMaxMessages,
      ),
    ),
  };
}
