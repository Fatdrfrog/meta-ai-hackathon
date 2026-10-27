import {
  buildBulkAnalyticsSendBaseMatch,
  buildBulkSendFailuresFacetStages,
  buildBulkSendOutcomesFacetStages,
  buildBulkSendSummaryFacetStages,
  buildConversationCandidateStages,
  buildConversationRecordsPipeline,
  buildEngagementScoreMatch,
  buildEnrichmentStages,
  buildMessageContainsStages,
  buildSendRecordsPipeline,
  buildTemplateNameStages,
  computePreviousAnalyticsWindow,
  expandAnalyticsWindowForCampaigns,
  fetchBulkCampaignDeliveryReceipts,
  fetchBulkAnalyticsCampaignIds,
  buildBulkReconciledSendStages,
  buildBulkDeliveryFilterStages,
  buildBulkRecipientSearchStages,
  parseBulkAnalyticsDeliveryStatus,
  BulkAnalyticsAudienceUnavailableError,
  fetchConversationIdsMatchingMessageText,
  normalizeBulkSendSummary,
  type BulkAnalyticsRecordsCursor,
  normalizeStringList,
} from "@/lib/analytics/bulk-analytics-audience";
import mongoose from "mongoose";
import {
  normalizeBulkAnalyticsRecipientSearch,
  BulkAnalyticsRecipientSearchError,
} from "@/lib/analytics/bulk-analytics-contract";
import type { BulkAnalyticsStatus } from "@/lib/analytics/bulk-analytics-contract";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import { listWhatsAppMessageIdLookupKeys } from "@icecore/shared/lib/whatsapp/message-id";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import {
  readCachedLocalAnalytics,
  withAnalyticsQueryBudget,
} from "@/lib/analytics/analytics-query-service";
import {
  BulkAnalyticsQueryError,
  bulkAnalyticsFilterKey,
  readBulkAnalyticsSnapshot,
  saveBulkAnalyticsSnapshot,
  type BulkAnalyticsSnapshot,
} from "@/lib/analytics/bulk-analytics-query";
import type { BulkSqlDeliveryReceipt } from "@/lib/analytics/whatsapp-delivery-reconciliation";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import type { PipelineStage } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { parsePositiveInt } from "@/lib/api/query-params";
import { readDate as parseDate } from "@icecore/shared/lib/value-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ workspaceId: string }>;

type ConversationScope =
  | "campaign_sends"
  | "all"
  | "fresh"
  | "campaign_or_fresh";

type MessageContainsMode = "contains" | "not_contains";

type EngagementBucket = "all" | "high" | "medium" | "low" | "unscored";

type BulkAnalyticsView = "all" | "overview" | "records" | "compare";

type CampaignOption = {
  id: string;
  name: string;
  templateName: string | null;
  sentAt: string | null;
  totalRecipients: number;
  successfulSends: number;
  failedSends: number;
};

type TemplateOption = {
  name: string;
  language: string | null;
  status: string | null;
  category: string | null;
  count: number;
  firstSentAt: Date | string | null;
  lastSentAt: Date | string | null;
  available: boolean;
};

const DEFAULT_DAYS = 14;
const DEFAULT_REPLY_WINDOW_HOURS = 168;
const DEFAULT_LIMIT = 100;
const MAX_RECORDS_LIMIT = 100;
const DEFAULT_MIN_RUN_SIZE = 10;

function normalizeOptionalParam(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") return null;
  return trimmed;
}

function parseOptionalListParam(
  searchParams: URLSearchParams,
  names: string[]
): string[] {
  return normalizeStringList(names.flatMap(name => searchParams.getAll(name)));
}

function parseConversationScope(value: string | null): ConversationScope {
  if (
    value === "campaign_sends" ||
    value === "all" ||
    value === "fresh" ||
    value === "campaign_or_fresh"
  ) {
    return value;
  }
  return "campaign_sends";
}

function parseMessageContainsMode(value: string | null): MessageContainsMode {
  return value === "not_contains" ? "not_contains" : "contains";
}

function parseEngagementBucket(value: string | null): EngagementBucket {
  if (
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "unscored"
  ) {
    return value;
  }
  return "all";
}

function parseAnalyticsView(value: string | null): BulkAnalyticsView {
  if (value === "overview" || value === "records" || value === "compare") {
    return value;
  }
  return "all";
}

function parseRecordsCursor(
  value: string | null
): BulkAnalyticsRecordsCursor | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const [rawSortAt, rawId] = trimmed.split("|");
  const sortAt = parseDate(rawSortAt || null);
  if (!sortAt || !rawId || !mongoose.Types.ObjectId.isValid(rawId)) {
    return null;
  }

  return { sortAt, id: rawId };
}

function normalizeTimezone(value: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9_+\-/:]+$/.test(trimmed)) return "UTC";
  return trimmed;
}

function mergeTemplateOptions(params: {
  available: TemplateOption[];
  used: Array<{
    _id?: unknown;
    count?: unknown;
    firstSentAt?: Date | string | null;
    lastSentAt?: Date | string | null;
  }>;
}): TemplateOption[] {
  const byName = new Map<string, TemplateOption>();

  for (const template of params.available) {
    if (!template.name) continue;
    byName.set(template.name, template);
  }

  for (const usage of params.used) {
    const name = String(usage._id || "").trim();
    if (!name) continue;
    const existing = byName.get(name);
    byName.set(name, {
      name,
      language: existing?.language || null,
      status: existing?.status || null,
      category: existing?.category || null,
      count: Number(usage.count || 0),
      firstSentAt: usage.firstSentAt || null,
      lastSentAt: usage.lastSentAt || null,
      available: existing?.available ?? false,
    });
  }

  return Array.from(byName.values()).sort((a, b) => {
    const byNameCompare = a.name.localeCompare(b.name);
    if (byNameCompare !== 0) return byNameCompare;
    return String(a.language || "").localeCompare(String(b.language || ""));
  });
}

function emptyAnalyticsResponse(params: {
  workspaceId: string;
  days: number;
  startDate: Date;
  endDate: Date;
  replyWindowHours: number;
  campaigns: CampaignOption[];
  templates?: TemplateOption[];
}) {
  return {
    workspaceId: params.workspaceId,
    generatedAt: new Date().toISOString(),
    window: {
      days: params.days,
      startDate: params.startDate.toISOString(),
      endDate: params.endDate.toISOString(),
      replyWindowHours: params.replyWindowHours,
    },
    filters: {
      templates: params.templates || [],
      campaigns: params.campaigns,
    },
    summary: {
      totalAccepted: 0,
      uniqueConversations: 0,
      replied: 0,
      notReplied: 0,
      totalReplies: 0,
      replyRate: 0,
      read: 0,
      readRate: 0,
      delivered: 0,
      deliveryRate: 0,
      failed: 0,
      failedRate: 0,
      estimatedCost: 0,
      costPerReply: null,
      avgReplyDelayMinutes: null,
      firstSentAt: null,
      lastSentAt: null,
    },
    byTemplate: [],
    daily: [],
    replyCategories: [],
    outcomes: [],
    failures: [],
    detectedRuns: [],
    topConversations: [],
    records: [],
    compare: null,
  };
}

function encodeRecordsCursor(record: Record<string, unknown> | undefined) {
  const rawSortAt = record?.cursorSortAt;
  const rawId = record?.cursorId;
  const sortAt =
    rawSortAt instanceof Date
      ? rawSortAt
      : typeof rawSortAt === "string"
        ? parseDate(rawSortAt)
        : null;

  if (
    !sortAt ||
    typeof rawId !== "string" ||
    !mongoose.Types.ObjectId.isValid(rawId)
  ) {
    return null;
  }

  return `${sortAt.toISOString()}|${rawId}`;
}

function stripRecordCursor(record: Record<string, unknown>) {
  const { cursorSortAt, cursorId, ...rest } = record;
  void cursorSortAt;
  void cursorId;
  return rest;
}

function paginateRecords(params: {
  rawRecords: Record<string, unknown>[];
  limit: number;
}) {
  const hasMore = params.rawRecords.length > params.limit;
  const pageRecords = hasMore
    ? params.rawRecords.slice(0, params.limit)
    : params.rawRecords;

  return {
    records: pageRecords.map(stripRecordCursor),
    pageInfo: {
      limit: params.limit,
      hasMore,
      nextCursor: hasMore
        ? encodeRecordsCursor(pageRecords[pageRecords.length - 1])
        : null,
    },
  };
}

async function fetchCampaignOptions(
  workspaceId: string,
  signal: AbortSignal
): Promise<CampaignOption[]> {
  const { data, error } = await supabaseAdmin
    .from("campaign_history")
    .select(
      "id, name, template_name, sent_at, total_recipients, successful_sends, failed_sends"
    )
    .eq("workspace_id", workspaceId)
    .eq("channel", "whatsapp")
    .order("sent_at", { ascending: false })
    .limit(100)
    .abortSignal(signal);

  if (error || !Array.isArray(data)) return [];

  return data
    .map(row => ({
      id: String(row.id || ""),
      name: String(row.name || "Campaign"),
      templateName:
        typeof row.template_name === "string" && row.template_name.trim()
          ? row.template_name.trim()
          : null,
      sentAt:
        typeof row.sent_at === "string" && row.sent_at.trim()
          ? row.sent_at.trim()
          : null,
      totalRecipients: Number(row.total_recipients || 0),
      successfulSends: Number(row.successful_sends || 0),
      failedSends: Number(row.failed_sends || 0),
    }))
    .filter(row => row.id);
}

async function ensureCampaignsBelongToWorkspace(params: {
  workspaceId: string;
  campaignIds: string[];
  signal: AbortSignal;
}): Promise<boolean> {
  if (params.campaignIds.length === 0) return true;

  const { data, error } = await supabaseAdmin
    .from("campaign_history")
    .select("id")
    .eq("workspace_id", params.workspaceId)
    .in("id", params.campaignIds)
    .abortSignal(params.signal);

  if (error || !Array.isArray(data))
    throw new BulkAnalyticsQueryError(
      "CAMPAIGN_HISTORY_UNAVAILABLE",
      "Selected campaign ownership could not be verified"
    );
  const found = new Set(data.map(row => String(row.id || "")));
  return params.campaignIds.every(id => found.has(id));
}

async function fetchAvailableTemplateOptions(
  workspaceId: string,
  signal?: AbortSignal
): Promise<TemplateOption[]> {
  try {
    const templates = await WhatsAppTemplateModel.find({
      workspaceId,
      status: "APPROVED",
    })
      .select("name language status category")
      .limit(500)
      .maxTimeMS(2500)
      .setOptions({ signal })
      .lean();

    return templates
      .map(template => ({
        name: String(template.name || "").trim(),
        language:
          typeof template.language === "string" && template.language.trim()
            ? template.language.trim()
            : null,
        status:
          typeof template.status === "string" && template.status.trim()
            ? template.status.trim()
            : null,
        category:
          typeof template.category === "string" && template.category.trim()
            ? template.category.trim()
            : null,
        count: 0,
        firstSentAt: null,
        lastSentAt: null,
        available: true,
      }))
      .filter(template => template.name);
  } catch (error) {
    logger.warn("[Bulk Analytics API] Failed to fetch available templates", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function generateBulkAnalyticsResponse(
  request: NextRequest,
  { params }: { params: Params },
  execution: {
    signal: AbortSignal;
    deadline: number;
    snapshot?: BulkAnalyticsSnapshot;
  }
) {
  const { signal } = execution;
  const remaining = () => {
    signal.throwIfAborted();
    return Math.max(1, execution.deadline - Date.now());
  };
  try {
    const { workspaceId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const view = parseAnalyticsView(searchParams.get("view"));
    const includeOverview = view !== "records" && view !== "compare";
    const includeRecords = view === "all" || view === "records";
    const days = parsePositiveInt(
      searchParams.get("days"),
      DEFAULT_DAYS,
      1,
      365
    );
    const replyWindowHours = parsePositiveInt(
      searchParams.get("replyWindowHours"),
      DEFAULT_REPLY_WINDOW_HOURS,
      1,
      24 * 30
    );
    const limit = parsePositiveInt(
      searchParams.get("limit"),
      DEFAULT_LIMIT,
      10,
      MAX_RECORDS_LIMIT
    );
    const recordsCursor = parseRecordsCursor(searchParams.get("cursor"));
    if (searchParams.has("cursor") && !recordsCursor)
      throw new BulkAnalyticsQueryError(
        "CURSOR_INVALID",
        "Invalid records cursor",
        400
      );
    const filterKey = bulkAnalyticsFilterKey(workspaceId, searchParams);
    let snapshotToken = searchParams.get("snapshotToken");
    if ((recordsCursor || searchParams.has("observedAt")) && !snapshotToken)
      throw new BulkAnalyticsQueryError(
        "SNAPSHOT_REQUIRED",
        "Paginated records require the original snapshot token",
        409
      );
    const snapshot =
      execution.snapshot ||
      (snapshotToken
        ? await readBulkAnalyticsSnapshot(snapshotToken, workspaceId, filterKey)
        : null);
    if (
      snapshot &&
      searchParams.get("observedAt") &&
      searchParams.get("observedAt") !== snapshot.observedAt
    )
      throw new BulkAnalyticsQueryError(
        "SNAPSHOT_OBSERVATION_MISMATCH",
        "Observation changed during export",
        409
      );
    const observedAt = snapshot ? new Date(snapshot.observedAt) : new Date();
    const dataQuality = {
      complete: true,
      reasons: [] as string[],
      observedAt: observedAt.toISOString(),
      consistency: "bounded_observation" as const,
    };
    const rawTemplateNames = parseOptionalListParam(searchParams, [
      "template",
      "templates",
      "template[]",
      "templates[]",
    ]);
    const rawCampaignIds = parseOptionalListParam(searchParams, [
      "campaignId",
      "campaignIds",
      "campaignId[]",
      "campaignIds[]",
    ]);
    // "Exclude templates" is mutually exclusive with template/campaign
    // filters. The UI disables both selects when it's on, but we also drop
    // any values server-side to keep the API honest.
    const excludeTemplates =
      searchParams.get("excludeTemplates") === "1" ||
      searchParams.get("excludeTemplates") === "true";
    const templateNames = excludeTemplates ? [] : rawTemplateNames;
    const campaignIds = excludeTemplates ? [] : rawCampaignIds;
    if (campaignIds.length > 100)
      throw new BulkAnalyticsQueryError(
        "CAMPAIGN_SCAN_LIMIT",
        "Select at most 100 campaigns",
        400
      );
    const status = normalizeOptionalParam(searchParams.get("status"));
    const rawDeliveryStatus = searchParams.get("deliveryStatus") || "all";
    if (
      !["all", "accepted", "delivered", "read", "failed", "unknown"].includes(
        rawDeliveryStatus
      )
    )
      throw new BulkAnalyticsQueryError(
        "DELIVERY_STATUS_INVALID",
        "Invalid delivery status",
        400
      );
    const deliveryStatus = parseBulkAnalyticsDeliveryStatus(rawDeliveryStatus);
    const deliveryErrorCode = normalizeOptionalParam(
      searchParams.get("deliveryErrorCode")
    );
    const recipientSearch = normalizeBulkAnalyticsRecipientSearch(
      searchParams.get("recipientSearch")
    );
    const messageContains = normalizeOptionalParam(
      searchParams.get("messageContains")
    );
    const messageContainsMode = parseMessageContainsMode(
      searchParams.get("messageContainsMode")
    );
    const engagement = parseEngagementBucket(searchParams.get("engagement"));
    const conversationScope = parseConversationScope(
      searchParams.get("conversationScope")
    );
    if (
      conversationScope !== "campaign_sends" &&
      (deliveryStatus !== "all" || deliveryErrorCode)
    )
      throw new BulkAnalyticsQueryError(
        "DELIVERY_FILTER_SCOPE_UNSUPPORTED",
        "Delivery filters require campaign-send scope",
        400
      );
    const compareMode =
      searchParams.get("compare") === "off" ? "off" : "previous";
    const timezone = normalizeTimezone(searchParams.get("timezone"));
    const requestedEndDate = snapshot
      ? new Date(snapshot.endDate)
      : parseDate(searchParams.get("to")) || observedAt;
    const requestedStartDate =
      (snapshot
        ? new Date(snapshot.startDate)
        : parseDate(searchParams.get("from"))) ||
      new Date(requestedEndDate.getTime() - days * 24 * 60 * 60 * 1000);

    if (requestedStartDate.getTime() > requestedEndDate.getTime()) {
      return NextResponse.json(
        { error: "from must be before to" },
        { status: 400 }
      );
    }
    if (status && status !== "replied" && status !== "not_replied") {
      return NextResponse.json(
        { error: "status must be all, replied, or not_replied" },
        { status: 400 }
      );
    }
    const statusFilter: BulkAnalyticsStatus =
      status === "replied" || status === "not_replied" ? status : "all";

    await connectDB();

    let startDate = requestedStartDate;
    let endDate = requestedEndDate;

    let campaignMessageIds: string[] | null = null;
    let sqlReceipts: BulkSqlDeliveryReceipt[] = snapshot?.receipts || [];
    if (campaignIds.length > 0) {
      const belongsToWorkspace = await ensureCampaignsBelongToWorkspace({
        workspaceId,
        campaignIds,
        signal,
      });
      if (!belongsToWorkspace) {
        return NextResponse.json(
          { error: "One or more campaigns were not found for this workspace" },
          { status: 404 }
        );
      }
      const expandedWindow = snapshot
        ? { startDate, endDate }
        : await expandAnalyticsWindowForCampaigns({
            campaignIds,
            startDate,
            endDate,
            replyWindowHours,
            signal,
          });
      startDate = expandedWindow.startDate;
      endDate = expandedWindow.endDate;
      if (!snapshot)
        sqlReceipts = await fetchBulkCampaignDeliveryReceipts({
          campaignIds,
          signal,
        });
      campaignMessageIds = Array.from(
        new Set(
          sqlReceipts.flatMap(row =>
            listWhatsAppMessageIdLookupKeys(row.providerMessageId)
          )
        )
      );
      if (!snapshotToken)
        snapshotToken = await saveBulkAnalyticsSnapshot({
          workspaceId,
          filterKey,
          observedAt: observedAt.toISOString(),
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          receipts: sqlReceipts,
        });
      if (
        campaignMessageIds.length === 0 &&
        conversationScope === "campaign_sends"
      ) {
        if (view === "records") {
          return NextResponse.json({
            workspaceId,
            generatedAt: new Date().toISOString(),
            dataQuality,
            snapshotToken,
            records: [],
            pageInfo: {
              limit,
              hasMore: false,
              nextCursor: null,
            },
          });
        }

        if (view === "compare") {
          return NextResponse.json({
            workspaceId,
            generatedAt: new Date().toISOString(),
            dataQuality,
            snapshotToken,
            compare: null,
          });
        }

        const [campaigns, availableTemplates] = await Promise.all([
          includeOverview
            ? fetchCampaignOptions(workspaceId, signal)
            : Promise.resolve<CampaignOption[]>([]),
          includeOverview
            ? fetchAvailableTemplateOptions(workspaceId, signal)
            : Promise.resolve<TemplateOption[]>([]),
        ]);
        return NextResponse.json({
          ...emptyAnalyticsResponse({
            workspaceId,
            days,
            startDate,
            endDate,
            replyWindowHours,
            campaigns,
            templates: availableTemplates,
          }),
          dataQuality,
          snapshotToken,
        });
      }
    }

    const campaignsPromise = includeOverview
      ? fetchCampaignOptions(workspaceId, signal)
      : Promise.resolve<CampaignOption[]>([]);
    const availableTemplatesPromise = includeOverview
      ? fetchAvailableTemplateOptions(workspaceId, signal)
      : Promise.resolve<TemplateOption[]>([]);

    if (
      !snapshot &&
      campaignIds.length === 0 &&
      conversationScope === "campaign_sends" &&
      !excludeTemplates
    ) {
      const receiptCampaignIds = await fetchBulkAnalyticsCampaignIds({
        workspaceId,
        startDate,
        endDate,
        signal,
      });
      sqlReceipts = await fetchBulkCampaignDeliveryReceipts({
        campaignIds: receiptCampaignIds,
        signal,
      });
    }
    if (!snapshotToken)
      snapshotToken = await saveBulkAnalyticsSnapshot({
        workspaceId,
        filterKey,
        observedAt: observedAt.toISOString(),
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        receipts: sqlReceipts,
      });
    if (!snapshotToken) dataQuality.reasons.push("snapshot_cache_unavailable");
    endDate = new Date(Math.min(endDate.getTime(), observedAt.getTime()));
    const reconciliationStages = buildBulkReconciledSendStages({
      workspaceId,
      startDate,
      observedAt,
      sqlReceipts,
    });

    const baseMatch = buildBulkAnalyticsSendBaseMatch({
      workspaceId,
      startDate,
      endDate,
      campaignMessageIds,
      templateNames,
      empty: excludeTemplates,
    });

    const baseStages: PipelineStage[] = [
      { $match: baseMatch },
      ...reconciliationStages,
      // Base match already applied template predicates; skip duplicate prefilter.
      ...buildTemplateNameStages(templateNames, { skipPrefilter: true }),
    ];

    const optionStages: PipelineStage[] = [
      {
        $match: buildBulkAnalyticsSendBaseMatch({
          workspaceId,
          startDate,
          endDate,
          campaignMessageIds,
          empty: excludeTemplates,
        }),
      },
      ...reconciliationStages,
      ...buildTemplateNameStages([], { skipPrefilter: true }),
      {
        $group: {
          _id: "$templateName",
          count: { $sum: 1 },
          firstSentAt: { $min: "$date" },
          lastSentAt: { $max: "$date" },
        },
      },
      { $sort: { count: -1 as const, _id: 1 as const } },
      { $limit: 100 },
    ];

    // Pre-compute matching conversation IDs via Atlas Search. One fast Lucene
    // query replaces per-conversation regex `$lookup` scans. It is scoped to
    // the analytics date window so the filter matches the visible period, not
    // the conversation's full lifetime.
    const textSearchDateRange = { from: startDate, to: endDate };
    const messageContainsResult =
      view === "compare"
        ? null
        : await fetchConversationIdsMatchingMessageText({
            workspaceId,
            query: messageContains,
            dateRange: textSearchDateRange,
            // Collect first-match previews for the `records` table, but only for
            // `contains` mode — `not_contains` has nothing to display per row.
            signal,
            maxTimeMS: remaining(),
            collectMatchDetails:
              includeRecords && messageContainsMode === "contains",
          });

    // Truncated match sets are incomplete for both modes:
    // - `contains` would under-count (silent wrong subset)
    // - `not_contains` would include real matches past the cap as "not matching"
    // Refuse with a controlled 400 instead of returning a wrong answer.
    if (messageContainsResult?.truncated) {
      const error =
        messageContainsMode === "not_contains"
          ? "The messageContains filter matches too many conversations to exclude safely. Please use a more specific keyword."
          : "The messageContains filter matches too many conversations to include safely. Please use a more specific keyword or a narrower date range.";
      return NextResponse.json(
        {
          error,
          code: "MESSAGE_CONTAINS_TOO_BROAD",
        },
        { status: 400 }
      );
    }

    const messageContainsConversationIds = messageContainsResult?.ids ?? null;

    const messageContainsStages = buildMessageContainsStages({
      conversationIds: messageContainsConversationIds,
      mode: messageContainsMode,
    });

    const postFilterStages: PipelineStage[] = buildBulkDeliveryFilterStages(
      deliveryStatus,
      deliveryErrorCode
    );

    postFilterStages.push(...buildBulkRecipientSearchStages(recipientSearch));
    if (status === "replied") {
      postFilterStages.push({ $match: { replied: true } });
    } else if (status === "not_replied") {
      postFilterStages.push({ $match: { replied: false } });
    }
    const engagementMatch = buildEngagementScoreMatch(
      "conversationDoc.engagement_metrics.score",
      engagement
    );
    if (engagementMatch) {
      postFilterStages.push({ $match: engagementMatch });
    }

    const previousWindow = computePreviousAnalyticsWindow(startDate, endDate);
    const shouldComparePrevious =
      (includeOverview || view === "compare") &&
      conversationScope === "campaign_sends" &&
      compareMode === "previous";

    const comparePromise = shouldComparePrevious
      ? (async () => {
          const previousTextSearch =
            messageContains && messageContains.trim()
              ? await fetchConversationIdsMatchingMessageText({
                  workspaceId,
                  query: messageContains,
                  dateRange: {
                    from: previousWindow.startDate,
                    to: previousWindow.endDate,
                  },
                  collectMatchDetails: false,
                  signal,
                  maxTimeMS: remaining(),
                })
              : null;
          if (previousTextSearch?.truncated) {
            return null;
          }
          const previousMessageContainsStages = buildMessageContainsStages({
            conversationIds: previousTextSearch?.ids ?? null,
            mode: messageContainsMode,
          });
          const previousBaseMatch = buildBulkAnalyticsSendBaseMatch({
            workspaceId,
            startDate: previousWindow.startDate,
            endDate: previousWindow.endDate,
            campaignMessageIds,
            templateNames,
            empty: excludeTemplates,
          });
          const previousReceiptCampaigns = campaignIds.length
            ? campaignIds
            : await fetchBulkAnalyticsCampaignIds({
                workspaceId,
                startDate: previousWindow.startDate,
                endDate: previousWindow.endDate,
                signal,
              });
          const previousSqlReceipts = campaignIds.length
            ? sqlReceipts
            : await fetchBulkCampaignDeliveryReceipts({
                campaignIds: previousReceiptCampaigns,
                signal,
              });
          const previousResult = await Message.aggregate([
            { $match: previousBaseMatch },
            ...buildBulkReconciledSendStages({
              workspaceId,
              startDate: previousWindow.startDate,
              observedAt,
              sqlReceipts: previousSqlReceipts,
            }),
            ...buildTemplateNameStages(templateNames, { skipPrefilter: true }),
            ...previousMessageContainsStages,
            ...buildEnrichmentStages({
              workspaceId,
              replyWindowHours,
              observedThrough: observedAt,
              outboundMessageIdsField: "providerMessageIds",
            }),
            ...postFilterStages,
            {
              $facet: {
                summary: buildBulkSendSummaryFacetStages(),
                outcomes: buildBulkSendOutcomesFacetStages(),
              },
            },
          ])
            .allowDiskUse(true)
            .option({ maxTimeMS: remaining(), signal });
          const row = previousResult?.[0] || {};
          return {
            window: {
              startDate: previousWindow.startDate.toISOString(),
              endDate: previousWindow.endDate.toISOString(),
            },
            summary: normalizeBulkSendSummary(row.summary?.[0], {
              includeDeliveryEconomics: true,
            }),
            outcomes: row.outcomes || [],
          };
        })()
      : Promise.resolve(null);

    const conversationCandidateStages =
      conversationScope === "campaign_sends"
        ? []
        : buildConversationCandidateStages({
            workspaceId,
            startDate,
            endDate,
            conversationScope,
            campaignMessageIds,
            templateNames,
            messageContainsConversationIds,
            messageContainsMode,
            status: statusFilter,
            engagement,
            excludeRecentClientMessageWithin24h: false,
            excludeTemplates,
            replyWindowHours,
          });

    conversationCandidateStages.push(
      ...buildBulkRecipientSearchStages(recipientSearch, true)
    );

    const conversationAnalyticsPromise =
      includeOverview && conversationScope !== "campaign_sends"
        ? Conversation.aggregate([
            ...conversationCandidateStages,
            {
              $facet: {
                summary: [
                  {
                    $group: {
                      _id: null,
                      totalAccepted: { $sum: 1 },
                      conversations: { $addToSet: "$conversationIdString" },
                      replied: {
                        $sum: { $cond: ["$replied", 1, 0] },
                      },
                      totalReplies: { $sum: "$replyCount" },
                      avgReplyDelayMinutes: { $avg: "$replyDelayMinutes" },
                      firstSentAt: { $min: "$sortAt" },
                      lastSentAt: { $max: "$sortAt" },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      totalAccepted: 1,
                      uniqueConversations: { $size: "$conversations" },
                      replied: 1,
                      notReplied: { $subtract: ["$totalAccepted", "$replied"] },
                      totalReplies: 1,
                      replyRate: {
                        $cond: [
                          { $gt: ["$totalAccepted", 0] },
                          { $divide: ["$replied", "$totalAccepted"] },
                          0,
                        ],
                      },
                      // Conversation-pool summary has no per-send Meta signals.
                      read: { $literal: null },
                      readRate: { $literal: null },
                      delivered: { $literal: null },
                      deliveryRate: { $literal: null },
                      failed: { $literal: null },
                      failedRate: { $literal: null },
                      estimatedCost: { $literal: null },
                      costPerReply: { $literal: null },
                      avgReplyDelayMinutes: 1,
                      firstSentAt: 1,
                      lastSentAt: 1,
                    },
                  },
                ],
              },
            },
          ])
            .allowDiskUse(true)
            .option({ maxTimeMS: remaining(), signal })
        : Promise.resolve(null);

    // Send-pipeline facets (byTemplate / daily / replyCategories / detectedRuns /
    // topConversations) describe accepted template sends. Conversation-pool
    // scopes use a different audience for `summary`/`records`, so running this
    // aggregate would surface mismatched totals. Skip it and return empty
    // facet arrays for those scopes instead.
    const analyticsOverviewPromise =
      includeOverview && conversationScope === "campaign_sends"
        ? Message.aggregate([
            ...baseStages,
            // Hoist the text pre-filter so enrichment `$lookup`s only run on
            // sends whose conversation matched the text.
            ...messageContainsStages,
            ...buildEnrichmentStages({
              workspaceId,
              replyWindowHours,
              observedThrough: observedAt,
              outboundMessageIdsField: "providerMessageIds",
            }),
            ...postFilterStages,
            {
              $facet: {
                summary: buildBulkSendSummaryFacetStages(),
                outcomes: buildBulkSendOutcomesFacetStages(),
                failures: buildBulkSendFailuresFacetStages(),
                byTemplate: [
                  {
                    $group: {
                      _id: "$templateName",
                      accepted: { $sum: 1 },
                      replied: { $sum: { $cond: ["$replied", 1, 0] } },
                      totalReplies: { $sum: "$replyCount" },
                      avgReplyDelayMinutes: { $avg: "$replyDelayMinutes" },
                      firstSentAt: { $min: "$date" },
                      lastSentAt: { $max: "$date" },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      templateName: "$_id",
                      accepted: 1,
                      replied: 1,
                      notReplied: { $subtract: ["$accepted", "$replied"] },
                      totalReplies: 1,
                      replyRate: {
                        $cond: [
                          { $gt: ["$accepted", 0] },
                          { $divide: ["$replied", "$accepted"] },
                          0,
                        ],
                      },
                      avgReplyDelayMinutes: 1,
                      firstSentAt: 1,
                      lastSentAt: 1,
                    },
                  },
                  { $sort: { accepted: -1, templateName: 1 } },
                ],
                daily: [
                  {
                    $group: {
                      _id: {
                        $dateToString: {
                          date: "$date",
                          format: "%Y-%m-%d",
                          timezone,
                        },
                      },
                      accepted: { $sum: 1 },
                      replied: { $sum: { $cond: ["$replied", 1, 0] } },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      date: "$_id",
                      accepted: 1,
                      replied: 1,
                      replyRate: {
                        $cond: [
                          { $gt: ["$accepted", 0] },
                          { $divide: ["$replied", "$accepted"] },
                          0,
                        ],
                      },
                    },
                  },
                  { $sort: { date: 1 } },
                ],
                replyCategories: [
                  {
                    $group: {
                      _id: "$replyCategory",
                      count: { $sum: 1 },
                    },
                  },
                  { $project: { _id: 0, category: "$_id", count: 1 } },
                  { $sort: { count: -1, category: 1 } },
                ],
                detectedRuns: [
                  {
                    $group: {
                      _id: {
                        templateName: "$templateName",
                        hour: {
                          $dateToString: {
                            date: "$date",
                            format: "%Y-%m-%d %H:00",
                            timezone,
                          },
                        },
                      },
                      accepted: { $sum: 1 },
                      replied: { $sum: { $cond: ["$replied", 1, 0] } },
                      firstSentAt: { $min: "$date" },
                      lastSentAt: { $max: "$date" },
                    },
                  },
                  { $match: { accepted: { $gte: DEFAULT_MIN_RUN_SIZE } } },
                  {
                    $project: {
                      _id: 0,
                      templateName: "$_id.templateName",
                      bucket: "$_id.hour",
                      accepted: 1,
                      replied: 1,
                      replyRate: {
                        $cond: [
                          { $gt: ["$accepted", 0] },
                          { $divide: ["$replied", "$accepted"] },
                          0,
                        ],
                      },
                      firstSentAt: 1,
                      lastSentAt: 1,
                    },
                  },
                  { $sort: { firstSentAt: -1 } },
                  { $limit: 100 },
                ],
                topConversations: [
                  { $match: { replied: true } },
                  { $sort: { replyCount: -1, "firstReply.date": 1 } },
                  { $limit: 20 },
                  {
                    $project: {
                      _id: 0,
                      conversationId: "$conversationIdString",
                      recipient: 1,
                      templateName: 1,
                      sentAt: "$date",
                      firstReplyAt: "$firstReply.date",
                      firstReplyText: 1,
                      replyCount: 1,
                      replyDelayMinutes: 1,
                    },
                  },
                ],
              },
            },
          ])
            .allowDiskUse(true)
            .option({ maxTimeMS: remaining(), signal })
        : Promise.resolve(null);

    const recordsPromise: Promise<Record<string, unknown>[]> = includeRecords
      ? conversationScope === "campaign_sends"
        ? Message.aggregate<Record<string, unknown>>(
            buildSendRecordsPipeline({
              baseStages,
              messageContainsStages,
              postFilterStages,
              workspaceId,
              replyWindowHours,
              limit,
              cursor: recordsCursor,
              observedThrough: observedAt,
            })
          )
            .allowDiskUse(true)
            .option({ maxTimeMS: remaining(), signal })
        : Conversation.aggregate<Record<string, unknown>>(
            buildConversationRecordsPipeline({
              candidateStages: conversationCandidateStages,
              limit,
              cursor: recordsCursor,
            })
          )
            .allowDiskUse(true)
            .option({ maxTimeMS: remaining(), signal })
      : Promise.resolve([]);

    const reuseOverviewTemplateUsage =
      includeOverview &&
      conversationScope === "campaign_sends" &&
      templateNames.length === 0;

    const [
      campaigns,
      usageTemplateOptionsRaw,
      availableTemplates,
      analyticsResult,
      conversationAnalytics,
      rawRecords,
      compareResult,
    ] = await Promise.all([
      campaignsPromise,
      includeOverview && !reuseOverviewTemplateUsage
        ? Message.aggregate(optionStages)
            .allowDiskUse(true)
            .option({ maxTimeMS: remaining(), signal })
        : Promise.resolve([]),
      availableTemplatesPromise,
      analyticsOverviewPromise,
      conversationAnalyticsPromise,
      recordsPromise,
      comparePromise,
    ]);

    if (view === "compare") {
      return NextResponse.json({
        workspaceId,
        generatedAt: new Date().toISOString(),
        dataQuality,
        snapshotToken,
        compare: compareResult,
      });
    }

    const result = analyticsResult?.[0] || {};
    const conversationResult = conversationAnalytics?.[0] || {};
    const isCampaignSendsScope = conversationScope === "campaign_sends";
    const summary = isCampaignSendsScope
      ? normalizeBulkSendSummary(result.summary?.[0], {
          includeDeliveryEconomics: true,
        })
      : normalizeBulkSendSummary(conversationResult.summary?.[0], {
          includeDeliveryEconomics: false,
        });
    // Non-campaign scopes: summary/records come from conversationCandidateStages.
    // Send-pipeline facets would describe a different audience — omit them.
    const sendFacets = isCampaignSendsScope
      ? {
          byTemplate: result.byTemplate || [],
          daily: result.daily || [],
          replyCategories: result.replyCategories || [],
          outcomes: result.outcomes || [],
          failures: result.failures || [],
          detectedRuns: result.detectedRuns || [],
          topConversations: result.topConversations || [],
        }
      : {
          byTemplate: [],
          daily: [],
          replyCategories: [],
          outcomes: [],
          failures: [],
          detectedRuns: [],
          topConversations: [],
        };

    // Hydrate the "matched message" UI columns JS-side from the Atlas Search
    // summary map. The previous per-conversation `$lookup` that populated
    // these fields was removed with the text-filter refactor, leaving the
    // `$project` stages always emitting null. Doing it here keeps the hot
    // pipeline lean and is O(records) — ~100-1k entries in practice.
    const paginatedRecords = paginateRecords({ rawRecords, limit });
    const matchesByConversation =
      messageContainsResult?.matchesByConversation ?? null;
    const records = matchesByConversation
      ? paginatedRecords.records.map(record => {
          const conversationId =
            typeof record.conversationId === "string"
              ? record.conversationId
              : "";
          const match = matchesByConversation.get(conversationId);
          if (!match) return record;
          return {
            ...record,
            matchedMessageCount: match.count,
            firstMatchedMessageAt: match.date,
            firstMatchedMessageText: match.text,
            firstMatchedMessageDirection: match.direction,
          };
        })
      : paginatedRecords.records;

    if (view === "records") {
      return NextResponse.json({
        workspaceId,
        generatedAt: new Date().toISOString(),
        dataQuality,
        snapshotToken,
        window: {
          days,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          replyWindowHours,
        },
        records,
        pageInfo: paginatedRecords.pageInfo,
      });
    }

    const usageTemplateOptions = reuseOverviewTemplateUsage
      ? (result.byTemplate || []).map(
          (row: {
            templateName?: unknown;
            accepted?: unknown;
            firstSentAt?: Date | string | null;
            lastSentAt?: Date | string | null;
          }) => ({
            _id: row.templateName,
            count: row.accepted,
            firstSentAt: row.firstSentAt ?? null,
            lastSentAt: row.lastSentAt ?? null,
          })
        )
      : usageTemplateOptionsRaw;

    const templateOptions = mergeTemplateOptions({
      available: availableTemplates,
      used: usageTemplateOptions,
    });

    return NextResponse.json({
      workspaceId,
      generatedAt: new Date().toISOString(),
      dataQuality,
      snapshotToken,
      window: {
        days,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        replyWindowHours,
      },
      filters: {
        applied: {
          templates: templateNames,
          campaignIds,
          status,
          deliveryStatus,
          deliveryErrorCode,
          recipientSearch,
          messageContains,
          messageContainsMode,
          engagement,
          conversationScope,
          timezone,
          excludeTemplates,
          compare: compareMode,
        },
        templates: templateOptions,
        campaigns,
      },
      summary,
      compare: compareResult,
      ...sendFacets,
      records,
      pageInfo: paginatedRecords.pageInfo,
      note: "Accepted sends are Mongo outbound WhatsApp template messages with Meta wamid IDs. Conversation pool modes can return WhatsApp conversations that have no accepted bulk send yet. Replies are inbound WhatsApp messages in the same conversation before the next outbound message or selected reply window for send analytics.",
    });
  } catch (error) {
    if (error instanceof BulkAnalyticsRecipientSearchError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    if (
      error instanceof BulkAnalyticsQueryError ||
      error instanceof BulkAnalyticsAudienceUnavailableError
    )
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          dataQuality: {
            complete: false,
            reasons: [error.code],
            observedAt: new Date().toISOString(),
            consistency: "bounded_observation",
          },
        },
        {
          status: error instanceof BulkAnalyticsQueryError ? error.status : 503,
        }
      );
    if (signal.aborted)
      return NextResponse.json(
        {
          error: "Analytics query exceeded its execution budget",
          code: "ANALYTICS_TIMEOUT",
        },
        { status: 504 }
      );
    logger.error("[Bulk Analytics API] GET error", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest, context: { params: Params }) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  const params = request.nextUrl.searchParams;
  let executionSignal: AbortSignal | undefined;
  const key = `bulk-analytics:v2:${workspaceId}:${Array.from(params.entries())
    .filter(([name]) => name !== "refresh")
    .sort()
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")}`;
  try {
    const shared = withAnalyticsQueryBudget({
      run: async budget => {
        executionSignal = budget.signal;
        const snapshotToken = params.get("snapshotToken");
        const snapshot = snapshotToken
          ? await awaitWithCancellation(
              readBulkAnalyticsSnapshot(
                snapshotToken,
                workspaceId,
                bulkAnalyticsFilterKey(workspaceId, params)
              ),
              budget.signal
            )
          : undefined;
        return readCachedLocalAnalytics({
          key,
          refresh: params.get("refresh") === "1",
          signal: budget.signal,
          run: async () => {
            const response = await generateBulkAnalyticsResponse(
              request,
              context,
              { signal: budget.signal, deadline: budget.deadlineAt, snapshot }
            );
            const body = await response.json();
            if (!response.ok)
              throw new BulkAnalyticsQueryError(
                body.code || "ANALYTICS_UNAVAILABLE",
                body.error || "Analytics unavailable",
                response.status
              );
            return body as Record<string, unknown>;
          },
        });
      },
    });
    const raw = await awaitWithCancellation(shared, request.signal);
    return NextResponse.json(raw);
  } catch (error) {
    if (executionSignal?.aborted && !request.signal.aborted)
      return NextResponse.json(
        {
          error: "Analytics query exceeded its execution budget",
          code: "ANALYTICS_TIMEOUT",
          dataQuality: {
            complete: false,
            reasons: ["ANALYTICS_TIMEOUT"],
            observedAt: new Date().toISOString(),
            consistency: "bounded_observation",
          },
        },
        { status: 504 }
      );
    if (request.signal.aborted)
      return NextResponse.json(
        { error: "Analytics request cancelled", code: "ANALYTICS_CANCELLED" },
        { status: 499 }
      );
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Analytics unavailable",
        code:
          error instanceof BulkAnalyticsQueryError
            ? error.code
            : "ANALYTICS_UNAVAILABLE",
        dataQuality: {
          complete: false,
          reasons: [
            error instanceof BulkAnalyticsQueryError
              ? error.code
              : "ANALYTICS_UNAVAILABLE",
          ],
          observedAt: new Date().toISOString(),
          consistency: "bounded_observation",
        },
      },
      { status: error instanceof BulkAnalyticsQueryError ? error.status : 503 }
    );
  }
}
