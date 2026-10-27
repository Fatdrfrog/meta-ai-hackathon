import connectDB from "@/lib/mongoose";
import {
  CreativeStudioChat,
  type CreativeStudioChatSource,
} from "@/models/creative-studio-chat";
import { Conversation } from "@/models/conversation";
import { emitWorkspaceUsageDeltaBestEffort } from "./company-usage-events";
import {
  readCompanyUsageSnapshot,
  type CompanyUsageSnapshotCounts,
} from "./company-usage-snapshots";
import { buildCacheKey, cache } from "@/lib/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import "server-only";
import { readDate, firstOrSelf } from "@icecore/shared/lib/value-utils";
import { evaluateChannelCapacity } from "./channel-capacity";

export const COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE =
  "company_conversation_limit_exceeded";
export const COMPANY_SEAT_LIMIT_EXCEEDED_CODE = "company_seat_limit_exceeded";
export const COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE =
  "company_channel_limit_exceeded";
export const COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE =
  "company_airi_auto_reply_limit_exceeded";
export const COMPANY_SCENARIO_LIMIT_EXCEEDED_CODE =
  "company_scenario_limit_exceeded";
export const COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE =
  "company_bulk_campaign_limit_exceeded";

/**
 * Whether a database bulk quota refusal is well formed. Recipient allowance
 * refusals carry the recipients the send asked for (used + requested over the
 * limit); the older campaign count refused once the count reached the limit.
 */
export function isCompanyBulkQuotaRefusal(
  row: Record<string, unknown>
): boolean {
  const limit = row.company_bulk_campaign_limit;
  const used = row.company_bulk_campaign_count;
  const requested = row.company_bulk_recipient_count;
  if (
    typeof limit !== "number" ||
    typeof used !== "number" ||
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(used) ||
    used < 0
  ) {
    return false;
  }
  if (requested === undefined) return used >= limit;
  return (
    typeof requested === "number" &&
    Number.isSafeInteger(requested) &&
    requested >= 1 &&
    used + requested > limit
  );
}
export const COMPANY_CLASSIFICATION_LIMIT_EXCEEDED_CODE =
  "company_classification_limit_exceeded";
export const COMPANY_COACH_LIMIT_EXCEEDED_CODE = "company_coach_limit_exceeded";
export const COMPANY_STUDIO_CHAT_LIMIT_EXCEEDED_CODE =
  "company_studio_chat_limit_exceeded";
export const COMPANY_WORKSPACE_LIMIT_EXCEEDED_CODE =
  "company_workspace_limit_exceeded";

export const COMPANY_LIMITED_CAPABILITIES = [
  "trial_expired",
  "new_conversations",
  "workspace_creation",
  "scenario_creation",
  "bulk_campaigns",
  "team_invites",
  "channel_connections",
  "whatsapp_number_connections",
  "integration_connections",
  "airi_auto_replies",
  "classifications",
  "coach",
  "studio_chats",
] as const;

export type CompanyLockedCapability =
  (typeof COMPANY_LIMITED_CAPABILITIES)[number];

export type CompanySubscriptionType = "free" | "pro" | "enterprise";
export const COMPANY_SUBSCRIPTION_TYPES = [
  "free",
  "pro",
  "enterprise",
] as const satisfies readonly CompanySubscriptionType[];

export function isCompanySubscriptionType(
  value: unknown
): value is CompanySubscriptionType {
  return COMPANY_SUBSCRIPTION_TYPES.includes(value as CompanySubscriptionType);
}
export type CompanyLimitedChannelType =
  | "canva"
  | "email"
  | "elevenlabs"
  | "google_calendar"
  | "higgsfield"
  | "instagram"
  | "intercom"
  | "meta_ads"
  | "teams"
  | "telegram"
  | "web_widget"
  | "whatsapp";

export type CompanyConversationLimitSnapshot = {
  companyId: string;
  workspaceIds: string[];
  subscriptionType: CompanySubscriptionType;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  trialExpired: boolean;
  conversationLimit: number | null;
  conversationCount: number;
  conversationsRemaining: number | null;
  conversationExhausted: boolean;
  visibleConversationLimit: number | null;
  visibleConversationCount: number;
  hiddenConversationCount: number;
  workspaceLimit: number | null;
  workspaceCount: number;
  workspacesRemaining: number | null;
  workspaceExhausted: boolean;
  seatLimit: number | null;
  seatCount: number;
  seatsRemaining: number | null;
  seatExhausted: boolean;
  channelLimit: number | null;
  channelCount: number;
  channelTypes: CompanyLimitedChannelType[];
  channelsRemaining: number | null;
  channelExhausted: boolean;
  whatsappNumberLimit: number | null;
  whatsappNumberCount: number;
  whatsappNumbersRemaining: number | null;
  whatsappNumberExhausted: boolean;
  integrationConnectionLimit: number | null;
  integrationConnectionCounts: Partial<
    Record<CompanyLimitedChannelType, number>
  >;
  integrationConnectionExhausted: boolean;
  airiAutoReplyLimit: number | null;
  airiAutoReplyCount: number;
  airiAutoRepliesRemaining: number | null;
  airiAutoReplyExhausted: boolean;
  scenarioLimit: number | null;
  scenarioCount: number;
  scenariosRemaining: number | null;
  scenarioExhausted: boolean;
  /** Free plans' bulk campaign recipients in total; null when unlimited. */
  bulkRecipientLimit: number | null;
  /** Recipients used so far; null when the caller did not read usage. */
  bulkRecipientCount: number | null;
  bulkRecipientsRemaining: number | null;
  bulkRecipientExhausted: boolean;
  classificationLimit: number | null;
  classificationCount: number;
  classificationsRemaining: number | null;
  classificationExhausted: boolean;
  coachLimit: number | null;
  coachCount: number;
  coachSessionsRemaining: number | null;
  coachExhausted: boolean;
  studioChatLimit: number | null;
  studioChatCount: number;
  studioChatsRemaining: number | null;
  studioChatExhausted: boolean;
  exhausted: boolean;
  anyLimitExhausted: boolean;
  lockedCapabilities: CompanyLockedCapability[];
};

export type CompanyConversationCapacityResult =
  | { allowed: true; limit: CompanyConversationLimitSnapshot }
  | { allowed: false; limit: CompanyConversationLimitSnapshot };

export type CompanyConversationVisibilityGate = {
  limit: CompanyConversationLimitSnapshot;
  visibleConversationIds: string[] | null;
  hiddenConversationCount: number;
  reason: "trial_expired" | "conversation_limit" | null;
};

function isCompanyBaseProcessingExhausted(
  limit: CompanyConversationLimitSnapshot
): boolean {
  return limit.trialExpired || limit.conversationExhausted;
}

type JoinedCompany =
  | {
      subscription_type?: string | null;
      trial_starts_at?: string | null;
      trial_ends_at?: string | null;
      conversation_limit?: number | null;
      workspace_limit?: number | null;
      seat_limit?: number | null;
      channel_limit?: number | null;
      whatsapp_number_limit?: number | null;
      integration_connection_limit?: number | null;
      scenario_limit?: number | null;
    }
  | Array<{
      subscription_type?: string | null;
      trial_starts_at?: string | null;
      trial_ends_at?: string | null;
      conversation_limit?: number | null;
      workspace_limit?: number | null;
      seat_limit?: number | null;
      channel_limit?: number | null;
      whatsapp_number_limit?: number | null;
      integration_connection_limit?: number | null;
      scenario_limit?: number | null;
    }>
  | null
  | undefined;

export type CompanyLimitCompanyConfig = {
  subscription_type?: string | null;
  trial_starts_at?: string | null;
  trial_ends_at?: string | null;
  conversation_limit?: number | null;
  workspace_limit?: number | null;
  seat_limit?: number | null;
  channel_limit?: number | null;
  whatsapp_number_limit?: number | null;
  integration_connection_limit?: number | null;
  scenario_limit?: number | null;
};

const DEFAULT_FREE_CONVERSATION_LIMIT = 500;
const DEFAULT_FREE_WORKSPACE_LIMIT = 1;
const DEFAULT_FREE_SEAT_LIMIT = 1;
const DEFAULT_FREE_CHANNEL_LIMIT = 2;
const DEFAULT_FREE_WHATSAPP_NUMBER_LIMIT = 1;
const DEFAULT_FREE_INTEGRATION_CONNECTION_LIMIT = 1;
const DEFAULT_FREE_AIRI_AUTO_REPLY_LIMIT = 100;
const DEFAULT_FREE_CLASSIFICATION_LIMIT = 500;
const DEFAULT_FREE_COACH_LIMIT = 500;
const DEFAULT_FREE_STUDIO_CHAT_LIMIT = 500;
const DEFAULT_FREE_SCENARIO_LIMIT = 5;
const DEFAULT_FREE_BULK_RECIPIENT_LIMIT = 500;
const DEFAULT_PRO_WORKSPACE_LIMIT = 1;
const DEFAULT_PRO_SEAT_LIMIT = 1;
const DEFAULT_PRO_WHATSAPP_NUMBER_LIMIT = 1;
const DEFAULT_PRO_INTEGRATION_CONNECTION_LIMIT = 1;
const DEFAULT_PRO_SCENARIO_LIMIT = 50;
const ENTERPRISE_AI_USAGE_MULTIPLIER = 20;

const LIMITED_CHANNEL_TYPES = new Set<CompanyLimitedChannelType>([
  "canva",
  "email",
  "elevenlabs",
  "google_calendar",
  "higgsfield",
  "instagram",
  "intercom",
  "meta_ads",
  "teams",
  "telegram",
  "web_widget",
  "whatsapp",
]);

function normalizeSubscriptionType(value: unknown): CompanySubscriptionType {
  return isCompanySubscriptionType(value) ? value : "free";
}

function normalizeOptionalLimit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function calculateRemaining(
  limit: number | null,
  count: number
): number | null {
  if (limit === null) return null;
  return Math.max(0, limit - count);
}

function isLimitExhausted(limit: number | null, count: number): boolean {
  return limit !== null && count >= limit;
}

function resolveTierLimit(
  subscriptionType: CompanySubscriptionType,
  freeLimit: number
): number | null {
  if (subscriptionType === "enterprise") {
    return freeLimit * ENTERPRISE_AI_USAGE_MULTIPLIER;
  }
  if (subscriptionType === "pro") {
    // Pro inference uses the atomic company/month allowance. These legacy
    // lifetime counters remain useful reporting, but cannot gate paid BYOK.
    return null;
  }
  return freeLimit;
}

function resolveAiriAutoReplyLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  return resolveTierLimit(subscriptionType, DEFAULT_FREE_AIRI_AUTO_REPLY_LIMIT);
}

function resolveClassificationLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  return resolveTierLimit(subscriptionType, DEFAULT_FREE_CLASSIFICATION_LIMIT);
}

function resolveCoachLimit(subscriptionType: CompanySubscriptionType): number | null {
  return resolveTierLimit(subscriptionType, DEFAULT_FREE_COACH_LIMIT);
}

function resolveStudioChatLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  return resolveTierLimit(subscriptionType, DEFAULT_FREE_STUDIO_CHAT_LIMIT);
}

function normalizeLimitedChannelType(
  value: unknown
): CompanyLimitedChannelType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as CompanyLimitedChannelType;
  return LIMITED_CHANNEL_TYPES.has(normalized) ? normalized : null;
}

function normalizeLimitIsoString(value: unknown): string | null {
  const parsed = readDate(value);
  return parsed ? parsed.toISOString() : null;
}

function isTrialExpired(
  subscriptionType: CompanySubscriptionType,
  trialEndsAt: unknown
): boolean {
  const endsAt = readDate(trialEndsAt);
  if (subscriptionType !== "free" || !endsAt) return false;
  return endsAt.getTime() <= Date.now();
}

function resolveConversationLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  return subscriptionType === "free" ? DEFAULT_FREE_CONVERSATION_LIMIT : null;
}

function resolveWorkspaceLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  if (subscriptionType === "enterprise") return null;
  if (subscriptionType === "pro") return DEFAULT_PRO_WORKSPACE_LIMIT;
  return DEFAULT_FREE_WORKSPACE_LIMIT;
}

/** Each WhatsApp number lives in its own workspace, so a raised number limit also raises this. */
function resolveCompanyWorkspaceLimit(
  subscriptionType: CompanySubscriptionType,
  configuredWorkspaceLimit: unknown,
  whatsappNumberLimit: number | null
): number | null {
  if (subscriptionType === "enterprise") return null;
  const workspaceLimit =
    normalizeOptionalLimit(configuredWorkspaceLimit) ??
    resolveWorkspaceLimit(subscriptionType);
  if (workspaceLimit === null || whatsappNumberLimit === null) {
    return workspaceLimit;
  }
  return Math.max(workspaceLimit, whatsappNumberLimit);
}

function resolveSeatLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  if (subscriptionType === "enterprise") return null;
  if (subscriptionType === "pro") return DEFAULT_PRO_SEAT_LIMIT;
  return DEFAULT_FREE_SEAT_LIMIT;
}

function resolveCompanySeatLimit(
  subscriptionType: CompanySubscriptionType,
  configuredSeatLimit: unknown
): number | null {
  if (subscriptionType === "enterprise") return null;
  return (
    normalizeOptionalLimit(configuredSeatLimit) ??
    resolveSeatLimit(subscriptionType)
  );
}

function resolveChannelLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  return subscriptionType === "free" ? DEFAULT_FREE_CHANNEL_LIMIT : null;
}

function resolveWhatsappNumberLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  if (subscriptionType === "enterprise") return null;
  if (subscriptionType === "pro") return DEFAULT_PRO_WHATSAPP_NUMBER_LIMIT;
  return DEFAULT_FREE_WHATSAPP_NUMBER_LIMIT;
}

function resolveCompanyWhatsappNumberLimit(
  subscriptionType: CompanySubscriptionType,
  configuredWhatsappNumberLimit: unknown
): number | null {
  if (subscriptionType === "enterprise") return null;
  return (
    normalizeOptionalLimit(configuredWhatsappNumberLimit) ??
    resolveWhatsappNumberLimit(subscriptionType)
  );
}

function resolveIntegrationConnectionLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  if (subscriptionType === "enterprise") return null;
  if (subscriptionType === "pro")
    return DEFAULT_PRO_INTEGRATION_CONNECTION_LIMIT;
  return DEFAULT_FREE_INTEGRATION_CONNECTION_LIMIT;
}

function resolveScenarioLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  if (subscriptionType === "enterprise") return null;
  if (subscriptionType === "pro") return DEFAULT_PRO_SCENARIO_LIMIT;
  return DEFAULT_FREE_SCENARIO_LIMIT;
}

function resolveBulkRecipientLimit(
  subscriptionType: CompanySubscriptionType
): number | null {
  return subscriptionType === "free" ? DEFAULT_FREE_BULK_RECIPIENT_LIMIT : null;
}

function getVisibleConversationLimitForSnapshot(params: {
  trialExpired: boolean;
  conversationLimit: number | null;
}): number | null {
  if (params.trialExpired) return 0;
  return params.conversationLimit;
}

async function repairMissingCompanyUsageSnapshot(
  supabase: SupabaseClient,
  companyId: string
) {
  const { repairCompanyUsageSnapshot } = await import("./company-usage-repair");
  return repairCompanyUsageSnapshot(supabase, companyId);
}

export function toPublicLimitPayload(limit: CompanyConversationLimitSnapshot) {
  return {
    subscriptionType: limit.subscriptionType,
    trialStartsAt: limit.trialStartsAt,
    trialEndsAt: limit.trialEndsAt,
    trialExpired: limit.trialExpired,
    conversationLimit: limit.conversationLimit,
    conversationCount: limit.conversationCount,
    conversationsRemaining: limit.conversationsRemaining,
    conversationExhausted: limit.conversationExhausted,
    visibleConversationLimit: limit.visibleConversationLimit,
    visibleConversationCount: limit.visibleConversationCount,
    hiddenConversationCount: limit.hiddenConversationCount,
    workspaceLimit: limit.workspaceLimit,
    workspaceCount: limit.workspaceCount,
    workspacesRemaining: limit.workspacesRemaining,
    workspaceExhausted: limit.workspaceExhausted,
    seatLimit: limit.seatLimit,
    seatCount: limit.seatCount,
    seatsRemaining: limit.seatsRemaining,
    seatExhausted: limit.seatExhausted,
    channelLimit: limit.channelLimit,
    channelCount: limit.channelCount,
    channelTypes: limit.channelTypes,
    channelsRemaining: limit.channelsRemaining,
    channelExhausted: limit.channelExhausted,
    whatsappNumberLimit: limit.whatsappNumberLimit,
    whatsappNumberCount: limit.whatsappNumberCount,
    whatsappNumbersRemaining: limit.whatsappNumbersRemaining,
    whatsappNumberExhausted: limit.whatsappNumberExhausted,
    integrationConnectionLimit: limit.integrationConnectionLimit,
    integrationConnectionCounts: limit.integrationConnectionCounts,
    integrationConnectionExhausted: limit.integrationConnectionExhausted,
    airiAutoReplyLimit: limit.airiAutoReplyLimit,
    airiAutoReplyCount: limit.airiAutoReplyCount,
    airiAutoRepliesRemaining: limit.airiAutoRepliesRemaining,
    airiAutoReplyExhausted: limit.airiAutoReplyExhausted,
    scenarioLimit: limit.scenarioLimit,
    scenarioCount: limit.scenarioCount,
    scenariosRemaining: limit.scenariosRemaining,
    scenarioExhausted: limit.scenarioExhausted,
    bulkRecipientLimit: limit.bulkRecipientLimit,
    bulkRecipientCount: limit.bulkRecipientCount,
    bulkRecipientsRemaining: limit.bulkRecipientsRemaining,
    bulkRecipientExhausted: limit.bulkRecipientExhausted,
    classificationLimit: limit.classificationLimit,
    classificationCount: limit.classificationCount,
    classificationsRemaining: limit.classificationsRemaining,
    classificationExhausted: limit.classificationExhausted,
    coachLimit: limit.coachLimit,
    coachCount: limit.coachCount,
    coachSessionsRemaining: limit.coachSessionsRemaining,
    coachExhausted: limit.coachExhausted,
    studioChatLimit: limit.studioChatLimit,
    studioChatCount: limit.studioChatCount,
    studioChatsRemaining: limit.studioChatsRemaining,
    studioChatExhausted: limit.studioChatExhausted,
    exhausted: limit.exhausted,
    anyLimitExhausted: limit.anyLimitExhausted,
    lockedCapabilities: limit.lockedCapabilities,
  };
}

export function buildCompanyConversationLimitSnapshotFromUsage(params: {
  companyId: string;
  company: CompanyLimitCompanyConfig | null | undefined;
  usage: CompanyUsageSnapshotCounts;
  workspaceIds: string[];
  minimumWorkspaceCount?: number;
  /** From readCompanyBulkRecipientUsage; omit when the caller doesn't need it. */
  bulkRecipientCount?: number | null;
}): CompanyConversationLimitSnapshot {
  const { company, usage } = params;
  const subscriptionType = normalizeSubscriptionType(
    company?.subscription_type
  );
  const trialStartsAt = normalizeLimitIsoString(company?.trial_starts_at);
  const trialEndsAt = normalizeLimitIsoString(company?.trial_ends_at);
  const trialExpired = isTrialExpired(subscriptionType, company?.trial_ends_at);
  const conversationLimit = resolveConversationLimit(subscriptionType);
  const whatsappNumberLimit = resolveCompanyWhatsappNumberLimit(
    subscriptionType,
    company?.whatsapp_number_limit
  );
  const workspaceLimit = resolveCompanyWorkspaceLimit(
    subscriptionType,
    company?.workspace_limit,
    whatsappNumberLimit
  );
  const seatLimit = resolveCompanySeatLimit(
    subscriptionType,
    company?.seat_limit
  );
  const channelLimit = resolveChannelLimit(subscriptionType);
  const integrationConnectionLimit =
    resolveIntegrationConnectionLimit(subscriptionType);
  const airiAutoReplyLimit = resolveAiriAutoReplyLimit(subscriptionType);
  const classificationLimit = resolveClassificationLimit(subscriptionType);
  const coachLimit = resolveCoachLimit(subscriptionType);
  const studioChatLimit = resolveStudioChatLimit(subscriptionType);
  const scenarioLimit = resolveScenarioLimit(subscriptionType);
  const bulkRecipientLimit = resolveBulkRecipientLimit(subscriptionType);

  const conversationCount = usage.conversationCount;
  const airiAutoReplyCount = usage.airiAutoReplyCount;
  const scenarioCount = usage.scenarioCount;
  const seatCount = usage.seatCount;
  const bulkRecipientCount =
    bulkRecipientLimit === null ? null : (params.bulkRecipientCount ?? null);
  const classificationCount = usage.classificationCount;
  const coachCount = usage.coachCount;
  const studioChatCount = usage.studioChatCount;
  const workspaceCount = Math.max(
    usage.workspaceCount,
    params.minimumWorkspaceCount ?? 0
  );
  const workspaceExhausted = isLimitExhausted(workspaceLimit, workspaceCount);
  const channelTypes = normalizeSnapshotChannelTypes(usage);
  const channelCount = channelTypes.length;
  const integrationConnectionCounts =
    normalizeSnapshotIntegrationConnectionCounts(usage);
  const conversationExhausted = isLimitExhausted(
    conversationLimit,
    conversationCount
  );
  const visibleConversationLimit = getVisibleConversationLimitForSnapshot({
    trialExpired,
    conversationLimit,
  });
  const visibleConversationCount =
    visibleConversationLimit === null
      ? conversationCount
      : Math.min(conversationCount, visibleConversationLimit);
  const hiddenConversationCount = Math.max(
    0,
    conversationCount - visibleConversationCount
  );
  const seatExhausted = isLimitExhausted(seatLimit, seatCount);
  const channelExhausted = isLimitExhausted(channelLimit, channelCount);
  const whatsappNumberExhausted = isLimitExhausted(
    whatsappNumberLimit,
    usage.whatsappNumberCount
  );
  const integrationConnectionExhausted = isLimitExhausted(
    integrationConnectionLimit,
    maxPerTypeIntegrationConnectionCount(integrationConnectionCounts)
  );
  const airiAutoReplyExhausted = isLimitExhausted(
    airiAutoReplyLimit,
    airiAutoReplyCount
  );
  const classificationExhausted = isLimitExhausted(
    classificationLimit,
    classificationCount
  );
  const coachExhausted = isLimitExhausted(coachLimit, coachCount);
  const studioChatExhausted = isLimitExhausted(
    studioChatLimit,
    studioChatCount
  );
  const scenarioExhausted = isLimitExhausted(scenarioLimit, scenarioCount);
  const bulkRecipientExhausted =
    bulkRecipientCount !== null &&
    isLimitExhausted(bulkRecipientLimit, bulkRecipientCount);

  const lockedCapabilities = new Set<CompanyLockedCapability>();
  if (trialExpired) {
    for (const capability of COMPANY_LIMITED_CAPABILITIES) {
      lockedCapabilities.add(capability);
    }
  }
  if (conversationExhausted) {
    lockedCapabilities.add("new_conversations");
  }
  if (workspaceExhausted) {
    lockedCapabilities.add("workspace_creation");
  }
  if (seatExhausted) {
    lockedCapabilities.add("team_invites");
  }
  if (channelExhausted) {
    lockedCapabilities.add("channel_connections");
  }
  if (whatsappNumberExhausted) {
    lockedCapabilities.add("whatsapp_number_connections");
  }
  if (integrationConnectionExhausted) {
    lockedCapabilities.add("integration_connections");
  }
  if (airiAutoReplyExhausted) {
    lockedCapabilities.add("airi_auto_replies");
  }
  if (classificationExhausted) {
    lockedCapabilities.add("classifications");
  }
  if (coachExhausted) {
    lockedCapabilities.add("coach");
  }
  if (studioChatExhausted) {
    lockedCapabilities.add("studio_chats");
  }
  if (scenarioExhausted) {
    lockedCapabilities.add("scenario_creation");
  }
  if (bulkRecipientExhausted) {
    lockedCapabilities.add("bulk_campaigns");
  }

  return {
    companyId: params.companyId,
    workspaceIds: params.workspaceIds,
    subscriptionType,
    trialStartsAt,
    trialEndsAt,
    trialExpired,
    conversationLimit,
    conversationCount,
    conversationsRemaining: calculateRemaining(
      conversationLimit,
      conversationCount
    ),
    conversationExhausted,
    visibleConversationLimit,
    visibleConversationCount,
    hiddenConversationCount,
    workspaceLimit,
    workspaceCount,
    workspacesRemaining: calculateRemaining(workspaceLimit, workspaceCount),
    workspaceExhausted,
    seatLimit,
    seatCount,
    seatsRemaining: calculateRemaining(seatLimit, seatCount),
    seatExhausted,
    channelLimit,
    channelCount,
    channelTypes,
    channelsRemaining: calculateRemaining(channelLimit, channelCount),
    channelExhausted,
    whatsappNumberLimit,
    whatsappNumberCount: usage.whatsappNumberCount,
    whatsappNumbersRemaining: calculateRemaining(
      whatsappNumberLimit,
      usage.whatsappNumberCount
    ),
    whatsappNumberExhausted,
    integrationConnectionLimit,
    integrationConnectionCounts,
    integrationConnectionExhausted,
    airiAutoReplyLimit,
    airiAutoReplyCount,
    airiAutoRepliesRemaining: calculateRemaining(
      airiAutoReplyLimit,
      airiAutoReplyCount
    ),
    airiAutoReplyExhausted,
    classificationLimit,
    classificationCount,
    classificationsRemaining: calculateRemaining(
      classificationLimit,
      classificationCount
    ),
    classificationExhausted,
    coachLimit,
    coachCount,
    coachSessionsRemaining: calculateRemaining(coachLimit, coachCount),
    coachExhausted,
    studioChatLimit,
    studioChatCount,
    studioChatsRemaining: calculateRemaining(
      studioChatLimit,
      studioChatCount
    ),
    studioChatExhausted,
    scenarioLimit,
    scenarioCount,
    scenariosRemaining: calculateRemaining(scenarioLimit, scenarioCount),
    scenarioExhausted,
    bulkRecipientLimit,
    bulkRecipientCount,
    bulkRecipientsRemaining:
      bulkRecipientCount === null
        ? null
        : calculateRemaining(bulkRecipientLimit, bulkRecipientCount),
    bulkRecipientExhausted,
    exhausted: trialExpired || conversationExhausted,
    anyLimitExhausted:
      trialExpired ||
      conversationExhausted ||
      workspaceExhausted ||
      seatExhausted ||
      channelExhausted ||
      whatsappNumberExhausted ||
      integrationConnectionExhausted ||
      airiAutoReplyExhausted ||
      classificationExhausted ||
      coachExhausted ||
      studioChatExhausted ||
      scenarioExhausted ||
      bulkRecipientExhausted,
    lockedCapabilities: Array.from(lockedCapabilities),
  };
}

function buildCompanyLimitExceededBodyForCode(params: {
  code: string;
  error: string;
  limit: CompanyConversationLimitSnapshot;
}) {
  return {
    code: params.code,
    error: params.error,
    limit: toPublicLimitPayload(params.limit),
  };
}

export function buildCompanyLimitExceededBody(
  limit: CompanyConversationLimitSnapshot
) {
  return buildCompanyLimitExceededBodyForCode({
    code: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
    error:
      "Company conversation limit exceeded. Upgrade to Pro to create more conversations, scenarios, or bulk campaigns.",
    limit,
  });
}

export function buildCompanyLimitExceededResponse(
  limit: CompanyConversationLimitSnapshot
) {
  return NextResponse.json(buildCompanyLimitExceededBody(limit), {
    status: 402,
  });
}

export function buildCompanyConversationVisibilityExceededResponse(
  gate: CompanyConversationVisibilityGate
) {
  return NextResponse.json(
    {
      ...buildCompanyLimitExceededBody(gate.limit),
      planGate: {
        hiddenCount: gate.hiddenConversationCount,
        reason: gate.reason ?? "conversation_limit",
      },
    },
    { status: 402 }
  );
}

export function buildCompanySeatLimitExceededResponse(
  limit: CompanyConversationLimitSnapshot
) {
  return NextResponse.json(
    buildCompanyLimitExceededBodyForCode({
      code: COMPANY_SEAT_LIMIT_EXCEEDED_CODE,
      error:
        "Company seat limit exceeded. Upgrade to Pro to invite more teammates.",
      limit,
    }),
    { status: 402 }
  );
}

export function buildCompanyChannelLimitExceededResponse(
  limit: CompanyConversationLimitSnapshot
) {
  return NextResponse.json(
    buildCompanyLimitExceededBodyForCode({
      code: COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
      error:
        "Company channel limit exceeded. Upgrade to Pro to connect more channels.",
      limit,
    }),
    { status: 402 }
  );
}

export function buildCompanyWorkspaceLimitExceededResponse(
  limit: CompanyConversationLimitSnapshot
) {
  return NextResponse.json(
    buildCompanyLimitExceededBodyForCode({
      code: COMPANY_WORKSPACE_LIMIT_EXCEEDED_CODE,
      error:
        "Company workspace limit exceeded. Upgrade to Enterprise to create more workspaces.",
      limit,
    }),
    { status: 402 }
  );
}

export function buildCompanyScenarioLimitExceededResponse(
  limit: CompanyConversationLimitSnapshot
) {
  return NextResponse.json(
    buildCompanyLimitExceededBodyForCode({
      code: COMPANY_SCENARIO_LIMIT_EXCEEDED_CODE,
      error:
        "Company scenario limit exceeded. Upgrade to Pro to create more scenarios.",
      limit,
    }),
    { status: 402 }
  );
}

export const COMPANY_BULK_RECIPIENT_LIMIT_EXCEEDED_ERROR =
  "Company bulk recipient allowance used. Upgrade to Pro to send more bulk campaigns.";

export function buildCompanyBulkRecipientLimitExceededResponse(
  limit: CompanyConversationLimitSnapshot
) {
  return NextResponse.json(
    buildCompanyLimitExceededBodyForCode({
      code: COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
      error: COMPANY_BULK_RECIPIENT_LIMIT_EXCEEDED_ERROR,
      limit,
    }),
    { status: 402 }
  );
}

export function buildCompanyStudioChatLimitExceededResponse(
  limit: CompanyConversationLimitSnapshot
) {
  return NextResponse.json(
    buildCompanyLimitExceededBodyForCode({
      code: COMPANY_STUDIO_CHAT_LIMIT_EXCEEDED_CODE,
      error:
        "Airi Creative Studio chat limit exceeded. Upgrade to Pro for more studio chats.",
      limit,
    }),
    { status: 402 }
  );
}

export function isCompanyConversationLimitExceeded(
  error: unknown
): error is CompanyConversationLimitExceededError {
  return (
    error instanceof CompanyConversationLimitExceededError ||
    (Boolean(error) &&
      typeof error === "object" &&
      (error as { code?: unknown }).code ===
        COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE)
  );
}

export function isCompanyAiriAutoReplyLimitExceeded(
  error: unknown
): error is CompanyAiriAutoReplyLimitExceededError {
  return (
    error instanceof CompanyAiriAutoReplyLimitExceededError ||
    (Boolean(error) &&
      typeof error === "object" &&
      (error as { code?: unknown }).code ===
        COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE)
  );
}

export class CompanyConversationLimitExceededError extends Error {
  readonly code = COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE;
  readonly limit: CompanyConversationLimitSnapshot;

  constructor(limit: CompanyConversationLimitSnapshot) {
    super("Company conversation limit exceeded");
    this.name = "CompanyConversationLimitExceededError";
    this.limit = limit;
  }
}

export class CompanyAiriAutoReplyLimitExceededError extends Error {
  readonly code = COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE;
  readonly limit: CompanyConversationLimitSnapshot;

  constructor(limit: CompanyConversationLimitSnapshot) {
    super("Company Airi auto-reply limit exceeded");
    this.name = "CompanyAiriAutoReplyLimitExceededError";
    this.limit = limit;
  }
}

async function isCompanySeatUserAlreadyCounted(
  supabase: SupabaseClient,
  workspaceIds: string[],
  userId: string
): Promise<boolean> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return false;

  const { data, error } = await supabase
    .from("company_users")
    .select("id")
    .in("workspace_id", workspaceIds)
    .eq("user_id", normalizedUserId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

export async function recordCreativeStudioChat(
  workspaceId: string,
  source: CreativeStudioChatSource
): Promise<void> {
  await connectDB();
  const chat = await CreativeStudioChat.create({ workspaceId, source });
  emitWorkspaceUsageDeltaBestEffort(
    {
      workspaceId,
      metric: "studio_chat_count",
      delta: 1,
      objectId: String(chat._id),
      source: "creative_studio_chat",
      metadata: {
        source,
      },
    },
    { logContext: "recordCreativeStudioChat" }
  );
}

async function getCompanyWorkspaceIds(
  supabase: SupabaseClient,
  companyId: string,
  fallbackWorkspaceId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .eq("company_id", companyId);

  if (error) {
    throw new Error(error.message);
  }

  const workspaceIds = (data ?? [])
    .map((row: { id?: string | null }) => row.id)
    .filter((id): id is string => Boolean(id));
  return workspaceIds.length > 0 ? workspaceIds : [fallbackWorkspaceId];
}

function normalizeSnapshotChannelTypes(
  usage: CompanyUsageSnapshotCounts
): CompanyLimitedChannelType[] {
  const channelTypes = new Set<CompanyLimitedChannelType>();
  for (const rawType of usage.channelTypes) {
    const channelType = normalizeLimitedChannelType(rawType);
    if (channelType) channelTypes.add(channelType);
  }
  for (const [rawType, count] of Object.entries(
    usage.integrationConnectionCounts
  )) {
    const channelType = normalizeLimitedChannelType(rawType);
    if (channelType && count > 0) channelTypes.add(channelType);
  }
  return Array.from(channelTypes).sort();
}

function normalizeSnapshotIntegrationConnectionCounts(
  usage: CompanyUsageSnapshotCounts
): Partial<Record<CompanyLimitedChannelType, number>> {
  const counts: Partial<Record<CompanyLimitedChannelType, number>> = {};
  for (const [rawType, count] of Object.entries(
    usage.integrationConnectionCounts
  )) {
    const channelType = normalizeLimitedChannelType(rawType);
    if (channelType && count > 0) {
      counts[channelType] = Math.floor(count);
    }
  }
  return counts;
}

/** WhatsApp numbers have their own limit, so they don't fill the per-type one. */
function maxPerTypeIntegrationConnectionCount(
  counts: Partial<Record<CompanyLimitedChannelType, number>>
): number {
  return Math.max(
    0,
    ...Object.entries(counts)
      .filter(([type]) => type !== "whatsapp")
      .map(([, count]) => count ?? 0)
  );
}

/**
 * Bulk campaign recipients each company has used, from the same SQL count
 * admission enforces. Needs the service-role client.
 */
export async function readCompanyBulkRecipientUsage(
  supabase: SupabaseClient,
  companyIds: readonly string[]
): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  const ids = Array.from(new Set(companyIds.filter(Boolean)));
  if (ids.length === 0) return usage;
  const { data, error } = await supabase.rpc(
    "get_company_bulk_recipient_usage",
    { p_company_ids: ids }
  );
  if (error) {
    throw new Error(
      error.message || "Company bulk recipient usage could not be read"
    );
  }
  for (const row of Array.isArray(data) ? data : []) {
    const companyId = (row as { company_id?: unknown }).company_id;
    const used = Number((row as { used_recipients?: unknown }).used_recipients);
    if (typeof companyId === "string" && Number.isSafeInteger(used)) {
      usage.set(companyId, Math.max(0, used));
    }
  }
  if (ids.some(id => !usage.has(id))) {
    throw new Error("Company bulk recipient usage is incomplete");
  }
  return usage;
}

async function countCompanyWhatsAppNumbers(
  supabase: SupabaseClient,
  workspaceIds: string[]
): Promise<number> {
  const { count, error } = await supabase
    .from("sources")
    .select("id", { count: "exact", head: true })
    .eq("type", "whatsapp")
    .in("workspace_id", workspaceIds);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** The usage snapshot with its workspace and WhatsApp counts read live. */
function withLiveCompanyUsageCounts(
  usage: CompanyUsageSnapshotCounts,
  live: { workspaceCount: number; whatsappNumberCount: number }
): CompanyUsageSnapshotCounts {
  const hasWhatsapp = live.whatsappNumberCount > 0;
  const integrationConnectionCounts = Object.fromEntries(
    Object.entries(usage.integrationConnectionCounts).filter(
      ([type]) => type !== "whatsapp"
    )
  );
  if (hasWhatsapp) {
    integrationConnectionCounts.whatsapp = live.whatsappNumberCount;
  }
  return {
    ...usage,
    workspaceCount: live.workspaceCount,
    whatsappNumberCount: live.whatsappNumberCount,
    channelTypes: [
      ...usage.channelTypes.filter(type => type !== "whatsapp"),
      ...(hasWhatsapp ? ["whatsapp"] : []),
    ],
    integrationConnectionCounts,
  };
}

export async function getCompanyConversationLimitSnapshot(
  supabase: SupabaseClient,
  workspaceId: string,
  options: {
    includeWorkspaceIds?: boolean;
    /** Reads the free bulk recipient usage (bulkRecipientCount stays null otherwise). */
    includeBulkRecipientUsage?: boolean;
    /**
     * Counts workspaces and WhatsApp numbers from their tables; the usage
     * snapshot only catches up in the daily repair. Needs the service-role
     * client, which sees every workspace in the company.
     */
    liveCounts?: boolean;
  } = {}
): Promise<CompanyConversationLimitSnapshot> {
  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select(
      "id, company_id, companies!workspaces_company_id_fkey(subscription_type, trial_starts_at, trial_ends_at, conversation_limit, workspace_limit, seat_limit, channel_limit, whatsapp_number_limit, integration_connection_limit, scenario_limit)"
    )
    .eq("id", workspaceId)
    .maybeSingle();

  if (workspaceError || !workspace?.company_id) {
    throw new Error(
      workspaceError?.message || "Workspace company could not be resolved"
    );
  }

  const company = firstOrSelf(
    (workspace as { companies?: JoinedCompany }).companies
  );

  const readsBulkRecipientUsage =
    options.includeBulkRecipientUsage === true &&
    resolveBulkRecipientLimit(
      normalizeSubscriptionType(company?.subscription_type)
    ) !== null;
  const readsWorkspaceIds = Boolean(
    options.includeWorkspaceIds || options.liveCounts
  );
  const workspaceIdsPromise = readsWorkspaceIds
    ? getCompanyWorkspaceIds(supabase, workspace.company_id, workspaceId)
    : Promise.resolve([workspaceId]);
  const [
    usage,
    scopedWorkspaceIds,
    liveWhatsappNumberCount,
    bulkRecipientUsage,
  ] = await Promise.all([
    readCompanyUsageSnapshot(supabase, workspace.company_id, {
      minimumWorkspaceCount: 1,
      repairMissingSnapshot: companyId =>
        repairMissingCompanyUsageSnapshot(supabase, companyId),
    }),
    workspaceIdsPromise,
    options.liveCounts
      ? workspaceIdsPromise.then(ids =>
          countCompanyWhatsAppNumbers(supabase, ids)
        )
      : Promise.resolve(null),
    readsBulkRecipientUsage
      ? readCompanyBulkRecipientUsage(supabase, [workspace.company_id])
      : Promise.resolve(null),
  ]);

  return buildCompanyConversationLimitSnapshotFromUsage({
    companyId: workspace.company_id,
    company,
    usage:
      liveWhatsappNumberCount === null
        ? usage
        : withLiveCompanyUsageCounts(usage, {
            workspaceCount: scopedWorkspaceIds.length,
            whatsappNumberCount: liveWhatsappNumberCount,
          }),
    workspaceIds: scopedWorkspaceIds,
    minimumWorkspaceCount: readsWorkspaceIds ? scopedWorkspaceIds.length : 1,
    bulkRecipientCount: bulkRecipientUsage?.get(workspace.company_id) ?? null,
  });
}

const COMPANY_CONVERSATION_VISIBILITY_GATE_CACHE_TTL_SECONDS = 30;

export async function getCompanyConversationVisibilityGate(
  supabase: SupabaseClient,
  workspaceId: string,
  options?: { useCache?: boolean }
): Promise<CompanyConversationVisibilityGate> {
  const useCache = options?.useCache !== false;
  const cacheKey = buildCacheKey("company_conversation_visibility_gate", [
    workspaceId,
  ]);

  if (useCache) {
    const cached = await cache
      .get<CompanyConversationVisibilityGate>(cacheKey)
      .catch(() => null);
    if (cached) {
      return cached;
    }
  }

  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId,
    { includeWorkspaceIds: true }
  );

  let result: CompanyConversationVisibilityGate;

  if (limit.visibleConversationLimit === null) {
    result = {
      limit,
      visibleConversationIds: null,
      hiddenConversationCount: 0,
      reason: null,
    };
  } else {
    const reason = limit.trialExpired
      ? "trial_expired"
      : limit.hiddenConversationCount > 0
        ? "conversation_limit"
        : null;

    if (limit.visibleConversationLimit <= 0) {
      result = {
        limit,
        visibleConversationIds: [],
        hiddenConversationCount: limit.conversationCount,
        reason,
      };
    } else {
      await connectDB();
      const conversations = await Conversation.find({
        workspaceId: { $in: limit.workspaceIds },
      })
        .sort({ createdAt: 1, _id: 1 })
        .select("_id")
        .limit(limit.visibleConversationLimit)
        .lean();

      result = {
        limit,
        visibleConversationIds: conversations.map(conversation =>
          String(conversation._id)
        ),
        hiddenConversationCount: limit.hiddenConversationCount,
        reason,
      };
    }
  }

  if (useCache) {
    await cache
      .set(cacheKey, result, COMPANY_CONVERSATION_VISIBILITY_GATE_CACHE_TTL_SECONDS)
      .catch(() => undefined);
  }

  return result;
}

export function isConversationVisibleForPlan(
  gate: CompanyConversationVisibilityGate,
  conversationId: string
): boolean {
  if (gate.visibleConversationIds === null) return true;
  return gate.visibleConversationIds.includes(conversationId);
}

export async function getHiddenConversationPlanGateResponse(
  supabase: SupabaseClient,
  workspaceId: string,
  conversationId: string
): Promise<NextResponse | null> {
  const gate = await getCompanyConversationVisibilityGate(
    supabase,
    workspaceId
  );
  return isConversationVisibleForPlan(gate, conversationId)
    ? null
    : buildCompanyConversationVisibilityExceededResponse(gate);
}

export async function ensureCompanyConversationCapacity(
  supabase: SupabaseClient,
  workspaceId: string,
  options: { includeBulkRecipientUsage?: boolean } = {}
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId,
    options
  );
  return limit.trialExpired || limit.conversationExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export type CompanyBulkRecipientAllowance = {
  limit: CompanyConversationLimitSnapshot;
  /** Unique recipients a new send may still reach; null when unlimited. */
  remaining: number | null;
};

/**
 * Unique recipients a new send may still reach; null when unlimited. Usage
 * that was not read counts as nothing left.
 */
export function getBulkRecipientsRemaining(
  limit: Pick<
    CompanyConversationLimitSnapshot,
    "bulkRecipientLimit" | "bulkRecipientsRemaining"
  >
): number | null {
  return limit.bulkRecipientLimit === null
    ? null
    : (limit.bulkRecipientsRemaining ?? 0);
}

/**
 * Reads the bulk recipient allowance fresh, before a send trims its audience.
 * A send with `remaining` 0 is refused; admission checks the same count again
 * under the company lock.
 */
export async function readCompanyBulkRecipientAllowance(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyBulkRecipientAllowance> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId,
    { includeBulkRecipientUsage: true }
  );
  return { limit, remaining: getBulkRecipientsRemaining(limit) };
}

export async function ensureCompanyWorkspaceCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId,
    { liveCounts: true }
  );
  return limit.trialExpired || limit.workspaceExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export async function ensureCompanySeatCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId
  );
  return limit.trialExpired || limit.seatExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export async function ensureCompanySeatCapacityForUser(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId,
    { includeWorkspaceIds: true }
  );
  if (limit.trialExpired) {
    return { allowed: false, limit };
  }
  if (!limit.seatExhausted) {
    return { allowed: true, limit };
  }

  const alreadyCounted = await isCompanySeatUserAlreadyCounted(
    supabase,
    limit.workspaceIds,
    userId
  );

  return alreadyCounted ? { allowed: true, limit } : { allowed: false, limit };
}

export async function ensureCompanyChannelCapacity(
  supabase: SupabaseClient,
  workspaceId: string,
  requestedChannelType: string
): Promise<CompanyConversationCapacityResult> {
  const channelType = normalizeLimitedChannelType(requestedChannelType);
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId,
    { liveCounts: channelType === "whatsapp" }
  );
  const verdict = evaluateChannelCapacity(limit, channelType);
  return { allowed: verdict.allowed, limit };
}

export async function ensureCompanyAiriAutoReplyCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId
  );
  return isCompanyBaseProcessingExhausted(limit) || limit.airiAutoReplyExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export async function ensureCompanyClassificationCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId
  );
  return isCompanyBaseProcessingExhausted(limit) ||
    limit.classificationExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export async function ensureCompanyCoachCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId
  );
  return isCompanyBaseProcessingExhausted(limit) || limit.coachExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export async function ensureCompanyStudioChatCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId
  );
  return isCompanyBaseProcessingExhausted(limit) || limit.studioChatExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export async function ensureCompanyScenarioCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationCapacityResult> {
  const limit = await getCompanyConversationLimitSnapshot(
    supabase,
    workspaceId
  );
  return isCompanyBaseProcessingExhausted(limit) || limit.scenarioExhausted
    ? { allowed: false, limit }
    : { allowed: true, limit };
}

export async function assertCompanyConversationCapacity(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CompanyConversationLimitSnapshot> {
  const result = await ensureCompanyConversationCapacity(supabase, workspaceId);
  if (!result.allowed) {
    throw new CompanyConversationLimitExceededError(result.limit);
  }
  return result.limit;
}
