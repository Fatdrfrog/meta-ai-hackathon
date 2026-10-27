import type { ConversationEngagementMetrics } from "./conversation-engagement-metrics";
import type mongoose from "mongoose";
export {
  CONVERSATION_ENGAGEMENT_VERSION,
  ENGAGEMENT_MESSAGE_SELECT,
  computeConversationEngagementMetrics,
} from "./conversation-engagement-metrics";
export type { ConversationEngagementMetrics } from "./conversation-engagement-metrics";
export type RefreshConversationEngagementOptions = {
  workspaceId?: string;
  messageId?: string | mongoose.Types.ObjectId;
};
export async function refreshConversationEngagement(
  conversationId: string | mongoose.Types.ObjectId,
  options?: RefreshConversationEngagementOptions
): Promise<ConversationEngagementMetrics | null> {
  const { refreshStoredConversationEngagement } = await import(
    "./conversation-engagement-store"
  );
  return refreshStoredConversationEngagement(conversationId, options);
}

export async function drainPendingConversationEngagement(options?: {
  limit?: number;
  now?: Date;
  heartbeat?: () => void;
}): Promise<{ processed: number; bootstrapsAdvanced: number }> {
  const store = await import("./conversation-engagement-store");
  return store.drainPendingConversationEngagement(options);
}

export async function ensureConversationEngagementIndexes(): Promise<void> {
  const indexes = await import("./conversation-engagement-indexes");
  await indexes.ensureConversationEngagementIndexes();
}
