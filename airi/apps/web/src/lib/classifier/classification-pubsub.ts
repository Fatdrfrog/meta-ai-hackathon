import "server-only";
import { after } from "next/server";

import { compactEnv } from "@/lib/google/gcp-auth";
import { publishGooglePubSubJsonMessage } from "@/lib/google/pubsub-json-publisher";
import {
  buildConversationClassificationWakeEventId,
  CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC_DEFAULT,
  CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION,
  normalizeConversationClassificationWakeData,
} from "@icecore/temporal";

import type { ClassificationWakeRequest } from "./classification-contract";
import { markConversationClassificationEnqueued } from "./conversation-classification-store";

export type ConversationClassificationWakeRequest = ClassificationWakeRequest;

export type ConversationClassificationWakeMarker =
  | { kind: "classification" }
  | { kind: "effects"; analysisRevisionId: string };

export type ConversationClassificationWakePublishOutcome =
  | {
      status: "publishing_disabled";
      eventId: string;
    }
  | {
      status: "published_marked" | "published_stale";
      eventId: string;
      messageId: string | null;
    }
  | {
      status: "publish_failed";
      eventId: string;
      error: string;
    }
  | {
      status: "published_marker_failed";
      eventId: string;
      messageId: string | null;
      error: string;
    };

const MAX_PUBLISH_ERROR_LENGTH = 500;

function safePublishError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown Pub/Sub error";
  return (
    message.trim().slice(0, MAX_PUBLISH_ERROR_LENGTH) || "Unknown Pub/Sub error"
  );
}

export function getConversationClassificationPubSubTopic(): string {
  return (
    compactEnv("CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC") ||
    CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC_DEFAULT
  );
}

export function isConversationClassificationPublishingEnabled(): boolean {
  return (
    compactEnv("CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED") === "true"
  );
}

export async function publishConversationClassificationWake(
  input: ConversationClassificationWakeRequest & {
    marker: ConversationClassificationWakeMarker;
  }
): Promise<ConversationClassificationWakePublishOutcome> {
  const eventId = buildConversationClassificationWakeEventId(input);
  if (!isConversationClassificationPublishingEnabled()) {
    return { status: "publishing_disabled", eventId };
  }
  const message = normalizeConversationClassificationWakeData({
    schemaVersion: CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION,
    eventId,
    conversationId: input.conversationId,
    requestedRevision: input.requestedRevision,
    generation: input.generation,
    requestedAt: input.requestedAt.toISOString(),
  });

  let published: Awaited<ReturnType<typeof publishGooglePubSubJsonMessage>>;
  try {
    published = await publishGooglePubSubJsonMessage({
      projectIdEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
      topic: getConversationClassificationPubSubTopic(),
      message,
      orderingKey: input.conversationId,
      attributes: {
        eventType: "conversation.classification.wake",
        schemaVersion: String(message.schemaVersion),
        eventId: message.eventId,
        requestedRevision: String(message.requestedRevision),
        generation: String(message.generation),
      },
    });
  } catch (error) {
    return {
      status: "publish_failed",
      eventId,
      error: safePublishError(error),
    };
  }

  if (!published.ok) {
    return {
      status: "publish_failed",
      eventId,
      error: "Pub/Sub publish returned ok=false",
    };
  }

  const messageId = published.messageId ?? null;
  try {
    const marked = await markConversationClassificationEnqueued({
      conversationId: input.conversationId,
      revision: input.requestedRevision,
      generation: input.generation,
      marker: input.marker,
    });
    return {
      status: marked ? "published_marked" : "published_stale",
      eventId,
      messageId,
    };
  } catch (error) {
    return {
      status: "published_marker_failed",
      eventId,
      messageId,
      error: safePublishError(error),
    };
  }
}

export async function scheduleConversationClassificationWakeBestEffort(
  request: ConversationClassificationWakeRequest
): Promise<void> {
  const publish = async () => {
    try {
      await publishConversationClassificationWake({
        ...request,
        marker: { kind: "classification" },
      });
    } catch {
      // Pending Mongo state is the durable outbox; reconciliation republishes.
    }
  };

  try {
    after(publish);
  } catch {
    // Workers have no request scope, so their activity owns the wake lifetime.
    await publish();
  }
}
