import type { TelegramCallbackQuery } from "@/types/telegram";

import { buildGroundedReplyOptionPayload } from "@/lib/airi/reply/selection";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import { SCENARIO_TRIGGER_EVENT_KIND } from "@icecore/scenario-contracts";
import { acceptAiriConversationIngress } from "@/lib/temporal/airi-direct-ingress";
import * as telegramApi from "@/lib/telegram";
import { resolveBusinessConnectionId } from "@/lib/telegram-business-connection";
import {
  triggerConversationResolved,
  triggerCsatSubmitted,
} from "@/lib/webhook-events";
import { Conversation } from "@/models/conversation";
import { measuredResolutionWholeSeconds } from "@/lib/analytics/service-truth";
import { customerCsatResolutionFields } from "@/lib/analytics/service-lifecycle";
import Message from "@/models/message";
import type { SourceContext } from "@icecore/shared/types/sources";
import type { MessageDocument } from "@/types/models";
import {
  saveMessageWithDedup,
  type TelegramAiriIngressPayload,
} from "./helpers";

export async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
  sourceContext?: SourceContext
) {
  const { id: cbId, data, message } = callbackQuery;
  const rawData = data ?? "";
  telegramApi.answerCallbackQuery(cbId, undefined, {
    botToken: sourceContext?.botToken,
  });

  if (!message) {
    return;
  }

  const chatId = message.chat?.id;
  if (!chatId) {
    return;
  }

  const messageId = message.message_id;
  if (!messageId) {
    return;
  }

  // Route to scenario quick-reply handler
  if (rawData.startsWith("sqr:")) {
    await handleScenarioQuickReply(
      callbackQuery,
      rawData,
      chatId,
      messageId,
      sourceContext
    );
    return;
  }

  if (rawData.startsWith("gqr:")) {
    await handleGroundedQuickReply(
      callbackQuery,
      rawData,
      chatId,
      messageId,
      sourceContext
    );
    return;
  }

  // Existing CSAT rating handler
  const [action, ratingStr, convId] = rawData.split(":");

  if (action !== "rate" || !ratingStr || !convId) {
    return;
  }

  const rating = Number(ratingStr);

  try {
    const convo = await Conversation.findByIdAndUpdate(
      convId,
      { $set: { customer_satisfaction_score: rating, status: "closed", ...customerCsatResolutionFields() } },
      { new: true }
    );

    if (!convo) throw new Error("conversation not found");

    await telegramApi.editTelegramMessage(
      chatId.toString(),
      messageId.toString(),
      `Thank you for your evaluation: ${"⭐".repeat(rating)}`,
      { botToken: sourceContext?.botToken }
    );

    // Trigger webhooks (async, don't block)
    if (convo.workspaceId) {
      const webhookData = {
        conversation_id: convId,
        score: rating,
        customer_phone: convo.user?.toString(),
        channel: convo.channel || "telegram",
        submitted_at: new Date().toISOString(),
      };

      triggerCsatSubmitted(convo.workspaceId, webhookData).catch(err =>
        console.error("Webhook trigger error:", err)
      );

      // Also trigger conversation resolved event
      triggerConversationResolved(
        convo.workspaceId,
        buildConversationEventData(convo, {
          status: "closed",
          channel: convo.channel || "telegram",
          customer_phone: convo.user?.toString(),
          resolution_kind: "customer_csat",
          resolution_time_seconds: measuredResolutionWholeSeconds(convo),
        })
      ).catch(err => console.error("Webhook trigger error:", err));
    }
  } catch {
    await telegramApi.answerCallbackQuery(
      cbId,
      "🚫 Some error occured during evaluation",
      { botToken: sourceContext?.botToken }
    );
  }
}

/**
 * Handles Telegram quick-reply button clicks that should route to
 * branch action nodes inside the current scenario.
 *
 * Callback data format: `sqr:<conversationId>:<payload>`
 *
 * Flow:
 *  1. Parse conversationId and payload from callback_data
 *  2. Load the conversation from DB
 *  3. Persist the button text as an inbound customer message
 *  4. Trigger auto-reply with `telegram_quick_reply` event kind so that
 *     scenario runtime can resolve the matching `telegramBranchPayload`
 *     deterministically.
 */
async function handleScenarioQuickReply(
  callbackQuery: TelegramCallbackQuery,
  rawData: string,
  chatId: number,
  messageId: number,
  sourceContext?: SourceContext
) {
  // Format: sqr:<conversationId>:<payload>
  const parts = rawData.slice(4).split(":");
  if (parts.length < 2) {
    console.warn("[Telegram Callback] Invalid sqr callback data:", rawData);
    return;
  }
  const conversationId = parts[0];
  const quickReplyPayload = parts.slice(1).join(":");

  if (!conversationId || !quickReplyPayload) {
    console.warn("[Telegram Callback] Missing sqr params:", {
      conversationId,
      quickReplyPayload,
    });
    return;
  }

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      console.warn(
        "[Telegram Callback] Conversation not found:",
        conversationId
      );
      return;
    }

    const workspaceId = conversation.workspaceId;
    if (!workspaceId) {
      console.warn(
        "[Telegram Callback] No workspaceId for conversation:",
        conversationId
      );
      return;
    }
    const { dbChatId, businessConnectionId } = resolveCallbackContext(
      conversation,
      callbackQuery,
      chatId
    );

    removeCallbackInlineKeyboard({
      chatId,
      messageId,
      botToken: sourceContext?.botToken,
      businessConnectionId,
      failureMessage: "[Telegram Callback] Failed to remove inline keyboard:",
    });

    // Resolve the button label from the callbackQuery
    // Telegram provides the original message's inline keyboard — find matching button
    const buttonText = resolveButtonText(callbackQuery, rawData);

    // Persist the button click as an inbound customer message
    const fromUserId = callbackQuery.from.id;
    const inboundMessage = new Message({
      messageId: `callback:${callbackQuery.id}`,
      chat: dbChatId,
      author: fromUserId,
      rawSourcePayload: buildRawSourcePayload({
        provider: "telegram",
        eventType: "callback_query",
        payload: callbackQuery,
      }),
      text: buttonText,
      date: new Date(),
      workspaceId,
      conversation: conversationId,
      channel: "telegram",
      direction: "inbound",
    });
    // Trigger auto-reply with telegram_quick_reply event kind so runtime
    // resolves the matching branch action inside the scenario.
    const chatDocument = {
      _id: dbChatId,
      sourceId: sourceContext?.sourceId || conversation.sourceId,
      workspaceId,
      businessConnectionId,
    };
    const ingressPayload = {
      type: "telegram" as const,
      triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply,
      quickReplyPayload,
      conversation: {
        _id: conversation._id,
        sourceId: conversation.sourceId,
        business_connection_id: conversation.business_connection_id,
        chat: conversation.chat,
      },
      workspaceId,
      chatDocument,
      chatId: chatId.toString(),
      chatType: "private",
    } as TelegramAiriIngressPayload;

    const { message: savedMessage } = await saveMessageWithDedup(
      inboundMessage as MessageDocument,
      { chat: dbChatId, messageId: `callback:${callbackQuery.id}` },
      ingressPayload
    );
    await acceptAiriConversationIngress(savedMessage, {
      ...ingressPayload,
      newMessage: savedMessage,
    });
    await appendMessageToConversationById(conversationId, savedMessage._id, {
      lastMessageAt: savedMessage.date as Date,
      direction: "inbound",
    });
  } catch (error) {
    console.error("[Telegram Callback] Quick-reply handler error:", error);
    throw error;
  }
}

async function handleGroundedQuickReply(
  callbackQuery: TelegramCallbackQuery,
  rawData: string,
  chatId: number,
  messageId: number,
  sourceContext?: SourceContext
) {
  const parts = rawData.slice(4).split(":");
  if (parts.length < 2) {
    console.warn("[Telegram Callback] Invalid gqr callback data:", rawData);
    return;
  }

  const conversationId = parts[0];
  const optionId = parts.slice(1).join(":");
  if (!conversationId || !optionId) {
    console.warn("[Telegram Callback] Missing gqr params:", {
      conversationId,
      optionId,
    });
    return;
  }

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation?.workspaceId) {
      return;
    }

    const outboundMessage = await Message.findOne({
      conversation: conversationId,
      channel: "telegram",
      direction: "outbound",
      messageId: String(messageId),
    })
      .select("groundedReplyOptions")
      .lean<{
        groundedReplyOptions?: {
          options?: Array<Record<string, unknown>>;
        } | null;
      } | null>();

    const selectedOption =
      outboundMessage?.groundedReplyOptions?.options?.find(
        option =>
          String(option?.callbackKey || "").trim() === optionId ||
          String(option?.id || "").trim() === optionId
      ) || null;
    const quickReplyPayload = buildGroundedReplyOptionPayload(
      selectedOption || undefined
    );
    const buttonText =
      (selectedOption &&
        typeof selectedOption.label === "string" &&
        selectedOption.label.trim()) ||
      resolveButtonText(callbackQuery, rawData);
    const { dbChatId, businessConnectionId } = resolveCallbackContext(
      conversation,
      callbackQuery,
      chatId
    );

    removeCallbackInlineKeyboard({
      chatId,
      messageId,
      botToken: sourceContext?.botToken,
      businessConnectionId,
      failureMessage: "[Telegram Callback] Failed to remove grounded keyboard:",
    });

    const inboundMessage = new Message({
      messageId: `callback:${callbackQuery.id}`,
      chat: dbChatId,
      author: callbackQuery.from.id,
      rawSourcePayload: buildRawSourcePayload({
        provider: "telegram",
        eventType: "callback_query",
        payload: callbackQuery,
      }),
      text: buttonText,
      date: new Date(),
      workspaceId: conversation.workspaceId,
      conversation: conversationId,
      channel: "telegram",
      direction: "inbound",
    });
    const chatDocument = {
      _id: dbChatId,
      sourceId: sourceContext?.sourceId || conversation.sourceId,
      workspaceId: conversation.workspaceId,
      businessConnectionId,
    };
    const ingressPayload = {
      type: "telegram" as const,
      quickReplyPayload,
      conversation: {
        _id: conversation._id,
        sourceId: conversation.sourceId,
        business_connection_id: conversation.business_connection_id,
        chat: conversation.chat,
      },
      workspaceId: conversation.workspaceId,
      chatDocument,
      chatId: chatId.toString(),
      chatType: "private",
    } as TelegramAiriIngressPayload;

    const { message: savedMessage } = await saveMessageWithDedup(
      inboundMessage as MessageDocument,
      { chat: dbChatId, messageId: `callback:${callbackQuery.id}` },
      ingressPayload
    );
    await acceptAiriConversationIngress(savedMessage, {
      ...ingressPayload,
      newMessage: savedMessage,
    });
    await appendMessageToConversationById(conversationId, savedMessage._id, {
      lastMessageAt: savedMessage.date as Date,
      direction: "inbound",
    });
  } catch (error) {
    console.error(
      "[Telegram Callback] Grounded quick-reply handler error:",
      error
    );
    throw error;
  }
}

function resolveCallbackContext(
  conversation: {
    chat?: unknown;
    business_connection_id?: string | null;
  },
  callbackQuery: TelegramCallbackQuery,
  chatId: number
) {
  const chat = conversation.chat as { _id?: unknown } | string | number | null;
  const dbChatId =
    typeof chat === "object" && chat?._id
      ? String(chat._id)
      : String(chat || chatId);
  const businessConnectionId = resolveBusinessConnectionId(
    conversation.business_connection_id,
    callbackQuery.message?.business_connection_id
  );

  return { dbChatId, businessConnectionId };
}

function removeCallbackInlineKeyboard({
  chatId,
  messageId,
  botToken,
  businessConnectionId,
  failureMessage,
}: {
  chatId: number;
  messageId: number;
  botToken?: string;
  businessConnectionId?: string;
  failureMessage: string;
}) {
  telegramApi
    .removeInlineKeyboard(chatId.toString(), messageId.toString(), {
      botToken,
      ...(businessConnectionId ? { businessConnectionId } : {}),
    })
    .catch(err => {
      // Non-fatal: buttons stay visible but the reply still works.
      console.warn(failureMessage, err);
    });
}

/**
 * Extracts the button label text from the callback query by matching the
 * callback_data against the original message's inline keyboard.
 * Falls back to the payload value if the keyboard is unavailable.
 */
function resolveButtonText(
  callbackQuery: TelegramCallbackQuery,
  rawData: string
): string {
  const replyMarkup = callbackQuery.message?.reply_markup;
  if (replyMarkup && "inline_keyboard" in replyMarkup) {
    for (const row of replyMarkup.inline_keyboard) {
      for (const button of row) {
        if (button.callback_data === rawData) {
          return button.text;
        }
      }
    }
  }
  // Fallback: use the payload portion as text
  const parts = rawData.slice(4).split(":");
  return parts.slice(1).join(":") || rawData;
}
