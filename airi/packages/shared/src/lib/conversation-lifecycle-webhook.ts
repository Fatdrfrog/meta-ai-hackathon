import { getCurrentConversationClassification } from "./conversation-classification-freshness";

/**
 * Who closed a conversation, carried on conversation.resolved payloads.
 * Managers cannot close one directly, so "manager" is no longer sent.
 */
export type ConversationResolutionKind = "customer_csat" | "timeout";

/** The data of every conversation.* lifecycle webhook. */
export interface ConversationEventData {
  conversation_id: string;
  status: string;
  previous_status?: string;
  channel: string;
  customer_phone?: string;
  classification?: {
    category?: string;
    priority?: string;
    sentiment?: string;
    summary?: string;
  };
  resolution_kind?: ConversationResolutionKind;
  /** Measured service time in whole seconds; absent when not measured. */
  resolution_time_seconds?: number;
  created_at: string;
  updated_at?: string;
}

export type ConversationEventFields = Omit<
  ConversationEventData,
  "conversation_id" | "classification" | "created_at" | "updated_at"
>;

/**
 * Builds a lifecycle webhook payload from the conversation document: its id,
 * its classification only while that is current, and its creation time,
 * plus the event's own fields.
 */
export function buildConversationEventData(
  conversation: { _id?: unknown; createdAt?: Date | null },
  fields: ConversationEventFields,
): ConversationEventData {
  const classification =
    getCurrentConversationClassification<
      NonNullable<ConversationEventData["classification"]>
    >(conversation);
  const now = new Date().toISOString();
  return {
    conversation_id: String(conversation._id),
    ...fields,
    ...(classification === undefined ? {} : { classification }),
    created_at: conversation.createdAt?.toISOString() || now,
    updated_at: now,
  };
}
