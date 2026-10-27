import { Conversation } from "@/models/conversation";
import { triggerRealtimeEvent } from "@/lib/realtime/server";

type LeanConversationForRealtime = {
  _id: unknown;
  createdAt?: Date;
  message_count?: number | null;
};

type LeanConversationRealtimeTarget = {
  _id: unknown;
  workspaceId?: string | null;
};

async function isNewConversation(conversationId: string): Promise<boolean> {
  try {
    const conversation = (await Conversation.findById(conversationId)
      .select("createdAt message_count")
      .lean()
      .exec()) as LeanConversationForRealtime | null;
    if (!conversation) return false;
    const createdAt = new Date(conversation.createdAt || Date.now());
    const secondsSinceCreation = (Date.now() - createdAt.getTime()) / 1000;
    return secondsSinceCreation < 5 && (conversation.message_count ?? 0) <= 1;
  } catch {
    return false;
  }
}

export async function triggerConversationUpdate(
  conversationId: string,
  eventType: "requests.new" | "requests.update" = "requests.update"
): Promise<void> {
  try {
    const conversation = (await Conversation.findById(conversationId)
      .select("_id workspaceId")
      .lean()
      .exec()) as LeanConversationRealtimeTarget | null;
    if (!conversation?.workspaceId) return;

    await triggerRealtimeEvent(
      `tenant-${conversation.workspaceId}`,
      eventType,
      {
        _id: String(conversation._id),
        conversationId: String(conversation._id),
        workspaceId: String(conversation.workspaceId),
      }
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error triggering conversation update:", error.message);
    }
  }
}

export async function triggerConversationChanged(
  conversationId: string
): Promise<void> {
  return triggerConversationUpdate(conversationId, "requests.update");
}

export async function triggerConversationRealtime(
  conversationId: string,
  wasJustCreated?: boolean
): Promise<void> {
  if (wasJustCreated === undefined) {
    const isNew = await isNewConversation(conversationId);
    return triggerConversationUpdate(
      conversationId,
      isNew ? "requests.new" : "requests.update"
    );
  }

  return triggerConversationUpdate(
    conversationId,
    wasJustCreated ? "requests.new" : "requests.update"
  );
}
