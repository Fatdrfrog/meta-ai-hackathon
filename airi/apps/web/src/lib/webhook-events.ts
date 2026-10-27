import type { ConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import {
  dispatchWebhookEvent,
  triggerWebhookEvent,
  WEBHOOK_EVENTS,
} from "./webhooks";

/**
 * Webhook Event Triggers
 * Call these functions when events occur to trigger webhooks
 */

export interface CsatEventData {
  conversation_id: string;
  score: number;
  customer_phone?: string;
  channel: string;
  submitted_at: string;
}

export interface ClassificationEventData {
  conversation_id: string;
  analysis_revision_id: string;
  source_revision: number;
  category: string;
  priority: string;
  sentiment: string;
  summary: string;
  confidence: number;
  completed_at: string;
}

/**
 * Trigger when conversation is resolved/closed
 */
export async function triggerConversationResolved(
  workspaceId: string,
  data: ConversationEventData
) {
  await triggerWebhookEvent(
    workspaceId,
    WEBHOOK_EVENTS.CONVERSATION_RESOLVED,
    data.conversation_id,
    data as unknown as Record<string, unknown>
  );
}

/**
 * Trigger when conversation is reopened
 */
export async function triggerConversationReopened(
  workspaceId: string,
  data: ConversationEventData
) {
  await triggerWebhookEvent(
    workspaceId,
    WEBHOOK_EVENTS.CONVERSATION_REOPENED,
    data.conversation_id,
    data as unknown as Record<string, unknown>
  );
}

export async function triggerClassificationCompletedStrict(
  workspaceId: string,
  data: ClassificationEventData
): Promise<void> {
  await dispatchWebhookEvent({
    workspaceId,
    eventType: WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED,
    resourceId: data.analysis_revision_id,
    timestamp: data.completed_at,
    data: data as unknown as Record<string, unknown>,
  });
}

/**
 * Trigger when CSAT is submitted
 */
export async function triggerCsatSubmitted(
  workspaceId: string,
  data: CsatEventData
) {
  await triggerWebhookEvent(
    workspaceId,
    WEBHOOK_EVENTS.CSAT_SUBMITTED,
    data.conversation_id,
    data as unknown as Record<string, unknown>
  );

  // Also trigger low CSAT event if score <= 2
  if (data.score <= 2) {
    await triggerWebhookEvent(
      workspaceId,
      WEBHOOK_EVENTS.CSAT_LOW,
      data.conversation_id,
      data as unknown as Record<string, unknown>
    );
  }
}
