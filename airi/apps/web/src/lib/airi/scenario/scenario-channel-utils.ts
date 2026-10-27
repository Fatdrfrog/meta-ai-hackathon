import { isPlaceholderContactName } from "@/lib/campaign/campaign-recipient-name";
import { decryptMaybeString } from "@/lib/crypto";
import { resolveInstagramSenderId } from "@/lib/instagram/outbound";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { readTelegramBotToken } from "@/lib/telegram/telegram-source";
import {
  resolveWhatsAppSendContext,
  resolveWhatsAppSendContextResult,
  type WhatsAppSendContext,
} from "@/lib/whatsapp/send-context";
import { z } from "zod";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import User from "@/models/user";
import type { Channel, ChatDocument } from "@/types/models";
import { resolveConversationReplySourceId } from "@icecore/shared/lib/conversation-reply-source";
import {
  parseWhatsAppRecipientTarget,
  resolveStoredWhatsAppRecipientTarget,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  isInstagramSource,
  isTelegramSource,
} from "@icecore/shared/types/sources";

import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import {
  joinNameParts,
  normalizeString,
  readEntityId,
  readEntityIdRaw,
  type ScenarioConversationBase,
} from "@/lib/scenarios/task-utils";

type ScenarioChatRecord = {
  _id?: unknown;
  sourceId?: string;
  workspaceId?: string;
  businessConnectionId?: string;
  type?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
};

export async function resolveChatDocument(
  conversation: ScenarioConversationBase
): Promise<{
  chatDocument: ChatDocument;
  chatId?: string | number;
  chatType?: string;
}> {
  const chatRefRaw = readEntityIdRaw(conversation.chat);
  const chatIdValue = readEntityId(chatRefRaw);
  const conversationBusinessConnectionId = normalizeString(
    conversation.business_connection_id
  );
  let chatDoc: ScenarioChatRecord | null = null;

  if (chatRefRaw !== null && chatRefRaw !== undefined) {
    chatDoc = await Chat.findOne({
      _id: chatRefRaw,
    }).lean<ScenarioChatRecord | null>();
  }

  const fallbackChatId = chatIdValue || String(conversation._id || "");

  return {
    chatDocument: {
      _id: chatDoc?._id || fallbackChatId,
      sourceId:
        resolveConversationReplySourceId({
          workspaceId: conversation.workspaceId,
          conversation,
          chat: chatDoc,
        }) || "",
      // The chat is shared by every workspace the customer writes to.
      workspaceId: conversation.workspaceId || chatDoc?.workspaceId,
      businessConnectionId:
        chatDoc?.businessConnectionId || conversationBusinessConnectionId,
      type:
        (chatDoc?.type as "private" | "group" | "supergroup" | "channel") ||
        "private",
      title: chatDoc?.title,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ChatDocument,
    chatId: fallbackChatId || undefined,
    chatType: normalizeString(chatDoc?.type) || undefined,
  };
}

/**
 * The name this workspace's campaign file gave the conversation's contact.
 * It lives on the conversation because the contact record is shared by every
 * workspace that talks to the number.
 */
async function readCampaignRecipientName(
  conversation: ScenarioConversationBase & {
    campaign_recipient_name?: unknown;
  }
): Promise<string> {
  if ("campaign_recipient_name" in conversation) {
    return normalizeString(conversation.campaign_recipient_name);
  }
  if (!conversation._id) return "";
  const stored = await Conversation.findById(conversation._id)
    .select("campaign_recipient_name")
    .lean<{ campaign_recipient_name?: unknown } | null>();
  return normalizeString(stored?.campaign_recipient_name);
}

export async function resolveConversationUserName(
  conversation: ScenarioConversationBase,
  chatDoc: ChatDocument
): Promise<string> {
  const conversationUserId = readEntityId(conversation.user);
  if (conversationUserId) {
    const user = await User.findById(conversationUserId)
      .select("firstName lastName")
      .lean<{ firstName?: string; lastName?: string } | null>();
    const name =
      joinNameParts(user?.firstName, user?.lastName) ||
      normalizeString(user?.firstName);
    // A name from WhatsApp or a manager wins; "Customer" or the phone a
    // campaign stored gives way to the name its recipient file had.
    if (name && !isPlaceholderContactName(name)) return name;
    const campaignName = await readCampaignRecipientName(conversation);
    if (campaignName) return campaignName;
    if (name) return name;
  }

  const chatAny = chatDoc as ChatDocument & {
    first_name?: string;
    last_name?: string;
    title?: string;
    username?: string;
  };
  return (
    joinNameParts(chatAny.first_name, chatAny.last_name) ||
    normalizeString(chatAny.first_name) ||
    normalizeString(chatAny.title) ||
    normalizeString(chatAny.username) ||
    "Customer"
  );
}

export type ChannelSpecificParams = {
  ok: boolean;
  reason?: string;
  botToken?: string;
  whatsAppInfo?: AiriAutoReplyParams["whatsAppInfo"];
  instagramInfo?: AiriAutoReplyParams["instagramInfo"];
};

const sourceBindingTimeSchema = z.string().datetime({ offset: true });

export async function buildChannelSpecificParams(params: {
  workspaceId: string;
  conversation: ScenarioConversationBase;
  chatDocument: ChatDocument;
  channelOverride?: string | null;
  /** Opt in to a fresh source read and reject a binding changed after this wait. */
  sourceBindingNotAfter?: string;
}): Promise<ChannelSpecificParams> {
  const channel = (normalizeString(params.channelOverride) ||
    normalizeString(params.conversation.channel)) as Channel;
  const sourceId = normalizeString(params.conversation.sourceId);
  const workspaceId = normalizeString(params.workspaceId);

  if (channel === "telegram") {
    if (!sourceId) return { ok: true };
    const source = await fetchSourceWithCredentials(sourceId, "telegram");
    const token =
      source && isTelegramSource(source)
        ? readTelegramBotToken(source.credentials)
        : undefined;
    return { ok: true, botToken: token || undefined };
  }

  if (channel === "whatsapp") {
    let sendContext: WhatsAppSendContext | null;
    if (params.sourceBindingNotAfter !== undefined) {
      const waitTime = sourceBindingTimeSchema.safeParse(
        params.sourceBindingNotAfter
      );
      if (!waitTime.success)
        return { ok: false, reason: "whatsapp_source_binding_changed" };
      const resolved = await resolveWhatsAppSendContextResult(
        { workspaceId, sourceId },
        { cacheMode: "bypass" }
      );
      if (!resolved.ok) {
        if (resolved.kind === "query_error") {
          throw resolved.error instanceof Error
            ? resolved.error
            : new Error("WhatsApp source lookup failed", {
                cause: resolved.error,
              });
        }
        return { ok: false, reason: resolved.reason };
      }
      sendContext = resolved.context;
      if (
        sendContext.attributionBoundaryAt === null ||
        (sendContext.attributionBoundaryAt !== undefined &&
          Date.parse(sendContext.attributionBoundaryAt) >
            Date.parse(waitTime.data))
      ) {
        return { ok: false, reason: "whatsapp_source_binding_changed" };
      }
    } else {
      sendContext = await resolveWhatsAppSendContext({ workspaceId, sourceId });
    }
    const phoneNumberId = normalizeString(sendContext?.phoneNumberId);
    const accessToken = normalizeString(sendContext?.accessToken);
    const recipientTarget =
      resolveStoredWhatsAppRecipientTarget(
        params.conversation.user,
        params.conversation.chat
      ) ||
      parseWhatsAppRecipientTarget(readEntityId(params.conversation.user)) ||
      parseWhatsAppRecipientTarget(readEntityId(params.conversation.chat));
    if (!phoneNumberId || !accessToken || !recipientTarget) {
      return { ok: false, reason: "missing_whatsapp_send_context" };
    }

    const resolvedName = await resolveConversationUserName(
      params.conversation,
      params.chatDocument
    );
    return {
      ok: true,
      whatsAppInfo: {
        phoneNumberId,
        accessToken,
        messagingAccountId: normalizeString(sendContext?.messagingAccountId),
        wabaId: normalizeString(sendContext?.wabaId),
        contactData: {
          ...(recipientTarget.kind === "phone"
            ? { waId: recipientTarget.value, primaryIdType: "wa_id" as const }
            : recipientTarget.kind === "parent_bsuid"
              ? {
                  parentUserId: recipientTarget.value,
                  primaryIdType: "parent_user_id" as const,
                }
              : {
                  userId: recipientTarget.value,
                  primaryIdType: "user_id" as const,
                }),
          profile: { name: resolvedName || "Customer" },
        },
      },
    };
  }

  if (channel === "instagram") {
    const threadType = normalizeString(
      params.conversation.external_thread?.type
    );
    if (threadType === "comment") {
      return {
        ok: false,
        reason: "instagram_comment_followup_unsupported",
      };
    }
    const source =
      (sourceId
        ? await fetchSourceWithCredentials(sourceId, "instagram")
        : null) ||
      (await fetchSourceWithCredentials(undefined, "instagram", {
        workspace_id: workspaceId,
      }));
    const credentials =
      source && isInstagramSource(source) ? source.credentials : null;
    const token = decryptMaybeString(credentials?.page_access_token);
    const authMethod = normalizeString(credentials?.auth_method);
    const pageId = credentials
      ? resolveInstagramSenderId(credentials, authMethod)
      : "";
    const recipientId = normalizeString(
      params.conversation.external_thread?.threadId
    );
    if (!token || !pageId || !recipientId) {
      return { ok: false, reason: "missing_instagram_send_context" };
    }
    return {
      ok: true,
      instagramInfo: {
        pageId,
        accessToken: token,
        recipientId,
        authMethod: authMethod || undefined,
        threadType: "dm",
      },
    };
  }

  return { ok: true };
}
