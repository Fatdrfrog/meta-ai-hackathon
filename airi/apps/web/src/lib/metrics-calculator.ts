import {
  Conversation,
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME,
} from "@/models/conversation";
import Message from "@/models/message";
import {
  buildDashboardCategoryQueryMatch,
  fetchDashboardMessageAnalytics,
  hasDashboardFilterValues,
} from "@/lib/dashboard-message-analytics";
import {
  buildDashboardCategoryComparisons,
  buildDashboardCountComparison,
  buildDashboardDurationComparison,
} from "@/lib/dashboard-comparison";
import { medianFromSortedValues } from "@/lib/statistics";
import { buildServiceTruthReport, measuredResolutionSeconds, type ServiceConversationEvidence } from "@/lib/analytics/service-truth";
import { CRM_ATTENTION_WINDOW_MS } from "@/lib/crm/attention";
import {
  readStringOrEmpty,
  isNonEmptyString,
  readUniqueStringArray,
  readDate,
  readFiniteNumber,
} from "@icecore/shared/lib/value-utils";
import {
  AdvertisementAnalytics,
  ConversationActivityByTime,
  DASHBOARD_UNCATEGORIZED_CATEGORY,
  type DashboardComparisonPeriod,
  DashboardData,
  DashboardManagerOption,
  DashboardManagerPerformance,
  DashboardMetric,
  FirstResponseAnalytics,
  InternalLabelAnalytics,
} from "@/types/dashboard";
import type { PipelineStage } from "mongoose";

type DashboardCurrentAggregation = {
  summary?: Array<{
    totalConversations?: number;
    openConversations?: number;
    inProgressConversations?: number;
    resolvedConversations?: number;
    slaBreached?: number;
    avgRating?: number | null;
    avgTTRSeconds?: number | null;
  }>;
  repeatCustomers?: Array<{
    repeatCustomers?: number;
    totalCustomers?: number;
  }>;
  topComplaintTags?: Array<{ tag: string; count: number }>;
  advertisementSummary?: Array<{
    totalConversations?: number;
    respondedConversations?: number;
    closedConversations?: number;
    sourceKeys?: string[];
  }>;
  advertisementTopSources?: Array<{
    sourceKey?: string | null;
    sourceId?: string | null;
    sourceType?: string | null;
    sourceUrl?: string | null;
    headline?: string | null;
    body?: string | null;
    mediaType?: string | null;
    conversations?: number;
    responded?: number;
    closed?: number;
    latestAt?: Date | string | null;
  }>;
  advertisementBySourceType?: Array<{
    sourceType?: string | null;
    conversations?: number;
  }>;
  advertisementDailyCounts?: Array<{
    date: string;
    conversations: number;
  }>;
  internalLabelSummary?: Array<{
    taggedConversations?: number;
    totalAssignments?: number;
    uniqueLabels?: number;
    labels?: string[];
  }>;
  internalLabelTopLabels?: Array<{
    label?: string | null;
    conversations?: number;
    open?: number;
    inProgress?: number;
    closed?: number;
    responded?: number;
    latestAt?: Date | string | null;
  }>;
  managerSummary?: Array<{
    managerId?: string | null;
    conversations?: number;
    open?: number;
    inProgress?: number;
    resolved?: number;
  }>;
};

type FirstResponseAggregation = {
  overall?: Array<{
    avgFirstResponseSeconds?: number | null;
    medianFirstResponseSeconds?: number | null;
    p90FirstResponseSeconds?: number | null;
    firstResponseCount?: number;
  }>;
  byManager?: Array<{
    managerId?: string | null;
    managerName?: string | null;
    avgFirstResponseSeconds?: number | null;
    medianFirstResponseSeconds?: number | null;
    p90FirstResponseSeconds?: number | null;
    firstResponseCount?: number;
  }>;
};

type DashboardActivityAggregationRow = {
  _id?: { dayOfWeek?: number | null; hour?: number | null } | null;
  count?: number | null;
};

type DashboardConversationRow = ServiceConversationEvidence & {
  status?: string | null;
  customer_satisfaction_score?: number | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  user?: unknown;
  channel?: string | null;
  classification?: {
    category?: string | null;
    tags?: unknown;
  } | null;
  internal_labels?: unknown;
  handled_by_agent_id?: string | null;
  last_outbound_at?: Date | string | null;
  lastMessageAt?: Date | string | null;
  whatsappReferral?: {
    sourceId?: string | null;
    ctwaClid?: string | null;
    sourceUrl?: string | null;
    sourceType?: string | null;
    headline?: string | null;
    body?: string | null;
    mediaType?: string | null;
    capturedAt?: Date | string | null;
  } | null;
};

type FirstResponseRow = {
  first_inbound_at?: Date | string | null;
  first_response_seconds?: number | null;
  first_response_manager_id?: string | null;
  first_response_manager_name?: string | null;
};

type DashboardMetricsFilters = {
  channels?: string[];
  categories?: string[];
  internalLabels?: string[];
  managerIds?: string[];
  managerOptions?: DashboardManagerOption[];
  managerUserLinks?: DashboardManagerUserLink[];
  timeZone?: string;
};

type DashboardManagerUserLink = {
  supabase_user_id?: string | null;
  mongo_user_id?: string | null;
};

type NormalizedDashboardManagerUserLink = {
  supabaseUserId: string;
  mongoUserId: string;
};

function normalizeManagerUserLinks(
  links: DashboardManagerUserLink[] | undefined
): NormalizedDashboardManagerUserLink[] {
  if (!Array.isArray(links)) return [];

  const seen = new Set<string>();
  const normalized: NormalizedDashboardManagerUserLink[] = [];

  for (const link of links) {
    const supabaseUserId = String(link.supabase_user_id || "").trim();
    const mongoUserId = String(link.mongo_user_id || "").trim();
    if (!supabaseUserId || !mongoUserId) continue;

    const key = `${supabaseUserId}|${mongoUserId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ supabaseUserId, mongoUserId });
  }

  return normalized;
}

function resolveLinkedManagerId(
  managerId: string,
  links: NormalizedDashboardManagerUserLink[]
): string {
  const matched = links.find(link => link.mongoUserId === managerId);
  return matched?.supabaseUserId || managerId;
}

function expandFirstResponseManagerFilterIds(
  managerIds: string[] | undefined,
  links: NormalizedDashboardManagerUserLink[]
): string[] {
  if (!managerIds || managerIds.length === 0) return [];

  const expanded = new Set<string>();
  for (const managerId of managerIds) {
    expanded.add(managerId);
    for (const link of links) {
      if (link.supabaseUserId === managerId) {
        expanded.add(link.mongoUserId);
      }
    }
  }

  return Array.from(expanded);
}

function normalizeDashboardTimeZone(value: string | undefined): string {
  const candidate = (value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(
      new Date(0)
    );
    return candidate;
  } catch {
    return "UTC";
  }
}

function toConversationKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const key = value.toString();
    return key === "[object Object]" ? null : key;
  }
  return String(value);
}

function buildConversationMatch(
  workspaceId: string,
  options?: DashboardMetricsFilters
): Record<string, unknown> {
  return {
    workspaceId,
    ...buildDashboardCategoryQueryMatch(
      "classification.category",
      options?.categories
    ),
    ...(options?.channels && options.channels.length > 0
      ? { channel: { $in: options.channels } }
      : {}),
    ...(options?.internalLabels && options.internalLabels.length > 0
      ? { internal_labels: { $in: options.internalLabels } }
      : {}),
    ...(options?.managerIds && options.managerIds.length > 0
      ? { handled_by_agent_id: { $in: options.managerIds } }
      : {}),
  };
}

function buildFirstResponseConversationMatch(
  workspaceId: string,
  start: Date,
  end: Date,
  managerUserLinks: NormalizedDashboardManagerUserLink[],
  options?: DashboardMetricsFilters
): Record<string, unknown> {
  const match = buildConversationMatch(workspaceId, {
    ...options,
    managerIds: undefined,
  });
  const managerIds = expandFirstResponseManagerFilterIds(
    options?.managerIds,
    managerUserLinks
  );

  return {
    ...match,
    first_inbound_at: { $gte: start, $lt: end },
    ...(managerIds.length > 0
      ? { first_response_manager_id: { $in: managerIds } }
      : {}),
  };
}

const DASHBOARD_CONVERSATION_SELECT = [
  "status",
  "customer_satisfaction_score",
  "createdAt",
  "updatedAt",
  "user",
  "channel",
  "classification.category",
  "classification.tags",
  "internal_labels",
  "handled_by_agent_id",
  "last_outbound_at",
  "lastMessageAt",
  "first_inbound_at",
  "service_episode_started_at",
  "service_resolved_at",
  "service_resolution_kind",
  "csat_timeout_closed",
  "whatsappReferral.sourceId",
  "whatsappReferral.ctwaClid",
  "whatsappReferral.sourceUrl",
  "whatsappReferral.sourceType",
  "whatsappReferral.headline",
  "whatsappReferral.body",
  "whatsappReferral.mediaType",
  "whatsappReferral.capturedAt",
].join(" ");

const DASHBOARD_FIRST_RESPONSE_SELECT = [
  "first_inbound_at",
  "first_response_seconds",
  "first_response_manager_id",
  "first_response_manager_name",
].join(" ");

function buildActiveConversationQueryMatch(
  workspaceId: string,
  start: Date,
  endExclusive: Date,
  options?: DashboardMetricsFilters
): Record<string, unknown> {
  return {
    ...buildConversationMatch(workspaceId, options),
    lastMessageAt: {
      $gte: start,
      $lt: endExclusive,
    },
  };
}

function buildMessageActivityMatch(
  workspaceId: string,
  start: Date,
  endExclusive: Date,
  options?: DashboardMetricsFilters
): Record<string, unknown> {
  return {
    workspaceId,
    date: { $gte: start, $lt: endExclusive },
    ...(hasDashboardFilterValues(options?.channels)
      ? { channel: { $in: options.channels } }
      : {}),
  };
}

function shouldLookupConversationsForActivity(
  options?: DashboardMetricsFilters
) {
  return (
    hasDashboardFilterValues(options?.categories) ||
    hasDashboardFilterValues(options?.internalLabels) ||
    hasDashboardFilterValues(options?.managerIds)
  );
}

function buildConversationActivityLookupStages(
  workspaceId: string,
  options?: DashboardMetricsFilters
): PipelineStage[] {
  if (!shouldLookupConversationsForActivity(options)) return [];

  const conversationFilterMatch: Record<string, unknown> = {
    ...buildDashboardCategoryQueryMatch(
      "dashboardConversation.classification.category",
      options?.categories
    ),
    ...(hasDashboardFilterValues(options?.internalLabels)
      ? {
          "dashboardConversation.internal_labels": {
            $in: options.internalLabels,
          },
        }
      : {}),
    ...(hasDashboardFilterValues(options?.managerIds)
      ? {
          "dashboardConversation.handled_by_agent_id": {
            $in: options.managerIds,
          },
        }
      : {}),
  };

  return [
    {
      $lookup: {
        from: Conversation.collection.name,
        let: { conversationId: "$conversation" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$conversationId"] },
                  { $eq: ["$workspaceId", workspaceId] },
                ],
              },
            },
          },
          {
            $project: {
              workspaceId: 1,
              "classification.category": 1,
              internal_labels: 1,
              handled_by_agent_id: 1,
            },
          },
        ],
        as: "dashboardConversation",
      },
    },
    { $unwind: "$dashboardConversation" },
    ...(Object.keys(conversationFilterMatch).length > 0
      ? [{ $match: conversationFilterMatch }]
      : []),
  ] as PipelineStage[];
}

async function fetchDashboardMessageActivityRows({
  workspaceId,
  start,
  endExclusive,
  timeZone,
  options,
}: {
  workspaceId: string;
  start: Date;
  endExclusive: Date;
  timeZone: string;
  options?: DashboardMetricsFilters;
}): Promise<DashboardActivityAggregationRow[]> {
  const activityBucket = {
    dayOfWeek: { $dayOfWeek: { date: "$date", timezone: timeZone } },
    hour: { $hour: { date: "$date", timezone: timeZone } },
  };
  const conversationLookupStages = buildConversationActivityLookupStages(
    workspaceId,
    options
  );
  const pipeline: PipelineStage[] = [
    {
      $match: buildMessageActivityMatch(
        workspaceId,
        start,
        endExclusive,
        options
      ),
    },
    ...(conversationLookupStages.length > 0
      ? [
          // Conversation filters are constant for every message in this bucket.
          // Join once per conversation/hour, preserving the number of messages.
          {
            $group: {
              _id: { conversation: "$conversation", ...activityBucket },
              count: { $sum: 1 },
            },
          },
          { $addFields: { conversation: "$_id.conversation" } },
          ...conversationLookupStages,
          {
            $group: {
              _id: { dayOfWeek: "$_id.dayOfWeek", hour: "$_id.hour" },
              count: { $sum: "$count" },
            },
          },
        ]
      : [{ $group: { _id: activityBucket, count: { $sum: 1 } } }]),
    { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
  ];

  return await Message.aggregate<DashboardActivityAggregationRow>(
    pipeline
  ).allowDiskUse(true);
}

function mapIncrement(map: Map<string, number>, key: string, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function createDashboardTimeFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  function parts(date: Date) {
    const result: Record<string, number> = {};
    for (const part of formatter.formatToParts(date)) {
      if (
        part.type === "year" ||
        part.type === "month" ||
        part.type === "day"
      ) {
        result[part.type] = Number(part.value);
      }
    }

    if (
      !Number.isFinite(result.year) ||
      !Number.isFinite(result.month) ||
      !Number.isFinite(result.day)
    ) {
      return null;
    }

    return {
      year: result.year,
      month: result.month,
      day: result.day,
    };
  }

  return {
    dateKey(date: Date): string | null {
      const local = parts(date);
      if (!local) return null;
      return `${String(local.year).padStart(4, "0")}-${String(
        local.month
      ).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    },
  };
}

function sourceKeyForReferral(
  referral: DashboardConversationRow["whatsappReferral"]
): string {
  if (isNonEmptyString(referral?.sourceId)) return referral.sourceId;
  if (isNonEmptyString(referral?.sourceUrl)) return referral.sourceUrl;
  if (isNonEmptyString(referral?.ctwaClid)) return referral.ctwaClid;
  return "unknown";
}

function sourceTypeForReferral(
  referral: DashboardConversationRow["whatsappReferral"]
): string {
  return isNonEmptyString(referral?.sourceType)
    ? referral.sourceType
    : "unknown";
}

function hasAdvertisementReferral(
  referral: DashboardConversationRow["whatsappReferral"]
): boolean {
  return (
    isNonEmptyString(referral?.sourceId) ||
    isNonEmptyString(referral?.ctwaClid) ||
    isNonEmptyString(referral?.sourceUrl)
  );
}

function normalizeDashboardActivityRows(
  rows: DashboardActivityAggregationRow[]
): ConversationActivityByTime[] {
  return rows
    .map(row => ({
      dayOfWeek: row._id?.dayOfWeek,
      hour: row._id?.hour,
      count: row.count,
    }))
    .filter(
      (row): row is ConversationActivityByTime =>
        Number.isInteger(row.dayOfWeek) &&
        Number(row.dayOfWeek) >= 1 &&
        Number(row.dayOfWeek) <= 7 &&
        Number.isInteger(row.hour) &&
        Number(row.hour) >= 0 &&
        Number(row.hour) <= 23 &&
        typeof row.count === "number" &&
        Number.isFinite(row.count) &&
        row.count > 0
    )
    .sort(
      (left, right) =>
        left.dayOfWeek - right.dayOfWeek || left.hour - right.hour
    );
}

function firstDate(
  ...values: Array<Date | string | null | undefined>
): Date | null {
  for (const value of values) {
    const date = readDate(value);
    if (date) return date;
  }
  return null;
}

function buildDashboardCurrentAggregationFromRows(
  rows: DashboardConversationRow[],
  timeZone: string
): DashboardCurrentAggregation {
  const formatter = createDashboardTimeFormatter(timeZone);
  const statusCounts = { open: 0, inProgress: 0, closed: 0 };
  let slaBreached = 0;
  let ratingSum = 0;
  let ratingCount = 0;
  let ttrSecondsSum = 0;
  let ttrCount = 0;
  const agedOpenBefore = new Date(Date.now() - CRM_ATTENTION_WINDOW_MS);
  const customerCounts = new Map<string, number>();
  const complaintTagCounts = new Map<string, number>();
  let taggedConversations = 0;
  let totalLabelAssignments = 0;
  const uniqueLabels = new Set<string>();
  const labelGroups = new Map<
    string,
    {
      label: string;
      conversations: number;
      open: number;
      inProgress: number;
      closed: number;
      responded: number;
      latestAt: Date | null;
    }
  >();
  const managerGroups = new Map<
    string,
    {
      managerId: string;
      conversations: number;
      open: number;
      inProgress: number;
      resolved: number;
    }
  >();
  let advertisementTotal = 0;
  let advertisementResponded = 0;
  let advertisementClosed = 0;
  const advertisementSourceKeys = new Set<string>();
  const advertisementSourceGroups = new Map<
    string,
    {
      sourceKey: string;
      sourceId?: string | null;
      sourceType?: string | null;
      sourceUrl?: string | null;
      headline?: string | null;
      body?: string | null;
      mediaType?: string | null;
      conversations: number;
      responded: number;
      closed: number;
      latestAt: Date | null;
    }
  >();
  const advertisementTypeCounts = new Map<string, number>();
  const advertisementDailyCounts = new Map<string, number>();

  for (const row of rows) {
    const status = readStringOrEmpty(row.status);
    const createdAt = readDate(row.createdAt);
    const lastMessageAt = readDate(row.lastMessageAt);
    const lastOutboundAt = readDate(row.last_outbound_at);
    const category = row.classification?.category ?? null;

    if (status === "open") statusCounts.open += 1;
    if (status === "in_progress") statusCounts.inProgress += 1;
    if (status === "closed") statusCounts.closed += 1;
    if (status !== "closed" && createdAt && createdAt <= agedOpenBefore) {
      slaBreached += 1;
    }
    if (typeof row.customer_satisfaction_score === "number") {
      ratingSum += row.customer_satisfaction_score;
      ratingCount += 1;
    }
    const resolutionSeconds = measuredResolutionSeconds(row);
    if (resolutionSeconds !== null) {
      ttrSecondsSum += resolutionSeconds;
      ttrCount += 1;
    }

    const customerKey = toConversationKey(row.user);
    if (customerKey) mapIncrement(customerCounts, customerKey);

    if (category === "Complaint" && Array.isArray(row.classification?.tags)) {
      for (const tag of row.classification.tags) {
        if (typeof tag === "string" && tag.trim()) {
          mapIncrement(complaintTagCounts, tag.trim());
        }
      }
    }

    const labels = readUniqueStringArray(row.internal_labels);
    if (labels.length > 0) {
      taggedConversations += 1;
      totalLabelAssignments += labels.length;
      const latestAt = firstDate(lastMessageAt, createdAt);
      for (const label of labels) {
        uniqueLabels.add(label);
        const group = labelGroups.get(label) ?? {
          label,
          conversations: 0,
          open: 0,
          inProgress: 0,
          closed: 0,
          responded: 0,
          latestAt: null,
        };
        group.conversations += 1;
        if (status === "open") group.open += 1;
        if (status === "in_progress") group.inProgress += 1;
        if (status === "closed") group.closed += 1;
        if (lastOutboundAt) group.responded += 1;
        if (
          latestAt &&
          (!group.latestAt || latestAt.getTime() > group.latestAt.getTime())
        ) {
          group.latestAt = latestAt;
        }
        labelGroups.set(label, group);
      }
    }

    if (isNonEmptyString(row.handled_by_agent_id)) {
      const managerId = row.handled_by_agent_id;
      const group = managerGroups.get(managerId) ?? {
        managerId,
        conversations: 0,
        open: 0,
        inProgress: 0,
        resolved: 0,
      };
      group.conversations += 1;
      if (status === "open") group.open += 1;
      if (status === "in_progress") group.inProgress += 1;
      if (status === "closed") group.resolved += 1;
      managerGroups.set(managerId, group);
    }

    if (hasAdvertisementReferral(row.whatsappReferral)) {
      advertisementTotal += 1;
      if (lastOutboundAt) advertisementResponded += 1;
      if (status === "closed") advertisementClosed += 1;
      const sourceKey = sourceKeyForReferral(row.whatsappReferral);
      const sourceType = sourceTypeForReferral(row.whatsappReferral);
      const latestAt = firstDate(row.whatsappReferral?.capturedAt, createdAt);
      advertisementSourceKeys.add(sourceKey);
      mapIncrement(advertisementTypeCounts, sourceType);

      const sourceGroup = advertisementSourceGroups.get(sourceKey) ?? {
        sourceKey,
        sourceId: row.whatsappReferral?.sourceId ?? null,
        sourceType: row.whatsappReferral?.sourceType ?? null,
        sourceUrl: row.whatsappReferral?.sourceUrl ?? null,
        headline: row.whatsappReferral?.headline ?? null,
        body: row.whatsappReferral?.body ?? null,
        mediaType: row.whatsappReferral?.mediaType ?? null,
        conversations: 0,
        responded: 0,
        closed: 0,
        latestAt: null,
      };
      sourceGroup.conversations += 1;
      if (lastOutboundAt) sourceGroup.responded += 1;
      if (status === "closed") sourceGroup.closed += 1;
      if (
        latestAt &&
        (!sourceGroup.latestAt ||
          latestAt.getTime() > sourceGroup.latestAt.getTime())
      ) {
        sourceGroup.latestAt = latestAt;
      }
      advertisementSourceGroups.set(sourceKey, sourceGroup);

      const advertisementDate = firstDate(
        row.whatsappReferral?.capturedAt,
        lastMessageAt
      );
      const advertisementDateKey = advertisementDate
        ? formatter.dateKey(advertisementDate)
        : null;
      if (advertisementDateKey)
        mapIncrement(advertisementDailyCounts, advertisementDateKey);
    }
  }

  return {
    summary: [
      {
        totalConversations: rows.length,
        openConversations: statusCounts.open,
        inProgressConversations: statusCounts.inProgress,
        resolvedConversations: statusCounts.closed,
        slaBreached,
        avgRating: ratingCount > 0 ? ratingSum / ratingCount : null,
        avgTTRSeconds: ttrCount > 0 ? ttrSecondsSum / ttrCount : null,
      },
    ],
    repeatCustomers: [
      {
        totalCustomers: customerCounts.size,
        repeatCustomers: Array.from(customerCounts.values()).filter(
          count => count > 1
        ).length,
      },
    ],
    topComplaintTags: Array.from(complaintTagCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 1)
      .map(([tag, count]) => ({ tag, count })),
    advertisementSummary: [
      {
        totalConversations: advertisementTotal,
        respondedConversations: advertisementResponded,
        closedConversations: advertisementClosed,
        sourceKeys: Array.from(advertisementSourceKeys),
      },
    ],
    advertisementTopSources: Array.from(advertisementSourceGroups.values())
      .sort(
        (left, right) =>
          right.conversations - left.conversations ||
          (right.latestAt?.getTime() ?? 0) - (left.latestAt?.getTime() ?? 0)
      )
      .slice(0, 8),
    advertisementBySourceType: Array.from(advertisementTypeCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([sourceType, conversations]) => ({ sourceType, conversations })),
    advertisementDailyCounts: Array.from(advertisementDailyCounts.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, conversations]) => ({ date, conversations })),
    internalLabelSummary: [
      {
        taggedConversations,
        totalAssignments: totalLabelAssignments,
        uniqueLabels: uniqueLabels.size,
        labels: Array.from(uniqueLabels).sort((left, right) =>
          left.localeCompare(right)
        ),
      },
    ],
    internalLabelTopLabels: Array.from(labelGroups.values())
      .sort(
        (left, right) =>
          right.conversations - left.conversations ||
          (right.latestAt?.getTime() ?? 0) - (left.latestAt?.getTime() ?? 0)
      )
      .slice(0, 10)
      .map(row => ({
        label: row.label,
        conversations: row.conversations,
        open: row.open,
        inProgress: row.inProgress,
        closed: row.closed,
        responded: row.responded,
        latestAt: row.latestAt,
      })),
    managerSummary: Array.from(managerGroups.values())
      .sort(
        (left, right) =>
          right.conversations - left.conversations ||
          left.managerId.localeCompare(right.managerId)
      )
      .map(row => ({
        managerId: row.managerId,
        conversations: row.conversations,
        open: row.open,
        inProgress: row.inProgress,
        resolved: row.resolved,
      })),
  };
}

function percentileValue(sortedValues: number[], ratio: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    Math.ceil(sortedValues.length * ratio) - 1,
    sortedValues.length - 1
  );
  return sortedValues[Math.max(0, index)] ?? null;
}

function buildFirstResponseStats(values: number[]) {
  const sorted = values
    .filter(value => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return {
      firstResponseCount: 0,
      avgFirstResponseSeconds: null,
      medianFirstResponseSeconds: null,
      p90FirstResponseSeconds: null,
    };
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    firstResponseCount: sorted.length,
    avgFirstResponseSeconds: sum / sorted.length,
    medianFirstResponseSeconds: medianFromSortedValues(sorted) ?? 0,
    p90FirstResponseSeconds: percentileValue(sorted, 0.9) ?? 0,
  };
}

function buildFirstResponseAggregationFromRows(
  rows: FirstResponseRow[],
  managerUserLinks: NormalizedDashboardManagerUserLink[]
): FirstResponseAggregation {
  const values: number[] = [];
  const managerGroups = new Map<
    string,
    { managerName: string | null; values: number[] }
  >();

  for (const row of rows) {
    const seconds = row.first_response_seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) continue;
    values.push(seconds);

    const rawManagerId = readStringOrEmpty(row.first_response_manager_id);
    if (!rawManagerId) continue;
    const managerId = resolveLinkedManagerId(rawManagerId, managerUserLinks);
    const group = managerGroups.get(managerId) ?? {
      managerName: row.first_response_manager_name ?? null,
      values: [],
    };
    group.values.push(seconds);
    if (!group.managerName && row.first_response_manager_name) {
      group.managerName = row.first_response_manager_name;
    }
    managerGroups.set(managerId, group);
  }

  return {
    overall: [buildFirstResponseStats(values)],
    byManager: Array.from(managerGroups.entries())
      .map(([managerId, group]) => ({
        managerId,
        managerName: group.managerName,
        ...buildFirstResponseStats(group.values),
      }))
      .sort(
        (left, right) =>
          (right.firstResponseCount ?? 0) - (left.firstResponseCount ?? 0) ||
          String(left.managerId).localeCompare(String(right.managerId))
      ),
  };
}

function splitFirstResponseRowsByPeriod(
  rows: FirstResponseRow[],
  comparisonPeriod: DashboardComparisonPeriod
) {
  const currentStart = Date.parse(comparisonPeriod.current.start);
  const currentEndExclusive = Date.parse(comparisonPeriod.current.endExclusive);
  const previousStart = comparisonPeriod.previous
    ? Date.parse(comparisonPeriod.previous.start)
    : null;
  const previousEndExclusive = comparisonPeriod.previous
    ? Date.parse(comparisonPeriod.previous.endExclusive)
    : null;
  const current: FirstResponseRow[] = [];
  const previous: FirstResponseRow[] = [];

  for (const row of rows) {
    const firstInboundAt = readDate(row.first_inbound_at)?.getTime();
    if (firstInboundAt === undefined) continue;
    if (
      firstInboundAt >= currentStart &&
      firstInboundAt < currentEndExclusive
    ) {
      current.push(row);
    } else if (
      previousStart !== null &&
      previousEndExclusive !== null &&
      firstInboundAt >= previousStart &&
      firstInboundAt < previousEndExclusive
    ) {
      previous.push(row);
    }
  }

  return { current, previous };
}

async function fetchDashboardConversationRows(
  match: Record<string, unknown>
): Promise<DashboardConversationRow[]> {
  return (await Conversation.find(match)
    .hint({ workspaceId: 1, lastMessageAt: -1 })
    .select(DASHBOARD_CONVERSATION_SELECT)
    .sort({ lastMessageAt: -1 })
    .limit(DASHBOARD_LEGACY_ROW_LIMIT + 1)
    .lean()
    .exec()) as DashboardConversationRow[];
}

async function fetchFirstResponseRows(
  match: Record<string, unknown>
): Promise<FirstResponseRow[]> {
  return (await Conversation.find(match)
    .hint(CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME)
    .select(DASHBOARD_FIRST_RESPONSE_SELECT)
    .sort({ first_inbound_at: -1 })
    .limit(DASHBOARD_LEGACY_ROW_LIMIT + 1)
    .lean()
    .exec()) as FirstResponseRow[];
}

const DASHBOARD_LEGACY_ROW_LIMIT = 10_000;

function buildAdvertisementAnalytics(
  aggregation: DashboardCurrentAggregation
): AdvertisementAnalytics {
  const summary = aggregation.advertisementSummary?.[0] ?? {};
  const totalConversations = summary.totalConversations ?? 0;
  const respondedConversations = summary.respondedConversations ?? 0;
  const closedConversations = summary.closedConversations ?? 0;

  return {
    totalConversations,
    uniqueSources: summary.sourceKeys?.filter(Boolean).length ?? 0,
    respondedConversations,
    closedConversations,
    responseRate:
      totalConversations > 0
        ? Math.round((respondedConversations / totalConversations) * 100)
        : 0,
    closeRate:
      totalConversations > 0
        ? Math.round((closedConversations / totalConversations) * 100)
        : 0,
    topSources: (aggregation.advertisementTopSources ?? []).map(row => ({
      sourceKey: row.sourceKey || row.sourceId || row.sourceUrl || "unknown",
      sourceId: row.sourceId ?? null,
      sourceType: row.sourceType ?? null,
      sourceUrl: row.sourceUrl ?? null,
      headline: row.headline ?? null,
      body: row.body ?? null,
      mediaType: row.mediaType ?? null,
      conversations: row.conversations ?? 0,
      responded: row.responded ?? 0,
      closed: row.closed ?? 0,
      latestAt: row.latestAt ?? null,
    })),
    bySourceType: (aggregation.advertisementBySourceType ?? []).map(row => ({
      sourceType: row.sourceType || "unknown",
      conversations: row.conversations ?? 0,
    })),
    dailyCounts: aggregation.advertisementDailyCounts ?? [],
  };
}

function buildInternalLabelAnalytics(
  aggregation: DashboardCurrentAggregation,
  totalConversations: number
): InternalLabelAnalytics {
  const summary = aggregation.internalLabelSummary?.[0] ?? {};
  const taggedConversations = summary.taggedConversations ?? 0;
  const availableLabels = (summary.labels ?? [])
    .map(label => label.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  return {
    taggedConversations,
    unlabeledConversations: Math.max(
      totalConversations - taggedConversations,
      0
    ),
    uniqueLabels: summary.uniqueLabels ?? 0,
    totalAssignments: summary.totalAssignments ?? 0,
    availableLabels,
    topLabels: (aggregation.internalLabelTopLabels ?? []).map(row => ({
      label: row.label || "unknown",
      conversations: row.conversations ?? 0,
      open: row.open ?? 0,
      inProgress: row.inProgress ?? 0,
      closed: row.closed ?? 0,
      responded: row.responded ?? 0,
      latestAt: row.latestAt ?? null,
    })),
  };
}

/** Average measured resolution in days, rounded as the card shows it. */
function averageResolutionDays(summary: {
  avgTTRSeconds?: number | null;
}): number | null {
  return summary.avgTTRSeconds === null || summary.avgTTRSeconds === undefined
    ? null
    : Number((summary.avgTTRSeconds / 86400).toFixed(1));
}

function isWhatsAppSyntheticManagerId(id: string): boolean {
  return (
    id.startsWith("whatsapp_business_") || id.startsWith("whatsapp_manager_")
  );
}

function getManagerDisplayName(
  id: string,
  managerName: string | null | undefined
): string {
  if (isWhatsAppSyntheticManagerId(id)) {
    return "WhatsApp Business app";
  }

  const trimmed = managerName?.trim();
  return trimmed || "Unknown manager";
}

function buildFirstResponseAnalytics(
  aggregation?: FirstResponseAggregation
): FirstResponseAnalytics {
  const overall = aggregation?.overall?.[0] ?? {};

  return {
    count: overall.firstResponseCount ?? 0,
    medianSeconds: readFiniteNumber(overall.medianFirstResponseSeconds),
    averageSeconds: readFiniteNumber(overall.avgFirstResponseSeconds),
    p90Seconds: readFiniteNumber(overall.p90FirstResponseSeconds),
  };
}

function buildManagerPerformance(
  currentAggregation: DashboardCurrentAggregation,
  firstResponseAggregation: FirstResponseAggregation | undefined,
  managerOptions: DashboardManagerOption[] = [],
  managerUserLinks: NormalizedDashboardManagerUserLink[] = []
): DashboardManagerPerformance[] {
  const optionsById = new Map(
    managerOptions.map(manager => [manager.id, manager])
  );
  const conversationByManager = new Map<
    string,
    {
      conversations: number;
      open: number;
      inProgress: number;
      resolved: number;
    }
  >();

  for (const row of currentAggregation.managerSummary ?? []) {
    if (!row.managerId) continue;
    const id = resolveLinkedManagerId(String(row.managerId), managerUserLinks);
    const existing = conversationByManager.get(id) ?? {
      conversations: 0,
      open: 0,
      inProgress: 0,
      resolved: 0,
    };

    existing.conversations += row.conversations ?? 0;
    existing.open += row.open ?? 0;
    existing.inProgress += row.inProgress ?? 0;
    existing.resolved += row.resolved ?? 0;
    conversationByManager.set(id, existing);
  }

  const responseByManager = new Map<
    string,
    {
      firstResponseCount: number;
      medianFirstResponseSeconds: number | null;
      averageFirstResponseSeconds: number | null;
      p90FirstResponseSeconds: number | null;
      managerName: string | null;
    }
  >();

  for (const row of firstResponseAggregation?.byManager ?? []) {
    if (!row.managerId) continue;
    const id = resolveLinkedManagerId(String(row.managerId), managerUserLinks);
    responseByManager.set(id, {
      firstResponseCount: row.firstResponseCount ?? 0,
      medianFirstResponseSeconds: readFiniteNumber(
        row.medianFirstResponseSeconds
      ),
      averageFirstResponseSeconds: readFiniteNumber(
        row.avgFirstResponseSeconds
      ),
      p90FirstResponseSeconds: readFiniteNumber(row.p90FirstResponseSeconds),
      managerName: row.managerName ?? null,
    });
  }

  const includeAllOptions = managerOptions.length > 1;
  const managerIds = new Set<string>([
    ...(includeAllOptions ? managerOptions.map(manager => manager.id) : []),
    ...conversationByManager.keys(),
    ...responseByManager.keys(),
  ]);

  return Array.from(managerIds)
    .map(id => {
      const option = optionsById.get(id);
      const conversations = conversationByManager.get(id);
      const responses = responseByManager.get(id);

      return {
        id,
        name: option?.name || getManagerDisplayName(id, responses?.managerName),
        role: option?.role ?? null,
        email: option?.email ?? null,
        avatarUrl: option?.avatarUrl ?? null,
        conversations: conversations?.conversations ?? 0,
        open: conversations?.open ?? 0,
        inProgress: conversations?.inProgress ?? 0,
        resolved: conversations?.resolved ?? 0,
        firstResponseCount: responses?.firstResponseCount ?? 0,
        medianFirstResponseSeconds:
          responses?.medianFirstResponseSeconds ?? null,
        averageFirstResponseSeconds:
          responses?.averageFirstResponseSeconds ?? null,
        p90FirstResponseSeconds: responses?.p90FirstResponseSeconds ?? null,
      };
    })
    .sort(
      (left, right) =>
        right.conversations - left.conversations ||
        right.firstResponseCount - left.firstResponseCount ||
        left.name.localeCompare(right.name)
    );
}

export async function calculateDashboardMetrics(
  workspaceId: string,
  comparisonPeriod: DashboardComparisonPeriod,
  options?: DashboardMetricsFilters
): Promise<DashboardData> {
  const timeZone = normalizeDashboardTimeZone(comparisonPeriod.timeZone);
  const currentStart = new Date(comparisonPeriod.current.start);
  const currentEndExclusive = new Date(comparisonPeriod.current.endExclusive);
  const unionStart = comparisonPeriod.previous
    ? new Date(comparisonPeriod.previous.start)
    : currentStart;
  const managerUserLinks = normalizeManagerUserLinks(options?.managerUserLinks);

  const [
    rawCurrentRows,
    rawFirstResponseRows,
    messageAnalytics,
    activityRows,
    rawPreviousRows,
  ] = await Promise.all([
    fetchDashboardConversationRows(
      buildActiveConversationQueryMatch(
        workspaceId,
        currentStart,
        currentEndExclusive,
        options
      )
    ),
    fetchFirstResponseRows(
      buildFirstResponseConversationMatch(
        workspaceId,
        unionStart,
        currentEndExclusive,
        managerUserLinks,
        options
      )
    ),
    fetchDashboardMessageAnalytics({
      workspaceId,
      comparisonPeriod,
      filters: options,
    }),
    fetchDashboardMessageActivityRows({
      workspaceId,
      start: currentStart,
      endExclusive: currentEndExclusive,
      timeZone,
      options,
    }),
    // The previous window uses the cards' own rule, so a previous value is
    // what the card shows for those dates. A conversation active in both
    // windows counts once, in the current one.
    comparisonPeriod.previous
      ? fetchDashboardConversationRows(
          buildActiveConversationQueryMatch(
            workspaceId,
            new Date(comparisonPeriod.previous.start),
            new Date(comparisonPeriod.previous.endExclusive),
            options
          )
        )
      : null,
  ]);

  const sourceCoverage = {
    status: rawCurrentRows.length > DASHBOARD_LEGACY_ROW_LIMIT || rawFirstResponseRows.length > DASHBOARD_LEGACY_ROW_LIMIT ? "partial" as const : "complete" as const,
    rowLimit: DASHBOARD_LEGACY_ROW_LIMIT,
    conversationRowsLoaded: Math.min(rawCurrentRows.length, DASHBOARD_LEGACY_ROW_LIMIT),
    firstResponseRowsLoaded: Math.min(rawFirstResponseRows.length, DASHBOARD_LEGACY_ROW_LIMIT),
    conversationRowsTruncated: rawCurrentRows.length > DASHBOARD_LEGACY_ROW_LIMIT,
    firstResponseRowsTruncated: rawFirstResponseRows.length > DASHBOARD_LEGACY_ROW_LIMIT,
  };
  const currentRows = rawCurrentRows.slice(0, DASHBOARD_LEGACY_ROW_LIMIT);
  const firstResponseRows = rawFirstResponseRows.slice(0, DASHBOARD_LEGACY_ROW_LIMIT);
  const currentAggregation = buildDashboardCurrentAggregationFromRows(
    currentRows,
    timeZone
  );
  const splitFirstResponseRows = splitFirstResponseRowsByPeriod(
    firstResponseRows,
    comparisonPeriod
  );
  const firstResponseAggregation = buildFirstResponseAggregationFromRows(
    splitFirstResponseRows.current,
    managerUserLinks
  );
  const previousFirstResponseAggregation =
    buildFirstResponseAggregationFromRows(
      splitFirstResponseRows.previous,
      managerUserLinks
    );
  const summary = currentAggregation.summary?.[0] ?? {};
  const repeatSummary = currentAggregation.repeatCustomers?.[0] ?? {};
  const totalConversations = messageAnalytics.totals.current;
  const currentConversationRowsTotal = summary.totalConversations ?? 0;
  const newConversations = summary.openConversations ?? 0;
  const inProgressConversations = summary.inProgressConversations ?? 0;
  const resolvedConversations = summary.resolvedConversations ?? 0;
  const slaBreached = summary.slaBreached ?? 0;
  const repeatCustomers = repeatSummary.repeatCustomers ?? 0;
  const totalCustomers = repeatSummary.totalCustomers ?? 0;
  const repeatCustomerPercentage =
    totalCustomers > 0 ? (repeatCustomers / totalCustomers) * 100 : 0;
  const avgTTRinDays = averageResolutionDays(summary);
  const firstResponse = buildFirstResponseAnalytics(firstResponseAggregation);
  const serviceTruth = buildServiceTruthReport({
    now: new Date(),
    conversationRows: currentRows,
    firstResponseRows: splitFirstResponseRows.current,
    firstResponderFiltered: hasDashboardFilterValues(options?.managerIds) || sourceCoverage.firstResponseRowsTruncated,
  });
  serviceTruth.sourceCoverage = sourceCoverage;
  Object.assign(firstResponse, {
    eligibleConversations: serviceTruth.firstHumanResponse.eligibleConversations,
    unansweredConversations: serviceTruth.firstHumanResponse.unansweredConversations,
    coverageRate: serviceTruth.firstHumanResponse.coverageRate,
    oldestUnansweredSeconds: serviceTruth.firstHumanResponse.oldestUnansweredSeconds,
  });
  const previousFirstResponse = buildFirstResponseAnalytics(
    previousFirstResponseAggregation
  );
  const managerPerformance = buildManagerPerformance(
    currentAggregation,
    firstResponseAggregation,
    options?.managerOptions ?? [],
    managerUserLinks
  );

  const categoryComparisons = buildDashboardCategoryComparisons(
    messageAnalytics.categories.current,
    messageAnalytics.categories.previous
  );
  const totalComparison = comparisonPeriod.previous
    ? buildDashboardCountComparison(
        messageAnalytics.totals.current,
        messageAnalytics.totals.previous
      )
    : null;
  const firstResponseComparison =
    !sourceCoverage.firstResponseRowsTruncated && comparisonPeriod.previous &&
    firstResponse.medianSeconds !== null &&
    previousFirstResponse.medianSeconds !== null
      ? buildDashboardDurationComparison(
          firstResponse.medianSeconds,
          previousFirstResponse.medianSeconds
        )
      : null;
  // A truncated previous read would understate it, so those cards stay uncompared.
  const previousAggregation =
    rawPreviousRows && rawPreviousRows.length <= DASHBOARD_LEGACY_ROW_LIMIT
      ? buildDashboardCurrentAggregationFromRows(rawPreviousRows, timeZone)
      : null;
  const previousSummary = previousAggregation?.summary?.[0] ?? {};
  const previousRepeatCustomers =
    previousAggregation?.repeatCustomers?.[0]?.repeatCustomers ?? 0;
  const previousAvgRating = previousSummary.avgRating ?? null;
  const previousAvgTTRinDays = averageResolutionDays(previousSummary);
  const currentAvgRating = summary.avgRating ?? null;
  const resolvedComparison = previousAggregation
    ? buildDashboardCountComparison(
        resolvedConversations,
        previousSummary.resolvedConversations ?? 0
      )
    : null;
  const repeatComparison = previousAggregation
    ? buildDashboardCountComparison(repeatCustomers, previousRepeatCustomers)
    : null;
  // Averages change by direction only; an absent side has nothing to compare.
  const csatComparison =
    previousAggregation &&
    currentAvgRating !== null &&
    previousAvgRating !== null
      ? buildDashboardDurationComparison(currentAvgRating, previousAvgRating)
      : null;
  const ttrComparison =
    previousAggregation && avgTTRinDays !== null && previousAvgTTRinDays !== null
      ? buildDashboardDurationComparison(avgTTRinDays, previousAvgTTRinDays)
      : null;

  const conversationActivityByTime =
    normalizeDashboardActivityRows(activityRows);
  const peak =
    conversationActivityByTime.reduce<ConversationActivityByTime | null>(
      (current, row) => (!current || row.count > current.count ? row : current),
      null
    );

  const statsData: DashboardMetric[] = [
    {
      id: "total",
      value: totalConversations,
      secondaryValue: null,
      comparison: totalComparison,
    },
    {
      id: "new",
      value: newConversations,
      secondaryValue: null,
      comparison: null,
    },
    {
      id: "in_progress",
      value: inProgressConversations,
      secondaryValue: null,
      comparison: null,
    },
    {
      id: "resolved",
      value: resolvedConversations,
      secondaryValue: null,
      comparison: resolvedComparison,
    },
    {
      id: "sla",
      value: slaBreached,
      secondaryValue: null,
      comparison: null,
    },
    {
      id: "repeat",
      value: repeatCustomers,
      secondaryValue: repeatCustomerPercentage,
      comparison: repeatComparison,
    },
    {
      id: "csat",
      value: currentAvgRating,
      secondaryValue: 5,
      comparison: csatComparison,
    },
    {
      id: "first_response",
      value: firstResponse.medianSeconds,
      secondaryValue: null,
      comparison: firstResponseComparison,
    },
    {
      id: "ttr",
      value: avgTTRinDays,
      secondaryValue: null,
      comparison: ttrComparison,
    },
  ];

  for (const metric of statsData) {
    if ((sourceCoverage.conversationRowsTruncated && !["total", "first_response"].includes(metric.id)) || (sourceCoverage.firstResponseRowsTruncated && metric.id === "first_response")) {
      metric.value = null; metric.secondaryValue = null; metric.comparison = null;
    }
  }
  return {
    stats: statsData,
    comparisonPeriod,
    dailySeries: messageAnalytics.dailySeries,
    conversationActivityByTime,
    categoryComparisons,
    peakTime: peak
      ? { dayOfWeek: peak.dayOfWeek, hour: peak.hour }
      : null,
    topCategories: Object.entries(messageAnalytics.categories.current)
      .sort(
        ([leftName, leftCount], [rightName, rightCount]) =>
          rightCount - leftCount ||
          (leftName < rightName ? -1 : leftName > rightName ? 1 : 0)
      )
      .slice(0, 5)
      .map(([name, value]) => ({ name, value })),
    uncategorizedCount:
      messageAnalytics.categories.current[DASHBOARD_UNCATEGORIZED_CATEGORY] ??
      0,
    categoriesByChannel: messageAnalytics.categoriesByChannel,
    topComplaintTag: currentAggregation.topComplaintTags?.[0]?.tag ?? null,
    advertisement: buildAdvertisementAnalytics(currentAggregation),
    internalLabels: buildInternalLabelAnalytics(
      currentAggregation,
      currentConversationRowsTotal
    ),
    managerOptions: options?.managerOptions ?? [],
    managerPerformance,
    firstResponse,
    serviceTruth,
    sourceCoverage,
  };
}
