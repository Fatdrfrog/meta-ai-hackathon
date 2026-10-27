import { PubSub, type Topic } from "@google-cloud/pubsub";
import WhatsAppWebhookEvent from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import type { WhatsAppWebhookEventEnvelope } from "@icecore/airi-runtime/whatsapp-webhook-event-envelopes";
import {
  WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
  type WhatsAppWebhookPubSubMessage,
} from "@icecore/temporal";
import {
  compactEnv,
  getGoogleCloudProjectId,
} from "./pubsub/pubsub-consumer-runtime.js";

let topic: Topic | undefined;
function historyTopic(): Topic {
  topic ??= new PubSub({
    projectId: getGoogleCloudProjectId("WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID"),
  }).topic(
    compactEnv("WHATSAPP_WEBHOOK_PUBSUB_TOPIC") ||
      WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_TOPIC,
    {
      messageOrdering: true,
      // The durable drain owns retries; wakeups must not consume the parent's
      // activity lease while the provider transport is unavailable.
      gaxOpts: { timeout: 5_000, retry: { retryCodes: [] } },
    },
  );
  return topic;
}

type PendingHistoryReceipt = {
  _id: unknown;
  dedupeKey: string;
  field: string;
  itemKind: string;
  orderingKey: string;
  firstReceivedAt: Date;
};
type HistoryDispatchDependencies = {
  now?: () => number;
  findPending(keys: string[]): Promise<PendingHistoryReceipt[]>;
  publish(message: WhatsAppWebhookPubSubMessage): Promise<string>;
  markPublished(eventId: string, messageId: string): Promise<void>;
};

/** Publication is a wakeup for already durable receipts. Failed wakeups stay
 * received, so the existing webhook drain remains the recovery owner. */
export async function publishWhatsAppHistoryChildren(
  children: WhatsAppWebhookEventEnvelope[],
  overrides?: HistoryDispatchDependencies,
): Promise<void> {
  const deps: HistoryDispatchDependencies = overrides || {
    findPending: async (keys) =>
      WhatsAppWebhookEvent.find({
        dedupeKey: { $in: keys },
        status: { $in: ["received", "failed"] },
      })
        .select("_id dedupeKey field itemKind orderingKey firstReceivedAt")
        .lean<PendingHistoryReceipt[]>(),
    publish: async (message) => {
      const target = historyTopic();
      try {
        return await target.publishMessage({
          data: Buffer.from(JSON.stringify(message)),
          orderingKey: message.orderingKey,
          attributes: {
            field: message.field,
            itemKind: message.itemKind || "history_message",
          },
        });
      } catch (error) {
        target.resumePublishing(message.orderingKey);
        throw error;
      }
    },
    markPublished: async (eventId, messageId) => {
      await WhatsAppWebhookEvent.updateOne(
        { _id: eventId, status: { $in: ["received", "failed"] } },
        {
          $set: {
            status: "published",
            publishedAt: new Date(),
            pubsubMessageId: messageId,
            lastError: null,
          },
          $inc: { publishAttempts: 1 },
        },
      );
    },
  };
  const now = deps.now ?? Date.now;
  const deadline = now() + 10_000;
  for (let offset = 0; offset < children.length; offset += 100) {
    if (now() >= deadline) return;
    const pending = await deps.findPending(
      children.slice(offset, offset + 100).map((child) => child.dedupeKey),
    );
    for (let batch = 0; batch < pending.length; batch += 10) {
      if (now() >= deadline) return;
      const results = await Promise.allSettled(
        pending.slice(batch, batch + 10).map(async (event) => {
          const eventId = String(event._id);
          const messageId = await deps.publish({
            eventId,
            dedupeKey: event.dedupeKey,
            field: event.field,
            itemKind: event.itemKind,
            orderingKey: event.orderingKey,
            receivedAt: event.firstReceivedAt.toISOString(),
          });
          await deps.markPublished(eventId, messageId);
        }),
      );
      for (const result of results)
        if (result.status === "rejected")
          console.error(
            "WhatsApp history wakeup failed; durable receipt awaits drain",
            {
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
          );
    }
  }
}
