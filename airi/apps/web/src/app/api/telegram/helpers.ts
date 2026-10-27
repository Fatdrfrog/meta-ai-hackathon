import {
  normalizeAiriLanguage,
  type AiriLanguage,
} from "@/lib/airi/shared/language-policy";
import {
  getWorkspaceBotDefault,
  getWorkspaceCoachDefault,
  getWorkspaceScenariosDefault,
} from "@/lib/airi/workspace-bot-default";
import {
  invalidateConversationCache,
  invalidateRequestsForWorkspace,
} from "@/lib/cache";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  ensureCompanyConversationCapacity,
} from "@/lib/limits/company-limits";
import { enqueueConversationMediaAnalysis } from "@/lib/media/conversation-media-analysis-jobs";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import { realtime } from "@/lib/realtime/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import * as telegramApi from "@/lib/telegram";
import { buildTelegramCompositeChatId } from "@/lib/telegram/chat-id";
import { buildTelegramStoredMessageMeta } from "@/lib/telegram/message-identity";
import {
  buildAiriConversationIngressIntent,
  type AiriTurnContextInput,
} from "@/lib/temporal/airi-turn-context";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import type {
  ChatDocument,
  ConversationDocument,
  MessageDocument,
} from "@/types/models";
import type {
  TelegramChat,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUser,
} from "@/types/telegram";
import { Document } from "mongoose";
import enMessages from "../../../../messages/settings/integrations/en/page.json";
import kzMessages from "../../../../messages/settings/integrations/kz/page.json";
import ruMessages from "../../../../messages/settings/integrations/ru/page.json";
import { linkBusinessConnectionToSource } from "./handleBusinessConnectionUpdate";
import { extractTelegramMediaMetadata } from "./message-content";

/**
 * Generates a unique, multi-tenant scoped ID for Telegram chats.
 * Format: tg_{chatId}_{sourceId}
 */
export function getTelegramChatId(
  chatId: string | number,
  sourceId: string
): string {
  return buildTelegramCompositeChatId(chatId, sourceId);
}

export interface SourceRow {
  id: string;
  workspace_id?: string;
  companies?: { name?: string } | Array<{ name?: string }>;
}

type SaveMessageResult = {
  message: MessageDocument;
  isNew: boolean;
};

export type TelegramAiriIngressPayload = Omit<
  AiriTurnContextInput,
  "newMessage"
>;

type TelegramUploadedMedia = {
  publicUrl: string;
  size: number;
  contentType: string;
  filename?: string;
};

function buildTelegramMessageRawSourcePayload(
  message: TelegramMessage,
  capturedAt: Date
) {
  return buildRawSourcePayload({
    provider: "telegram",
    eventType: "message",
    capturedAt,
    payload: message,
  });
}

type SupportedTelegramLocale = "en" | "ru" | "kz";

type TelegramWebhookTranslations = {
  invalidSourceOrConfiguration: string;
  linkSuccessBusiness: string;
  linkSuccessStandard: string;
  businessLinkSuccess: string;
  businessLinkWarningReplyDisabled: string;
  businessLinkReady: string;
  businessLinkErrorTitle: string;
  businessLinkErrorInvalidSource: string;
  businessLinkErrorNoWorkspace: string;
  businessLinkErrorGeneric: string;
  statusNoConnection: string;
  statusConnectedDateUnknown: string;
  statusWorkspaceLinked: string;
  statusWorkspaceNotLinked: string;
  statusCanReplyYes: string;
  statusCanReplyNo: string;
  statusEnabledYes: string;
  statusEnabledNo: string;
  statusTemplate: string;
  helpGreeting: string;
  helpBusinessMode: string;
};

const DEFAULT_COMPANY_NAME = "your company";

const TELEGRAM_WEBHOOK_TRANSLATIONS = {
  en: enMessages.TelegramWebhook,
  ru: ruMessages.TelegramWebhook,
  kz: kzMessages.TelegramWebhook,
} satisfies Record<SupportedTelegramLocale, TelegramWebhookTranslations>;

function resolveTelegramLocale(
  rawLanguage?: string | null
): SupportedTelegramLocale {
  const normalized = normalizeAiriLanguage(
    rawLanguage as AiriLanguage | string | null | undefined
  );
  if (normalized === "ru" || normalized === "kz") {
    return normalized;
  }
  return "en";
}

async function getWorkspaceAiriLanguage(
  workspaceId?: string
): Promise<SupportedTelegramLocale> {
  if (!workspaceId) {
    return "en";
  }
  try {
    const { data } = await supabaseAdmin
      .from("companies")
      .select("airi_language")
      .eq("id", workspaceId)
      .maybeSingle<{ airi_language: string | null }>();
    return resolveTelegramLocale(data?.airi_language);
  } catch {
    return "en";
  }
}

async function getSourceAiriLanguage(
  sourceId?: string
): Promise<SupportedTelegramLocale> {
  if (!sourceId) {
    return "en";
  }
  try {
    const { data } = await supabaseAdmin
      .from("sources")
      .select("workspace_id, companies(airi_language)")
      .eq("id", sourceId)
      .maybeSingle<{
        workspace_id: string | null;
        companies?: { airi_language?: string | null } | null;
      }>();

    const company = Array.isArray(data?.companies)
      ? data.companies[0]
      : data?.companies;
    if (company?.airi_language) {
      return resolveTelegramLocale(company.airi_language);
    }
    if (data?.workspace_id) {
      return getWorkspaceAiriLanguage(data.workspace_id);
    }
    return "en";
  } catch {
    return "en";
  }
}

function tTelegramWebhook(
  locale: SupportedTelegramLocale
): TelegramWebhookTranslations {
  return TELEGRAM_WEBHOOK_TRANSLATIONS[locale];
}

export function safeParseChatId(
  chatId: string | number | undefined | null
): number | null {
  if (typeof chatId === "number") {
    return Number.isFinite(chatId) ? chatId : null;
  }
  if (typeof chatId === "string" && chatId.length > 0) {
    const parsed = Number(chatId);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveCompanyName(source?: SourceRow | null) {
  const companies = source?.companies;
  if (Array.isArray(companies)) {
    return companies[0]?.name ?? DEFAULT_COMPANY_NAME;
  }
  if (companies && typeof companies === "object") {
    return companies.name ?? DEFAULT_COMPANY_NAME;
  }
  return DEFAULT_COMPANY_NAME;
}

export async function updateTelegramUserAvatar(
  userDoc: Document & { _id: number; avatar_url?: string },
  botToken?: string
): Promise<void> {
  const maxAvatarBytes = 2 * 1024 * 1024;
  try {
    const photos = await telegramApi.getUserProfilePhotos(userDoc._id, {
      limit: 1,
      botToken,
    });

    if (photos.total_count > 0 && photos.photos.length > 0) {
      const variants = photos.photos[0];
      const largestPhoto = variants[variants.length - 1]; // Get largest variant

      const fileInfo = await telegramApi.getFile(
        largestPhoto.file_id,
        botToken
      );
      if (Number(fileInfo.file_size || largestPhoto.file_size) > maxAvatarBytes)
        throw new Error("Telegram avatar exceeds the allowed size");
      if (fileInfo.file_path) {
        const fileUrl = telegramApi.getFileUrl(fileInfo.file_path, botToken);

        // Fetch the image
        const response = await fetch(fileUrl);
        if (response.ok) {
          if (Number(response.headers.get("content-length")) > maxAvatarBytes) {
            await response.body?.cancel();
            throw new Error("Telegram avatar exceeds the allowed size");
          }
          if (!response.body)
            throw new Error("Telegram avatar body is unavailable");
          const reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > maxAvatarBytes) {
                await reader.cancel();
                throw new Error("Telegram avatar exceeds the allowed size");
              }
              chunks.push(Buffer.from(next.value));
            }
          } finally {
            reader.releaseLock();
          }
          if (!size) throw new Error("Telegram avatar is empty");
          const buffer = Buffer.concat(chunks, size);
          const fileName = `telegram/${userDoc._id}.jpg`;

          // Upload to Supabase Storage
          const { error: uploadError } = await supabaseAdmin.storage
            .from("avatars")
            .upload(fileName, buffer, {
              contentType: "image/jpeg",
              upsert: true,
            });

          if (!uploadError) {
            const { data } = supabaseAdmin.storage
              .from("avatars")
              .getPublicUrl(fileName);

            if (data.publicUrl) {
              await User.updateOne(
                { _id: userDoc._id },
                { $set: { avatar_url: data.publicUrl } }
              );
            }
          } else {
            console.error("Failed to upload avatar to Supabase:", uploadError);
          }
        }
      }
    }
  } catch (error) {
    console.error("Error updating Telegram avatar:", error);
  }
}

export async function ensureTelegramUser(
  user: TelegramUser,
  botToken?: string
): Promise<void> {
  const userDoc = await User.findOneAndUpdate(
    { _id: user.id },
    {
      _id: user.id,
      isBot: user.is_bot,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
    },
    { upsert: true, new: true }
  );

  if (userDoc && !userDoc.avatar_url) {
    // Run in background to not block the main flow
    updateTelegramUserAvatar(userDoc, botToken).catch(err =>
      console.error("Backround avatar update failed:", err)
    );
  }
}

export async function ensureChatDocument(
  chat: TelegramChat,
  participantId: number,
  sourceId: string,
  businessConnectionId?: string
): Promise<ChatDocument> {
  const compositeId = getTelegramChatId(chat.id, sourceId);
  const filter = { _id: compositeId };

  const update: Record<string, unknown> = {
    $addToSet: { participants: participantId },
    $setOnInsert: {
      type: chat.type,
      title: chat.title,
      sourceId: sourceId,
      ...(typeof chat.is_forum === "boolean"
        ? { is_forum: chat.is_forum }
        : {}),
    },
  };

  if (businessConnectionId) {
    update.$set = {
      businessConnectionId,
      ...(chat.first_name && { first_name: chat.first_name }),
      ...(chat.last_name && { last_name: chat.last_name }),
      ...(chat.username && { username: chat.username }),
      ...(typeof chat.is_forum === "boolean"
        ? { is_forum: chat.is_forum }
        : {}),
    };
  } else {
    const setOnInsert = update.$setOnInsert as Record<string, unknown>;
    if (chat.first_name) setOnInsert.first_name = chat.first_name;
    if (chat.last_name) setOnInsert.last_name = chat.last_name;
    if (chat.username) setOnInsert.username = chat.username;
    if (typeof chat.is_forum === "boolean") {
      setOnInsert.is_forum = chat.is_forum;
    }
  }

  const chatDoc = await Chat.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  if (!chatDoc) {
    throw new Error("Failed to upsert Telegram chat document");
  }

  return chatDoc as ChatDocument;
}

export async function resolveWorkspaceId(
  chatDoc: ChatDocument,
  chat: TelegramChat,
  businessConnectionId: string | undefined
): Promise<string | undefined> {
  let workspaceId: string | undefined;

  if (businessConnectionId) {
    try {
      const query = supabaseAdmin
        .from("telegram_business_connections")
        .select("workspace_id, source_id, telegram_user_id")
        .eq("business_connection_id", businessConnectionId)
        .maybeSingle();
      const { data: bc } = await query;

      if (bc?.workspace_id) {
        workspaceId = bc.workspace_id as string;
        const sourceId = bc.source_id as string | undefined;

        const updateFields: Record<string, unknown> = {
          workspaceId,
          businessConnectionId: businessConnectionId,
        };
        if (sourceId) {
          updateFields.sourceId = sourceId;
        }

        await Chat.updateOne({ _id: chatDoc._id }, { $set: updateFields });

        chatDoc.workspaceId = workspaceId;
        chatDoc.businessConnectionId = businessConnectionId;
        if (sourceId) {
          chatDoc.sourceId = sourceId;
        }

        return workspaceId;
      }
    } catch {}
  }
  workspaceId = chatDoc.workspaceId;

  return workspaceId;
}

/**
 * Handles business connection conflicts in group chats where multiple business owners
 * might have connected the same bot to their business accounts
 */
export async function resolveGroupChatBusinessConnection(
  chatId: string,
  _fromUserId: number,
  businessConnectionId?: string
): Promise<{ businessConnectionId?: string; workspaceId?: string }> {
  if (!businessConnectionId) {
    return {};
  }

  try {
    const { data: connection, error } = await supabaseAdmin
      .from("telegram_business_connections")
      .select("workspace_id, telegram_user_id, user_chat_id")
      .eq("business_connection_id", businessConnectionId)
      .maybeSingle<{
        workspace_id: string | null;
        telegram_user_id: number | null;
        user_chat_id: number | null;
      }>();

    if (error || !connection) {
      return {};
    }

    const chatNumericId = safeParseChatId(chatId);
    const isBusinessOwnerChat =
      chatNumericId !== null && connection.user_chat_id === chatNumericId;

    if (isBusinessOwnerChat) {
      return {};
    }

    if (connection.workspace_id) {
      return {
        businessConnectionId,
        workspaceId: connection.workspace_id,
      };
    }

    return {};
  } catch {
    return {};
  }
}

export async function ensureConversation(
  chatDoc: ChatDocument,
  fromUserId: number,
  workspaceId: string,
  sourceId?: string,
  businessConnectionId?: string
): Promise<{ conversation: ConversationDocument; isNew: boolean } | null> {
  // FIND logic: Strictly scoped by chat, user, sourceId and businessConnectionId
  const query: Record<string, unknown> = {
    chat: chatDoc._id,
    user: fromUserId,
    workspaceId: workspaceId,
  };

  if (sourceId) {
    query.sourceId = sourceId;
  }

  if (businessConnectionId) {
    query.business_connection_id = businessConnectionId;
  } else {
    // If no business connection, explicitly look for non-business conversation
    // to prevent standard bots from "hijacking" business connection conversations
    query.business_connection_id = { $in: [null, undefined] };
  }

  let conversation = (await Conversation.findOne(
    query
  )) as ConversationDocument | null;

  let isNew = false;

  // Fallback for business connection: if this is a new BC message,
  // check if a private Bot chat already exists that we should "upgrade" or link
  if (!conversation && businessConnectionId) {
    // We only do this if strictly necessary for existing flows
    const privateChatQuery: Record<string, unknown> = {
      chat: chatDoc._id,
      user: fromUserId,
      workspaceId: workspaceId,
      business_connection_id: { $in: [null, undefined] },
    };
    if (sourceId) privateChatQuery.sourceId = sourceId;

    const privateConversation = (await Conversation.findOne(
      privateChatQuery
    )) as ConversationDocument | null;

    if (privateConversation) {
      privateConversation.business_connection_id = businessConnectionId;
      await privateConversation.save();
      conversation = privateConversation;
    }
  }

  if (!conversation) {
    const capacity = await ensureCompanyConversationCapacity(
      supabaseAdmin,
      workspaceId
    );
    if (!capacity.allowed) {
      console.warn("[Telegram] New conversation blocked by company limit", {
        workspaceId,
        sourceId: sourceId || null,
        chatId: String(chatDoc._id || ""),
        userId: fromUserId,
        code: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
      });
      return null;
    }

    const [botDefaultEnabled, scenariosDefaultEnabled, coachDefaultEnabled] =
      await Promise.all([
        getWorkspaceBotDefault(workspaceId),
        getWorkspaceScenariosDefault(workspaceId),
        getWorkspaceCoachDefault(workspaceId),
      ]);

    const conversationData: Record<string, unknown> = {
      chat: chatDoc._id,
      user: fromUserId,
      messages: [],
      is_classified: false,
      workspaceId,
      sourceId,
      channel: "telegram",
      airi_bot_enabled: botDefaultEnabled,
      airi_scenarios_enabled: scenariosDefaultEnabled,
      airi_coach_enabled: coachDefaultEnabled,
    };

    if (businessConnectionId) {
      conversationData.business_connection_id = businessConnectionId;
    }

    conversation = new Conversation(conversationData) as ConversationDocument;
    await conversation.save();
    isNew = true;
  } else {
    const previousStatus = conversation.status;
    const shouldReopen = previousStatus === "closed";

    conversation.workspaceId = workspaceId;
    if (sourceId) {
      conversation.sourceId = sourceId;
    }
    conversation.channel = "telegram";
    if (businessConnectionId && !conversation.business_connection_id) {
      conversation.business_connection_id = businessConnectionId;
    }

    // Reopen conversation if it was closed
    if (shouldReopen) {
      conversation.status = "open";
    }

    await conversation.save();

    // Trigger webhook for reopening
    if (shouldReopen) {
      const { triggerConversationReopened } = await import(
        "@/lib/webhook-events"
      );
      triggerConversationReopened(
        workspaceId,
        buildConversationEventData(conversation, {
          status: "open",
          previous_status: previousStatus,
          channel: conversation.channel || "telegram",
          customer_phone: conversation.user?.toString(),
        })
      ).catch(err => console.error("Webhook trigger error:", err));
    }
  }

  return { conversation, isNew };
}

export async function saveMessageWithDedup(
  doc: MessageDocument,
  filter: Record<string, unknown>,
  ingressPayload?: TelegramAiriIngressPayload
): Promise<SaveMessageResult> {
  if (ingressPayload) {
    doc.airiIngressIntent = buildAiriConversationIngressIntent({
      ...ingressPayload,
      newMessage: doc,
    });
  }
  try {
    await doc.save();
    return { message: doc, isNew: true };
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }

    const existing = (await Message.findOne(filter)) as MessageDocument | null;
    if (!existing) {
      throw error;
    }

    return { message: existing, isNew: false };
  }
}

async function handlePhotoMessage(
  message: TelegramMessage,
  chatId: string,
  workspaceId: string,
  conversationId: string,
  authorId: number | undefined,
  direction: "inbound" | "outbound" = "inbound",
  botToken?: string,
  ingressPayload?: TelegramAiriIngressPayload
): Promise<SaveMessageResult> {
  if (!message.photo || message.photo.length === 0) {
    throw new Error("No photo found in the message");
  }

  const photo: TelegramPhotoSize | undefined =
    message.photo[message.photo.length - 1];

  if (!photo) {
    throw new Error("Unable to determine photo payload");
  }

  if (message.message_id === undefined || message.message_id === null) {
    throw new Error("Telegram message missing message_id for photo payload");
  }

  let mediaResult: { publicUrl: string; size: number } | null = null;
  try {
    const fileInfo = await telegramApi.getFile(photo.file_id, botToken);
    if (!fileInfo?.file_path)
      throw new Error("Telegram file info did not include file_path");
    const fileUrl = telegramApi.getFileUrl(fileInfo.file_path, botToken);
    const { handleTelegramPhoto } = await import("@/lib/media/handler");
    mediaResult = await handleTelegramPhoto(
      fileUrl,
      workspaceId,
      conversationId,
      message.message_id.toString()
    );
  } catch (error) {
    console.warn("[Telegram Webhook] Failed to upload photo attachment", {
      workspaceId,
      conversationId,
      messageId: message.message_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const messageDate = new Date((message.forward_date || message.date) * 1000);
  const newMessage = new Message({
    messageId: message.message_id.toString(),
    chat: chatId,
    ...(authorId !== undefined ? { author: authorId } : {}),
    rawSourcePayload: buildTelegramMessageRawSourcePayload(
      message,
      messageDate
    ),
    text: message.caption || (mediaResult ? "" : "[image attachment]"),
    ...(mediaResult?.publicUrl ? { imageUrl: mediaResult.publicUrl } : {}),
    date: messageDate,
    workspaceId,
    conversation: conversationId,
    channel: "telegram",
    direction: direction,
    telegramMeta: buildTelegramStoredMessageMeta(message),
    // Store media metadata
    mediaType: "image",
    mimeType: "image/jpeg",
    fileSize: mediaResult?.size ?? photo.file_size,
  });

  return saveMessageWithDedup(
    newMessage as MessageDocument,
    {
      messageId: message.message_id.toString(),
      chat: chatId,
    },
    ingressPayload
  );
}

async function uploadTelegramMediaForMessage(
  mediaMetadata: {
    fileId: string;
    mediaType: "video" | "audio" | "document" | "sticker" | "voice";
    mimeType?: string;
    fileName?: string;
  },
  workspaceId: string,
  conversationId: string,
  messageId: string,
  botToken?: string
): Promise<TelegramUploadedMedia | null> {
  try {
    const fileInfo = await telegramApi.getFile(mediaMetadata.fileId, botToken);
    if (!fileInfo?.file_path) {
      throw new Error("Telegram file info did not include file_path");
    }

    const fileUrl = telegramApi.getFileUrl(fileInfo.file_path, botToken);
    const { handleTelegramMedia } = await import("@/lib/media/handler");
    return await handleTelegramMedia(
      fileUrl,
      workspaceId,
      conversationId,
      messageId,
      {
        mediaType: mediaMetadata.mediaType,
        contentType: mediaMetadata.mimeType,
        filename: mediaMetadata.fileName,
      }
    );
  } catch (error) {
    console.warn("[Telegram Webhook] Failed to upload media attachment", {
      workspaceId,
      conversationId,
      messageId,
      mediaType: mediaMetadata.mediaType,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function persistInboundMessage(
  message: TelegramMessage,
  chatDoc: ChatDocument,
  authorId: number | undefined,
  conversationId: string,
  workspaceId: string,
  direction: "inbound" | "outbound" = "inbound",
  botToken?: string,
  ingressPayload?: TelegramAiriIngressPayload
): Promise<SaveMessageResult | null> {
  const telegramMeta = buildTelegramStoredMessageMeta(message);

  if (message.photo && message.photo.length > 0) {
    return handlePhotoMessage(
      message,
      chatDoc._id,
      workspaceId,
      conversationId,
      authorId,
      direction,
      botToken,
      ingressPayload
    );
  }

  if (message.text) {
    const messageDate = new Date((message.forward_date || message.date) * 1000);
    const newMessageDoc = new Message({
      messageId: message.message_id.toString(),
      chat: chatDoc._id,
      ...(authorId !== undefined ? { author: authorId } : {}),
      rawSourcePayload: buildTelegramMessageRawSourcePayload(
        message,
        messageDate
      ),
      text: message.text,
      date: messageDate,
      workspaceId,
      conversation: conversationId,
      channel: "telegram",
      direction: direction,
      telegramMeta,
    });

    return saveMessageWithDedup(
      newMessageDoc as MessageDocument,
      {
        messageId: message.message_id.toString(),
        chat: chatDoc._id,
      },
      ingressPayload
    );
  }

  const mediaMetadata = extractTelegramMediaMetadata(message);
  if (mediaMetadata) {
    const messageDate = new Date((message.forward_date || message.date) * 1000);
    const caption =
      typeof message.caption === "string" ? message.caption.trim() : "";
    const uploadedMedia = await uploadTelegramMediaForMessage(
      mediaMetadata,
      workspaceId,
      conversationId,
      message.message_id.toString(),
      botToken
    );
    const resolvedMimeType =
      uploadedMedia?.contentType || mediaMetadata.mimeType;
    const resolvedFileSize = uploadedMedia?.size ?? mediaMetadata.fileSize;
    const newMessageDoc = new Message({
      messageId: message.message_id.toString(),
      chat: chatDoc._id,
      ...(authorId !== undefined ? { author: authorId } : {}),
      rawSourcePayload: buildTelegramMessageRawSourcePayload(
        message,
        messageDate
      ),
      text: caption || `[${mediaMetadata.mediaType} attachment]`,
      ...(uploadedMedia?.publicUrl
        ? { imageUrl: uploadedMedia.publicUrl }
        : {}),
      date: messageDate,
      workspaceId,
      conversation: conversationId,
      channel: "telegram",
      direction: direction,
      telegramMeta,
      mediaType: mediaMetadata.mediaType,
      mimeType: resolvedMimeType,
      fileName: uploadedMedia?.filename || mediaMetadata.fileName,
      fileSize: resolvedFileSize,
      ...(uploadedMedia?.publicUrl
        ? {
            attachments: [
              {
                filename: uploadedMedia.filename || mediaMetadata.fileName,
                url: uploadedMedia.publicUrl,
                contentType: resolvedMimeType,
                sizeBytes: resolvedFileSize,
              },
            ],
          }
        : {}),
    });

    return saveMessageWithDedup(
      newMessageDoc as MessageDocument,
      {
        messageId: message.message_id.toString(),
        chat: chatDoc._id,
      },
      ingressPayload
    );
  }

  if (
    typeof message.caption === "string" &&
    message.caption.trim().length > 0
  ) {
    const messageDate = new Date((message.forward_date || message.date) * 1000);
    const newMessageDoc = new Message({
      messageId: message.message_id.toString(),
      chat: chatDoc._id,
      ...(authorId !== undefined ? { author: authorId } : {}),
      rawSourcePayload: buildTelegramMessageRawSourcePayload(
        message,
        messageDate
      ),
      text: message.caption.trim(),
      date: messageDate,
      workspaceId,
      conversation: conversationId,
      channel: "telegram",
      direction: direction,
      telegramMeta,
    });

    return saveMessageWithDedup(
      newMessageDoc as MessageDocument,
      {
        messageId: message.message_id.toString(),
        chat: chatDoc._id,
      },
      ingressPayload
    );
  }
  return null;
}

export async function runPostSaveSideEffects(
  conversation: ConversationDocument,
  workspaceId: string,
  newMessage: MessageDocument,
  isNewConversation: boolean = false
) {
  const direction = newMessage.direction;
  if (direction !== "inbound" && direction !== "outbound") {
    throw new TypeError("Telegram message direction is required before append");
  }

  const appendResult = await appendMessageToConversationById(
    conversation._id,
    newMessage._id,
    {
      lastMessageAt: newMessage.date as Date,
      direction,
    }
  );

  const mediaAnalysisStart = await enqueueConversationMediaAnalysis({
    workspaceId,
    conversationId: String(conversation._id),
    messageId: String(newMessage._id),
    mediaType: newMessage.mediaType,
    sourceId: conversation.sourceId || undefined,
  }).catch(error => ({
    queued: false as const,
    reason: "publish_failed" as const,
    errorMessage: error instanceof Error ? error.message : String(error),
  }));
  if (
    !mediaAnalysisStart.queued &&
    !["unsupported_media", "already_active", "already_complete"].includes(
      mediaAnalysisStart.reason
    )
  ) {
    console.warn("[Telegram Webhook] Media analysis enqueue failed", {
      workspaceId,
      conversationId: String(conversation._id),
      messageId: String(newMessage._id),
      mediaType: newMessage.mediaType,
      reason: mediaAnalysisStart.reason,
      error: mediaAnalysisStart.errorMessage,
    });
  }

  if (!appendResult.appended) {
    return;
  }

  const populatedMessage = await Message.findById(newMessage._id).populate({
    path: "author",
    model: User,
    select: "firstName lastName username avatar_url isBot",
  });

  try {
    await realtime.trigger(
      `private-conversation-${conversation._id}`,
      "new-message",
      populatedMessage
    );
  } catch (RealtimeError) {
    console.warn(
      "[Telegram Webhook] Realtime new-message trigger failed (non-fatal):",
      {
        conversationId: String(conversation._id),
        messageId: String(newMessage._id),
        error:
          RealtimeError instanceof Error
            ? RealtimeError.message
            : RealtimeError,
      }
    );
  }

  try {
    await invalidateRequestsForWorkspace(workspaceId);
    try {
      await invalidateConversationCache(workspaceId, String(conversation._id));
    } catch {}
    // Use singleton pattern - determine if new or update based on conversation state
    const { triggerConversationRealtime } = await import(
      "@/lib/realtime-updates"
    );
    await triggerConversationRealtime(
      String(conversation._id),
      isNewConversation
    );
  } catch {}
}

async function linkChatToSource(
  chatId: string,
  fromId: number,
  sourceId: string,
  businessConnectionId?: string,
  botToken?: string
): Promise<boolean> {
  const locale = await getSourceAiriLanguage(sourceId);
  const i18n = tTelegramWebhook(locale);
  const useBusinessConnection = await shouldUseBusinessConnectionId(
    chatId,
    businessConnectionId,
    undefined,
    "private"
  );

  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .select("id, workspace_id, companies(name)")
    .eq("id", sourceId)
    .maybeSingle<SourceRow>();

  if (error || !source || !source.workspace_id) {
    await telegramApi.sendTelegramMessage(
      chatId,
      i18n.invalidSourceOrConfiguration,
      useBusinessConnection ? { businessConnectionId, botToken } : { botToken }
    );
    return false;
  }

  const compositeChatId = getTelegramChatId(chatId, sourceId);
  await Chat.findOneAndUpdate(
    { _id: compositeChatId },
    {
      $set: {
        sourceId: source.id,
        workspaceId: source.workspace_id,
        ...(businessConnectionId ? { businessConnectionId } : {}),
      },
      $addToSet: { participants: fromId },
    },
    { upsert: true, new: true }
  );

  const companyName = resolveCompanyName(source);
  if (businessConnectionId) {
    try {
      await linkBusinessConnectionToSource(
        fromId,
        sourceId,
        chatId,
        businessConnectionId
      );
    } catch {
      // Keep chat linking successful even if business-link upsert fails.
    }
  }

  const successMessage = businessConnectionId
    ? i18n.linkSuccessBusiness.replace("{companyName}", companyName)
    : i18n.linkSuccessStandard.replace("{companyName}", companyName);

  await telegramApi.sendTelegramMessage(
    chatId,
    successMessage,
    useBusinessConnection ? { businessConnectionId, botToken } : { botToken }
  );
  return true;
}

function matchesCommand(
  text: string | undefined,
  pattern: RegExp
): RegExpMatchArray | null {
  if (typeof text !== "string") {
    return null;
  }
  return text.match(pattern);
}

/**
 */
export async function validateBusinessConnectionOwnership(
  businessConnectionId: string,
  expectedWorkspaceId: string
): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("telegram_business_connections")
      .select("workspace_id, telegram_user_id")
      .eq("business_connection_id", businessConnectionId)
      .maybeSingle<{
        workspace_id: string | null;
        telegram_user_id: number | null;
      }>();

    if (error || !data) {
      return false;
    }

    if (data.workspace_id !== expectedWorkspaceId) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function shouldUseBusinessConnectionId(
  chatId: string,
  businessConnectionId: string | undefined,
  workspaceId?: string,
  chatType?: string
): Promise<boolean> {
  if (!businessConnectionId) {
    return false;
  }

  if (chatType && chatType !== "private") {
    return false;
  }

  if (workspaceId) {
    const isValidOwnership = await validateBusinessConnectionOwnership(
      businessConnectionId,
      workspaceId
    );
    if (!isValidOwnership) {
      return false;
    }
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("telegram_business_connections")
      .select("user_chat_id")
      .eq("business_connection_id", businessConnectionId)
      .maybeSingle<{ user_chat_id: number | null }>();

    if (error || !data) {
      return false;
    }

    if (data.user_chat_id === null || data.user_chat_id === undefined) {
      return false;
    }

    const chatNumericId = safeParseChatId(chatId);
    if (chatNumericId !== null && data.user_chat_id === chatNumericId) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function handleCommands(
  message: TelegramMessage,
  businessConnectionId: string | undefined,
  botToken?: string,
  contextSourceId?: string
): Promise<boolean> {
  const { chat, from, text } = message;
  if (!from) return false;
  const locale = await getSourceAiriLanguage(contextSourceId);
  const i18n = tTelegramWebhook(locale);

  const linkMatch = matchesCommand(
    text,
    /^\/(?:start|link_chat)(?:@\w+)?\s+(\S+)/
  );
  if (linkMatch) {
    const sourceId = linkMatch[1];
    if (sourceId) {
      await linkChatToSource(
        chat.id.toString(),
        from.id,
        sourceId,
        businessConnectionId,
        botToken
      );
    }
    return true;
  }

  const businessLinkMatch = matchesCommand(
    text,
    /^\/link_business(?:@\w+)?\s+(\S+)/
  );
  if (businessLinkMatch) {
    const sourceId = businessLinkMatch[1];
    const chatIdStr = chat.id.toString();

    const useBusinessConnection = await shouldUseBusinessConnectionId(
      chatIdStr,
      businessConnectionId,
      undefined,
      "private"
    );

    try {
      const src = await linkBusinessConnectionToSource(
        from.id,
        sourceId,
        chatIdStr,
        businessConnectionId
      );
      const connection = await import("./handleBusinessConnectionUpdate").then(
        m => m.getExistingBusinessConnection(from.id, sourceId)
      );

      let successMessage = i18n.businessLinkSuccess.replace(
        "{companyName}",
        resolveCompanyName(src)
      );

      if (connection && !connection.can_reply) {
        successMessage += `\n\n${i18n.businessLinkWarningReplyDisabled}`;
      } else {
        successMessage += `\n\n${i18n.businessLinkReady}`;
      }

      await telegramApi.sendTelegramMessage(
        chatIdStr,
        successMessage,
        useBusinessConnection
          ? { businessConnectionId, botToken }
          : { botToken }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "";
      let helpText = `${i18n.businessLinkErrorTitle}\n\n`;

      if (errorMessage.includes("Invalid sourceId")) {
        helpText += i18n.businessLinkErrorInvalidSource;
      } else if (errorMessage.includes("workspace")) {
        helpText += i18n.businessLinkErrorNoWorkspace;
      } else {
        helpText += i18n.businessLinkErrorGeneric;
      }

      await telegramApi.sendTelegramMessage(
        chatIdStr,
        helpText,
        useBusinessConnection
          ? { businessConnectionId, botToken }
          : { botToken }
      );
    }
    return true;
  }

  // /status command - Check business connection status
  const statusMatch = matchesCommand(text, /^\/status(?:@\w+)?\b/);
  if (statusMatch) {
    const chatIdStr = chat.id.toString();
    const connection = await import("./handleBusinessConnectionUpdate").then(
      m => m.getExistingBusinessConnection(from.id, contextSourceId)
    );

    if (!connection) {
      await telegramApi.sendTelegramMessage(
        chatIdStr,
        i18n.statusNoConnection,
        { botToken }
      );
      return true;
    }

    const statusEmoji = connection.workspace_id ? "✅" : "⚠️";
    const replyEmoji = connection.can_reply ? "✅" : "❌";
    const enabledEmoji = connection.is_enabled ? "✅" : "❌";

    const connectedDate = connection.connected_at
      ? new Date(connection.connected_at).toLocaleDateString()
      : i18n.statusConnectedDateUnknown;

    const statusText = i18n.statusTemplate
      .replace(
        "{workspaceStatus}",
        connection.workspace_id
          ? i18n.statusWorkspaceLinked
          : i18n.statusWorkspaceNotLinked
      )
      .replace(
        "{canReplyStatus}",
        connection.can_reply ? i18n.statusCanReplyYes : i18n.statusCanReplyNo
      )
      .replace(
        "{enabledStatus}",
        connection.is_enabled ? i18n.statusEnabledYes : i18n.statusEnabledNo
      )
      .replace("{connectedDate}", connectedDate)
      .replace("{workspaceEmoji}", statusEmoji)
      .replace("{replyEmoji}", replyEmoji)
      .replace("{enabledEmoji}", enabledEmoji);

    await telegramApi.sendTelegramMessage(chatIdStr, statusText, {
      botToken,
    });
    return true;
  }

  // /help command - Show available commands
  const helpMatch = text
    ? matchesCommand(text, /^\/(?:help|start)(?:@\w+)?\b/)
    : null;
  if (
    helpMatch &&
    text &&
    !text.match(/\/(?:start|link_chat)(?:@\w+)?\s+(\S+)/)
  ) {
    // Don't trigger if /start has source key
    const chatIdStr = chat.id.toString();
    const connection = await import("./handleBusinessConnectionUpdate").then(
      m => m.getExistingBusinessConnection(from.id, contextSourceId)
    );
    const hasBusinessConnection = !!connection?.business_connection_id;

    let helpText = i18n.helpGreeting;

    if (hasBusinessConnection) {
      helpText += `\n\n${i18n.helpBusinessMode}`;
    }
    await telegramApi.sendTelegramMessage(
      chatIdStr,
      helpText,
      businessConnectionId &&
        (await shouldUseBusinessConnectionId(
          chatIdStr,
          businessConnectionId,
          undefined,
          "private"
        ))
        ? { businessConnectionId, botToken }
        : { botToken }
    );
    return true;
  }

  return false;
}
