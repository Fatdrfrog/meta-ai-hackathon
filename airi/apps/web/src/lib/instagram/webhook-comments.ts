import { type AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import { detectAndUpdateConversationLanguage } from "@/lib/airi/coach/coach-utils-server";
import {
  getWorkspaceBotDefault,
  getWorkspaceCoachDefault,
  getWorkspaceScenariosDefault,
} from "@/lib/airi/workspace-bot-default";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  ensureCompanyConversationCapacity,
} from "@/lib/limits/company-limits";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import { persistOrRecoverAndLink } from "@icecore/shared/lib/persist-recover-link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildAiriConversationIngressIntent } from "@/lib/temporal/airi-turn-context";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import { readFiniteNumber, readDate } from "@icecore/shared/lib/value-utils";
import {
  getInstagramGraphApiBases,
  hashInstagramIdToNumber,
  INSTAGRAM_USER_PLACEHOLDER,
  publishInstagramConversationMessage,
  queueInstagramAiriAutoReply,
  resolveInstagramAccessToken,
  type InstagramSourceData,
} from "./webhook-shared";
import type { InstagramWebhookCommentPayload } from "./webhook-source";
import { buildInstagramMediaPermalink } from "./thread-meta";

function normalizeInstagramUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toDefinedDotNotation(
  prefix: string,
  values: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [`${prefix}.${key}`, value])
  );
}

async function enrichInstagramCommentPayload(
  payload: InstagramWebhookCommentPayload,
  source: InstagramSourceData
): Promise<InstagramWebhookCommentPayload> {
  const token = resolveInstagramAccessToken(source.pageAccessToken);
  const commentId = String(payload.id || "").trim();
  if (!token || !commentId) return payload;

  const fields =
    "id,text,timestamp,parent_id,hidden,like_count,from{id,username},media{id,media_product_type,media_type,permalink,shortcode,timestamp,caption,media_url,thumbnail_url,username}";
  const bases = getInstagramGraphApiBases(source.authMethod);

  for (const base of bases) {
    try {
      const url = new URL(`${base}/${encodeURIComponent(commentId)}`);
      url.searchParams.set("fields", fields);
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });
      if (!response.ok) continue;

      const data = (await response.json().catch(() => null)) as {
        id?: string;
        text?: string;
        timestamp?: string;
        parent_id?: string;
        hidden?: boolean;
        like_count?: number;
        from?: { id?: string; username?: string };
        media?: {
          id?: string;
          media_product_type?: string;
          media_type?: string;
          permalink?: string;
          shortcode?: string;
          timestamp?: string;
          caption?: string;
          media_url?: string;
          thumbnail_url?: string;
          username?: string;
        };
      } | null;
      if (!data) continue;

      const mediaShortcode =
        String(
          data.media?.shortcode || payload.media?.shortcode || ""
        ).trim() || undefined;
      const mediaPermalink = buildInstagramMediaPermalink(
        data.media?.permalink || payload.media?.permalink,
        mediaShortcode
      );
      const hidden = toOptionalBoolean(data.hidden);
      const likeCount = readFiniteNumber(data.like_count) ?? undefined;

      return {
        id: String(data.id || payload.id),
        text: String(data.text || payload.text || ""),
        timestamp:
          String(data.timestamp || payload.timestamp || "").trim() ||
          payload.timestamp,
        parent_id:
          String(data.parent_id || payload.parent_id || "").trim() ||
          payload.parent_id,
        hidden: hidden ?? payload.hidden,
        like_count: likeCount ?? payload.like_count,
        from: {
          id: String(data.from?.id || payload.from?.id || ""),
          username:
            String(data.from?.username || "").trim() ||
            payload.from?.username ||
            undefined,
        },
        media: {
          id: String(data.media?.id || payload.media?.id || ""),
          media_product_type:
            String(data.media?.media_product_type || "").trim() ||
            payload.media?.media_product_type,
          media_type:
            String(data.media?.media_type || "").trim() ||
            payload.media?.media_type,
          permalink: mediaPermalink || payload.media?.permalink,
          shortcode: mediaShortcode || payload.media?.shortcode,
          timestamp:
            String(
              data.media?.timestamp || payload.media?.timestamp || ""
            ).trim() || payload.media?.timestamp,
          caption:
            String(data.media?.caption || "").trim() || payload.media?.caption,
          media_url:
            String(data.media?.media_url || "").trim() ||
            payload.media?.media_url,
          thumbnail_url:
            String(data.media?.thumbnail_url || "").trim() ||
            payload.media?.thumbnail_url,
          username:
            String(data.media?.username || "").trim() ||
            payload.media?.username,
        },
      };
    } catch {
      // Fall through to next official Graph host fallback.
    }
  }

  return payload;
}

/**
 * Handle incoming Instagram comments
 */
export async function handleInstagramComment(
  commentData: InstagramWebhookCommentPayload,
  source: InstagramSourceData
) {
  await connectDB();

  const normalizedComment = await enrichInstagramCommentPayload(
    commentData,
    source
  );
  const senderId = String(normalizedComment.from?.id || "").trim();
  const senderUsername = normalizeInstagramUsername(
    normalizedComment.from?.username
  );
  const connectedUsername = normalizeInstagramUsername(
    source.instagramUsername
  );
  const text = String(normalizedComment.text || "").trim();
  const commentId = String(normalizedComment.id || "").trim();
  const mediaId = String(normalizedComment.media?.id || "").trim();
  const mediaPermalink =
    buildInstagramMediaPermalink(
      normalizedComment.media?.permalink,
      normalizedComment.media?.shortcode
    ) || "";
  const messageDate = readDate(normalizedComment.timestamp) || new Date();
  const commentMeta = {
    id: commentId || undefined,
    timestamp: readDate(normalizedComment.timestamp) ?? undefined,
    parentId: String(normalizedComment.parent_id || "").trim() || undefined,
    hidden: toOptionalBoolean(normalizedComment.hidden),
    likeCount: readFiniteNumber(normalizedComment.like_count) ?? undefined,
  };
  const mediaMeta = {
    id: mediaId || undefined,
    mediaType:
      String(normalizedComment.media?.media_type || "").trim() || undefined,
    mediaProductType:
      String(normalizedComment.media?.media_product_type || "").trim() ||
      undefined,
    shortcode:
      String(normalizedComment.media?.shortcode || "").trim() || undefined,
    timestamp: readDate(normalizedComment.media?.timestamp) ?? undefined,
    caption: String(normalizedComment.media?.caption || "").trim() || undefined,
    mediaUrl:
      String(normalizedComment.media?.media_url || "").trim() || undefined,
    thumbnailUrl:
      String(normalizedComment.media?.thumbnail_url || "").trim() || undefined,
    username:
      String(normalizedComment.media?.username || "").trim() || undefined,
  };
  const isOwnComment =
    senderId === source.pageId ||
    (source.instagramScopedId && senderId === source.instagramScopedId) ||
    (source.instagramBusinessAccountId &&
      senderId === source.instagramBusinessAccountId) ||
    (senderUsername &&
      connectedUsername &&
      senderUsername === connectedUsername);

  if (!text || !senderId || !commentId || !mediaId || isOwnComment) {
    return { status: "ignored", reason: "missing_data_or_self" };
  }

  // Extra safeguard against infinite loops: if this comment was already saved
  // as an outbound reply by Airi / a manager, skip it to prevent self-reply loops.
  const existingOutbound = await Message.findOne({
    channel: "instagram",
    workspaceId: source.workspace_id,
    direction: "outbound",
    messageId: commentId,
  });
  if (existingOutbound) {
    return { status: "ignored", reason: "own_outbound_echo" };
  }

  const workspaceId = source.workspace_id;
  const userId = hashInstagramIdToNumber(`ig:user:${senderId}`);
  const username =
    String(normalizedComment.from?.username || "").trim() ||
    INSTAGRAM_USER_PLACEHOLDER;
  const hasRealUsername = username !== INSTAGRAM_USER_PLACEHOLDER;
  const userSetOnInsert: Record<string, unknown> = { _id: userId };
  const userSet: Record<string, unknown> = {
    isBot: false,
    workspaceId,
  };

  if (hasRealUsername) {
    userSet.firstName = username;
    userSet.username = username;
  } else {
    userSetOnInsert.firstName = username;
  }

  const user = await User.findOneAndUpdate(
    { _id: userId },
    {
      $setOnInsert: userSetOnInsert,
      $set: userSet,
    },
    { upsert: true, new: true }
  );

  const chatId = hashInstagramIdToNumber(`ig:media:${mediaId}`);
  const chat = await Chat.findOneAndUpdate(
    { _id: chatId },
    {
      _id: chatId,
      type: "group",
      title: "Instagram Post Comments",
      sourceId: source.id,
      workspaceId,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  let conversation = await Conversation.findOne({
    workspaceId,
    channel: "instagram",
    "external_thread.provider": "instagram",
    "external_thread.threadId": mediaId,
    status: { $ne: "closed" },
    $or: [
      { "external_thread.type": "comment" },
      { "external_thread.type": { $exists: false } },
      { "external_thread.type": null },
    ],
  });

  let isNewConversation = false;
  if (!conversation) {
    const capacity = await ensureCompanyConversationCapacity(
      supabaseAdmin,
      workspaceId
    );
    if (!capacity.allowed) {
      console.warn(
        "[Instagram comments] New conversation blocked by company limit",
        {
          workspaceId,
          sourceId: source.id,
          mediaId,
          commentId,
          userId,
          code: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
        }
      );
      return {
        status: "ok",
        blockedByLimit: true,
        reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
      };
    }

    const [botDefaultEnabled, scenariosDefaultEnabled, coachDefaultEnabled] =
      await Promise.all([
        getWorkspaceBotDefault(workspaceId),
        getWorkspaceScenariosDefault(workspaceId),
        getWorkspaceCoachDefault(workspaceId),
      ]);
    conversation = new Conversation({
      chat: chatId,
      user: userId,
      messages: [],
      is_classified: false,
      workspaceId,
      channel: "instagram",
      airi_bot_enabled: botDefaultEnabled,
      airi_scenarios_enabled: scenariosDefaultEnabled,
      airi_coach_enabled: coachDefaultEnabled,
      participants: { from: [String(userId)], to: ["agent"] },
      external_thread: {
        provider: "instagram",
        threadId: mediaId,
        type: "comment",
        permalink: mediaPermalink || undefined,
        comment: commentMeta,
        media: mediaMeta,
      },
    });
    await conversation.save();
    isNewConversation = true;
  } else {
    if (!conversation.participants?.from?.includes(String(userId))) {
      conversation.participants = conversation.participants || {
        from: [],
        to: ["agent"],
      };
      conversation.participants.from = conversation.participants.from || [];
      conversation.participants.to = conversation.participants.to || ["agent"];
      conversation.participants.from.push(String(userId));
    }
    if (!conversation.user) conversation.user = userId;
    conversation.external_thread = {
      ...(conversation.external_thread || {}),
      provider: "instagram",
      threadId: mediaId,
      type: "comment",
      permalink: mediaPermalink || conversation.external_thread?.permalink,
      comment: {
        ...(conversation.external_thread?.comment || {}),
        ...commentMeta,
      },
      media: {
        ...(conversation.external_thread?.media || {}),
        ...mediaMeta,
      },
    };
  }

  const messageDoc = new Message({
    messageId: commentId,
    chat: chat._id,
    author: user._id,
    rawSourcePayload: buildRawSourcePayload({
      provider: "instagram",
      eventType: "comment",
      capturedAt: messageDate,
      payload: normalizedComment,
    }),
    text,
    date: messageDate,
    workspaceId,
    conversation: conversation._id,
    channel: "instagram",
    direction: "inbound",
  });
  const accessToken = resolveInstagramAccessToken(source.pageAccessToken);
  const airiParams: AiriAutoReplyParams | undefined = accessToken
    ? {
        type: "instagram",
        instagramInfo: {
          pageId: source.pageId,
          accessToken,
          recipientId: senderId,
          authMethod: source.authMethod,
          threadType: "comment",
          commentId,
        },
        newMessage: messageDoc,
        conversation,
        workspaceId,
        chatDocument: chat,
        chatId,
      }
    : undefined;
  if (airiParams) {
    messageDoc.airiIngressIntent =
      buildAiriConversationIngressIntent(airiParams);
  }

  const { record: newMessage, linkResult } = await persistOrRecoverAndLink({
    findExisting: () =>
      Message.findOne({
        channel: "instagram",
        workspaceId,
        direction: "inbound",
        messageId: commentId,
      }).exec(),
    persist: () => messageDoc.save(),
    isDuplicateError: isMongoDuplicateKeyError,
    link: message => {
      if (
        !message.conversation ||
        String(message.conversation) !== String(conversation._id)
      ) {
        throw new Error(
          `Instagram comment ${commentId} is persisted against a different conversation.`
        );
      }

      return appendMessageToConversationById(
        message.conversation,
        message._id,
        {
          lastMessageAt:
            message.date instanceof Date ? message.date : messageDate,
          direction: "inbound",
          set: {
            workspaceId,
            participants: conversation.participants,
            user: conversation.user,
            "external_thread.provider": "instagram",
            "external_thread.threadId": mediaId,
            "external_thread.type": "comment",
            ...(mediaPermalink
              ? { "external_thread.permalink": mediaPermalink }
              : {}),
            ...toDefinedDotNotation("external_thread.comment", commentMeta),
            ...toDefinedDotNotation("external_thread.media", mediaMeta),
          },
        }
      );
    },
  });

  if (airiParams) {
    await queueInstagramAiriAutoReply(
      { ...airiParams, newMessage },
      {
        missingContextError:
          "Instagram comment auto-reply Temporal ingress requires workspace, conversation, and message ids",
      }
    );
  }

  if (!linkResult.appended) {
    return { status: "ok", duplicate: true };
  }

  if (text) {
    await detectAndUpdateConversationLanguage(String(conversation._id), text);
  }

  try {
    await publishInstagramConversationMessage({
      workspaceId,
      conversationId: conversation._id,
      messageId: newMessage._id,
      isNewConversation,
    });
  } catch {}

  return { status: "ok", conversationId: String(conversation._id) };
}
