import {
  applyInstagramHumanAgentWindow,
  type InstagramHumanAgentCapability,
} from "@/lib/instagram/human-agent";
import {
  resolveInstagramSendContext,
  resolveInstagramSendContextHumanAgent,
} from "@/lib/instagram/send-context";
import {
  checkMessagingWindowForConversation,
  formatWindowMessage,
  requiresMessagingWindow,
} from "@/lib/messaging-window";
import type { MessagingWindowInfo } from "@/lib/messaging-window-utils";

type ConversationMessagingWindowStatus = {
  channel: string;
  requiresWindow: boolean;
  windowInfo: MessagingWindowInfo | null;
  humanAgent: InstagramHumanAgentCapability;
  message?: string;
};

type ConversationLike = {
  _id?: unknown;
  channel?: string | null;
  workspaceId?: string | null;
  sourceId?: string | null;
  last_inbound_at?: Date | string | null;
};

// Same account and capability rule the Instagram reply handler sends with.
async function resolveHumanAgentForConversation(
  conversation: ConversationLike,
  channel: string
): Promise<InstagramHumanAgentCapability> {
  if (channel !== "instagram") {
    return { supported: false, enabled: false };
  }

  return resolveInstagramSendContextHumanAgent(
    await resolveInstagramSendContext({
      sourceId: conversation.sourceId,
      workspaceId: conversation.workspaceId,
    })
  );
}

/**
 * Shared messaging-window payload for chat open + dedicated window-status route.
 * Prefer this over a second client round-trip when conversation is already loaded.
 */
export async function buildConversationMessagingWindowStatus(
  conversation: ConversationLike
): Promise<ConversationMessagingWindowStatus> {
  const channel = String(conversation.channel || "");
  const humanAgent = await resolveHumanAgentForConversation(
    conversation,
    channel
  );

  if (!requiresMessagingWindow(channel)) {
    return {
      channel,
      requiresWindow: false,
      windowInfo: null,
      humanAgent,
      message:
        "24-hour window only applies to Meta platforms (WhatsApp, Instagram)",
    };
  }

  const windowInfo = await checkMessagingWindowForConversation(conversation);

  return {
    channel,
    requiresWindow: true,
    windowInfo,
    humanAgent:
      channel === "instagram"
        ? applyInstagramHumanAgentWindow(
            humanAgent,
            windowInfo.lastCustomerMessageAt
          )
        : humanAgent,
    message: formatWindowMessage(windowInfo, channel),
  };
}
