import {
  CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS,
  resolveCustomerMediaReadUrl,
} from "@/lib/media/customer-media-read-url";
import {
  persistManagerOutboundMessage,
  upsertManagerAuthor,
  type ManagerAuthor,
} from "@/lib/conversation-messages";
import {
  buildInstagramAttachmentMessagePayload,
  buildInstagramDmMessageBody,
  buildInstagramPrivateReplyMessageBody,
  isInstagramTextTooLong,
  postInstagramGraph,
  readInstagramSendId,
} from "@/lib/instagram/outbound";
import { applyInstagramHumanAgentWindow } from "@/lib/instagram/human-agent";
import {
  InstagramPartialSendError,
  InstagramSendError,
  isInstagramSendError,
  throwInstagramGraphFailure,
} from "@/lib/instagram/send-errors";
import {
  resolveInstagramSendContext,
  resolveInstagramSendContextHumanAgent,
} from "@/lib/instagram/send-context";
import { checkMessagingWindowForConversation } from "@/lib/messaging-window";
import Message from "@/models/message";
import { ConversationDocument, PopulatedMessage } from "@/types/models";
import type { OutboundAttachment } from "@/types/outbound-attachment";
import type { ManagerReplyContext } from "./manager-reply-context";

type InstagramSendResult = {
  id?: string;
};

function normalizeAttachmentPreview(attachments: OutboundAttachment[]) {
  const attachment = attachments.find(item => item.url);
  if (!attachment?.url) return {};

  return {
    imageUrl: attachment.url,
    mediaType: attachment.mediaType,
    attachments: attachments
      .filter(item => item.url)
      .map(item => ({
        filename: item.fileName || "Instagram attachment",
        url: item.url || "",
        contentType: item.mimeType || "application/octet-stream",
        sizeBytes: item.fileSize || 0,
      })),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(typeof attachment.fileSize === "number"
      ? { fileSize: attachment.fileSize }
      : {}),
  };
}

async function sendInstagramDmPayload(params: {
  graphApiBase: string;
  senderId: string;
  accessToken: string;
  recipientId: string;
  message: Record<string, unknown>;
  useHumanAgentTag: boolean;
  isAttachment: boolean;
}): Promise<InstagramSendResult> {
  const url = `${params.graphApiBase}/${encodeURIComponent(params.senderId)}/messages`;
  const response = await postInstagramGraph(
    url,
    params.accessToken,
    buildInstagramDmMessageBody({
      recipientId: params.recipientId,
      message: params.message,
      useHumanAgentTag: params.useHumanAgentTag,
    })
  );

  if (!response.ok) {
    await throwInstagramGraphFailure(response, url, {
      kind: "dm",
      usedHumanAgentTag: params.useHumanAgentTag,
      isAttachment: params.isAttachment,
    });
  }

  return { id: await readInstagramSendId(response) };
}

export async function handleInstagramReply({
  conversation,
  text,
  workspaceId,
  manager,
  attachments,
  replyToMessageId,
  instagramReplyMode,
}: ManagerReplyContext): Promise<PopulatedMessage> {
  const startedAt = Date.now();
  const sendContext = await resolveInstagramSendContext({
    sourceId: conversation.sourceId,
    workspaceId,
  });
  if (!sendContext?.accessToken || !sendContext.senderId) {
    throw new Error("Instagram not configured");
  }

  const accessToken = sendContext.accessToken;
  const senderId = sendContext.senderId;
  const graphApiBase = sendContext.graphApiBase;
  const isCommentThread = conversation.external_thread?.type === "comment";
  const receiverIgUserId = conversation.external_thread?.threadId || "";
  if (!isCommentThread && !receiverIgUserId) {
    throw new Error("Missing Instagram recipient id");
  }

  const messageText = text.trim();
  let platformMessageId: string | undefined;
  const firstAttachment = attachments.find(item => item.url);
  let useHumanAgentTag = false;
  const sendsThroughMessagesApi =
    !isCommentThread || instagramReplyMode === "private";
  if (sendsThroughMessagesApi && isInstagramTextTooLong(messageText)) {
    throw new InstagramSendError({ code: "instagram_text_too_long" });
  }

  if (isCommentThread) {
    if (attachments.length > 0) {
      throw new Error("Instagram comment replies support text only");
    }
    if (!messageText) {
      throw new Error("Instagram comment replies require message text");
    }

    const targetMsg =
      (replyToMessageId
        ? await Message.findOne({
            _id: replyToMessageId,
            conversation: conversation._id,
            channel: "instagram",
            direction: "inbound",
          })
        : null) ||
      (await Message.findOne({
        conversation: conversation._id,
        channel: "instagram",
        direction: "inbound",
        messageId: { $exists: true, $ne: null },
      }).sort({ date: -1 }));
    if (!targetMsg?.messageId) {
      throw new Error(
        "Target comment not found. Select a comment message and retry."
      );
    }
    const igCommentId = String(targetMsg.messageId).trim();
    if (!igCommentId) {
      throw new Error("Target comment not found or missing Instagram ID");
    }

    const preMetaMs = Date.now() - startedAt;
    const metaStartedAt = Date.now();

    const commentSendUrl =
      instagramReplyMode === "private"
        ? `${graphApiBase}/${encodeURIComponent(senderId)}/messages`
        : `${graphApiBase}/${encodeURIComponent(igCommentId)}/replies`;
    const sendRes = await postInstagramGraph(
      commentSendUrl,
      accessToken,
      instagramReplyMode === "private"
        ? buildInstagramPrivateReplyMessageBody({
            commentId: igCommentId,
            text: messageText,
          })
        : { message: messageText }
    );

    if (!sendRes.ok) {
      await throwInstagramGraphFailure(sendRes, commentSendUrl, {
        kind:
          instagramReplyMode === "private" ? "private_reply" : "comment_reply",
      });
    }

    platformMessageId = await readInstagramSendId(sendRes);

    const result = await persistInstagramReply({
      conversation,
      workspaceId,
      manager,
      messageText,
      attachments,
      firstAttachment,
      platformMessageId,
      preMetaMs,
      metaSendMs: Date.now() - metaStartedAt,
      cacheHit: sendContext.cacheHit,
      startedAt,
    });

    return result;
  }

  const windowInfo = await checkMessagingWindowForConversation(conversation);
  if (!windowInfo.isWithinWindow) {
    if (!windowInfo.lastCustomerMessageAt) {
      throw new InstagramSendError({
        code: "instagram_customer_message_required",
      });
    }

    const humanAgent = applyInstagramHumanAgentWindow(
      resolveInstagramSendContextHumanAgent(sendContext),
      windowInfo.lastCustomerMessageAt
    );

    if (!humanAgent.enabled) {
      throw new InstagramSendError({
        code:
          humanAgent.reason === "human_agent_window_expired"
            ? "instagram_human_agent_window_expired"
            : "instagram_window_closed",
      });
    }

    useHumanAgentTag = true;
  }

  const preMetaMs = Date.now() - startedAt;
  const metaStartedAt = Date.now();
  let textDelivered = false;
  const deliveredAttachments: OutboundAttachment[] = [];
  let failure: unknown = null;

  // Text and each attachment are separate Meta messages. Keep going only while
  // they succeed, and remember what already reached the customer.
  try {
    if (messageText) {
      const result = await sendInstagramDmPayload({
        graphApiBase,
        senderId,
        accessToken,
        recipientId: receiverIgUserId,
        message: { text: messageText },
        useHumanAgentTag,
        isAttachment: false,
      });
      platformMessageId = result.id;
      textDelivered = true;
    }

    for (const attachment of attachments) {
      if (!attachment.url) continue;
      const result = await sendInstagramDmPayload({
        graphApiBase,
        senderId,
        accessToken,
        recipientId: receiverIgUserId,
        message: buildInstagramAttachmentMessagePayload({
          mediaType: attachment.mediaType,
          url: await resolveCustomerMediaReadUrl(
            attachment.url,
            CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS
          ),
        }),
        useHumanAgentTag,
        isAttachment: true,
      });
      deliveredAttachments.push(attachment);
      if (!platformMessageId && result.id) {
        platformMessageId = result.id;
      }
    }
  } catch (error) {
    failure = error;
  }

  if (failure && !textDelivered && deliveredAttachments.length === 0) {
    throw failure;
  }

  const persisted = await persistInstagramReply({
    conversation,
    workspaceId,
    manager,
    messageText: textDelivered ? messageText : "",
    attachments: failure ? deliveredAttachments : attachments,
    firstAttachment: failure ? deliveredAttachments[0] : firstAttachment,
    platformMessageId,
    preMetaMs,
    metaSendMs: Date.now() - metaStartedAt,
    cacheHit: sendContext.cacheHit,
    startedAt,
  });

  if (failure) {
    throw new InstagramPartialSendError(
      isInstagramSendError(failure)
        ? failure
        : new InstagramSendError({
            code: "instagram_send_failed",
            cause: failure,
          }),
      persisted
    );
  }

  return persisted;
}

async function persistInstagramReply(params: {
  conversation: ConversationDocument;
  workspaceId: string;
  manager: ManagerAuthor;
  messageText: string;
  attachments: OutboundAttachment[];
  firstAttachment?: OutboundAttachment;
  platformMessageId?: string;
  preMetaMs: number;
  metaSendMs: number;
  cacheHit?: boolean;
  startedAt: number;
}): Promise<PopulatedMessage> {
  const { manager, messageText, attachments, firstAttachment } = params;

  const persistStartedAt = Date.now();
  const populatedMessage = await persistManagerOutboundMessage({
    conversation: params.conversation,
    workspaceId: params.workspaceId,
    channel: "instagram",
    managerId: manager.id,
    managerUser: await upsertManagerAuthor(manager),
    message: {
      messageId: params.platformMessageId,
      date: new Date(),
      text: messageText || (firstAttachment ? "[attachment]" : ""),
      fields: normalizeAttachmentPreview(attachments),
    },
    logTag: "Reply:Instagram",
  });

  console.info("[Reply:Instagram] Manager send timing", {
    preMetaMs: params.preMetaMs,
    metaSendMs: params.metaSendMs,
    persistMs: Date.now() - persistStartedAt,
    totalMs: Date.now() - params.startedAt,
    channel: "instagram",
    attachmentCount: attachments.length,
    cacheHit: params.cacheHit,
  });

  return populatedMessage;
}
