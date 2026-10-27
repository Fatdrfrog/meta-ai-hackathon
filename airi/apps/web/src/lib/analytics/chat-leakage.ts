import "server-only";
import connectDB from "@/lib/mongoose";
import {
  loadCrmPipelineStages,
  loadStageEnteredAtByCustomer,
} from "@/lib/crm/board";
import {
  deriveCrmCardAttention,
  isCrmNoiseCategory,
  isTerminalCrmStage,
  CRM_ATTENTION_WINDOW_MS,
  type CrmAttentionKind,
} from "@/lib/crm/attention";
import {
  deriveCrmFollowUp,
  extractCrmKeyMomentTypes,
  type CrmFollowUp,
} from "@/lib/crm/follow-up";
import {
  crmAttentionDaysToMs,
  getEffectivePipelineStages,
  normalizeCrmStageKey,
  type CrmPipelineStage,
} from "@/lib/crm/stages";
import { getCurrentConversationClassification } from "@icecore/shared/lib/conversation-classification-freshness";
import { Conversation } from "@/models/conversation";
import Customer from "@/models/customer";
import type { SupabaseClient } from "@supabase/supabase-js";
import mongoose from "mongoose";
import { listWorkspaceMemberLabels } from "@/lib/supabase/company-users";
import { readNonEmptyString, readDate } from "@icecore/shared/lib/value-utils";

export const CHAT_LEAKAGE_SOURCE_LIMIT = 1000;
export const CHAT_LEAKAGE_KINDS = [
  "needs_reply",
  "aged_unanswered",
  "stalled",
  "handoff",
  "ghosted",
  "qualified_unanswered",
] as const;
export type ChatLeakageKind = (typeof CHAT_LEAKAGE_KINDS)[number];
export type ChatLeakageFilters = {
  kind?: ChatLeakageKind;
  sourceIds?: string[];
  adIds?: string[];
  ownerIds?: string[];
  channels?: string[];
  qualifiedOnly?: boolean;
};
export type ChatLeakageSourceRow = {
  customerId: string;
  conversationId: string;
  stageKey: string;
  ownerId: string | null;
  sourceId: string | null;
  adId: string | null;
  channel: string | null;
  status: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  stageEnteredAt: string | null;
  handoffActive: boolean;
  category: string | null;
  isUnread: boolean;
  keyMomentTypes?: string[];
  customerName?: string | null;
  ownerName?: string | null;
  sourceName?: string | null;
};
type Counts = {
  needsReply: number;
  agedUnanswered: number;
  stalled: number;
  handoff: number;
  ghosted: number;
  qualifiedUnanswered: number;
};
export type ChatLeakageAudienceItem = Pick<
  ChatLeakageSourceRow,
  | "customerId"
  | "conversationId"
  | "stageKey"
  | "ownerId"
  | "sourceId"
  | "adId"
  | "channel"
  | "lastInboundAt"
  | "customerName"
  | "ownerName"
  | "sourceName"
> & {
  stageName?: string | null;
  qualified: boolean;
  waitSeconds: number | null;
  attention: CrmAttentionKind[];
  followUp: { kind: CrmFollowUp["kind"]; dueAt: string | null } | null;
};
export type ChatLeakageReport = {
  status: "ready" | "partial";
  asOf: string;
  population: "current_active_customer_primary_conversations";
  scannedCustomers: number;
  eligibleCustomers: number;
  truncated: boolean;
  qualification: { stageKeys: string[]; policyRevision: number };
  counts: Counts;
  groups: {
    sourceId: string | null;
    adId: string | null;
    ownerId: string | null;
    ownerName?: string | null;
    sourceName?: string | null;
    eligibleCustomers: number;
    counts: Counts;
  }[];
  audience: ChatLeakageAudienceItem[];
  audienceTotal: number;
  audienceTruncated: boolean;
};
const emptyCounts = (): Counts => ({
  needsReply: 0,
  agedUnanswered: 0,
  stalled: 0,
  handoff: 0,
  ghosted: 0,
  qualifiedUnanswered: 0,
});
function iso(value: unknown): string | null {
  return readDate(value)?.toISOString() ?? null;
}
function match(values: string[] | undefined, value: string | null) {
  return (
    !values?.length || values.includes(value === null ? "__none__" : value)
  );
}

/** Counts and audience use one bounded population and the canonical CRM rules. */
export function buildChatLeakageReport({
  now,
  rows,
  stages,
  qualifiedStageKeys,
  policyRevision,
  scannedCustomers,
  truncated,
  filters = {},
  audienceLimit = 100,
}: {
  now: Date;
  rows: ChatLeakageSourceRow[];
  stages: CrmPipelineStage[];
  qualifiedStageKeys: string[];
  policyRevision: number;
  scannedCustomers: number;
  truncated: boolean;
  filters?: ChatLeakageFilters;
  audienceLimit?: number;
}): ChatLeakageReport {
  const stageWindows = new Map(stages.map(stage => [stage.key, stage]));
  const qualification = new Set(
    qualifiedStageKeys.map(normalizeCrmStageKey).filter(Boolean)
  );
  const counts = emptyCounts();
  const groups = new Map<string, ChatLeakageReport["groups"][number]>();
  const audience: ChatLeakageAudienceItem[] = [];
  const seen = new Set<string>();
  let eligibleCustomers = 0;
  for (const row of rows) {
    if (
      seen.has(row.customerId) ||
      row.status === "closed" ||
      isTerminalCrmStage(row.stageKey) ||
      isCrmNoiseCategory(row.category)
    )
      continue;
    const qualified = qualification.has(row.stageKey);
    if (
      (filters.qualifiedOnly && !qualified) ||
      !match(filters.sourceIds, row.sourceId) ||
      !match(filters.adIds, row.adId) ||
      !match(filters.ownerIds, row.ownerId) ||
      !match(filters.channels, row.channel)
    )
      continue;
    seen.add(row.customerId);
    eligibleCustomers++;
    const stage = stageWindows.get(row.stageKey);
    const lastInboundAt = readDate(row.lastInboundAt);
    const attention = deriveCrmCardAttention({
      stageKey: row.stageKey,
      now,
      lastInboundAt,
      lastOutboundAt: readDate(row.lastOutboundAt),
      isUnread: row.isUnread,
      conversationStatus: row.status,
      stageEnteredAt: readDate(row.stageEnteredAt),
      ghostedAfterMs: stage
        ? crmAttentionDaysToMs(stage.ghostedAfterDays)
        : undefined,
      stalledAfterMs: stage
        ? crmAttentionDaysToMs(stage.stalledAfterDays)
        : undefined,
    });
    const needsReply = attention.includes("needs_reply");
    const waitSeconds =
      needsReply && lastInboundAt
        ? Math.max(0, (now.getTime() - lastInboundAt.getTime()) / 1000)
        : null;
    const flags: Record<ChatLeakageKind, boolean> = {
      needs_reply: needsReply,
      aged_unanswered:
        needsReply &&
        waitSeconds !== null &&
        waitSeconds * 1000 >=
          (stage
            ? crmAttentionDaysToMs(stage.ghostedAfterDays)
            : CRM_ATTENTION_WINDOW_MS),
      stalled: attention.includes("stalled"),
      handoff: row.handoffActive && needsReply,
      ghosted: attention.includes("ghosted"),
      qualified_unanswered: qualified && needsReply,
    };
    const groupKey = JSON.stringify([row.sourceId, row.adId, row.ownerId]);
    const group = groups.get(groupKey) ?? {
      sourceId: row.sourceId,
      adId: row.adId,
      ownerId: row.ownerId,
      ownerName: row.ownerName ?? null,
      sourceName: row.sourceName ?? null,
      eligibleCustomers: 0,
      counts: emptyCounts(),
    };
    group.eligibleCustomers++;
    const mapping: Record<ChatLeakageKind, keyof Counts> = {
      needs_reply: "needsReply",
      aged_unanswered: "agedUnanswered",
      stalled: "stalled",
      handoff: "handoff",
      ghosted: "ghosted",
      qualified_unanswered: "qualifiedUnanswered",
    };
    for (const kind of CHAT_LEAKAGE_KINDS)
      if (flags[kind]) {
        counts[mapping[kind]]++;
        group.counts[mapping[kind]]++;
      }
    groups.set(groupKey, group);
    if (
      filters.kind ? !flags[filters.kind] : !Object.values(flags).some(Boolean)
    )
      continue;
    const followUp = deriveCrmFollowUp({
      attention,
      handoffActive: row.handoffActive,
      keyMomentTypes: row.keyMomentTypes ?? [],
      slaDueAt: null,
      lastInboundAt,
    });
    audience.push({
      customerId: row.customerId,
      customerName: row.customerName ?? null,
      conversationId: row.conversationId,
      stageKey: row.stageKey,
      stageName: stage?.name ?? null,
      ownerId: row.ownerId,
      ownerName: row.ownerName ?? null,
      sourceId: row.sourceId,
      sourceName: row.sourceName ?? null,
      adId: row.adId,
      channel: row.channel,
      lastInboundAt: row.lastInboundAt,
      qualified,
      waitSeconds,
      attention,
      followUp: followUp
        ? { kind: followUp.kind, dueAt: followUp.dueAt?.toISOString() ?? null }
        : null,
    });
  }
  audience.sort(
    (a, b) =>
      (b.waitSeconds ?? -1) - (a.waitSeconds ?? -1) ||
      a.customerId.localeCompare(b.customerId)
  );
  const limit = Math.min(100, Math.max(1, Math.floor(audienceLimit)));
  return {
    status: truncated ? "partial" : "ready",
    asOf: now.toISOString(),
    population: "current_active_customer_primary_conversations",
    scannedCustomers,
    eligibleCustomers,
    truncated,
    qualification: {
      stageKeys: [...qualification] as string[],
      policyRevision,
    },
    counts,
    groups: [...groups.values()],
    audience: audience.slice(0, limit),
    audienceTotal: audience.length,
    audienceTruncated: audience.length > limit,
  };
}

export async function getChatLeakageReport({
  supabase,
  workspaceId,
  qualifiedStageKeys = ["qualified"],
  policyRevision = 0,
  filters = {},
  now = new Date(),
}: {
  supabase: SupabaseClient;
  workspaceId: string;
  qualifiedStageKeys?: string[];
  policyRevision?: number;
  filters?: ChatLeakageFilters;
  now?: Date;
}): Promise<ChatLeakageReport> {
  await connectDB();
  const customerMatch = {
    workspaceId,
    status: "active",
    ...(filters.ownerIds?.length
      ? {
          ownerUserId: {
            $in: filters.ownerIds.map(value =>
              value === "__none__" ? null : value
            ),
          },
        }
      : {}),
    ...(filters.qualifiedOnly
      ? { currentFunnelStage: { $in: qualifiedStageKeys } }
      : {}),
  };
  const [rawCustomers, persistedStages] = await Promise.all([
    Customer.find(customerMatch)
      .select(
        "_id displayName primaryConversationId currentFunnelStage ownerUserId createdAt"
      )
      .sort({ lastInteractionAt: -1, _id: -1 })
      .limit(CHAT_LEAKAGE_SOURCE_LIMIT + 1)
      .lean()
      .exec(),
    loadCrmPipelineStages({ supabase, workspaceId }),
  ]);
  const customers = (
    rawCustomers as Array<{
      _id: unknown;
      displayName?: string | null;
      primaryConversationId?: unknown;
      currentFunnelStage?: string | null;
      ownerUserId?: string | null;
      createdAt?: Date;
    }>
  ).slice(0, CHAT_LEAKAGE_SOURCE_LIMIT);
  const conversationIds = customers
    .map(row => String(row.primaryConversationId ?? ""))
    .filter(value => mongoose.Types.ObjectId.isValid(value))
    .map(value => new mongoose.Types.ObjectId(value));
  const [rawConversations, stageDates] = await Promise.all([
    conversationIds.length
      ? Conversation.find({ _id: { $in: conversationIds }, workspaceId })
          .select(
            "_id sourceId channel status last_inbound_at last_outbound_at airi_handoff_active is_read_by_manager whatsappReferral.sourceId classification is_classified classification_meta classification_revision classification_state"
          )
          .lean()
          .exec()
      : [],
    loadStageEnteredAtByCustomer(
      workspaceId,
      customers.map(row => String(row._id))
    ),
  ]);
  const conversations = new Map(
    (rawConversations as Array<Record<string, unknown>>).map(row => [
      String(row._id),
      row,
    ])
  );
  const ownerIds = [
    ...new Set(
      customers
        .map(row => readNonEmptyString(row.ownerUserId))
        .filter((value): value is string => Boolean(value))
    ),
  ];
  const sourceIds = [
    ...new Set(
      [...conversations.values()]
        .map(row => readNonEmptyString(row.sourceId))
        .filter((value): value is string => Boolean(value))
    ),
  ];
  const owners = new Map<string, string>(),
    sources = new Map<string, string>();
  // Bounded batched lookups reuse membership labels; names are never fetched per lead.
  for (
    let offset = 0;
    offset < Math.max(ownerIds.length, sourceIds.length);
    offset += 100
  ) {
    const [members, sourceRows] = await Promise.all([
      listWorkspaceMemberLabels(
        supabase,
        workspaceId,
        ownerIds.slice(offset, offset + 100)
      ).catch(() => []),
      sourceIds.slice(offset, offset + 100).length
        ? supabase
            .from("sources")
            .select("id,name")
            .eq("workspace_id", workspaceId)
            .in("id", sourceIds.slice(offset, offset + 100))
            .limit(100)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const member of members) owners.set(member.userId, member.label);
    for (const source of sourceRows.data ?? [])
      if (readNonEmptyString(source.name))
        sources.set(String(source.id), String(source.name));
  }
  const rows: ChatLeakageSourceRow[] = [];
  for (const customer of customers) {
    const conversation = conversations.get(
      String(customer.primaryConversationId)
    );
    if (!conversation) continue;
    const classification = getCurrentConversationClassification<{
      category?: string;
      key_moments?: unknown;
    }>(conversation);
    rows.push({
      customerId: String(customer._id),
      customerName: readNonEmptyString(customer.displayName),
      conversationId: String(conversation._id),
      stageKey:
        normalizeCrmStageKey(customer.currentFunnelStage) ?? "unassigned",
      ownerId: readNonEmptyString(customer.ownerUserId),
      ownerName: owners.get(String(customer.ownerUserId)) ?? null,
      sourceId: readNonEmptyString(conversation.sourceId),
      sourceName: sources.get(String(conversation.sourceId)) ?? null,
      adId: readNonEmptyString(
        (conversation.whatsappReferral as { sourceId?: string } | undefined)
          ?.sourceId
      ),
      channel: readNonEmptyString(conversation.channel),
      status: readNonEmptyString(conversation.status),
      lastInboundAt: iso(conversation.last_inbound_at),
      lastOutboundAt: iso(conversation.last_outbound_at),
      stageEnteredAt: iso(stageDates.get(String(customer._id))),
      handoffActive: conversation.airi_handoff_active === true,
      category: classification?.category ?? null,
      isUnread: conversation.is_read_by_manager === false,
      keyMomentTypes: extractCrmKeyMomentTypes(classification?.key_moments),
    });
  }
  return buildChatLeakageReport({
    now,
    rows,
    stages: getEffectivePipelineStages(persistedStages),
    qualifiedStageKeys,
    policyRevision,
    scannedCustomers: customers.length,
    truncated: rawCustomers.length > CHAT_LEAKAGE_SOURCE_LIMIT,
    filters,
  });
}
