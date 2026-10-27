/**
 * Instagram webhook event handlers
 * Supports: messages (including echoes via `message.is_echo`),
 * message_reactions, messaging_postbacks, message_deliveries, message_reads,
 * messaging_seen
 */

import { type AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import { detectAndUpdateConversationLanguage } from "@/lib/airi/coach/coach-utils-server";
import {
  getWorkspaceBotDefault,
  getWorkspaceCoachDefault,
  getWorkspaceScenariosDefault,
} from "@/lib/airi/workspace-bot-default";
import { invalidateRequestsForWorkspace } from "@/lib/cache";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  ensureCompanyConversationCapacity,
} from "@/lib/limits/company-limits";
import {
  isConfirmedCampaignLabelStatus,
  resolveMetaAdMetadataForWorkspace,
} from "@/lib/meta-ads/meta-ad-metadata";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { createServerLogger } from "@/lib/observability/server-logs";
import { realtime } from "@/lib/realtime/server";
import {
  isInstagramCdnMediaUrl,
  resolveInstagramMessageContent,
  type ProviderMessageContent,
} from "@/lib/provider-message-display";
import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import { SCENARIO_TRIGGER_EVENT_KIND } from "@icecore/scenario-contracts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildAiriConversationIngressIntent } from "@/lib/temporal/airi-turn-context";
import {
  instagramBusinessAuthorId,
  upsertInstagramBusinessAuthor,
} from "@/lib/instagram/business-author";
import {
  buildInstagramReferralRagContext,
  readInstagramReferralContext,
  type InstagramMessagingEvent,
  type InstagramReferralContext,
} from "@/lib/instagram/webhook-events";
import {
  getInstagramGraphApiBases,
  hashInstagramIdToNumber,
  INSTAGRAM_USER_PLACEHOLDER,
  publishInstagramConversationMessage,
  queueInstagramAiriAutoReply,
  resolveInstagramAccessToken,
  type InstagramSourceData,
} from "@/lib/instagram/webhook-shared";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import type { MessageDocument } from "@/types/models";
import mongoose from "mongoose";
import {
  readNonEmptyStringOrUndefined,
  readDate,
} from "@icecore/shared/lib/value-utils";

const ECHO_MANAGER_MATCH_WINDOW_MS = 5 * 60 * 1000;
const ECHO_MANAGER_FUTURE_TOLERANCE_MS = 30 * 1000;
/** The parts of one of our sends reach Meta within seconds of each other. */
const OWN_MEDIA_ECHO_MATCH_WINDOW_MS = 60 * 1000;
const instagramWebhookLogger = createServerLogger("instagram.webhook.handlers");

function toOptionalUsername(value: unknown): string | undefined {
  const normalized = readNonEmptyStringOrUndefined(value);
  if (!normalized) return undefined;
  return normalized.replace(/^@+/g, "");
}

async function enrichInstagramReferralContext(params: {
  workspaceId: string;
  referral: InstagramReferralContext | null;
}): Promise<InstagramReferralContext | null> {
  if (!params.referral?.adId) return params.referral;
  if (
    isConfirmedCampaignLabelStatus(params.referral.campaignLabelStatus) &&
    params.referral.campaignId &&
    params.referral.adSetId
  ) {
    return params.referral;
  }

  const metadata = await resolveMetaAdMetadataForWorkspace({
    workspaceId: params.workspaceId,
    adId: params.referral.adId,
  }).catch(() => null);
  if (!metadata) {
    return {
      ...params.referral,
      campaignLabelStatus: params.referral.campaignLabelStatus ?? "unavailable",
    };
  }

  const confirmed = isConfirmedCampaignLabelStatus(
    metadata.campaignLabelStatus
  );
  return {
    ...params.referral,
    campaignId: params.referral.campaignId || metadata.campaignId,
    campaignName: params.referral.campaignName || metadata.campaignName,
    adSetId: params.referral.adSetId || metadata.adSetId,
    adSetName: params.referral.adSetName || metadata.adSetName,
    adAccountId: confirmed
      ? metadata.adAccountId || params.referral.adAccountId
      : params.referral.adAccountId,
    campaignLabels: confirmed
      ? metadata.campaignLabels
      : params.referral.campaignLabels,
    campaignLabelStatus: confirmed
      ? metadata.campaignLabelStatus
      : "unavailable",
  };
}

function splitName(value: string): { firstName?: string; lastName?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

type InstagramProfileHint = {
  firstName?: string;
  lastName?: string;
  username?: string;
  avatar_url?: string;
};

function extractInstagramProfileHint(
  sender: InstagramMessagingEvent["sender"]
): InstagramProfileHint | null {
  if (!sender || typeof sender !== "object") return null;

  const rawName = readNonEmptyStringOrUndefined(sender.name);
  const nameParts = rawName ? splitName(rawName) : {};
  const username = toOptionalUsername(sender.username);
  const avatar_url =
    readNonEmptyStringOrUndefined(sender.profile_pic) ||
    readNonEmptyStringOrUndefined(sender.profile_picture_url);

  const firstName = nameParts.firstName || undefined;
  const lastName = nameParts.lastName || undefined;

  if (!firstName && !lastName && !username && !avatar_url) {
    return null;
  }

  return {
    firstName,
    lastName,
    username,
    avatar_url,
  };
}

async function fetchInstagramCustomerProfile(
  senderId: string,
  source: InstagramSourceData
): Promise<{
  firstName?: string;
  lastName?: string;
  username?: string;
  avatar_url?: string;
} | null> {
  const accessToken = resolveInstagramAccessToken(source.pageAccessToken);
  if (!accessToken) return null;
  if (
    senderId === source.pageId ||
    (source.instagramScopedId && senderId === source.instagramScopedId)
  ) {
    return null;
  }

  const graphBases = getInstagramGraphApiBases(source.authMethod);
  const fieldSets = [
    "name,username,profile_picture_url,profile_pic",
    "name,username,profile_pic",
    "name,username,profile_picture_url",
    "name,username",
    "name",
    "username",
  ];

  for (const base of graphBases) {
    for (const fields of fieldSets) {
      try {
        const url = new URL(`${base}/${encodeURIComponent(senderId)}`);
        url.searchParams.set("fields", fields);
        url.searchParams.set("access_token", accessToken);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        let response: Response;
        try {
          response = await fetch(url.toString(), {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!response.ok) {
          continue;
        }

        const payload = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (!payload || typeof payload !== "object") {
          continue;
        }

        const rawName = readNonEmptyStringOrUndefined(payload.name);
        const username = toOptionalUsername(payload.username);
        const avatarUrl =
          readNonEmptyStringOrUndefined(payload.profile_picture_url) ||
          readNonEmptyStringOrUndefined(payload.profile_pic);
        const nameParts = rawName ? splitName(rawName) : {};

        if (
          nameParts.firstName ||
          nameParts.lastName ||
          username ||
          avatarUrl
        ) {
          return {
            firstName: nameParts.firstName,
            lastName: nameParts.lastName,
            username,
            avatar_url: avatarUrl,
          };
        }
      } catch {
        // Continue to next endpoint/field-set fallback.
      }
    }
  }

  return null;
}

async function maybeHydrateInstagramCustomer(
  userId: number,
  senderId: string,
  source: InstagramSourceData,
  profileHint?: InstagramProfileHint | null
) {
  const user = await User.findById(userId);
  const existingFirstName = readNonEmptyStringOrUndefined(user?.firstName);
  const hasPlaceholderName =
    !existingFirstName || existingFirstName === INSTAGRAM_USER_PLACEHOLDER;
  const existingUsername = toOptionalUsername(user?.username);
  const existingAvatar = readNonEmptyStringOrUndefined(user?.avatar_url);
  const needsUsername = !existingUsername;
  const needsAvatar = !existingAvatar;
  const hintFirstName = readNonEmptyStringOrUndefined(profileHint?.firstName);
  const hintLastName = readNonEmptyStringOrUndefined(profileHint?.lastName);
  const hintUsername = toOptionalUsername(profileHint?.username);
  const hintAvatar = readNonEmptyStringOrUndefined(profileHint?.avatar_url);

  const hintUpdatePayload: Record<string, unknown> = {};
  if (hintUsername && hintUsername !== existingUsername) {
    hintUpdatePayload.username = hintUsername;
  }
  if (hintAvatar && hintAvatar !== existingAvatar) {
    hintUpdatePayload.avatar_url = hintAvatar;
  }
  if (hintLastName && !readNonEmptyStringOrUndefined(user?.lastName)) {
    hintUpdatePayload.lastName = hintLastName;
  }
  if (hasPlaceholderName) {
    const preferredHintName = hintFirstName || hintUsername;
    if (preferredHintName) {
      hintUpdatePayload.firstName = preferredHintName;
    }
  }

  if (Object.keys(hintUpdatePayload).length > 0) {
    await User.findOneAndUpdate(
      { _id: userId },
      { $set: hintUpdatePayload }
    ).catch(() => {});
  }

  const stillNeedsName = hasPlaceholderName && !hintUpdatePayload.firstName;
  const stillNeedsUsername = needsUsername && !hintUpdatePayload.username;
  const stillNeedsAvatar = needsAvatar && !hintUpdatePayload.avatar_url;

  if (!stillNeedsName && !stillNeedsUsername && !stillNeedsAvatar) {
    return;
  }

  const profile = await fetchInstagramCustomerProfile(senderId, source);
  if (!profile) {
    return;
  }

  const updatePayload: Record<string, unknown> = {};
  const profileFirstName =
    profile.firstName || (stillNeedsName ? profile.username : undefined);
  if (profileFirstName) updatePayload.firstName = profileFirstName;
  if (profile.lastName) updatePayload.lastName = profile.lastName;
  if (profile.username) updatePayload.username = profile.username;
  if (profile.avatar_url) updatePayload.avatar_url = profile.avatar_url;
  if (Object.keys(updatePayload).length === 0) {
    return;
  }

  await User.findOneAndUpdate({ _id: userId }, { $set: updatePayload }).catch(
    () => {}
  );
}

async function findExistingInstagramMessage(
  messageId: string | undefined,
  workspaceId: string,
  direction: "inbound" | "outbound"
) {
  if (!messageId) return null;

  return Message.findOne({
    channel: "instagram",
    workspaceId,
    direction,
    messageId,
  });
}

async function saveInstagramMessageWithDedup(
  messageDoc: MessageDocument,
  workspaceId: string,
  direction: "inbound" | "outbound"
) {
  const messageId =
    typeof messageDoc.messageId === "string" && messageDoc.messageId.trim()
      ? messageDoc.messageId.trim()
      : undefined;

  if (messageId) {
    const existing = await findExistingInstagramMessage(
      messageId,
      workspaceId,
      direction
    );
    if (existing) {
      return { message: existing, isNew: false as const };
    }
  }

  try {
    await messageDoc.save();
    return { message: messageDoc, isNew: true as const };
  } catch (error) {
    if (!isMongoDuplicateKeyError(error) || !messageId) {
      throw error;
    }

    const existing = await findExistingInstagramMessage(
      messageId,
      workspaceId,
      direction
    );
    if (!existing) {
      throw error;
    }

    return { message: existing, isNew: false as const };
  }
}

/**
 * Copies a message's media off Meta's CDN, whose links expire within days,
 * and lets the copy's type replace Instagram's guess. If the copy fails the
 * message still saves with the CDN link, as Telegram's does.
 */
async function storeInstagramMessageMedia(params: {
  content: ProviderMessageContent;
  messageId: string | undefined;
  workspaceId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
}) {
  const { content, messageId, workspaceId, conversationId, direction } = params;
  const providerMedia = {
    text: content.text,
    imageUrl: content.imageUrl,
    mediaType: content.mediaType,
  };
  if (
    !messageId ||
    !content.imageUrl ||
    !isInstagramCdnMediaUrl(content.imageUrl) ||
    // A retried webhook finds the row saved with its copy.
    (await findExistingInstagramMessage(messageId, workspaceId, direction))
  ) {
    return providerMedia;
  }

  try {
    const { handleInstagramMedia } = await import("@/lib/media/handler");
    const media = await handleInstagramMedia(
      content.imageUrl,
      workspaceId,
      conversationId,
      messageId
    );
    return {
      // Plain attachments carry a "[kind attachment]" placeholder; labelled
      // ones (a story mention) keep their label.
      text: content.providerEventKind
        ? content.text
        : `[${media.mediaType} attachment]`,
      imageUrl: media.publicUrl,
      mediaType: media.mediaType,
      mimeType: media.contentType,
      fileSize: media.size,
    };
  } catch (error) {
    instagramWebhookLogger.warn("Instagram media copy failed", {
      workspaceId,
      conversationId,
      messageId,
      direction,
      error: error instanceof Error ? error.message : String(error),
    });
    return providerMedia;
  }
}

async function linkMessageToConversation(
  conversationId: string,
  messageId: mongoose.Types.ObjectId | string,
  messageDate: Date,
  workspaceId: string,
  direction: "inbound" | "outbound"
) {
  await appendMessageToConversationById(conversationId, messageId, {
    lastMessageAt: messageDate,
    direction,
    set: { workspaceId },
  });
}

function compactReferralContext(
  referral: InstagramReferralContext | null | undefined
): InstagramReferralContext | undefined {
  if (!referral) return undefined;
  const compact = Object.fromEntries(
    Object.entries(referral).filter(([, value]) => Boolean(value))
  ) as InstagramReferralContext;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

async function persistInstagramReferralContext(params: {
  conversationId: unknown;
  workspaceId: string;
  referral: InstagramReferralContext | null | undefined;
}) {
  const referral = compactReferralContext(params.referral);
  if (!referral) return;

  await Conversation.updateOne(
    {
      _id: params.conversationId,
      workspaceId: params.workspaceId,
      channel: "instagram",
    },
    {
      $set: {
        "external_thread.provider": "instagram",
        "external_thread.referral": referral,
      },
    }
  );
}

/**
 * Get or create user and chat documents
 */
async function getOrCreateUserAndChat(
  senderId: string,
  source: InstagramSourceData,
  profileHint?: InstagramProfileHint | null
) {
  const workspaceId = source.workspace_id;
  const userId = hashInstagramIdToNumber(`ig:user:${senderId}`);
  const chatId = hashInstagramIdToNumber(`ig:chat:${senderId}`);
  const hintFirstName = readNonEmptyStringOrUndefined(profileHint?.firstName);
  const hintUsername = toOptionalUsername(profileHint?.username);
  const hintAvatar = readNonEmptyStringOrUndefined(profileHint?.avatar_url);
  const initialFirstName =
    hintFirstName || hintUsername || INSTAGRAM_USER_PLACEHOLDER;

  const user = await User.findOneAndUpdate(
    { _id: userId },
    {
      $setOnInsert: {
        _id: userId,
        firstName: initialFirstName,
        ...(hintUsername ? { username: hintUsername } : {}),
        ...(hintAvatar ? { avatar_url: hintAvatar } : {}),
      },
      $set: {
        isBot: false,
        workspaceId,
        ...(hintUsername ? { username: hintUsername } : {}),
        ...(hintAvatar ? { avatar_url: hintAvatar } : {}),
      },
    },
    { upsert: true, new: true }
  );

  const chat = await Chat.findOneAndUpdate(
    { _id: chatId },
    {
      _id: chatId,
      type: "private",
      sourceId: source.id,
      workspaceId,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await maybeHydrateInstagramCustomer(
    userId,
    senderId,
    source,
    profileHint
  ).catch(() => {});

  return { user, chat, userId, chatId };
}

/**
 * Get or create conversation
 */
async function getOrCreateConversation(
  workspaceId: string,
  userId: number,
  chatId: number,
  senderId: string
) {
  // First try to find an open conversation
  let conversation = await Conversation.findOne({
    workspaceId,
    channel: "instagram",
    "participants.from": { $in: [String(userId)] },
    status: { $ne: "closed" },
  });

  // If no open conversation found, check for closed ones to reopen
  if (!conversation) {
    conversation = await Conversation.findOne({
      workspaceId,
      channel: "instagram",
      "participants.from": { $in: [String(userId)] },
      status: "closed",
    }).sort({ updatedAt: -1 }); // Get most recently closed

    if (conversation) {
      // Reopen the closed conversation
      conversation.status = "open";
      conversation.workspaceId = workspaceId;
      await conversation.save();

      // Trigger webhook for reopening
      const { triggerConversationReopened } = await import(
        "@/lib/webhook-events"
      );
      triggerConversationReopened(
        workspaceId,
        buildConversationEventData(conversation, {
          status: "open",
          previous_status: "closed",
          channel: "instagram",
          customer_phone: String(userId),
        })
      ).catch(err => {
        instagramWebhookLogger.error(
          "Instagram conversation reopened webhook trigger failed",
          err,
          {
            workspaceId,
            conversationId: String(conversation._id),
          }
        );
      });
    }
  }

  let isNew = false;

  // Create new conversation if none found
  if (!conversation) {
    const capacity = await ensureCompanyConversationCapacity(
      supabaseAdmin,
      workspaceId
    );
    if (!capacity.allowed) {
      instagramWebhookLogger.info("Instagram conversation blocked by limit", {
        workspaceId,
        senderId,
        userId,
        chatId,
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
      external_thread: { provider: "instagram", threadId: senderId },
    });
    await conversation.save();
    isNew = true;
  }

  return { conversation, isNew };
}

async function resolveInstagramInboundContext(params: {
  source: InstagramSourceData;
  senderId: string;
  profileHint?: InstagramProfileHint | null;
}) {
  const workspaceId = params.source.workspace_id;
  const { user, chat, userId, chatId } = await getOrCreateUserAndChat(
    params.senderId,
    params.source,
    params.profileHint
  );

  const conversationResult = await getOrCreateConversation(
    workspaceId,
    userId,
    chatId,
    params.senderId
  );
  if (!conversationResult) {
    return {
      blockedByCapacity: true as const,
      workspaceId,
      user,
      chat,
      userId,
      chatId,
    };
  }

  return {
    blockedByCapacity: false as const,
    workspaceId,
    user,
    chat,
    userId,
    chatId,
    conversation: conversationResult.conversation,
    isNewConversation: conversationResult.isNew,
  };
}

function getEventTimestampMs(timestamp: unknown): number {
  if (
    typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp > 0
  ) {
    return timestamp;
  }
  return Date.now();
}

type InstagramDeliveryStatus = "delivered" | "read";

type LeanInstagramDeliveryMessage = {
  _id: mongoose.Types.ObjectId;
  messageId?: string | number | null;
  conversation?: mongoose.Types.ObjectId | string | null;
  delivery?: MessageDocument["delivery"] | null;
};

const INSTAGRAM_DELIVERY_STATUS_PRIORITY: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

function shouldApplyInstagramDeliveryUpdate(params: {
  current?: MessageDocument["delivery"] | null;
  incomingStatus: InstagramDeliveryStatus;
  eventAt: Date;
}): boolean {
  const currentStatus = params.current?.status || null;
  if (!currentStatus) return true;

  const incomingPriority =
    INSTAGRAM_DELIVERY_STATUS_PRIORITY[params.incomingStatus] || 0;
  const currentPriority =
    INSTAGRAM_DELIVERY_STATUS_PRIORITY[currentStatus] || 0;
  if (incomingPriority > currentPriority) return true;
  if (incomingPriority < currentPriority) return false;

  const currentLastEventAt = readDate(params.current?.lastEventAt);
  return !currentLastEventAt || params.eventAt >= currentLastEventAt;
}

function buildInstagramDeliveryState(params: {
  current?: MessageDocument["delivery"] | null;
  status: InstagramDeliveryStatus;
  eventAt: Date;
}): NonNullable<MessageDocument["delivery"]> {
  const next: NonNullable<MessageDocument["delivery"]> = {
    ...(params.current || {}),
    status: params.status,
    lastEventAt: params.eventAt,
  };

  if (params.status === "delivered") {
    next.deliveredAt = params.eventAt;
    if (!next.sentAt) {
      next.sentAt = params.eventAt;
    }
  }

  if (params.status === "read") {
    next.readAt = params.eventAt;
    if (!next.deliveredAt) {
      next.deliveredAt = params.eventAt;
    }
    if (!next.sentAt) {
      next.sentAt = params.eventAt;
    }
  }

  return next;
}

function readInstagramDeliveryWatermarkMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function updateInstagramOutboundDeliveryStatus(params: {
  messaging: InstagramMessagingEvent;
  source: InstagramSourceData;
  status: InstagramDeliveryStatus;
  messageIds?: string[];
  watermarkMs?: number | null;
}) {
  await connectDB();

  const workspaceId = params.source.workspace_id;
  const senderId = String(params.messaging.sender?.id || "");
  const eventAt = new Date(getEventTimestampMs(params.messaging.timestamp));
  const messageIds = Array.from(
    new Set(
      (params.messageIds || [])
        .map(messageId => String(messageId || "").trim())
        .filter(Boolean)
    )
  );

  const query: Record<string, unknown> = {
    channel: "instagram",
    workspaceId,
    direction: "outbound",
  };

  if (messageIds.length > 0) {
    query.messageId = { $in: messageIds };
  } else {
    const watermarkMs = params.watermarkMs || null;
    if (!senderId || !watermarkMs) {
      return {
        status: "ignored",
        type: params.status,
        reason: "missing_delivery_message_id",
      };
    }

    query.chat = hashInstagramIdToNumber(`ig:chat:${senderId}`);
    query.date = { $lte: new Date(watermarkMs) };
  }

  const candidates = (await Message.find(query)
    .select("_id messageId conversation delivery")
    .sort({ date: -1 })
    .limit(messageIds.length > 0 ? Math.max(messageIds.length, 1) : 100)
    .lean()
    .exec()) as LeanInstagramDeliveryMessage[];

  let updatedCount = 0;
  for (const message of candidates) {
    if (
      !shouldApplyInstagramDeliveryUpdate({
        current: message.delivery,
        incomingStatus: params.status,
        eventAt,
      })
    ) {
      continue;
    }

    const delivery = buildInstagramDeliveryState({
      current: message.delivery,
      status: params.status,
      eventAt,
    });
    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          delivery,
        },
      }
    ).exec();
    updatedCount += 1;

    if (message.conversation) {
      try {
        await realtime.trigger(
          `private-conversation-${message.conversation}`,
          "message-delivery",
          {
            workspaceId,
            messageId:
              message.messageId !== null && message.messageId !== undefined
                ? String(message.messageId)
                : String(message._id),
            delivery,
            status: params.status,
          }
        );
      } catch {}
    }
  }

  if (updatedCount === 0) {
    return {
      status: "ignored",
      type: params.status,
      reason: "message_not_found",
    };
  }

  return { status: "ok", type: params.status, updatedCount };
}

/**
 * Whether a media echo is a later part of one of our own sends. A manager
 * reply with text and attachments, or an Airi reply with media, goes out as
 * several Instagram messages but is stored as one row under the first part's
 * id, so the other parts can only be matched by time.
 */
async function isOwnMediaSendEcho(params: {
  conversationId: unknown;
  workspaceId: string;
  businessAuthorId: string;
  eventTimestampMs: number;
}) {
  const own = await Message.exists({
    channel: "instagram",
    workspaceId: params.workspaceId,
    conversation: params.conversationId,
    direction: "outbound",
    author: { $ne: params.businessAuthorId },
    $or: [
      { imageUrl: { $nin: [null, ""] } },
      { "attachments.0": { $exists: true } },
    ],
    date: {
      $gte: new Date(params.eventTimestampMs - OWN_MEDIA_ECHO_MATCH_WINDOW_MS),
      $lte: new Date(params.eventTimestampMs + OWN_MEDIA_ECHO_MATCH_WINDOW_MS),
    },
  });
  return Boolean(own);
}

async function findRecentManagerOutboundMessage(
  conversationId: unknown,
  workspaceId: string,
  text: string,
  eventTimestampMs: number,
  businessAuthorId: string
) {
  const windowStart = new Date(eventTimestampMs - ECHO_MANAGER_MATCH_WINDOW_MS);
  const windowEnd = new Date(
    eventTimestampMs + ECHO_MANAGER_FUTURE_TOLERANCE_MS
  );

  const candidates = await Message.find({
    channel: "instagram",
    workspaceId,
    conversation: conversationId,
    direction: "outbound",
    text,
    // An earlier reply typed in the app is not a manager send to match.
    author: { $ne: businessAuthorId },
    date: { $gte: windowStart, $lte: windowEnd },
  })
    .sort({ date: -1 })
    .limit(5)
    .populate({
      path: "author",
      model: User,
      select: "isBot",
    });

  return (
    candidates.find(candidate => {
      const author = candidate.author as { isBot?: boolean } | null;
      return author?.isBot === false;
    }) || null
  );
}

/**
 * Handle incoming Instagram message
 */
export async function handleIncomingMessage(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  await connectDB();

  const senderId = String(messaging.sender?.id || "");
  const recipientId = String(messaging.recipient?.id || "");
  const content = resolveInstagramMessageContent(messaging.message);
  const text = content.text;
  const messageId = messaging.message?.mid;
  const rawReferral = readInstagramReferralContext(messaging.message?.referral);
  const quickReplyPayload =
    typeof messaging.message?.quick_reply?.payload === "string"
      ? messaging.message.quick_reply.payload.trim()
      : "";

  if (!messaging.message || !recipientId || !senderId) {
    return { status: "ignored", reason: "missing_data" };
  }

  const workspaceId = source.workspace_id;
  const pageId = source.pageId;
  const accessToken = resolveInstagramAccessToken(source.pageAccessToken);
  const senderProfileHint = extractInstagramProfileHint(messaging.sender);

  const context = await resolveInstagramInboundContext({
    source,
    senderId,
    profileHint: senderProfileHint,
  });
  const { user, chat, chatId } = context;

  if (context.blockedByCapacity) {
    return {
      status: "ok",
      reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
    };
  }
  const { conversation, isNewConversation } = context;
  const referral = await enrichInstagramReferralContext({
    workspaceId,
    referral: rawReferral,
  });
  const referralRagContext = buildInstagramReferralRagContext(referral);

  const now = new Date(getEventTimestampMs(messaging.timestamp));
  if (referral) {
    await persistInstagramReferralContext({
      conversationId: conversation._id,
      workspaceId,
      referral,
    });
    conversation.external_thread = {
      ...(conversation.external_thread || {}),
      provider: "instagram",
      referral: compactReferralContext(referral),
    } as typeof conversation.external_thread;
  }

  if (content.providerEventKind === "instagram_deleted" && messageId) {
    const existing = await findExistingInstagramMessage(
      messageId,
      workspaceId,
      "inbound"
    );
    if (existing) {
      const previousText =
        typeof existing.text === "string" ? existing.text : null;
      existing.text = text;
      existing.rawSourcePayload = buildRawSourcePayload({
        provider: "instagram",
        eventType: "message_deleted",
        capturedAt: now,
        payload: messaging,
      });
      existing.editMeta = {
        editedAt: now,
        previousText,
        editCount: ((existing.editMeta?.editCount || 0) as number) + 1,
        source: "instagram_webhook",
        kind: "revoke",
      } as MessageDocument["editMeta"];
      await existing.save();

      try {
        await invalidateRequestsForWorkspace(workspaceId);
        await realtime.trigger(
          `private-conversation-${conversation._id}`,
          "message-updated",
          await Message.findById(existing._id).populate({
            path: "author",
            model: User,
            select: "firstName isBot",
          })
        );
      } catch {}

      return {
        status: "ok",
        type: "message_deleted",
        conversationId: String(conversation._id),
      };
    }
  }

  const media = await storeInstagramMessageMedia({
    content,
    messageId,
    workspaceId,
    conversationId: String(conversation._id),
    direction: "inbound",
  });
  const messageDoc = new Message({
    messageId,
    chat: chat._id,
    author: user._id,
    rawSourcePayload: buildRawSourcePayload({
      provider: "instagram",
      eventType: "message",
      capturedAt: now,
      payload: messaging,
    }),
    text: media.text,
    ...(referralRagContext ? { ragContext: referralRagContext } : {}),
    ...(media.imageUrl ? { imageUrl: media.imageUrl } : {}),
    ...(media.mediaType ? { mediaType: media.mediaType } : {}),
    ...("mimeType" in media
      ? { mimeType: media.mimeType, fileSize: media.fileSize }
      : {}),
    date: now,
    workspaceId,
    conversation: conversation._id,
    channel: "instagram",
    direction: "inbound",
  });
  const airiParams: AiriAutoReplyParams | undefined =
    content.shouldQueueAiri !== false
      ? {
          type: "instagram",
          instagramInfo: {
            pageId,
            accessToken,
            recipientId: senderId,
            authMethod: source.authMethod,
          },
          newMessage: messageDoc,
          conversation,
          workspaceId,
          chatDocument: chat,
          chatId,
          triggerEventKind: quickReplyPayload
            ? SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply
            : undefined,
          quickReplyPayload: quickReplyPayload || undefined,
          suppressGeneralAutoReply:
            content.suppressGeneralAutoReply || undefined,
        }
      : undefined;
  if (airiParams) {
    messageDoc.airiIngressIntent =
      buildAiriConversationIngressIntent(airiParams);
  }
  const { message: newMessage, isNew: messageWasNew } =
    await saveInstagramMessageWithDedup(messageDoc, workspaceId, "inbound");
  const savedMessageDate = (newMessage.date as Date) || now;

  await linkMessageToConversation(
    String(conversation._id),
    newMessage._id,
    savedMessageDate,
    workspaceId,
    "inbound"
  );
  conversation.lastMessageAt = savedMessageDate;

  if (airiParams) {
    await queueInstagramAiriAutoReply(
      { ...airiParams, newMessage },
      {
        missingContextError:
          "Instagram auto-reply Temporal ingress requires workspace, conversation, and message ids",
      }
    );
  }

  if (!messageWasNew) {
    return {
      status: "ok",
      conversationId: String(conversation._id),
      duplicate: true,
    };
  }

  // Detect and update conversation language from customer message
  if (text && content.shouldDetectLanguage !== false) {
    await detectAndUpdateConversationLanguage(String(conversation._id), text);
  }

  // Realtime updates - use singleton pattern
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

/**
 * Handle message echoes: everything the business account sends, through our
 * API (matched to the row we saved) or from the Instagram app (saved here).
 */
export async function handleMessageEcho(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  await connectDB();

  const senderId = String(messaging.sender?.id || "");
  const recipientId = String(messaging.recipient?.id || "");
  const typedText = messaging.message?.text || "";
  const content = resolveInstagramMessageContent(messaging.message);
  const messageId = messaging.message?.mid;
  const eventTimestampMs = getEventTimestampMs(messaging.timestamp);
  const eventDate = new Date(eventTimestampMs);
  const echoRawSourcePayload = buildRawSourcePayload({
    provider: "instagram",
    eventType: "message_echo",
    capturedAt: eventDate,
    payload: messaging,
  });

  // Text, media and shared posts. Cards and button templates only come from
  // our own sends and have no media link; deletions are not new messages.
  const isMediaEcho = !typedText && Boolean(content.imageUrl);
  const isSharedLinkEcho =
    content.providerEventKind === "instagram_share" ||
    content.providerEventKind === "instagram_reel_share";
  if ((!typedText && !isMediaEcho && !isSharedLinkEcho) || !senderId) {
    return { status: "ignored", reason: "missing_data" };
  }
  const businessAuthorId = instagramBusinessAuthorId(senderId);

  const workspaceId = source.workspace_id;

  // For echoes, the sender is the business (you), recipient is the customer
  const customerId = recipientId;
  const { user, chat, chatId } = await getOrCreateUserAndChat(
    customerId,
    source
  );

  const conversationResult = await getOrCreateConversation(
    workspaceId,
    user._id as number,
    chatId,
    customerId
  );
  if (!conversationResult) {
    return {
      status: "ok",
      type: "echo",
      reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
    };
  }
  const { conversation } = conversationResult;

  if (
    isMediaEcho &&
    (await isOwnMediaSendEcho({
      conversationId: conversation._id,
      workspaceId,
      businessAuthorId,
      eventTimestampMs,
    }))
  ) {
    return { status: "ok", type: "echo", duplicate: true };
  }

  // If this echo corresponds to a message already saved by our reply endpoint,
  // reuse that message instead of creating a duplicate echo copy.
  const managerMessage = typedText
    ? await findRecentManagerOutboundMessage(
        conversation._id,
        workspaceId,
        typedText,
        eventTimestampMs,
        businessAuthorId
      )
    : null;
  if (managerMessage) {
    let shouldSaveManagerMessage = false;
    if (
      messageId &&
      (!managerMessage.messageId ||
        String(managerMessage.messageId) !== messageId)
    ) {
      managerMessage.messageId = messageId;
      shouldSaveManagerMessage = true;
    }

    if (!managerMessage.rawSourcePayload) {
      managerMessage.rawSourcePayload = echoRawSourcePayload;
      shouldSaveManagerMessage = true;
    }

    if (shouldSaveManagerMessage) {
      try {
        await managerMessage.save();
      } catch (error) {
        if (!isMongoDuplicateKeyError(error)) {
          throw error;
        }
      }
    }

    const matchedMessageDate =
      (managerMessage.date as Date) || new Date(eventTimestampMs);
    await linkMessageToConversation(
      String(conversation._id),
      managerMessage._id,
      matchedMessageDate,
      workspaceId,
      "outbound"
    );

    return {
      status: "ok",
      type: "echo",
      duplicate: true,
      matchedMessageId: String(managerMessage._id),
    };
  }

  // Not one of our sends: the business replied from the Instagram app.
  const businessAuthor = await upsertInstagramBusinessAuthor(senderId);
  const media = await storeInstagramMessageMedia({
    content,
    messageId,
    workspaceId,
    conversationId: String(conversation._id),
    direction: "outbound",
  });

  const now = eventDate;
  const echoMessageDoc = new Message({
    messageId,
    chat: chat._id,
    author: businessAuthor._id,
    rawSourcePayload: echoRawSourcePayload,
    text: media.text,
    ...(media.imageUrl ? { imageUrl: media.imageUrl } : {}),
    ...(media.mediaType ? { mediaType: media.mediaType } : {}),
    ...("mimeType" in media
      ? { mimeType: media.mimeType, fileSize: media.fileSize }
      : {}),
    date: now,
    workspaceId,
    conversation: conversation._id,
    channel: "instagram",
    direction: "outbound",
    origin: {
      kind: "manager",
      sourceId: source.id,
      sentByUserId: businessAuthorId,
    },
  });
  const { message: echoMessage, isNew: messageWasNew } =
    await saveInstagramMessageWithDedup(
      echoMessageDoc,
      workspaceId,
      "outbound"
    );
  const savedEchoDate = (echoMessage.date as Date) || now;

  await linkMessageToConversation(
    String(conversation._id),
    echoMessage._id,
    savedEchoDate,
    workspaceId,
    "outbound"
  );
  conversation.lastMessageAt = savedEchoDate;

  if (!messageWasNew) {
    return { status: "ok", type: "echo", duplicate: true };
  }

  // Realtime update
  try {
    await realtime.trigger(
      `private-conversation-${conversation._id}`,
      "new-message",
      await Message.findById(echoMessage._id).populate({
        path: "author",
        model: User,
        select: "firstName isBot",
      })
    );
  } catch {}

  return { status: "ok", type: "echo" };
}

async function persistInstagramNonMessageEvent(params: {
  messaging: InstagramMessagingEvent;
  source: InstagramSourceData;
  eventType: string;
  text: string;
  referral?: InstagramReferralContext | null;
}) {
  await connectDB();

  const senderId = String(params.messaging.sender?.id || "");
  const recipientId = String(params.messaging.recipient?.id || "");
  if (!senderId || !recipientId) {
    return { status: "ignored", reason: "missing_data" };
  }

  const workspaceId = params.source.workspace_id;
  const senderProfileHint = extractInstagramProfileHint(
    params.messaging.sender
  );
  const context = await resolveInstagramInboundContext({
    source: params.source,
    senderId,
    profileHint: senderProfileHint,
  });
  const { user, chat } = context;

  if (context.blockedByCapacity) {
    return {
      status: "ok",
      type: params.eventType,
      reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
    };
  }

  const { conversation, isNewConversation } = context;
  const now = new Date(getEventTimestampMs(params.messaging.timestamp));
  const referral = await enrichInstagramReferralContext({
    workspaceId,
    referral: params.referral ?? null,
  });
  const referralRagContext = buildInstagramReferralRagContext(referral);
  if (referral) {
    await persistInstagramReferralContext({
      conversationId: conversation._id,
      workspaceId,
      referral,
    });
  }

  const eventMessageId = [
    "instagram",
    params.eventType,
    senderId,
    String(params.messaging.timestamp || ""),
    params.text,
  ].join(":");
  const messageDoc = new Message({
    messageId: eventMessageId,
    chat: chat._id,
    author: user._id,
    rawSourcePayload: buildRawSourcePayload({
      provider: "instagram",
      eventType: params.eventType,
      capturedAt: now,
      payload: params.messaging,
    }),
    text: params.text,
    ...(referralRagContext ? { ragContext: referralRagContext } : {}),
    date: now,
    workspaceId,
    conversation: conversation._id,
    channel: "instagram",
    direction: "inbound",
  });

  const { message: newMessage, isNew: messageWasNew } =
    await saveInstagramMessageWithDedup(messageDoc, workspaceId, "inbound");
  const savedMessageDate = (newMessage.date as Date) || now;

  await linkMessageToConversation(
    String(conversation._id),
    newMessage._id,
    savedMessageDate,
    workspaceId,
    "inbound"
  );
  conversation.lastMessageAt = savedMessageDate;

  if (!messageWasNew) {
    return {
      status: "ok",
      type: params.eventType,
      duplicate: true,
      conversationId: String(conversation._id),
    };
  }

  try {
    await publishInstagramConversationMessage({
      workspaceId,
      conversationId: conversation._id,
      messageId: newMessage._id,
      isNewConversation,
    });
  } catch {}

  return {
    status: "ok",
    type: params.eventType,
    conversationId: String(conversation._id),
  };
}

export async function handleRead(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  const messageId =
    typeof messaging.read?.mid === "string" ? messaging.read.mid.trim() : "";
  return updateInstagramOutboundDeliveryStatus({
    messaging,
    source,
    status: "read",
    messageIds: messageId ? [messageId] : [],
    watermarkMs: readInstagramDeliveryWatermarkMs(messaging.read?.watermark),
  });
}

export async function handleDelivery(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  const mids = Array.isArray(messaging.delivery?.mids)
    ? messaging.delivery.mids
    : [];

  return updateInstagramOutboundDeliveryStatus({
    messaging,
    source,
    status: "delivered",
    messageIds: mids,
    watermarkMs: readInstagramDeliveryWatermarkMs(
      messaging.delivery?.watermark
    ),
  });
}

export async function handleReferral(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  const referral = readInstagramReferralContext(messaging.referral);
  return persistInstagramNonMessageEvent({
    messaging,
    source,
    eventType: "referral",
    text: "Instagram referral received",
    referral,
  });
}

export async function handleOptin(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  const payload =
    typeof messaging.optin?.payload === "string" && messaging.optin.payload
      ? `: ${messaging.optin.payload}`
      : "";
  return persistInstagramNonMessageEvent({
    messaging,
    source,
    eventType: "optin",
    text: `Instagram notification opt-in received${payload}`,
  });
}

export async function handleStandby(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  return persistInstagramNonMessageEvent({
    messaging,
    source,
    eventType: "standby",
    text: "Instagram standby event received",
  });
}

/**
 * Handle message reactions
 */
export async function handleReaction(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  await connectDB();

  const senderId = String(messaging.sender?.id || "");
  const reaction = messaging.reaction;

  if (!reaction || !senderId) {
    return { status: "ignored", reason: "missing_data" };
  }

  const senderProfileHint = extractInstagramProfileHint(messaging.sender);
  const context = await resolveInstagramInboundContext({
    source,
    senderId,
    profileHint: senderProfileHint,
  });
  if (context.blockedByCapacity) {
    return {
      status: "ok",
      type: "reaction",
      reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
    };
  }
  const { conversation, user } = context;
  const targetMessageId =
    typeof reaction.mid === "string" ? reaction.mid.trim() : "";
  const action =
    typeof reaction.action === "string" && reaction.action.trim()
      ? reaction.action.trim()
      : "react";
  const emoji =
    typeof reaction.emoji === "string" && reaction.emoji.trim()
      ? reaction.emoji.trim()
      : typeof reaction.reaction === "string" && reaction.reaction.trim()
        ? reaction.reaction.trim()
        : "";
  const reactionAuthorId =
    user && typeof user === "object" && "_id" in user
      ? String((user as { _id?: unknown })._id || "")
      : "";
  const authorName =
    user && typeof user === "object"
      ? [
          (user as { firstName?: unknown }).firstName,
          (user as { lastName?: unknown }).lastName,
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .trim() ||
        (typeof (user as { username?: unknown }).username === "string"
          ? ((user as { username: string }).username as string)
          : "")
      : "";

  instagramWebhookLogger.info("Instagram reaction received", {
    action,
    emoji,
    messageId: targetMessageId,
    conversationId: String(conversation._id),
  });

  const targetMessage = targetMessageId
    ? await Message.findOne({
        channel: "instagram",
        workspaceId: source.workspace_id,
        conversation: conversation._id,
        messageId: targetMessageId,
      })
    : null;

  if (!targetMessage || !reactionAuthorId) {
    return {
      status: "ok",
      type: "reaction",
      reason: "message_not_found",
    };
  }

  await Message.updateOne(
    { _id: targetMessage._id },
    { $pull: { reactions: { authorId: reactionAuthorId } } }
  );

  if (action !== "unreact" && emoji) {
    await Message.updateOne(
      { _id: targetMessage._id },
      {
        $push: {
          reactions: {
            emoji,
            authorId: reactionAuthorId,
            authorName: authorName || "Instagram User",
            reactionMessageId: `${targetMessageId}:${action}`,
            date: new Date(getEventTimestampMs(messaging.timestamp)),
          },
        },
      }
    );
  }

  const updatedTarget = await Message.findById(targetMessage._id).populate({
    path: "author",
    model: User,
    select: "firstName isBot",
  });

  try {
    await realtime.trigger(
      `private-conversation-${conversation._id}`,
      "message-reaction",
      {
        action,
        emoji: emoji || null,
        messageId: String(targetMessage._id),
        reactions:
          updatedTarget && "reactions" in updatedTarget
            ? (updatedTarget as { reactions?: unknown }).reactions
            : [],
        timestamp: new Date(getEventTimestampMs(messaging.timestamp)),
      }
    );
  } catch {}

  return {
    status: "ok",
    type: "reaction",
    messageId: String(targetMessage._id),
  };
}

/**
 * Handle postbacks (button clicks, quick replies)
 */
export async function handlePostback(
  messaging: InstagramMessagingEvent,
  source: InstagramSourceData
) {
  await connectDB();

  const senderId = String(messaging.sender?.id || "");
  const postback = messaging.postback;
  const postbackPayload =
    typeof postback?.payload === "string" ? postback.payload.trim() : "";

  if (!postback || !senderId) {
    return { status: "ignored", reason: "missing_data" };
  }

  const workspaceId = source.workspace_id;
  const pageId = source.pageId;
  const accessToken = resolveInstagramAccessToken(source.pageAccessToken);
  const senderProfileHint = extractInstagramProfileHint(messaging.sender);
  const context = await resolveInstagramInboundContext({
    source,
    senderId,
    profileHint: senderProfileHint,
  });
  if (context.blockedByCapacity) {
    return {
      status: "ok",
      type: "postback",
      reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
    };
  }
  const { user, chat, chatId, conversation, isNewConversation } = context;

  const now = new Date(getEventTimestampMs(messaging.timestamp));
  const postbackText = `[Button: ${postback.title}]`;

  // Save postback as a message
  const messageDoc = new Message({
    messageId: postback.mid,
    chat: chat._id,
    author: user._id,
    rawSourcePayload: buildRawSourcePayload({
      provider: "instagram",
      eventType: "postback",
      capturedAt: now,
      payload: messaging,
    }),
    text: postbackText,
    date: now,
    workspaceId,
    conversation: conversation._id,
    channel: "instagram",
    direction: "inbound",
  });
  const airiParams = {
    type: "instagram" as const,
    instagramInfo: {
      pageId,
      accessToken,
      recipientId: senderId,
      authMethod: source.authMethod,
    },
    newMessage: messageDoc,
    conversation,
    workspaceId,
    chatDocument: chat,
    chatId,
    triggerEventKind: postbackPayload
      ? SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply
      : undefined,
    quickReplyPayload: postbackPayload || undefined,
  } satisfies AiriAutoReplyParams;
  messageDoc.airiIngressIntent = buildAiriConversationIngressIntent(airiParams);
  const { message: newMessage, isNew: messageWasNew } =
    await saveInstagramMessageWithDedup(messageDoc, workspaceId, "inbound");
  const savedMessageDate = (newMessage.date as Date) || now;

  await linkMessageToConversation(
    String(conversation._id),
    newMessage._id,
    savedMessageDate,
    workspaceId,
    "inbound"
  );
  conversation.lastMessageAt = savedMessageDate;

  await queueInstagramAiriAutoReply(
    { ...airiParams, newMessage },
    {
      missingContextError:
        "Instagram auto-reply Temporal ingress requires workspace, conversation, and message ids",
    }
  );

  if (!messageWasNew) {
    return {
      status: "ok",
      type: "postback",
      duplicate: true,
      conversationId: String(conversation._id),
    };
  }

  try {
    await publishInstagramConversationMessage({
      workspaceId,
      conversationId: conversation._id,
      messageId: newMessage._id,
      isNewConversation,
    });
  } catch {}

  return { status: "ok", type: "postback" };
}
