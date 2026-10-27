import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";

import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import { resolveWhatsAppReferralSourcePlatform } from "@icecore/whatsapp/referralFields";
import AiriTurnContext, {
  buildAiriIngressKeyFilter,
} from "@/models/airi-turn-context";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import type {
  ChatDocument,
  ConversationDocument,
  MessageDocument,
} from "@/types/models";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";
import { resolveConversationReplySourceId } from "@icecore/shared/lib/conversation-reply-source";
import { resolveInstagramSenderId } from "@/lib/instagram/outbound";
import {
  buildNormalizedWhatsAppContact,
  resolveStoredWhatsAppRecipientTarget,
  resolveWhatsAppRecipientTarget,
  type WhatsAppRecipientTarget,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  isInstagramSource,
  isTelegramSource,
} from "@icecore/shared/types/sources";
import type { AiriConversationTurnSignal } from "@icecore/temporal";

/** Context persistence reads message values, including synthetic timer IDs. */
export type AiriTurnContextInput = Omit<AiriAutoReplyParams, "newMessage"> & {
  newMessage: Pick<MessageDocument, "text" | "date" | "whatsappReferral"> & {
    _id: unknown;
  };
};

async function ensureDbConnected(): Promise<void> {
  const moduleRecord = await import("@/lib/mongoose");
  await moduleRecord.default();
}

async function loadSourceUtils() {
  return import("@/lib/sources/utils");
}

async function decryptValue(value: unknown): Promise<string> {
  const moduleRecord = await import("@/lib/crypto");
  return moduleRecord.decryptMaybeString(value as never);
}

type AiriTurnContextRecipientHint = {
  kind: "phone" | "bsuid" | "parent_bsuid";
  value: string;
};

type AiriTurnContextInstagramReferralHint = {
  source?: string;
  type?: string;
  ref?: string;
  adId?: string;
  productId?: string;
  productRetailerId?: string;
  title?: string;
  body?: string;
  mediaUrl?: string;
  sourceUrl?: string;
};

type AiriTurnContextWhatsAppReferralHint = {
  sourceType?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourcePlatform?: string;
  campaignId?: string;
  campaignName?: string;
  adSetId?: string;
  adSetName?: string;
  headline?: string;
  body?: string;
  mediaType?: string;
  imageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  ctwaClid?: string;
  ref?: string;
  welcomeMessageText?: string;
};

export type AiriTurnContextDocument = {
  turnContextId: string;
  ingressKey?: string | null;
  ingressStatus?: "pending" | "signaled" | "failed" | null;
  ingressAttempts?: number;
  ingressAttemptedAt?: Date | null;
  ingressSignaledAt?: Date | null;
  ingressWorkflowId?: string | null;
  ingressLastError?: string | null;
  ingressKind?: "conversation_turn";
  ingressNextRetryAt?: Date | null;
  ingressLeaseToken?: string | null;
  ingressLeaseExpiresAt?: Date | null;
  messageDate?: Date | null;
  enqueuedAt?: Date;
  textPreview?: string | null;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  messageRecoveryRevision?: string;
  whatsappMessageContentUnavailable?: boolean;
  channel: string | null;
  sourceId: string | null;
  triggerEventKind: string | null;
  scenarioOverrideId: string | null;
  scenarioTriggerNodeId: string | null;
  skipTriggerMatch: boolean;
  proactiveTrigger: boolean;
  suppressGeneralAutoReply: boolean;
  quickReplyPayload: string | null;
  whatsAppFlowResponseJson: string | null;
  followUpInstruction: string | null;
  systemPromptOverride: string | null;
  chatId: string | number | null;
  chatType: string | null;
  channelHints: {
    telegram: {
      businessConnectionId: string | null;
    };
    whatsapp: {
      recipientTarget: AiriTurnContextRecipientHint | null;
      contactName: string | null;
      username: string | null;
      referral: AiriTurnContextWhatsAppReferralHint | null;
    };
    instagram: {
      recipientId: string | null;
      threadType: "dm" | "comment" | null;
      commentId: string | null;
      authMethod: string | null;
      referral: AiriTurnContextInstagramReferralHint | null;
    };
  };
  expiresAt: Date | null;
};

type AiriTurnContextLean = AiriTurnContextDocument & {
  _id?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeDateIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof String
  ) {
    const parsed = new Date(value.valueOf());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function isSyntheticScenarioTimeoutMessageId(value: unknown): boolean {
  return (
    normalizeOptionalString(value)?.startsWith("scenario-timeout:") ?? false
  );
}

function toChatIdValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = normalizeOptionalString(value);
  return normalized || null;
}

function resolveConversationId(value: unknown): string {
  const normalized =
    normalizeOptionalString(
      value && typeof value === "object" && "_id" in (value as object)
        ? (value as { _id?: unknown })._id
        : value
    ) || "";

  if (!normalized) {
    throw new Error("Airi turn context requires a conversation id");
  }

  return normalized;
}

function resolveMessageId(value: unknown): string {
  const normalized =
    normalizeOptionalString(
      value && typeof value === "object" && "_id" in (value as object)
        ? (value as { _id?: unknown })._id
        : value
    ) || "";

  if (!normalized) {
    throw new Error("Airi turn context requires a message id");
  }

  return normalized;
}

function extractDocumentId(value: unknown): string | null {
  if (value && typeof value === "object" && "_id" in (value as object)) {
    return normalizeOptionalString((value as { _id?: unknown })._id);
  }

  return normalizeOptionalString(value);
}

function resolveTurnContextRecipientHint(
  params: AiriTurnContextInput
): AiriTurnContextRecipientHint | null {
  const directTarget = resolveWhatsAppRecipientTarget(
    params.whatsAppInfo?.contactData
  );
  if (directTarget) {
    return directTarget;
  }

  return resolveStoredWhatsAppRecipientTarget(
    params.chatDocument,
    params.conversation?.chat,
    params.conversation?.user
  );
}

function resolveWhatsAppContactName(
  params: AiriTurnContextInput
): string | null {
  return (
    normalizeOptionalString(params.whatsAppInfo?.contactData?.profile?.name) ||
    normalizeOptionalString(params.chatDocument?.whatsapp?.profileName) ||
    normalizeOptionalString(params.chatDocument?.first_name) ||
    normalizeOptionalString(params.chatDocument?.title) ||
    normalizeOptionalString(params.chatDocument?.username)
  );
}

function resolveWhatsAppUsername(params: AiriTurnContextInput): string | null {
  return (
    normalizeOptionalString(
      params.whatsAppInfo?.contactData?.profile?.username
    ) ||
    normalizeOptionalString(params.chatDocument?.whatsapp?.username) ||
    normalizeOptionalString(params.chatDocument?.username)
  );
}

function resolveInstagramThreadType(
  params: AiriTurnContextInput
): "dm" | "comment" | null {
  if (params.instagramInfo?.threadType === "dm") return "dm";
  if (params.instagramInfo?.threadType === "comment") return "comment";
  if (params.conversation?.external_thread?.type === "comment")
    return "comment";
  return "dm";
}

function resolveInstagramReferralHint(
  params: AiriTurnContextInput
): AiriTurnContextInstagramReferralHint | null {
  const referral = params.conversation?.external_thread?.referral;
  if (!referral || typeof referral !== "object") {
    return null;
  }

  const hint: AiriTurnContextInstagramReferralHint = {
    source: normalizeOptionalString(referral.source) || undefined,
    type: normalizeOptionalString(referral.type) || undefined,
    ref: normalizeOptionalString(referral.ref) || undefined,
    adId: normalizeOptionalString(referral.adId) || undefined,
    productId: normalizeOptionalString(referral.productId) || undefined,
    productRetailerId:
      normalizeOptionalString(referral.productRetailerId) || undefined,
    title: normalizeOptionalString(referral.title) || undefined,
    body: normalizeOptionalString(referral.body) || undefined,
    mediaUrl: normalizeOptionalString(referral.mediaUrl) || undefined,
    sourceUrl: normalizeOptionalString(referral.sourceUrl) || undefined,
  };

  const compactHint = Object.fromEntries(
    Object.entries(hint).filter(([, value]) => value !== undefined)
  ) as AiriTurnContextInstagramReferralHint;

  return Object.keys(compactHint).length > 0 ? compactHint : null;
}

function resolveWhatsAppReferralHint(
  params: AiriTurnContextInput
): AiriTurnContextWhatsAppReferralHint | null {
  const messageRecord = asPlainRecord(params.newMessage);
  const conversationRecord = asPlainRecord(params.conversation);
  const referral =
    asPlainRecord(messageRecord?.whatsappReferral) ||
    asPlainRecord(conversationRecord?.whatsappReferral);
  if (!referral) return null;

  const sourceUrl = normalizeOptionalString(referral.sourceUrl) || undefined;
  const sourcePlatform = sourceUrl
    ? resolveWhatsAppReferralSourcePlatform(sourceUrl)
    : "";
  const hint: AiriTurnContextWhatsAppReferralHint = {
    sourceType: normalizeOptionalString(referral.sourceType) || undefined,
    sourceId: normalizeOptionalString(referral.sourceId) || undefined,
    sourceUrl,
    sourcePlatform: sourcePlatform || undefined,
    campaignId: normalizeOptionalString(referral.campaignId) || undefined,
    campaignName: normalizeOptionalString(referral.campaignName) || undefined,
    adSetId: normalizeOptionalString(referral.adSetId) || undefined,
    adSetName: normalizeOptionalString(referral.adSetName) || undefined,
    headline: normalizeOptionalString(referral.headline) || undefined,
    body: normalizeOptionalString(referral.body) || undefined,
    mediaType: normalizeOptionalString(referral.mediaType) || undefined,
    imageUrl: normalizeOptionalString(referral.imageUrl) || undefined,
    videoUrl: normalizeOptionalString(referral.videoUrl) || undefined,
    thumbnailUrl: normalizeOptionalString(referral.thumbnailUrl) || undefined,
    ctwaClid: normalizeOptionalString(referral.ctwaClid) || undefined,
    ref: normalizeOptionalString(referral.ref) || undefined,
    welcomeMessageText:
      normalizeOptionalString(referral.welcomeMessageText) || undefined,
  };

  const compactHint = Object.fromEntries(
    Object.entries(hint).filter(([, value]) => value !== undefined)
  ) as AiriTurnContextWhatsAppReferralHint;

  return Object.keys(compactHint).length > 0 ? compactHint : null;
}

export function buildAiriTurnContextDocument(
  params: AiriTurnContextInput,
  options?: {
    turnContextId?: string;
    ingressKey?: string | null;
  }
): AiriTurnContextDocument {
  const ingressKey = normalizeOptionalString(options?.ingressKey);
  const turnContextId =
    normalizeOptionalString(options?.turnContextId) ||
    (ingressKey
      ? `airi-turn:${createHash("sha256").update(ingressKey).digest("hex")}`
      : randomUUID());
  const conversationId = resolveConversationId(params.conversation);
  const messageId = resolveMessageId(params.newMessage);

  return {
    turnContextId,
    ...(ingressKey ? { ingressKey } : {}),
    workspaceId: String(params.workspaceId || ""),
    conversationId,
    messageId,
    channel: normalizeOptionalString(params.type),
    ...(params.messageRecoveryRevision
      ? { messageRecoveryRevision: params.messageRecoveryRevision }
      : {}),
    ...(params.whatsappMessageContentUnavailable
      ? { whatsappMessageContentUnavailable: true }
      : {}),
    sourceId: resolveConversationReplySourceId({
      workspaceId: params.workspaceId,
      conversation: params.conversation,
      chat: params.chatDocument,
    }),
    triggerEventKind: normalizeOptionalString(params.triggerEventKind),
    scenarioOverrideId: normalizeOptionalString(params.scenarioOverrideId),
    scenarioTriggerNodeId: normalizeOptionalString(
      params.scenarioTriggerNodeId
    ),
    skipTriggerMatch: Boolean(params.skipTriggerMatch),
    proactiveTrigger: Boolean(params.proactiveTrigger),
    suppressGeneralAutoReply: Boolean(params.suppressGeneralAutoReply),
    quickReplyPayload: normalizeOptionalString(params.quickReplyPayload),
    whatsAppFlowResponseJson: normalizeOptionalString(
      params.whatsAppFlowResponseJson
    ),
    followUpInstruction: normalizeOptionalString(params.followUpInstruction),
    systemPromptOverride: normalizeOptionalString(params.systemPromptOverride),
    chatId:
      toChatIdValue(params.chatId) ??
      toChatIdValue(params.chatDocument?._id) ??
      null,
    chatType: normalizeOptionalString(params.chatType),
    channelHints: {
      telegram: {
        businessConnectionId:
          normalizeOptionalString(params.chatDocument?.businessConnectionId) ||
          normalizeOptionalString(params.conversation?.business_connection_id),
      },
      whatsapp: {
        recipientTarget: resolveTurnContextRecipientHint(params),
        contactName: resolveWhatsAppContactName(params),
        username: resolveWhatsAppUsername(params),
        referral: resolveWhatsAppReferralHint(params),
      },
      instagram: {
        recipientId: normalizeOptionalString(params.instagramInfo?.recipientId),
        threadType: resolveInstagramThreadType(params),
        commentId:
          normalizeOptionalString(params.instagramInfo?.commentId) ||
          normalizeOptionalString(
            params.conversation?.external_thread?.comment?.id
          ),
        authMethod: normalizeOptionalString(params.instagramInfo?.authMethod),
        referral: resolveInstagramReferralHint(params),
      },
    },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

export async function createAiriConversationTurnContext(
  params: AiriTurnContextInput,
  options?: { ingressKey?: string | null }
): Promise<AiriTurnContextLean> {
  await ensureDbConnected();
  const ingressKey = normalizeOptionalString(options?.ingressKey);
  if (ingressKey) {
    return persistAiriConversationIngressIntent(
      buildAiriConversationIngressIntent(params, ingressKey)
    );
  }
  const document = buildAiriTurnContextDocument(params);
  const created = new AiriTurnContext(document);
  await created.save();

  return (created.toObject() as AiriTurnContextLean) || document;
}

/** Persist this sanitized intent with the inbound message, before side effects. */
export function buildAiriConversationIngressIntent(
  params: AiriTurnContextInput,
  ingressKey = buildAiriConversationIngressKey(params)
): AiriTurnContextDocument {
  const now = new Date();
  const messageDate = normalizeDateIso(params.newMessage.date);
  return {
    ...buildAiriTurnContextDocument(params, { ingressKey }),
    ingressKind: "conversation_turn",
    ingressStatus: "pending",
    ingressAttempts: 0,
    ingressNextRetryAt: now,
    messageDate: messageDate ? new Date(messageDate) : null,
    enqueuedAt: now,
    textPreview:
      normalizeOptionalString(params.newMessage.text)?.slice(0, 240) || null,
    // Unaccepted work must survive outages longer than the context retention TTL.
    expiresAt: null,
  };
}

export async function persistAiriConversationIngressIntent(
  document: AiriTurnContextDocument
): Promise<AiriTurnContextLean> {
  await ensureDbConnected();
  if (!document.ingressKey || document.ingressKind !== "conversation_turn") {
    throw new Error("Airi conversation ingress requires a durable intent");
  }
  let stored: AiriTurnContextLean | null;
  try {
    const result = await AiriTurnContext.findOneAndUpdate(
      buildAiriIngressKeyFilter(document.ingressKey),
      { $setOnInsert: document },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    stored = result?.toObject() as AiriTurnContextLean | null;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    stored = await AiriTurnContext.findOne(
      buildAiriIngressKeyFilter(document.ingressKey)
    ).lean<AiriTurnContextLean | null>();
  }
  if (!stored)
    throw new Error("Airi conversation ingress could not be persisted");
  if (!stored.ingressKind && stored.ingressStatus !== "signaled") {
    // Adopt a pre-queue idempotent attempt only when its provider retries it.
    // Completed legacy turns remain completed; timer-replan records use another key.
    const adopted = await AiriTurnContext.findOneAndUpdate(
      {
        ...buildAiriIngressKeyFilter(document.ingressKey),
        ingressKind: { $exists: false },
        ingressStatus: { $ne: "signaled" },
      },
      {
        $set: {
          ingressKind: "conversation_turn",
          ingressStatus: "pending",
          ingressNextRetryAt: document.ingressNextRetryAt,
          messageDate: document.messageDate,
          enqueuedAt: stored.createdAt || document.enqueuedAt,
          textPreview: document.textPreview,
          expiresAt: null,
        },
      },
      { new: true }
    );
    if (adopted) stored = adopted.toObject() as AiriTurnContextLean;
  }
  return stored;
}

export function buildStoredAiriConversationTurnSignal(
  context: AiriTurnContextDocument
): AiriConversationTurnSignal {
  return {
    workspaceId: context.workspaceId,
    conversationId: context.conversationId,
    messageId: context.messageId,
    ...(context.messageRecoveryRevision
      ? { messageRecoveryRevision: context.messageRecoveryRevision }
      : {}),
    ...(context.whatsappMessageContentUnavailable
      ? { whatsappMessageContentUnavailable: true }
      : {}),
    channel: context.channel,
    sourceId: context.sourceId,
    textPreview: context.textPreview ?? null,
    messageDate: normalizeDateIso(context.messageDate),
    triggerEventKind: context.triggerEventKind,
    scenarioOverrideId: context.scenarioOverrideId,
    enqueuedAt:
      normalizeDateIso(context.enqueuedAt) || new Date().toISOString(),
    turnContextId: context.turnContextId,
  };
}

export function buildAiriConversationIngressKey(
  params: AiriTurnContextInput
): string {
  const identityParts = [
    String(params.workspaceId || ""),
    resolveConversationId(params.conversation),
    resolveMessageId(params.newMessage),
    normalizeOptionalString(params.type) || "unknown",
  ];
  if (params.messageRecoveryRevision)
    identityParts.push("recovery", params.messageRecoveryRevision);
  const identity = identityParts.join(":");
  return `airi-ingress:${createHash("sha256").update(identity).digest("hex")}`;
}

export function buildAiriConversationTurnSignalFromContext(params: {
  autoReplyParams: AiriTurnContextInput;
  turnContextId: string | null;
}): AiriConversationTurnSignal {
  const { autoReplyParams, turnContextId } = params;

  return {
    workspaceId: autoReplyParams.workspaceId,
    conversationId: resolveConversationId(autoReplyParams.conversation),
    messageId: resolveMessageId(autoReplyParams.newMessage),
    ...(autoReplyParams.messageRecoveryRevision
      ? { messageRecoveryRevision: autoReplyParams.messageRecoveryRevision }
      : {}),
    ...(autoReplyParams.whatsappMessageContentUnavailable
      ? { whatsappMessageContentUnavailable: true }
      : {}),
    channel: normalizeOptionalString(autoReplyParams.type),
    sourceId: resolveConversationReplySourceId({
      workspaceId: autoReplyParams.workspaceId,
      conversation: autoReplyParams.conversation,
      chat: autoReplyParams.chatDocument,
    }),
    textPreview:
      normalizeOptionalString(autoReplyParams.newMessage?.text)?.slice(
        0,
        240
      ) || null,
    messageDate: normalizeDateIso(autoReplyParams.newMessage?.date),
    triggerEventKind: normalizeOptionalString(autoReplyParams.triggerEventKind),
    scenarioOverrideId: normalizeOptionalString(
      autoReplyParams.scenarioOverrideId
    ),
    enqueuedAt: new Date().toISOString(),
    turnContextId: normalizeOptionalString(turnContextId),
  };
}

async function readTurnContext(
  turnContextId: string
): Promise<AiriTurnContextLean | null> {
  return AiriTurnContext.findOne({
    turnContextId,
  }).lean<AiriTurnContextLean | null>();
}

async function loadChatDocument(params: {
  conversation: ConversationDocument | null;
  turnContext: AiriTurnContextLean | null;
}): Promise<ChatDocument | null> {
  const conversationChatId = extractDocumentId(params.conversation?.chat);
  const contextChatId = toChatIdValue(params.turnContext?.chatId);
  const chatLookupId = conversationChatId || contextChatId;

  if (!chatLookupId) {
    return null;
  }

  return Chat.findById(chatLookupId).lean<ChatDocument | null>();
}

async function resolveTelegramRuntimeSettings(params: {
  sourceId: string | null;
}): Promise<{
  botToken?: string;
  telegramReactionsEnabled: boolean;
}> {
  if (!params.sourceId) {
    return { telegramReactionsEnabled: false };
  }

  const { fetchSourceWithCredentials } = await loadSourceUtils();
  const source = await fetchSourceWithCredentials(params.sourceId, "telegram");
  if (!source || !isTelegramSource(source)) {
    return { telegramReactionsEnabled: false };
  }

  const { readTelegramBotToken } = await import(
    "@/lib/telegram/telegram-source"
  );
  return {
    botToken: readTelegramBotToken(source.credentials) || undefined,
    telegramReactionsEnabled: source.credentials.ai_reactions_enabled === true,
  };
}

function resolveWhatsAppRecipientHint(params: {
  turnContext: AiriTurnContextLean | null;
  chatDocument: ChatDocument | null;
  conversation: ConversationDocument | null;
}): WhatsAppRecipientTarget | null {
  const storedHint =
    params.turnContext?.channelHints?.whatsapp?.recipientTarget;
  if (
    storedHint?.value &&
    (storedHint.kind === "phone" ||
      storedHint.kind === "bsuid" ||
      storedHint.kind === "parent_bsuid")
  ) {
    return {
      kind: storedHint.kind,
      value: storedHint.value,
    };
  }

  return resolveStoredWhatsAppRecipientTarget(
    params.chatDocument,
    params.conversation?.user,
    params.conversation?.chat
  );
}

function resolveWhatsAppProfileName(params: {
  turnContext: AiriTurnContextLean | null;
  chatDocument: ChatDocument | null;
}): string {
  return (
    normalizeOptionalString(
      params.turnContext?.channelHints?.whatsapp?.contactName
    ) ||
    normalizeOptionalString(params.chatDocument?.whatsapp?.profileName) ||
    normalizeOptionalString(params.chatDocument?.first_name) ||
    normalizeOptionalString(params.chatDocument?.title) ||
    normalizeOptionalString(params.chatDocument?.username) ||
    "Customer"
  );
}

function resolveWhatsAppProfileUsername(params: {
  turnContext: AiriTurnContextLean | null;
  chatDocument: ChatDocument | null;
}): string | undefined {
  return (
    normalizeOptionalString(
      params.turnContext?.channelHints?.whatsapp?.username
    ) ||
    normalizeOptionalString(params.chatDocument?.whatsapp?.username) ||
    normalizeOptionalString(params.chatDocument?.username) ||
    undefined
  );
}

function buildWhatsAppInfo(params: {
  sourceId: string | null;
  turnContext: AiriTurnContextLean | null;
  chatDocument: ChatDocument | null;
  conversation: ConversationDocument | null;
}): AiriAutoReplyParams["whatsAppInfo"] | undefined {
  const recipientTarget = resolveWhatsAppRecipientHint(params);
  if (!recipientTarget) {
    return undefined;
  }

  const contactData = buildNormalizedWhatsAppContact({
    waId: recipientTarget.kind === "phone" ? recipientTarget.value : undefined,
    userId:
      recipientTarget.kind === "bsuid" ? recipientTarget.value : undefined,
    parentUserId:
      recipientTarget.kind === "parent_bsuid"
        ? recipientTarget.value
        : undefined,
    profileName: resolveWhatsAppProfileName(params),
    username: resolveWhatsAppProfileUsername(params),
  });
  if (!contactData) {
    return undefined;
  }

  return {
    contactData,
  };
}

async function resolveInstagramInfo(params: {
  workspaceId: string;
  sourceId: string | null;
  conversation: ConversationDocument | null;
  turnContext: AiriTurnContextLean | null;
}): Promise<AiriAutoReplyParams["instagramInfo"] | undefined> {
  const { fetchSourceWithCredentials } = await loadSourceUtils();
  const source =
    (params.sourceId
      ? await fetchSourceWithCredentials(params.sourceId, "instagram")
      : null) ||
    (await fetchSourceWithCredentials(undefined, "instagram", {
      workspace_id: params.workspaceId,
    }));

  if (!source || !isInstagramSource(source)) {
    return undefined;
  }

  const token = await decryptValue(source.credentials.page_access_token);
  const authMethod =
    normalizeOptionalString(
      params.turnContext?.channelHints?.instagram?.authMethod
    ) || normalizeOptionalString(source.credentials.auth_method);
  const pageId = resolveInstagramSenderId(source.credentials, authMethod);
  const threadType =
    params.turnContext?.channelHints?.instagram?.threadType ||
    (params.conversation?.external_thread?.type === "comment"
      ? "comment"
      : "dm");
  const commentId =
    normalizeOptionalString(
      params.turnContext?.channelHints?.instagram?.commentId
    ) ||
    normalizeOptionalString(params.conversation?.external_thread?.comment?.id);
  const recipientId =
    normalizeOptionalString(
      params.turnContext?.channelHints?.instagram?.recipientId
    ) ||
    (threadType === "dm"
      ? normalizeOptionalString(params.conversation?.external_thread?.threadId)
      : null);

  if (!token || !pageId) {
    return undefined;
  }

  if (threadType === "comment" && !commentId) {
    return undefined;
  }

  if (threadType === "dm" && !recipientId) {
    return undefined;
  }

  return {
    pageId,
    accessToken: token,
    recipientId: recipientId || undefined,
    authMethod: authMethod || undefined,
    threadType,
    commentId: commentId || undefined,
  };
}

function buildFallbackChatDocument(params: {
  conversation: ConversationDocument | null;
  turnContext: AiriTurnContextLean | null;
  sourceId: string | null;
}): ChatDocument {
  return {
    _id:
      toChatIdValue(params.turnContext?.chatId) ||
      extractDocumentId(params.conversation?.chat) ||
      params.conversation?._id,
    sourceId: params.sourceId || "",
    workspaceId: params.conversation?.workspaceId,
    businessConnectionId:
      normalizeOptionalString(
        params.turnContext?.channelHints?.telegram?.businessConnectionId
      ) ||
      normalizeOptionalString(params.conversation?.business_connection_id) ||
      undefined,
    type:
      (normalizeOptionalString(
        params.turnContext?.chatType
      ) as ChatDocument["type"]) || "private",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ChatDocument;
}

function buildSyntheticScenarioTimeoutMessage(params: {
  turn: AiriConversationTurnSignal;
  conversation: ConversationDocument;
  channel: AiriAutoReplyParams["type"];
  workspaceId: string;
}): MessageDocument {
  const dateIso =
    normalizeDateIso(params.turn.messageDate) ||
    normalizeDateIso(params.turn.enqueuedAt);

  return {
    _id: params.turn.messageId,
    text: normalizeOptionalString(params.turn.textPreview) || "",
    date: dateIso ? new Date(dateIso) : new Date(),
    direction: "inbound",
    channel: params.channel,
    conversation: params.conversation._id,
    workspaceId: params.workspaceId,
  } as unknown as MessageDocument;
}

export async function hydrateAiriAutoReplyParamsFromTurn(
  turn: AiriConversationTurnSignal,
  options?: { allowStoredTurnWithoutContext?: boolean }
): Promise<AiriAutoReplyParams> {
  if (turn.messageId.startsWith("customer-behavior:")) {
    const { hydrateCustomerBehaviorTurn } = await import(
      "@/lib/scenarios/behavior-runtime"
    );
    return hydrateCustomerBehaviorTurn(turn);
  }
  if (turn.messageId.startsWith("confirmed-payment:")) {
    const { hydrateConfirmedPaymentTurn } = await import(
      "@/lib/conversions/confirmed-payment-runtime"
    );
    return hydrateConfirmedPaymentTurn(turn);
  }
  await ensureDbConnected();

  const turnContextId = normalizeOptionalString(turn.turnContextId);
  const legacyPayload =
    turn.autoReplyPayload && typeof turn.autoReplyPayload === "object"
      ? (JSON.parse(
          JSON.stringify(turn.autoReplyPayload)
        ) as AiriAutoReplyParams)
      : null;

  const syntheticScenarioTimeoutMessage = isSyntheticScenarioTimeoutMessageId(
    turn.messageId
  );
  const hydrationRecordsPromise = legacyPayload
    ? null
    : Promise.all([
        syntheticScenarioTimeoutMessage
          ? Promise.resolve(null)
          : Message.findById(turn.messageId)
              .populate({ path: "author", select: "_id isBot" })
              .lean<MessageDocument | null>(),
        Conversation.findById(turn.conversationId)
          .select("-messages -embedding")
          .lean<ConversationDocument | null>(),
      ]);
  // The turn context decides whether the records are needed. Observe the
  // prefetch immediately so an early database rejection cannot become an
  // unhandled promise while that decision is still in flight.
  void hydrationRecordsPromise?.catch(() => undefined);

  let turnContext: AiriTurnContextLean | null = null;
  if (turnContextId) {
    turnContext = await readTurnContext(turnContextId);
  }

  const usesStoredTurnWithoutContext =
    !turnContext && Boolean(options?.allowStoredTurnWithoutContext);
  if (usesStoredTurnWithoutContext) {
    turnContext = {
      turnContextId: "",
      workspaceId: normalizeOptionalString(turn.workspaceId) || "",
      conversationId: normalizeOptionalString(turn.conversationId) || "",
      messageId: normalizeOptionalString(turn.messageId) || "",
      ...(turn.messageRecoveryRevision
        ? { messageRecoveryRevision: turn.messageRecoveryRevision }
        : {}),
      ...(turn.whatsappMessageContentUnavailable
        ? { whatsappMessageContentUnavailable: true }
        : {}),
      channel: normalizeOptionalString(turn.channel),
      sourceId: normalizeOptionalString(turn.sourceId),
      triggerEventKind: normalizeOptionalString(turn.triggerEventKind),
      scenarioOverrideId: normalizeOptionalString(turn.scenarioOverrideId),
      scenarioTriggerNodeId: null,
      skipTriggerMatch: false,
      proactiveTrigger: false,
      suppressGeneralAutoReply: false,
      quickReplyPayload: null,
      whatsAppFlowResponseJson: null,
      followUpInstruction: null,
      systemPromptOverride: null,
      chatId: null,
      chatType: null,
      channelHints: {
        telegram: { businessConnectionId: null },
        whatsapp: {
          recipientTarget: null,
          contactName: null,
          username: null,
          referral: null,
        },
        instagram: {
          recipientId: null,
          threadType: null,
          commentId: null,
          authMethod: null,
          referral: null,
        },
      },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }

  if (!turnContext && legacyPayload) {
    return { ...legacyPayload, confirmedPaymentScenario: undefined };
  }

  if (!turnContext) {
    await hydrationRecordsPromise?.catch(() => undefined);
    throw new Error(
      `Airi turn ${turn.messageId} is missing turn context and has no legacy payload fallback`
    );
  }

  const [messageRecord, conversation] = await (hydrationRecordsPromise ||
    Promise.all([
      syntheticScenarioTimeoutMessage
        ? Promise.resolve(null)
        : Message.findById(turn.messageId)
            .populate({ path: "author", select: "_id isBot" })
            .lean<MessageDocument | null>(),
      Conversation.findById(turn.conversationId)
        .select("-messages -embedding")
        .lean<ConversationDocument | null>(),
    ]));

  if (!conversation) {
    throw new Error(
      `Unable to hydrate Airi turn ${turn.messageId}: conversation not found`
    );
  }

  const syntheticWorkspaceId =
    normalizeOptionalString(turnContext.workspaceId) ||
    normalizeOptionalString(turn.workspaceId) ||
    normalizeOptionalString(conversation.workspaceId) ||
    "";
  const syntheticChannel = (normalizeOptionalString(turn.channel) ||
    normalizeOptionalString(turnContext.channel) ||
    normalizeOptionalString(
      conversation.channel
    )) as AiriAutoReplyParams["type"];
  const message =
    messageRecord ||
    (syntheticScenarioTimeoutMessage
      ? buildSyntheticScenarioTimeoutMessage({
          turn,
          conversation,
          channel: syntheticChannel,
          workspaceId: syntheticWorkspaceId,
        })
      : null);

  if (!message) {
    throw new Error(
      `Unable to hydrate Airi turn ${turn.messageId}: message not found`
    );
  }

  const chatDocument =
    (await loadChatDocument({
      conversation,
      turnContext,
    })) ||
    buildFallbackChatDocument({
      conversation,
      turnContext,
      sourceId:
        normalizeOptionalString(turnContext.sourceId) ||
        normalizeOptionalString(turn.sourceId) ||
        normalizeOptionalString(conversation.sourceId),
    });

  const workspaceId =
    normalizeOptionalString(turnContext.workspaceId) ||
    normalizeOptionalString(turn.workspaceId) ||
    normalizeOptionalString(conversation.workspaceId) ||
    "";
  const sourceId =
    normalizeOptionalString(turnContext.sourceId) ||
    normalizeOptionalString(turn.sourceId) ||
    resolveConversationReplySourceId({
      workspaceId,
      conversation,
      chat: chatDocument,
    });
  const channel = (normalizeOptionalString(turn.channel) ||
    normalizeOptionalString(turnContext.channel) ||
    normalizeOptionalString(message.channel) ||
    normalizeOptionalString(
      conversation.channel
    )) as AiriAutoReplyParams["type"];

  const whatsAppInfo =
    channel === "whatsapp"
      ? buildWhatsAppInfo({
          sourceId,
          turnContext,
          chatDocument,
          conversation,
        })
      : undefined;
  const [telegramSettings, instagramInfo] = await Promise.all([
    channel === "telegram"
      ? resolveTelegramRuntimeSettings({ sourceId })
      : undefined,
    channel === "instagram"
      ? resolveInstagramInfo({
          workspaceId,
          sourceId,
          conversation,
          turnContext,
        })
      : undefined,
  ]);

  const isBehaviorTimer =
    turn.messageId.startsWith("scenario-timeout:") &&
    Boolean(conversation.airi_scenario_state?.behaviorRunId);
  const behaviorBlockedReason = isBehaviorTimer
    ? await (
        await import("@/lib/scenarios/behavior-runtime")
      ).revalidateBehaviorScenarioSession(conversation)
    : null;

  return {
    type: channel,
    workspaceId,
    newMessage: message,
    conversation,
    chatDocument,
    chatId:
      toChatIdValue(turnContext.chatId) ??
      toChatIdValue(chatDocument?._id) ??
      undefined,
    chatType:
      normalizeOptionalString(turnContext.chatType) ||
      normalizeOptionalString(chatDocument?.type) ||
      undefined,
    scenarioOverrideId:
      normalizeOptionalString(turnContext.scenarioOverrideId) ||
      normalizeOptionalString(turn.scenarioOverrideId) ||
      undefined,
    scenarioTriggerNodeId:
      normalizeOptionalString(turnContext.scenarioTriggerNodeId) || undefined,
    skipTriggerMatch: Boolean(turnContext.skipTriggerMatch),
    proactiveTrigger: Boolean(turnContext.proactiveTrigger),
    suppressGeneralAutoReply:
      isBehaviorTimer || Boolean(turnContext.suppressGeneralAutoReply),
    messageRecoveryRevision:
      turnContext.messageRecoveryRevision ||
      (usesStoredTurnWithoutContext
        ? normalizeOptionalString(message.whatsappRecoveryRevision)
        : undefined) ||
      undefined,
    ...(turnContext.whatsappMessageContentUnavailable
      ? { whatsappMessageContentUnavailable: true }
      : {}),
    behaviorBlockedReason: behaviorBlockedReason || undefined,
    triggerEventKind: (normalizeOptionalString(turnContext.triggerEventKind) ||
      normalizeOptionalString(turn.triggerEventKind) ||
      undefined) as AiriAutoReplyParams["triggerEventKind"],
    quickReplyPayload:
      normalizeOptionalString(turnContext.quickReplyPayload) || undefined,
    whatsAppFlowResponseJson:
      normalizeOptionalString(turnContext.whatsAppFlowResponseJson) ||
      undefined,
    followUpInstruction:
      normalizeOptionalString(turnContext.followUpInstruction) || undefined,
    systemPromptOverride:
      normalizeOptionalString(turnContext.systemPromptOverride) || undefined,
    ...telegramSettings,
    whatsAppInfo,
    instagramInfo,
    runtimeHydrated: true,
  };
}

export function hydrateStoredAiriAutoReplyParamsFromTurn(
  turn: AiriConversationTurnSignal
): Promise<AiriAutoReplyParams> {
  return hydrateAiriAutoReplyParamsFromTurn(turn, {
    allowStoredTurnWithoutContext: true,
  });
}
