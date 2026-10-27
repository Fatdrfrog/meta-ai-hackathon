import connectDB from "@/lib/mongoose";
import type { BulkCampaignRecipient } from "@/lib/campaign/bulk-campaign-contracts";
import {
  buildTelegramCompositeChatId,
  isTelegramPrivateChatId,
  normalizeTelegramChatId,
} from "@/lib/telegram/chat-id";
import {
  findEligibleTelegramSubscriberMap,
  findTelegramSubscriberStatusMap,
  type TelegramSubscriberStatus,
} from "@/lib/telegram/subscribers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";
import { readDate } from "@icecore/shared/lib/value-utils";

const TELEGRAM_BUSINESS_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_PREFLIGHT_LOOKUP_CHUNK_SIZE = 500;

type TelegramConversationEligibilityRow = {
  chat?: unknown;
  sourceId?: string | null;
  business_connection_id?: string | null;
  first_inbound_at?: Date | string | null;
  last_inbound_at?: Date | string | null;
};

type TelegramBusinessConnectionEligibilityRow = {
  business_connection_id?: string | null;
  workspace_id?: string | null;
  source_id?: string | null;
  can_reply?: boolean | null;
  is_enabled?: boolean | null;
};

type TelegramBulkPreflightCandidate = {
  recipient: BulkCampaignRecipient;
  rawChatId: string;
  sourceId: string;
};

export type ResolvedTelegramBulkCampaignRecipient =
  BulkCampaignRecipient & {
    chatId: string;
    sourceId?: string | null;
    businessConnectionId?: string | null;
  };

type TelegramBulkPreflightSkippedRecipientDetail = {
  reason: string;
  detail?: string;
};

type TelegramBulkPreflightResult = {
  recipients: ResolvedTelegramBulkCampaignRecipient[];
  skippedRecipientDetails: TelegramBulkPreflightSkippedRecipientDetail[];
};

function addTelegramChatLookupValue(
  values: Set<string | number>,
  value: string
) {
  const trimmed = value.trim();
  if (!trimmed) return;
  values.add(trimmed);
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) values.add(numeric);
}

function getTelegramConversationSourceId(
  conversation: TelegramConversationEligibilityRow
): string {
  return typeof conversation.sourceId === "string"
    ? conversation.sourceId.trim()
    : "";
}

function getTelegramConversationBusinessConnectionId(
  conversation: TelegramConversationEligibilityRow
): string {
  return typeof conversation.business_connection_id === "string"
    ? conversation.business_connection_id.trim()
    : "";
}

function chunkTelegramLookupValues<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += TELEGRAM_PREFLIGHT_LOOKUP_CHUNK_SIZE
  ) {
    chunks.push(
      values.slice(offset, offset + TELEGRAM_PREFLIGHT_LOOKUP_CHUNK_SIZE)
    );
  }
  return chunks;
}

async function fetchActiveTelegramBusinessConnections(
  workspaceId: string,
  businessConnectionIds: string[]
): Promise<Map<string, TelegramBusinessConnectionEligibilityRow>> {
  if (businessConnectionIds.length === 0) {
    return new Map();
  }

  const rows: TelegramBusinessConnectionEligibilityRow[] = [];
  const uniqueBusinessConnectionIds = Array.from(
    new Set(businessConnectionIds)
  );
  for (const idChunk of chunkTelegramLookupValues(
    uniqueBusinessConnectionIds
  )) {
    const { data, error } = await supabaseAdmin
      .from("telegram_business_connections")
      .select(
        "business_connection_id, workspace_id, source_id, can_reply, is_enabled"
      )
      .eq("workspace_id", workspaceId)
      .in("business_connection_id", idChunk);

    if (error) {
      throw new Error(
        `Failed to validate Telegram Business reply windows: ${error.message || String(error)}`
      );
    }
    rows.push(
      ...((data || []) as TelegramBusinessConnectionEligibilityRow[])
    );
  }

  return new Map(
    rows
      .filter(
        row =>
          typeof row.business_connection_id === "string" &&
          row.business_connection_id.trim()
      )
      .map(row => [row.business_connection_id!.trim(), row])
  );
}

type TelegramConversationEligibilityResolution =
  | {
      eligible: true;
      businessConnectionId?: string;
    }
  | {
      eligible: false;
      reason:
        | "telegram_recipient_not_contacted"
        | "telegram_business_reply_unavailable"
        | "telegram_business_reply_window_expired";
    };

function resolveTelegramConversationEligibility(params: {
  conversations: TelegramConversationEligibilityRow[];
  activeBusinessConnections: Map<
    string,
    TelegramBusinessConnectionEligibilityRow
  >;
  workspaceId: string;
  sourceId: string;
  businessReplyWindowCutoff: Date;
}): TelegramConversationEligibilityResolution {
  const hasEligibleStandardConversation = params.conversations.some(
    conversation =>
      !getTelegramConversationBusinessConnectionId(conversation) &&
      Boolean(
        readDate(conversation.first_inbound_at) ||
        readDate(conversation.last_inbound_at)
      )
  );
  if (hasEligibleStandardConversation) {
    return { eligible: true };
  }

  const eligibleBusinessConversations: Array<{
    businessConnectionId: string;
    lastInboundAtMs: number;
  }> = [];
  let hasUnavailableBusinessConversation = false;
  let hasExpiredBusinessConversation = false;

  for (const conversation of params.conversations) {
    const businessConnectionId =
      getTelegramConversationBusinessConnectionId(conversation);
    if (!businessConnectionId) continue;

    const businessConnection =
      params.activeBusinessConnections.get(businessConnectionId);
    if (
      !businessConnection ||
      businessConnection.can_reply !== true ||
      businessConnection.is_enabled !== true ||
      businessConnection.workspace_id !== params.workspaceId ||
      (businessConnection.source_id &&
        businessConnection.source_id !== params.sourceId)
    ) {
      hasUnavailableBusinessConversation = true;
      continue;
    }

    const lastInboundAt = readDate(conversation.last_inbound_at);
    if (
      !lastInboundAt ||
      lastInboundAt < params.businessReplyWindowCutoff
    ) {
      hasExpiredBusinessConversation = true;
      continue;
    }

    eligibleBusinessConversations.push({
      businessConnectionId,
      lastInboundAtMs: lastInboundAt.getTime(),
    });
  }

  if (eligibleBusinessConversations.length > 0) {
    eligibleBusinessConversations.sort(
      (left, right) =>
        right.lastInboundAtMs - left.lastInboundAtMs ||
        left.businessConnectionId.localeCompare(right.businessConnectionId)
    );
    return {
      eligible: true,
      businessConnectionId:
        eligibleBusinessConversations[0].businessConnectionId,
    };
  }
  if (hasExpiredBusinessConversation) {
    return {
      eligible: false,
      reason: "telegram_business_reply_window_expired",
    };
  }
  if (hasUnavailableBusinessConversation) {
    return {
      eligible: false,
      reason: "telegram_business_reply_unavailable",
    };
  }
  return {
    eligible: false,
    reason: "telegram_recipient_not_contacted",
  };
}

export async function resolveEligibleTelegramBulkRecipients(params: {
  workspaceId: string;
  recipients: BulkCampaignRecipient[];
  defaultSourceId: string;
}): Promise<TelegramBulkPreflightResult> {
  const normalizedRecipients = params.recipients.map(recipient => {
    const rawChatId = normalizeTelegramChatId(recipient.chatId);
    const sourceId =
      typeof recipient.sourceId === "string" && recipient.sourceId.trim()
        ? recipient.sourceId.trim()
        : params.defaultSourceId;
    return {
      recipient,
      rawChatId,
      sourceId,
    };
  });

  const skippedRecipientDetails: TelegramBulkPreflightSkippedRecipientDetail[] =
    [];
  const candidates = normalizedRecipients.filter(candidate => {
    if (!candidate.rawChatId) {
      skippedRecipientDetails.push({ reason: "missing_chat_id" });
      return false;
    }
    if (!isTelegramPrivateChatId(candidate.rawChatId)) {
      skippedRecipientDetails.push({
        reason: "telegram_group_dm_not_supported",
        detail: candidate.rawChatId,
      });
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    return { recipients: [], skippedRecipientDetails };
  }

  await connectDB();

  const candidatesBySourceId = new Map<
    string,
    TelegramBulkPreflightCandidate[]
  >();
  for (const candidate of candidates) {
    const sourceCandidates =
      candidatesBySourceId.get(candidate.sourceId) || [];
    sourceCandidates.push(candidate);
    candidatesBySourceId.set(candidate.sourceId, sourceCandidates);
  }

  const conversations: TelegramConversationEligibilityRow[] = [];
  for (const [sourceId, sourceCandidates] of candidatesBySourceId) {
    if (!sourceId) continue;
    const lookupValues = new Set<string | number>();
    for (const candidate of sourceCandidates) {
      addTelegramChatLookupValue(lookupValues, candidate.rawChatId);
      addTelegramChatLookupValue(
        lookupValues,
        buildTelegramCompositeChatId(candidate.rawChatId, sourceId)
      );
      if (candidate.recipient.chatId) {
        addTelegramChatLookupValue(lookupValues, candidate.recipient.chatId);
      }
    }

    for (const lookupChunk of chunkTelegramLookupValues(
      Array.from(lookupValues)
    )) {
      const chunkRows = (await Conversation.find({
        workspaceId: params.workspaceId,
        channel: "telegram",
        sourceId,
        chat: { $in: lookupChunk },
      })
        .select(
          "chat sourceId business_connection_id first_inbound_at last_inbound_at"
        )
        .lean()) as TelegramConversationEligibilityRow[];
      conversations.push(...chunkRows);
    }
  }

  const conversationsByRecipientKey = new Map<
    string,
    TelegramConversationEligibilityRow[]
  >();
  for (const conversation of conversations) {
    const rawChatId = normalizeTelegramChatId(conversation.chat);
    const sourceId = getTelegramConversationSourceId(conversation);
    if (!rawChatId || !sourceId) continue;
    const recipientKey = `${rawChatId}:${sourceId}`;
    const existing = conversationsByRecipientKey.get(recipientKey) || [];
    existing.push(conversation);
    conversationsByRecipientKey.set(recipientKey, existing);
  }

  const businessConnectionIds = Array.from(
    new Set(
      conversations
        .map(getTelegramConversationBusinessConnectionId)
        .filter(Boolean)
    )
  );
  const activeBusinessConnections =
    await fetchActiveTelegramBusinessConnections(
      params.workspaceId,
      businessConnectionIds
    );
  const importedSubscriberMap = new Map<
    string,
    {
      chatId: string;
      sourceId: string;
      status: TelegramSubscriberStatus;
    }
  >();
  const subscriberStatusMap = new Map<
    string,
    {
      chatId: string;
      sourceId: string;
      status: TelegramSubscriberStatus;
    }
  >();
  for (const [sourceId, sourceCandidates] of candidatesBySourceId) {
    if (!sourceId) continue;
    const sourceChatIds = Array.from(
      new Set(sourceCandidates.map(candidate => candidate.rawChatId))
    );
    for (const chatIds of chunkTelegramLookupValues(sourceChatIds)) {
      const [eligibleSubscribers, subscriberStatuses] = await Promise.all([
        findEligibleTelegramSubscriberMap({
          workspaceId: params.workspaceId,
          sourceIds: [sourceId],
          chatIds,
        }),
        findTelegramSubscriberStatusMap({
          workspaceId: params.workspaceId,
          sourceIds: [sourceId],
          chatIds,
        }),
      ]);
      eligibleSubscribers.forEach((value, key) =>
        importedSubscriberMap.set(key, value)
      );
      subscriberStatuses.forEach((value, key) =>
        subscriberStatusMap.set(key, value)
      );
    }
  }
  const businessReplyWindowCutoff = new Date(
    Date.now() - TELEGRAM_BUSINESS_REPLY_WINDOW_MS
  );

  const eligibleRecipients: ResolvedTelegramBulkCampaignRecipient[] = [];

  for (const candidate of candidates) {
    const subscriberStatus = subscriberStatusMap.get(
      `${candidate.rawChatId}:${candidate.sourceId}`
    );
    if (
      subscriberStatus &&
      subscriberStatus.status !== "active" &&
      subscriberStatus.status !== "imported"
    ) {
      skippedRecipientDetails.push({
        reason: `telegram_subscriber_${subscriberStatus.status}`,
        detail: candidate.rawChatId,
      });
      continue;
    }

    const matchingConversations =
      conversationsByRecipientKey.get(
        `${candidate.rawChatId}:${candidate.sourceId}`
      ) || [];

    if (matchingConversations.length === 0) {
      const subscriber = importedSubscriberMap.get(
        `${candidate.rawChatId}:${candidate.sourceId}`
      );
      if (subscriber) {
        eligibleRecipients.push({
          ...candidate.recipient,
          chatId: candidate.rawChatId,
          sourceId: subscriber.sourceId,
          businessConnectionId: undefined,
        });
        continue;
      }
      skippedRecipientDetails.push({
        reason: "telegram_recipient_not_contacted",
        detail: candidate.rawChatId,
      });
      continue;
    }

    const conversationEligibility = resolveTelegramConversationEligibility({
      conversations: matchingConversations,
      activeBusinessConnections,
      workspaceId: params.workspaceId,
      sourceId: candidate.sourceId,
      businessReplyWindowCutoff,
    });
    if (conversationEligibility.eligible) {
      eligibleRecipients.push({
        ...candidate.recipient,
        chatId: candidate.rawChatId,
        sourceId: candidate.sourceId,
        businessConnectionId: conversationEligibility.businessConnectionId,
      });
      continue;
    }

    skippedRecipientDetails.push({
      reason: conversationEligibility.reason,
      detail: candidate.rawChatId,
    });
  }

  return {
    recipients: eligibleRecipients,
    skippedRecipientDetails,
  };
}
