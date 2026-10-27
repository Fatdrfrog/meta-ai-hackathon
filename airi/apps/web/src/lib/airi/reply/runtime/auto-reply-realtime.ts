import { realtime } from "@/lib/realtime/server";
import * as telegramApi from "@/lib/telegram";
import { resolveBusinessConnectionId } from "@/lib/telegram-business-connection";
import { Conversation } from "@/models/conversation";
import type {
  Channel,
  ChatDocument,
  ConversationDocument,
} from "@/types/models";
import { parseTelegramCompositeChatId } from "@/lib/telegram/chat-id";
import type { ManagerReplyGuardDecisionReason } from "@/lib/airi/reply/runtime/manager-reply-guard";
import { getRealtimeChannelNameForConversation } from "@icecore/shared/types/sources";
import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";

type TypingManagerParams = {
  type: Channel;
  workspaceId: string;
  conversation: ConversationDocument;
  chatDocument: ChatDocument;
  chatId?: string | number;
  chatType?: string;
  botToken?: string;
  whatsAppInfo?: {
    phoneNumberId?: string;
    accessToken?: string;
  };
  newMessage?: {
    messageId?: unknown;
  };
};

export class TypingManager {
  private telegramInterval: NodeJS.Timeout | null = null;

  constructor(private params: TypingManagerParams) {}

  async start() {
    const { type, workspaceId, conversation, chatId, chatType, chatDocument } =
      this.params;
    const isGroupChat = chatType === "group" || chatType === "supergroup";
    const channelName = getRealtimeChannelNameForConversation(
      type,
      String(conversation._id)
    );

    // Realtime indicator
    void realtime
      .trigger(channelName, "airi.typing", { workspaceId, started: true })
      .catch(err => {
        airiOrchestrationLogger.warn("airi.orchestration.realtime", {
          conversationId: String(conversation._id),
          channel: type,
          note: "typing_trigger_failed",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });

    // Telegram Indicator
    if (type === "telegram" && !isGroupChat && chatId) {
      const bizId = resolveBusinessConnectionId(
        conversation.business_connection_id,
        chatDocument?.businessConnectionId
      );
      const botToken = this.params.botToken;
      const realChatId = parseTelegramCompositeChatId(String(chatId));
      const sendAction = () =>
        telegramApi
          .sendChatAction(
            realChatId,
            "typing",
            bizId
              ? { businessConnectionId: bizId, botToken }
              : botToken
                ? { botToken }
                : undefined
          )
          .catch(() => this.stop());

      sendAction();
      this.telegramInterval = setInterval(sendAction, 4000);
    }
  }

  async sendCooldown() {
    const { type, workspaceId, conversation } = this.params;
    const channelName = getRealtimeChannelNameForConversation(
      type,
      String(conversation._id)
    );
    void realtime
      .trigger(channelName, "airi.typing", { workspaceId, cooldown: true })
      .catch(() => undefined);
  }

  stop() {
    if (this.telegramInterval) {
      clearInterval(this.telegramInterval);
      this.telegramInterval = null;
    }
  }
}

type SuppressionStateParams = {
  workspaceId: string;
  conversationId: string;
  reason: ManagerReplyGuardDecisionReason | "scenario_handoff";
  managerUserId?: string;
  messageId: string;
  channel: Channel;
};

export async function persistSuppressedState(params: SuppressionStateParams) {
  const suppressedAt = new Date();

  await Conversation.updateOne(
    { _id: params.conversationId },
    {
      $set: {
        airi_last_suppressed_at: suppressedAt,
        airi_last_suppressed_reason: params.reason,
        airi_last_suppressed_manager_user_id: params.managerUserId || null,
        airi_last_suppressed_message_id: params.messageId,
      },
    }
  );

  await realtime.trigger(
    getRealtimeChannelNameForConversation(
      params.channel,
      params.conversationId
    ),
    "airi.suppressed",
    {
      workspaceId: params.workspaceId,
      reason: params.reason,
      managerUserId: params.managerUserId || null,
      messageId: params.messageId,
      suppressedAt: suppressedAt.toISOString(),
    }
  );
}

export async function clearSuppressedState(conversationId: string) {
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        airi_last_suppressed_at: null,
        airi_last_suppressed_reason: null,
        airi_last_suppressed_manager_user_id: null,
        airi_last_suppressed_message_id: null,
      },
    }
  );
}
