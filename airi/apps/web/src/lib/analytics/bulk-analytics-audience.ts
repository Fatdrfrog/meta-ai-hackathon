import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { stripWhatsAppMessageIdPrefix } from "@icecore/shared/lib/whatsapp/message-id";
import {
  buildCanonicalProviderMessageIdExpr,
  buildNormalizedWhatsAppPhoneExpr,
  buildWhatsAppDeliveryReconciliationStages,
  type BulkSqlDeliveryReceipt,
} from "./whatsapp-delivery-reconciliation";
import type { CampaignAdHocRecipient } from "@/lib/campaign/campaign-recipient-utils";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "@/lib/campaign/bulk-campaign-contracts";
import {
  buildWhatsAppMessageCostUsdExpr,
  finalizeCostPerReplyValue,
  roundUsd,
} from "@/lib/campaign/whatsapp-campaign-cost";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import Message from "@/models/message";
import mongoose, { type PipelineStage } from "mongoose";
import { escapeRegExp } from "@/lib/regex-utils";
import type {
  BulkAnalyticsAudienceFilters,
  BulkAnalyticsConversationScope,
  BulkAnalyticsEngagement,
  BulkAnalyticsMessageContainsMode,
  BulkAnalyticsStatus,
  BulkAnalyticsDeliveryStatus,
} from "./bulk-analytics-contract";
import {
  isBulkAnalyticsAudienceResolvable,
  normalizeBulkAnalyticsRecipientSearch,
} from "./bulk-analytics-contract";

export { isBulkAnalyticsAudienceResolvable };

const MESSAGES_TEXT_SEARCH_INDEX = "messages_text_search";
const MAX_TEXT_SEARCH_CONVERSATION_IDS = 50_000;
const MAX_TEXT_SEARCH_MESSAGE_SCAN = 200_000;
const ACCEPTED_WHATSAPP_MESSAGE_ID_PREFIXES = ["wamid.", "ws_wamid."] as const;
const CAMPAIGN_HISTORY_PAGE_SIZE = 1000;
const CAMPAIGN_MESSAGES_PAGE_SIZE = 1000;
const MAX_CAMPAIGN_HISTORY_IDS = MAX_BULK_CAMPAIGN_RECIPIENTS;

type LookupPipeline = NonNullable<PipelineStage.Lookup["$lookup"]["pipeline"]>;

/**
 * `$arrayElemAt` on an empty lookup yields a missing value, not null.
 * `$ne: [missing, null]` is true in `$expr`, so callers that treat "no next
 * outbound" as "use the reply-window end" must coalesce missing → null first.
 */
function firstLookupDateOrNull(arrayDatePath: string) {
  return {
    $ifNull: [{ $arrayElemAt: [arrayDatePath, 0] }, null],
  };
}

function buildIndexedConversationMessageLookup(params: {
  as: string;
  localField: string;
  workspaceId: string;
  direction: "inbound" | "outbound";
  let: Record<string, unknown>;
  dateExpr: Array<Record<string, unknown>>;
  pipelineTail: LookupPipeline;
}): PipelineStage.Lookup {
  return {
    $lookup: {
      from: "messages",
      localField: params.localField,
      foreignField: "conversation",
      let: params.let,
      pipeline: [
        {
          $match: {
            workspaceId: params.workspaceId,
            channel: "whatsapp",
            direction: params.direction,
          },
        },
        {
          $match: {
            $expr: { $and: params.dateExpr },
          },
        },
        ...params.pipelineTail,
      ],
      as: params.as,
    },
  };
}

export type MessageTextSearchDirection = "inbound" | "outbound";

export type MessageTextSearchMatch = {
  text: string | null;
  date: Date | null;
  direction: string | null;
  messageId: string | null;
  count: number;
};

export type MessageTextSearchResult = {
  ids: string[];
  truncated: boolean;
  matchesByConversation: Map<string, MessageTextSearchMatch> | null;
};

type NormalizedBulkAnalyticsAudienceFilters = {
  days: number;
  startDate: Date;
  endDate: Date;
  timezone: string;
  templateNames: string[];
  campaignIds: string[];
  status: BulkAnalyticsStatus;
  deliveryStatus?: BulkAnalyticsDeliveryStatus;
  deliveryErrorCode?: string | null;
  recipientSearch?: string | null;
  engagement: BulkAnalyticsEngagement;
  conversationScope: BulkAnalyticsConversationScope;
  messageContains: string | null;
  messageContainsMode: BulkAnalyticsMessageContainsMode;
  replyWindowHours: number;
  excludeRecentClientMessageWithin24h: boolean;
  excludeTemplates: boolean;
};

export type BulkAnalyticsAudienceRecipient = CampaignAdHocRecipient & {
  conversationId: string;
  optedIn: boolean;
};

export type BulkAnalyticsResolvedAudience = {
  total: number;
  eligibleTotal: number;
  excludedOptIn: number;
  marketingOptInWarningCount: number;
  recipients: BulkAnalyticsAudienceRecipient[];
  capped: boolean;
  maxRecipients: number;
};

export class BulkAnalyticsAudienceUnavailableError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BulkAnalyticsAudienceUnavailableError";
    this.code = code;
  }
}

const DEFAULT_DAYS = 14;
const DEFAULT_REPLY_WINDOW_HOURS = 168;
const CLIENT_MESSAGE_WINDOW_HOURS = 24;
const MAX_CAMPAIGN_MESSAGE_IDS = 20_000;
const MAX_CAMPAIGN_AUDIENCE_MESSAGE_ROWS = MAX_BULK_CAMPAIGN_RECIPIENTS + 1;

function parsePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;

  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function normalizeOptionalString(value: unknown): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.toLowerCase() === "all") return null;
  return trimmed;
}

export function normalizeStringList(values: unknown): string[] {
  const rawValues = Array.isArray(values) ? values : values ? [values] : [];
  const normalized = rawValues
    .flatMap(value => String(value || "").split(","))
    .map(value => value.trim())
    .filter(value => value && value.toLowerCase() !== "all");

  return Array.from(new Set(normalized));
}

function buildAtlasSearchValueFilter(
  path: string,
  values: readonly unknown[]
): Record<string, unknown> {
  if (values.length === 1) {
    return { equals: { path, value: values[0] } };
  }
  return { in: { path, value: values } };
}

export function buildAcceptedWhatsAppMessageIdMatch(): Record<string, unknown> {
  // Single anchored alternation so the planner can still treat this as a
  // residual filter on top of workspace/channel/direction/date index bounds.
  return {
    messageId: {
      $regex: `^(?:${ACCEPTED_WHATSAPP_MESSAGE_ID_PREFIXES.map(escapeRegExp).join("|")})`,
    },
  };
}

function buildTemplateTextPrefixRegex(
  templateNames: readonly string[]
): RegExp | null {
  if (templateNames.length === 0) return null;
  const alternatives = templateNames.map(escapeRegExp).join("|");
  return new RegExp(`^\\[Template:\\s*(?:${alternatives})\\]`, "i");
}

/**
 * Index-backed early filter for template sends.
 * Uses `whatsappTemplate.name` / `origin.templateName` compound indexes instead
 * of scanning every accepted outbound and `$regexFind`-parsing text.
 */
export function buildHasTemplateNameMatch(
  templateNames: readonly string[] = []
): Record<string, unknown> {
  const normalized = normalizeStringList(templateNames);
  if (normalized.length > 0) {
    const textRegex = buildTemplateTextPrefixRegex(normalized);
    return {
      $or: [
        { "whatsappTemplate.name": { $in: normalized } },
        { "origin.templateName": { $in: normalized } },
        ...(textRegex ? [{ text: textRegex }] : []),
      ],
    };
  }

  return {
    $or: [
      { "whatsappTemplate.name": { $gt: "" } },
      { "origin.templateName": { $gt: "" } },
      // Rare legacy rows that only embed the template name in message text.
      { text: { $regex: /^\[Template:/i } },
    ],
  };
}

/**
 * Campaign-send analytics base match. Equality fields first, then date range,
 * then template-name predicates that hit existing compound indexes.
 */
export function buildBulkAnalyticsSendBaseMatch(params: {
  workspaceId: string;
  startDate: Date;
  endDate: Date;
  campaignMessageIds?: string[] | null;
  templateNames?: readonly string[];
  empty?: boolean;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    channel: "whatsapp",
    direction: "outbound",
    date: {
      $gte: params.startDate,
      $lte: params.endDate,
    },
  };

  if (params.empty) {
    return { ...base, messageId: { $in: [] as string[] } };
  }

  if (params.campaignMessageIds) {
    return {
      ...base,
      messageId: { $in: params.campaignMessageIds },
      ...buildHasTemplateNameMatch(params.templateNames || []),
    };
  }

  return {
    ...base,
    $and: [
      buildAcceptedWhatsAppMessageIdMatch(),
      buildHasTemplateNameMatch(params.templateNames || []),
    ],
  };
}

function buildTemplateNamePrefilterStage(
  templateNames: readonly string[]
): PipelineStage.Match | null {
  const normalized = normalizeStringList(templateNames);
  if (normalized.length === 0) return null;
  return {
    $match: buildHasTemplateNameMatch(normalized),
  };
}

export function parseBulkAnalyticsStatus(value: unknown): BulkAnalyticsStatus {
  if (value === "replied" || value === "not_replied") {
    return value;
  }
  return "all";
}

function parseConversationScope(
  value: unknown
): BulkAnalyticsConversationScope {
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

function parseMessageContainsMode(
  value: unknown
): BulkAnalyticsMessageContainsMode {
  return value === "not_contains" ? "not_contains" : "contains";
}

function parseEngagementBucket(value: unknown): BulkAnalyticsEngagement {
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

export function buildEngagementScoreMatch(
  field: string,
  engagement: BulkAnalyticsEngagement
): Record<string, unknown> | null {
  if (engagement === "high") return { [field]: { $gte: 70 } };
  if (engagement === "medium") return { [field]: { $gte: 40, $lt: 70 } };
  if (engagement === "low") return { [field]: { $gt: 0, $lt: 40 } };
  if (engagement === "unscored") {
    return {
      $or: [
        { [field]: { $exists: false } },
        { [field]: null },
        { [field]: { $lte: 0 } },
      ],
    };
  }
  return null;
}

function parseDate(value: unknown): Date | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeTimezone(value: unknown): string {
  const trimmed = String(value || "").trim();
  if (!trimmed || !/^[A-Za-z0-9_+\-/:]+$/.test(trimmed)) return "UTC";
  return trimmed;
}

/**
 * Escape Lucene wildcard metacharacters so the user's query is treated as a
 * literal substring instead of a Lucene pattern. Atlas Search `wildcard`
 * treats `?` and `*` as wildcards and `\` as an escape character.
 */
function escapeLuceneWildcard(value: string): string {
  return value.replace(/([\\?*])/g, "\\$1");
}

export function buildMessageTextSearchPipeline(params: {
  workspaceId: string;
  query: string | null;
  dateRange?: { from: Date; to: Date } | null;
  collectMatchDetails?: boolean;
  directions?: readonly MessageTextSearchDirection[] | null;
  conversationIds?: readonly string[] | null;
}): PipelineStage[] {
  const groups = parseKeywordGroups(params.query);
  if (groups.length === 0) return [];

  const shouldClauses: Record<string, unknown>[] = [];
  for (const group of groups) {
    const wildcardQuery = `*${escapeLuceneWildcard(group.toLocaleLowerCase())}*`;
    shouldClauses.push(
      {
        phrase: {
          query: group,
          path: ["text", "whatsappTemplate.name", "messageId"],
        },
      },
      {
        wildcard: {
          query: wildcardQuery,
          path: "text",
          allowAnalyzedField: true,
        },
      },
      {
        wildcard: {
          query: wildcardQuery,
          path: "whatsappTemplate.name",
          allowAnalyzedField: true,
        },
      }
    );
  }

  const filterClauses: Record<string, unknown>[] = [
    { equals: { path: "workspaceId", value: params.workspaceId } },
    { equals: { path: "channel", value: "whatsapp" } },
  ];
  const directions = Array.from(new Set(params.directions || []));
  if (directions.length > 0) {
    filterClauses.push(buildAtlasSearchValueFilter("direction", directions));
  }
  if (params.conversationIds) {
    const conversationIds = toObjectIds(params.conversationIds);
    if (conversationIds.length === 0) {
      return [{ $match: { _id: { $exists: false } } }];
    }
    filterClauses.push(
      buildAtlasSearchValueFilter("conversation", conversationIds)
    );
  }
  if (params.dateRange) {
    filterClauses.push({
      range: {
        path: "date",
        gte: params.dateRange.from,
        lte: params.dateRange.to,
      },
    });
  }

  const conversationLimit = MAX_TEXT_SEARCH_CONVERSATION_IDS + 1;
  const messageScanLimit = MAX_TEXT_SEARCH_MESSAGE_SCAN + 1;
  const searchStage: Record<string, unknown> = {
    index: MESSAGES_TEXT_SEARCH_INDEX,
    returnStoredSource: true,
    compound: {
      filter: filterClauses,
      should: shouldClauses,
      minimumShouldMatch: 1,
    },
  };

  const conversationStages: PipelineStage[] = params.collectMatchDetails
    ? [
        {
          $group: {
            _id: "$conversation",
            count: { $sum: 1 },
            firstText: { $first: "$text" },
            firstDate: { $first: "$date" },
            firstDirection: { $first: "$direction" },
            firstMessageId: { $first: "$messageId" },
          },
        },
        { $limit: conversationLimit },
      ]
    : [{ $group: { _id: "$conversation" } }, { $limit: conversationLimit }];

  // Cap messages at MAX+1 so callers can detect scan exhaustion separately
  // from the conversation-ID cap. Without this, `not_contains` treats
  // un-scanned matching conversations as non-matches.
  const pipeline: PipelineStage[] = [
    {
      $search: searchStage,
    },
    { $limit: messageScanLimit },
    {
      $facet: {
        scanMeta: [{ $count: "scannedMessages" }],
        conversations:
          conversationStages as PipelineStage.Facet["$facet"][string],
      },
    },
  ];

  return pipeline;
}

export async function fetchConversationIdsMatchingMessageText(params: {
  workspaceId: string;
  query: string | null;
  dateRange?: { from: Date; to: Date } | null;
  collectMatchDetails?: boolean;
  signal?: AbortSignal;
  maxTimeMS?: number;
}): Promise<MessageTextSearchResult | null> {
  const pipeline = buildMessageTextSearchPipeline(params);
  if (pipeline.length === 0) return null;

  await connectDB();

  type DetailedRow = {
    _id: mongoose.Types.ObjectId;
    count?: number;
    firstText?: string | null;
    firstDate?: Date | null;
    firstDirection?: string | null;
    firstMessageId?: string | null;
  };

  type FacetRow = {
    scanMeta?: Array<{ scannedMessages?: number }>;
    conversations?: DetailedRow[];
  };

  const aggregate = Message.aggregate<FacetRow>(pipeline).allowDiskUse(true);
  if (params.signal)
    aggregate.option({
      signal: params.signal,
      maxTimeMS: params.maxTimeMS || 25000,
    });
  const facetRows = await aggregate;
  const facet = facetRows[0] || {};
  const scannedMessages = Number(facet.scanMeta?.[0]?.scannedMessages || 0);
  const results = Array.isArray(facet.conversations) ? facet.conversations : [];
  const scanCapped = scannedMessages > MAX_TEXT_SEARCH_MESSAGE_SCAN;

  const matchesByConversation: Map<string, MessageTextSearchMatch> | null =
    params.collectMatchDetails ? new Map() : null;
  const ids = new Set<string>();
  for (const row of results) {
    if (!row || !row._id) continue;
    const convId = String(row._id);
    ids.add(convId);
    if (matchesByConversation && !matchesByConversation.has(convId)) {
      matchesByConversation.set(convId, {
        text: row.firstText ?? null,
        date: row.firstDate ?? null,
        direction: row.firstDirection ?? null,
        messageId: row.firstMessageId ?? null,
        count: row.count ?? 0,
      });
    }
  }

  const idArray = Array.from(ids);
  const conversationCapped = idArray.length > MAX_TEXT_SEARCH_CONVERSATION_IDS;
  const truncated = scanCapped || conversationCapped;
  const trimmedIds = conversationCapped
    ? idArray.slice(0, MAX_TEXT_SEARCH_CONVERSATION_IDS)
    : idArray;
  if (truncated && matchesByConversation) {
    const trimmedSet = new Set(trimmedIds);
    for (const key of matchesByConversation.keys()) {
      if (!trimmedSet.has(key)) matchesByConversation.delete(key);
    }
  }

  return {
    ids: trimmedIds,
    truncated,
    matchesByConversation,
  };
}

export function parseKeywordGroups(value: string | null): string[] {
  if (!value) return [];
  const groups: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/[,;|]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(trimmed);
  }
  return groups;
}

function buildExcludeRecentClientMessageWithin24hStage(params: {
  field: string;
  cutoffDate: Date;
}): PipelineStage.Match {
  return {
    $match: {
      $or: [
        { [params.field]: null },
        { [`${params.field}.date`]: null },
        { [`${params.field}.date`]: { $lt: params.cutoffDate } },
      ],
    },
  };
}

export function parseBulkAnalyticsAudienceFiltersFromSearchParams(
  searchParams: URLSearchParams
): BulkAnalyticsAudienceFilters {
  return {
    days: searchParams.get("days") || undefined,
    from: searchParams.get("from") || undefined,
    to: searchParams.get("to") || undefined,
    timezone: searchParams.get("timezone") || undefined,
    templates: [
      ...searchParams.getAll("template"),
      ...searchParams.getAll("templates"),
      ...searchParams.getAll("template[]"),
      ...searchParams.getAll("templates[]"),
    ],
    campaignIds: [
      ...searchParams.getAll("campaignId"),
      ...searchParams.getAll("campaignIds"),
      ...searchParams.getAll("campaignId[]"),
      ...searchParams.getAll("campaignIds[]"),
    ],
    status: parseBulkAnalyticsStatus(searchParams.get("status")),
    deliveryStatus: parseBulkAnalyticsDeliveryStatus(
      searchParams.get("deliveryStatus")
    ),
    deliveryErrorCode: searchParams.get("deliveryErrorCode") || undefined,
    recipientSearch:
      normalizeBulkAnalyticsRecipientSearch(
        searchParams.get("recipientSearch")
      ) || undefined,
    engagement: parseEngagementBucket(searchParams.get("engagement")),
    conversationScope: parseConversationScope(
      searchParams.get("conversationScope")
    ),
    messageContains: searchParams.get("messageContains") || undefined,
    messageContainsMode: parseMessageContainsMode(
      searchParams.get("messageContainsMode")
    ),
    replyWindowHours: searchParams.get("replyWindowHours") || undefined,
    excludeRecentClientMessageWithin24h: searchParams.has(
      "excludeRecentClientMessageWithin24h"
    )
      ? parseBoolean(searchParams.get("excludeRecentClientMessageWithin24h"))
      : undefined,
    excludeTemplates: searchParams.has("excludeTemplates")
      ? parseBoolean(searchParams.get("excludeTemplates"))
      : undefined,
  };
}

export function normalizeBulkAnalyticsAudienceFilters(
  filters: BulkAnalyticsAudienceFilters | null | undefined
): NormalizedBulkAnalyticsAudienceFilters {
  const input = filters || {};
  const excludeTemplates = parseBoolean(input.excludeTemplates);
  const days = parsePositiveInt(input.days, DEFAULT_DAYS, 1, 365);
  const replyWindowHours = parsePositiveInt(
    input.replyWindowHours,
    DEFAULT_REPLY_WINDOW_HOURS,
    1,
    24 * 30
  );
  const endDate = parseDate(input.to) || new Date();
  const startDate =
    parseDate(input.from) ||
    new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  return {
    days,
    startDate,
    endDate,
    timezone: normalizeTimezone(input.timezone),
    templateNames: excludeTemplates ? [] : normalizeStringList(input.templates),
    campaignIds: excludeTemplates ? [] : normalizeStringList(input.campaignIds),
    status: parseBulkAnalyticsStatus(input.status),
    deliveryStatus: parseBulkAnalyticsDeliveryStatus(input.deliveryStatus),
    deliveryErrorCode: normalizeOptionalString(input.deliveryErrorCode),
    recipientSearch: normalizeBulkAnalyticsRecipientSearch(
      input.recipientSearch
    ),
    engagement: parseEngagementBucket(input.engagement),
    conversationScope: parseConversationScope(input.conversationScope),
    messageContains: normalizeOptionalString(input.messageContains),
    messageContainsMode: parseMessageContainsMode(input.messageContainsMode),
    replyWindowHours,
    excludeRecentClientMessageWithin24h: parseBoolean(
      input.excludeRecentClientMessageWithin24h
    ),
    excludeTemplates,
  };
}

export function parseBulkAnalyticsDeliveryStatus(
  value: unknown
): BulkAnalyticsDeliveryStatus {
  if (value == null || value === "" || value === "all") return "all";
  if (
    ["accepted", "delivered", "read", "failed", "unknown"].includes(
      String(value)
    )
  )
    return value as BulkAnalyticsDeliveryStatus;
  throw new BulkAnalyticsAudienceUnavailableError(
    "DELIVERY_STATUS_INVALID",
    "Invalid delivery status"
  );
}

export async function fetchBulkCampaignDeliveryReceipts(params: {
  campaignIds: string[];
  signal?: AbortSignal;
}): Promise<BulkSqlDeliveryReceipt[]> {
  const campaignIds = Array.from(new Set(params.campaignIds));
  if (campaignIds.length > 100)
    throw new BulkAnalyticsAudienceUnavailableError(
      "CAMPAIGN_SCAN_LIMIT",
      "Select at most 100 campaigns"
    );
  const rows: BulkSqlDeliveryReceipt[] = [];
  let scanned = 0;
  for (const ids of chunkValues(campaignIds, 100)) {
    for (let offset = 0; ; offset += CAMPAIGN_MESSAGES_PAGE_SIZE) {
      params.signal?.throwIfAborted();
      let query = supabaseAdmin
        .from("campaign_messages")
        .select(
          "id,message_id,status,error_code,error_message,delivered_at,read_at,failed_at,attempted_at,recipient,phone"
        )
        .in("campaign_id", ids)
        .order("id", { ascending: true })
        .range(
          offset,
          offset +
            Math.min(
              CAMPAIGN_MESSAGES_PAGE_SIZE,
              MAX_CAMPAIGN_MESSAGE_IDS + 1 - scanned
            ) -
            1
        );
      if (params.signal) query = query.abortSignal(params.signal);
      const { data, error } = await query;
      if (error || !Array.isArray(data))
        throw new BulkAnalyticsAudienceUnavailableError(
          "CAMPAIGN_RECEIPTS_UNAVAILABLE",
          "Campaign receipt evidence could not be read completely"
        );
      scanned += data.length;
      if (scanned > MAX_CAMPAIGN_MESSAGE_IDS)
        throw new BulkAnalyticsAudienceUnavailableError(
          "CAMPAIGN_RECEIPTS_SCAN_LIMIT",
          "Campaign receipt evidence exceeds 20,000 rows. Narrow the campaign/date filters."
        );
      for (const row of data) {
        const providerMessageId = stripWhatsAppMessageIdPrefix(
          String(row.message_id || "").trim()
        );
        if (!providerMessageId.startsWith("wamid.")) continue;
        const status = String(row.status || "").toLowerCase();
        const attempt = parseDate(row.attempted_at);
        const readAt =
          parseDate(row.read_at) ||
          (["read", "played"].includes(status) ? attempt : null);
        const deliveredAt =
          parseDate(row.delivered_at) ||
          readAt ||
          (status === "delivered" ? attempt : null);
        const failedAt =
          parseDate(row.failed_at) || (status === "failed" ? attempt : null);
        rows.push({
          providerMessageId,
          providerRecipient:
            normalizeWhatsAppPhone(row.phone) ||
            normalizeWhatsAppPhone(row.recipient) ||
            null,
          providerRecipients: Array.from(
            new Set(
              [
                normalizeWhatsAppPhone(row.phone),
                normalizeWhatsAppPhone(row.recipient),
              ].filter((value): value is string => Boolean(value))
            )
          ),
          delivery: {
            status,
            sentAt: attempt,
            deliveredAt,
            readAt,
            failedAt,
            errorCode: row.error_code == null ? null : String(row.error_code),
            errorMessage:
              row.error_message == null ? null : String(row.error_message),
          },
        });
      }
      if (Buffer.byteLength(JSON.stringify(rows), "utf8") > 6_000_000)
        throw new BulkAnalyticsAudienceUnavailableError(
          "CAMPAIGN_RECEIPTS_SIZE_LIMIT",
          "Campaign receipt evidence exceeds the safe query payload. Narrow the filters."
        );
      if (data.length < CAMPAIGN_MESSAGES_PAGE_SIZE) break;
    }
  }
  return rows;
}
export async function fetchBulkAnalyticsCampaignIds(params: {
  workspaceId: string;
  startDate: Date;
  endDate: Date;
  signal?: AbortSignal;
}): Promise<string[]> {
  let query = supabaseAdmin
    .from("campaign_history")
    .select("id")
    .eq("workspace_id", params.workspaceId)
    .eq("channel", "whatsapp")
    .gte("sent_at", params.startDate.toISOString())
    .lte("sent_at", params.endDate.toISOString())
    .order("id", { ascending: true })
    .range(0, 100);
  if (params.signal) query = query.abortSignal(params.signal);
  const { data, error } = await query;
  if (error || !Array.isArray(data))
    throw new BulkAnalyticsAudienceUnavailableError(
      "CAMPAIGN_RECEIPTS_UNAVAILABLE",
      "Campaign receipt coverage could not be verified"
    );
  if (data.length > 100)
    throw new BulkAnalyticsAudienceUnavailableError(
      "CAMPAIGN_SCAN_LIMIT",
      "Selected window contains more than 100 campaigns. Narrow the window."
    );
  return data.map(row => String(row.id));
}
export function buildBulkReconciledSendStages(params: {
  workspaceId: string;
  startDate: Date;
  observedAt: Date;
  sqlReceipts: BulkSqlDeliveryReceipt[];
}): PipelineStage[] {
  return [
    { $set: { providerMessageId: buildCanonicalProviderMessageIdExpr() } },
    ...buildWhatsAppDeliveryReconciliationStages(params),
  ];
}
/** Search the complete reconciled cohort; never limit or page before this match. */
export function buildBulkRecipientSearchStages(
  search: string | null,
  conversationScope = false
): PipelineStage[] {
  if (!search) return [];
  return [
    {
      $match: {
        $expr: {
          $anyElementTrue: [
            {
              $map: {
                input: {
                  $concatArrays: [
                    { $ifNull: ["$providerRecipients", []] },
                    conversationScope
                      ? ["$user", "$chat", "$recipient"]
                      : [
                          "$conversationDoc.user",
                          "$conversationDoc.chat",
                          "$recipient",
                        ],
                  ],
                },
                as: "phone",
                in: {
                  $regexMatch: {
                    input: {
                      $ifNull: [
                        buildNormalizedWhatsAppPhoneExpr("$$phone"),
                        "",
                      ],
                    },
                    regex: escapeRegExp(search),
                  },
                },
              },
            },
          ],
        },
      },
    },
  ];
}

export function buildBulkDeliveryFilterStages(
  status: BulkAnalyticsDeliveryStatus,
  errorCode: string | null
): PipelineStage[] {
  const stages: PipelineStage[] = [];
  if (status === "delivered") stages.push({ $match: { wasDelivered: true } });
  else if (status === "read") stages.push({ $match: { wasRead: true } });
  else if (status !== "all")
    stages.push({ $match: { deliveryStatus: status } });
  if (errorCode === "unknown") {
    // The failure facet uses this sentinel for absent provider codes. Keep it
    // explicit in the query so pagination/export cannot broaden to all failures.
    stages.push({
      $match: { deliveryStatus: "failed", deliveryErrorCode: null },
    });
  } else if (errorCode) {
    stages.push({ $match: { deliveryErrorCode: errorCode } });
  }
  return stages;
}

/**
 * When users pick specific campaigns, expand the analytics window so older
 * selected campaigns are not silently dropped by the period preset.
 */
export async function expandAnalyticsWindowForCampaigns(params: {
  campaignIds: string[];
  startDate: Date;
  endDate: Date;
  replyWindowHours?: number;
  signal?: AbortSignal;
}): Promise<{ startDate: Date; endDate: Date }> {
  if (params.campaignIds.length === 0) {
    return { startDate: params.startDate, endDate: params.endDate };
  }

  let query = supabaseAdmin
    .from("campaign_history")
    .select("sent_at")
    .in("id", params.campaignIds);
  if (params.signal) query = query.abortSignal(params.signal);
  const { data, error } = await query;

  if (error || !Array.isArray(data) || data.length === 0) {
    throw new BulkAnalyticsAudienceUnavailableError(
      "CAMPAIGN_HISTORY_UNAVAILABLE",
      "Selected campaign window could not be verified"
    );
  }

  let minSent = Number.POSITIVE_INFINITY;
  let maxSent = Number.NEGATIVE_INFINITY;
  for (const row of data) {
    const sentAt = Date.parse(String(row.sent_at || ""));
    if (!Number.isFinite(sentAt)) continue;
    minSent = Math.min(minSent, sentAt);
    maxSent = Math.max(maxSent, sentAt);
  }

  if (!Number.isFinite(minSent) || !Number.isFinite(maxSent)) {
    return { startDate: params.startDate, endDate: params.endDate };
  }

  const replyBufferMs =
    Math.max(1, params.replyWindowHours ?? DEFAULT_REPLY_WINDOW_HOURS) *
    60 *
    60 *
    1000;

  return {
    startDate: new Date(Math.min(params.startDate.getTime(), minSent)),
    endDate: new Date(
      Math.max(params.endDate.getTime(), maxSent + replyBufferMs)
    ),
  };
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeRecipientDedupeKey(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits || value.trim().toLowerCase();
}

function canResolveCampaignSendAudienceFromHistory(
  filters: NormalizedBulkAnalyticsAudienceFilters
): boolean {
  return (
    filters.conversationScope === "campaign_sends" &&
    !filters.excludeTemplates &&
    (!filters.deliveryStatus || filters.deliveryStatus === "all") &&
    !filters.deliveryErrorCode &&
    !filters.recipientSearch &&
    filters.status === "all" &&
    filters.engagement === "all" &&
    !filters.messageContains &&
    !filters.excludeRecentClientMessageWithin24h
  );
}

function getCampaignSendAudienceUnavailableMessage(
  filters: NormalizedBulkAnalyticsAudienceFilters
): string {
  const blockers: string[] = [];
  if (filters.deliveryStatus && filters.deliveryStatus !== "all")
    blockers.push("delivery status");
  if (filters.deliveryErrorCode) blockers.push("delivery error");
  if (filters.recipientSearch) blockers.push("recipient search");
  if (filters.status !== "all") blockers.push("reply status");
  if (filters.engagement !== "all") blockers.push("engagement");
  if (filters.messageContains) blockers.push("message text");
  if (filters.excludeRecentClientMessageWithin24h) {
    blockers.push("recent client message exclusion");
  }
  if (filters.excludeTemplates) blockers.push("template exclusion");

  const suffix = blockers.length > 0 ? ` for ${blockers.join(", ")}` : "";
  return `Campaign-send audience resolution${suffix} requires the materialized reply/audience rollup. Narrow to campaign history filters only, or use manual recipients until the rollup is available.`;
}

function getConversationAudienceUnavailableMessage(
  filters: NormalizedBulkAnalyticsAudienceFilters
): string {
  return `The ${filters.conversationScope} conversation audience requires the materialized conversation rollup. Use campaign-send history filters or manual recipients until that rollup is available.`;
}

async function fetchCampaignHistoryIdsForAudience(params: {
  workspaceId: string;
  filters: NormalizedBulkAnalyticsAudienceFilters;
}): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  const readLimit = MAX_CAMPAIGN_HISTORY_IDS + 1;

  for (
    let offset = 0;
    offset < readLimit;
    offset += CAMPAIGN_HISTORY_PAGE_SIZE
  ) {
    const pageSize = Math.min(CAMPAIGN_HISTORY_PAGE_SIZE, readLimit - offset);
    let query = supabaseAdmin
      .from("campaign_history")
      .select("id")
      .eq("workspace_id", params.workspaceId)
      .eq("channel", "whatsapp")
      .gte("sent_at", params.filters.startDate.toISOString())
      .lte("sent_at", params.filters.endDate.toISOString());

    if (params.filters.campaignIds.length > 0) {
      query = query.in("id", params.filters.campaignIds);
    }
    if (params.filters.templateNames.length > 0) {
      query = query.in("template_name", params.filters.templateNames);
    }

    const { data, error } = await query
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error || !Array.isArray(data)) {
      throw new Error("Failed to resolve campaign history audience IDs");
    }

    for (const row of data) {
      const id = String(row.id || "").trim();
      if (id) ids.push(id);
    }

    if (ids.length > MAX_CAMPAIGN_HISTORY_IDS || data.length < pageSize) break;
  }

  const uniqueIds = Array.from(new Set(ids));
  return {
    ids: uniqueIds.slice(0, MAX_CAMPAIGN_HISTORY_IDS),
    truncated: uniqueIds.length > MAX_CAMPAIGN_HISTORY_IDS,
  };
}

function getCampaignSendAudienceScanLimitMessage(): string {
  return `Campaign-send audience resolution could not prove the complete audience within ${MAX_BULK_CAMPAIGN_RECIPIENTS} source rows. Narrow the campaign or date filters before sending.`;
}

async function resolveCampaignSendAudienceFromHistory(params: {
  workspaceId: string;
  filters: NormalizedBulkAnalyticsAudienceFilters;
  templateCategory?: string | null;
  maxRecipients: number;
}): Promise<BulkAnalyticsResolvedAudience> {
  const campaignHistory = await fetchCampaignHistoryIdsForAudience({
    workspaceId: params.workspaceId,
    filters: params.filters,
  });
  if (campaignHistory.truncated) {
    throw new BulkAnalyticsAudienceUnavailableError(
      "campaign_send_audience_scan_limit",
      getCampaignSendAudienceScanLimitMessage()
    );
  }
  const campaignIds = campaignHistory.ids;

  if (campaignIds.length === 0) {
    return {
      total: 0,
      eligibleTotal: 0,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients: [],
      capped: false,
      maxRecipients: params.maxRecipients,
    };
  }

  const recipients: BulkAnalyticsAudienceRecipient[] = [];
  const seenTargets = new Set<string>();
  let scannedMessageRows = 0;
  let messageRowsTruncated = false;

  for (const chunk of chunkValues(campaignIds, 500)) {
    let chunkExhausted = false;
    for (
      let offset = 0;
      scannedMessageRows < MAX_CAMPAIGN_AUDIENCE_MESSAGE_ROWS;

    ) {
      const pageSize = Math.min(
        CAMPAIGN_MESSAGES_PAGE_SIZE,
        MAX_CAMPAIGN_AUDIENCE_MESSAGE_ROWS - scannedMessageRows
      );
      const { data, error } = await supabaseAdmin
        .from("campaign_messages")
        .select("campaign_id, message_id, recipient, phone")
        .in("campaign_id", chunk)
        .order("campaign_id", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error || !Array.isArray(data)) {
        throw new Error("Failed to resolve campaign message audience");
      }
      scannedMessageRows += data.length;

      for (const row of data) {
        const phone = String(row.phone || row.recipient || "").trim();
        if (!phone) continue;

        const dedupeKey = normalizeRecipientDedupeKey(phone);
        if (!dedupeKey || seenTargets.has(dedupeKey)) continue;
        seenTargets.add(dedupeKey);

        const campaignId = String(row.campaign_id || "").trim();
        const messageId = String(row.message_id || "").trim();
        recipients.push({
          phone,
          name: "Customer",
          fields: {},
          conversationId: `campaign:${campaignId || "unknown"}:${
            messageId || dedupeKey
          }`,
          optedIn: false,
        });

        if (recipients.length > params.maxRecipients) break;
      }

      if (recipients.length > params.maxRecipients) {
        break;
      }
      if (data.length < pageSize) {
        chunkExhausted = true;
        break;
      }
      offset += pageSize;
    }

    if (recipients.length > params.maxRecipients) break;
    if (
      !chunkExhausted &&
      scannedMessageRows >= MAX_CAMPAIGN_AUDIENCE_MESSAGE_ROWS
    ) {
      messageRowsTruncated = true;
      break;
    }
  }

  if (messageRowsTruncated) {
    throw new BulkAnalyticsAudienceUnavailableError(
      "campaign_send_audience_scan_limit",
      getCampaignSendAudienceScanLimitMessage()
    );
  }

  const capped = recipients.length > params.maxRecipients;
  const returnedRecipients = capped
    ? recipients.slice(0, params.maxRecipients)
    : recipients;
  const isMarketing =
    String(params.templateCategory || "").toUpperCase() === "MARKETING";

  return {
    total: returnedRecipients.length,
    eligibleTotal: returnedRecipients.length,
    excludedOptIn: 0,
    marketingOptInWarningCount: isMarketing ? returnedRecipients.length : 0,
    recipients: returnedRecipients,
    capped,
    maxRecipients: params.maxRecipients,
  };
}

const TEMPLATE_NAME_FROM_TEXT_EXPR = {
  $let: {
    vars: {
      fromText: {
        $regexFind: {
          input: { $ifNull: ["$text", ""] },
          regex: "\\[Template:\\s*([^\\]]+)\\]",
        },
      },
    },
    in: {
      $trim: {
        input: {
          $ifNull: [{ $arrayElemAt: ["$$fromText.captures", 0] }, ""],
        },
      },
    },
  },
};

/**
 * Resolve templateName from indexed fields first. Only `$regexFind` text when
 * both structured fields are empty (legacy duck-tape path).
 */
export function buildTemplateNameStages(
  templateNames: string[],
  options: { skipPrefilter?: boolean } = {}
): PipelineStage[] {
  const normalized = normalizeStringList(templateNames);
  const templatePrefilterStage = options.skipPrefilter
    ? null
    : buildTemplateNamePrefilterStage(normalized);
  const stages: PipelineStage[] = [
    ...(templatePrefilterStage ? [templatePrefilterStage] : []),
    {
      $addFields: {
        templateName: {
          $let: {
            vars: {
              fromTemplate: {
                $trim: {
                  input: { $ifNull: ["$whatsappTemplate.name", ""] },
                },
              },
              fromOrigin: {
                $trim: {
                  input: { $ifNull: ["$origin.templateName", ""] },
                },
              },
            },
            in: {
              $cond: [
                { $ne: ["$$fromTemplate", ""] },
                "$$fromTemplate",
                {
                  $cond: [
                    { $ne: ["$$fromOrigin", ""] },
                    "$$fromOrigin",
                    TEMPLATE_NAME_FROM_TEXT_EXPR,
                  ],
                },
              ],
            },
          },
        },
      },
    },
    { $match: { templateName: { $ne: "" } } },
  ];

  if (normalized.length > 0) {
    stages.push({ $match: { templateName: { $in: normalized } } });
  }

  return stages;
}

const REPLY_CATEGORY_EXPR = {
  $switch: {
    branches: [
      { case: { $eq: ["$replied", false] }, then: "no_reply" },
      {
        case: { $ne: ["$firstReply.whatsappFlowReply", null] },
        then: "flow",
      },
      {
        case: {
          $regexMatch: {
            input: { $toLower: { $ifNull: ["$firstReply.text", ""] } },
            regex: "message deleted|сообщение удалено",
          },
        },
        then: "deleted",
      },
      {
        case: {
          $in: [{ $ifNull: ["$firstReply.mediaType", ""] }, ["audio", "voice"]],
        },
        then: "audio",
      },
      {
        case: {
          $regexMatch: {
            input: { $toLower: { $ifNull: ["$firstReply.text", ""] } },
            regex: "макет|мокап|mockup",
          },
        },
        then: "mockup",
      },
      {
        case: {
          $regexMatch: {
            input: { $toLower: { $ifNull: ["$firstReply.text", ""] } },
            regex: "қанша|канша|сколько|цена|баға|бағасы|багасы|тг|тенге",
          },
        },
        then: "price",
      },
    ],
    default: "other",
  },
};

/** Delivery outcome flags shared by bulk and WhatsApp analytics. */
export function buildDeliveryOutcomeFields() {
  const read = {
    $or: [
      { $in: [{ $ifNull: ["$delivery.status", ""] }, ["read", "played"]] },
      { $ne: [{ $ifNull: ["$delivery.readAt", null] }, null] },
    ],
  };
  const delivered = {
    $or: [
      read,
      { $eq: ["$delivery.status", "delivered"] },
      { $ne: [{ $ifNull: ["$delivery.deliveredAt", null] }, null] },
    ],
  };
  const failed = {
    $and: [
      { $not: [delivered] },
      {
        $or: [
          { $eq: ["$delivery.status", "failed"] },
          { $ne: [{ $ifNull: ["$delivery.failedAt", null] }, null] },
        ],
      },
    ],
  };
  return { wasRead: read, wasDelivered: delivered, wasFailed: failed };
}

export function buildEnrichmentStages(params: {
  workspaceId: string;
  replyWindowHours: number;
  observedThrough?: Date;
  outboundMessageIdsField?: string;
}): PipelineStage[] {
  const replyStatsGroup = {
    _id: null,
    replyCount: { $sum: 1 },
    firstReply: {
      $first: {
        text: "$text",
        date: "$date",
        mediaType: "$mediaType",
        messageId: "$messageId",
        whatsappFlowReply: "$whatsappFlowReply",
      },
    },
  } satisfies PipelineStage.Group["$group"];

  return [
    buildIndexedConversationMessageLookup({
      as: "nextOutbound",
      localField: "conversation",
      workspaceId: params.workspaceId,
      direction: "outbound",
      let: {
        outboundDate: "$date",
        ...(params.outboundMessageIdsField
          ? { outboundMessageIds: `$${params.outboundMessageIdsField}` }
          : {}),
      },
      dateExpr: [
        { $gt: ["$date", "$$outboundDate"] },
        ...(params.observedThrough
          ? [{ $lte: ["$date", params.observedThrough] }]
          : []),
        ...(params.outboundMessageIdsField
          ? [
              {
                $not: [
                  {
                    $in: [
                      {
                        $replaceOne: {
                          input: { $ifNull: ["$messageId", ""] },
                          find: "ws_",
                          replacement: "",
                        },
                      },
                      "$$outboundMessageIds",
                    ],
                  },
                ],
              },
            ]
          : []),
      ],
      pipelineTail: [
        { $sort: { date: 1 as const } },
        { $limit: 1 },
        { $project: { _id: 0, date: 1 } },
      ],
    }),
    {
      $addFields: {
        nextOutboundAt: firstLookupDateOrNull("$nextOutbound.date"),
        replyWindowEndsAt: {
          $dateAdd: {
            startDate: "$date",
            unit: "hour",
            amount: params.replyWindowHours,
          },
        },
      },
    },
    {
      $addFields: {
        attributionEndsAt: {
          $cond: [
            {
              $and: [
                { $ne: ["$nextOutboundAt", null] },
                { $lt: ["$nextOutboundAt", "$replyWindowEndsAt"] },
              ],
            },
            "$nextOutboundAt",
            "$replyWindowEndsAt",
          ],
        },
      },
    },
    buildIndexedConversationMessageLookup({
      as: "replyStats",
      localField: "conversation",
      workspaceId: params.workspaceId,
      direction: "inbound",
      let: {
        outboundDate: "$date",
        attributionEndsAt: "$attributionEndsAt",
      },
      dateExpr: [
        { $gt: ["$date", "$$outboundDate"] },
        { $lte: ["$date", "$$attributionEndsAt"] },
        ...(params.observedThrough
          ? [{ $lte: ["$date", params.observedThrough] }]
          : []),
      ],
      pipelineTail: [
        { $sort: { date: 1 as const } },
        { $group: replyStatsGroup },
        {
          $project: {
            _id: 0,
            replyCount: 1,
            firstReply: 1,
          },
        },
      ],
    }),
    {
      $lookup: {
        from: "conversations",
        localField: "conversation",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              status: 1,
              is_read_by_manager: 1,
              engagement_metrics: 1,
              user: 1,
              chat: 1,
              whatsapp_opt_in: 1,
            },
          },
        ],
        as: "conversationDoc",
      },
    },
    {
      $addFields: {
        conversationDoc: { $arrayElemAt: ["$conversationDoc", 0] },
        replyStats: { $arrayElemAt: ["$replyStats", 0] },
        conversationIdString: { $toString: "$conversation" },
      },
    },
    {
      $addFields: {
        firstReply: "$replyStats.firstReply",
        replyCount: { $ifNull: ["$replyStats.replyCount", 0] },
        replied: {
          $gt: [{ $ifNull: ["$replyStats.replyCount", 0] }, 0],
        },
        firstReplyText: {
          $ifNull: ["$replyStats.firstReply.text", ""],
        },
        recipient: {
          $convert: {
            input: {
              $ifNull: ["$conversationDoc.user", "$conversationDoc.chat"],
            },
            to: "string",
            onError: "",
            onNull: "",
          },
        },
        replyDelayMinutes: {
          $cond: [
            { $gt: [{ $ifNull: ["$replyStats.replyCount", 0] }, 0] },
            {
              $divide: [
                {
                  $subtract: ["$replyStats.firstReply.date", "$date"],
                },
                1000 * 60,
              ],
            },
            null,
          ],
        },
      },
    },
    {
      $addFields: {
        replyCategory: REPLY_CATEGORY_EXPR,
        ...buildDeliveryOutcomeFields(),
      },
    },
    {
      $addFields: {
        deliveryStatus: {
          $switch: {
            branches: [
              { case: "$wasRead", then: "read" },
              { case: "$wasDelivered", then: "delivered" },
              { case: "$wasFailed", then: "failed" },
              {
                case: {
                  $regexMatch: {
                    input: { $ifNull: ["$providerMessageId", "$messageId"] },
                    regex: "^(ws_)?wamid\\.",
                  },
                },
                then: "accepted",
              },
            ],
            default: "unknown",
          },
        },
        deliveryErrorCode: {
          $cond: [
            "$wasFailed",
            {
              $convert: {
                input: "$delivery.errorCode",
                to: "string",
                onError: null,
                onNull: null,
              },
            },
            null,
          ],
        },
        deliveryErrorMessage: {
          $cond: [
            "$wasFailed",
            { $ifNull: ["$delivery.errorMessage", null] },
            null,
          ],
        },
        recipientConflict: {
          $or: [
            {
              $gt: [
                { $size: { $ifNull: ["$identityConversationIds", []] } },
                1,
              ],
            },
            {
              $gt: [
                {
                  $size: {
                    $setUnion: [
                      { $ifNull: ["$providerRecipients", []] },
                      {
                        $filter: {
                          input: {
                            $map: {
                              input: [
                                "$conversationDoc.user",
                                "$conversationDoc.chat",
                                "$recipient",
                              ],
                              as: "identity",
                              in: buildNormalizedWhatsAppPhoneExpr(
                                "$$identity"
                              ),
                            },
                          },
                          cond: { $ne: ["$$this", null] },
                        },
                      },
                    ],
                  },
                },
                1,
              ],
            },
          ],
        },
        outcomeBucket: {
          $switch: {
            branches: [
              { case: "$wasFailed", then: "failed" },
              { case: "$replied", then: "replied" },
              {
                case: {
                  $and: ["$wasRead", { $not: ["$replied"] }],
                },
                then: "read_no_reply",
              },
              {
                case: {
                  $and: [
                    "$wasDelivered",
                    { $not: ["$wasRead"] },
                    { $not: ["$replied"] },
                  ],
                },
                then: "delivered_unread",
              },
            ],
            default: "not_delivered",
          },
        },
        messageCostUsd: buildWhatsAppMessageCostUsdExpr(),
      },
    },
  ];
}

export type BulkSendAnalyticsSummary = {
  totalAccepted: number;
  uniqueConversations: number;
  recipientConflictCount?: number;
  replied: number;
  notReplied: number;
  totalReplies: number;
  replyRate: number;
  read: number | null;
  readRate: number | null;
  delivered: number | null;
  deliveryRate: number | null;
  failed: number | null;
  failedRate: number | null;
  estimatedCost: number | null;
  costPerReply: number | null;
  /** Delivered messages without a verified price (why estimatedCost is null). */
  unknownCostCount?: number | null;
  avgReplyDelayMinutes: number | null;
  firstSentAt: string | Date | null;
  lastSentAt: string | Date | null;
};

/** Shared summary $facet branch for campaign_sends analytics. */
export function buildBulkSendSummaryFacetStages(): NonNullable<
  PipelineStage.Facet["$facet"]
>[string] {
  return [
    {
      $group: {
        _id: null,
        totalAccepted: { $sum: 1 },
        recipientConflictCount: {
          $sum: { $cond: ["$recipientConflict", 1, 0] },
        },
        conversations: { $addToSet: "$conversationIdString" },
        replied: { $sum: { $cond: ["$replied", 1, 0] } },
        read: { $sum: { $cond: ["$wasRead", 1, 0] } },
        delivered: { $sum: { $cond: ["$wasDelivered", 1, 0] } },
        failed: { $sum: { $cond: ["$wasFailed", 1, 0] } },
        estimatedCost: { $sum: "$messageCostUsd" },
        unknownCostCount: {
          $sum: { $cond: [{ $eq: ["$messageCostUsd", null] }, 1, 0] },
        },
        totalReplies: { $sum: "$replyCount" },
        avgReplyDelayMinutes: { $avg: "$replyDelayMinutes" },
        firstSentAt: { $min: "$date" },
        lastSentAt: { $max: "$date" },
      },
    },
    {
      $project: {
        _id: 0,
        totalAccepted: 1,
        recipientConflictCount: 1,
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
        read: 1,
        readRate: {
          $cond: [
            { $gt: ["$totalAccepted", 0] },
            { $divide: ["$read", "$totalAccepted"] },
            0,
          ],
        },
        delivered: 1,
        deliveryRate: {
          $cond: [
            { $gt: ["$totalAccepted", 0] },
            { $divide: ["$delivered", "$totalAccepted"] },
            0,
          ],
        },
        failed: 1,
        failedRate: {
          $cond: [
            { $gt: ["$totalAccepted", 0] },
            { $divide: ["$failed", "$totalAccepted"] },
            0,
          ],
        },
        estimatedCost: {
          $cond: [{ $gt: ["$unknownCostCount", 0] }, null, "$estimatedCost"],
        },
        unknownCostCount: 1,
        costPerReply: {
          $cond: [
            {
              $and: [
                { $gt: ["$replied", 0] },
                { $eq: ["$unknownCostCount", 0] },
              ],
            },
            { $divide: ["$estimatedCost", "$replied"] },
            null,
          ],
        },
        avgReplyDelayMinutes: 1,
        firstSentAt: 1,
        lastSentAt: 1,
      },
    },
  ];
}

export function buildBulkSendOutcomesFacetStages(): NonNullable<
  PipelineStage.Facet["$facet"]
>[string] {
  return [
    {
      $group: {
        _id: "$outcomeBucket",
        count: { $sum: 1 },
      },
    },
    { $project: { _id: 0, bucket: "$_id", count: 1 } },
    { $sort: { count: -1 as const, bucket: 1 as const } },
  ];
}

export function buildBulkSendFailuresFacetStages(): NonNullable<
  PipelineStage.Facet["$facet"]
>[string] {
  return [
    { $match: { wasFailed: true } },
    {
      $group: {
        _id: {
          $ifNull: [
            {
              $cond: [
                { $eq: [{ $ifNull: ["$delivery.errorCode", null] }, null] },
                "unknown",
                { $toString: "$delivery.errorCode" },
              ],
            },
            "unknown",
          ],
        },
        count: { $sum: 1 },
      },
    },
    { $project: { _id: 0, errorCode: "$_id", count: 1 } },
    { $sort: { count: -1 as const, errorCode: 1 as const } },
    { $limit: 20 },
  ];
}

export function normalizeBulkSendSummary(
  raw: Partial<BulkSendAnalyticsSummary> | null | undefined,
  options: { includeDeliveryEconomics: boolean } = {
    includeDeliveryEconomics: true,
  }
): BulkSendAnalyticsSummary {
  const totalAccepted = Number(raw?.totalAccepted || 0);
  const replied = Number(raw?.replied || 0);
  const estimatedCostRaw = raw?.estimatedCost;
  const estimatedCost =
    options.includeDeliveryEconomics &&
    typeof estimatedCostRaw === "number" &&
    Number.isFinite(estimatedCostRaw)
      ? roundUsd(estimatedCostRaw)
      : null;

  if (!options.includeDeliveryEconomics) {
    return {
      totalAccepted,
      uniqueConversations: Number(raw?.uniqueConversations || 0),
      recipientConflictCount: Number(raw?.recipientConflictCount || 0),
      replied,
      notReplied: Number(
        raw?.notReplied || Math.max(0, totalAccepted - replied)
      ),
      totalReplies: Number(raw?.totalReplies || 0),
      replyRate: Number(raw?.replyRate || 0),
      read: null,
      readRate: null,
      delivered: null,
      deliveryRate: null,
      failed: null,
      failedRate: null,
      estimatedCost: null,
      costPerReply: null,
      unknownCostCount: null,
      avgReplyDelayMinutes:
        typeof raw?.avgReplyDelayMinutes === "number"
          ? raw.avgReplyDelayMinutes
          : null,
      firstSentAt: raw?.firstSentAt ?? null,
      lastSentAt: raw?.lastSentAt ?? null,
    };
  }

  return {
    totalAccepted,
    uniqueConversations: Number(raw?.uniqueConversations || 0),
    recipientConflictCount: Number(raw?.recipientConflictCount || 0),
    replied,
    notReplied: Number(raw?.notReplied || Math.max(0, totalAccepted - replied)),
    totalReplies: Number(raw?.totalReplies || 0),
    replyRate: Number(raw?.replyRate || 0),
    read: Number(raw?.read || 0),
    readRate: Number(raw?.readRate || 0),
    delivered: Number(raw?.delivered || 0),
    deliveryRate: Number(raw?.deliveryRate || 0),
    failed: Number(raw?.failed || 0),
    failedRate: Number(raw?.failedRate || 0),
    estimatedCost,
    costPerReply: finalizeCostPerReplyValue(estimatedCost, replied),
    unknownCostCount: Number(raw?.unknownCostCount || 0),
    avgReplyDelayMinutes:
      typeof raw?.avgReplyDelayMinutes === "number"
        ? raw.avgReplyDelayMinutes
        : null,
    firstSentAt: raw?.firstSentAt ?? null,
    lastSentAt: raw?.lastSentAt ?? null,
  };
}

export function computePreviousAnalyticsWindow(
  startDate: Date,
  endDate: Date
): { startDate: Date; endDate: Date } {
  const durationMs = Math.max(0, endDate.getTime() - startDate.getTime());
  return {
    startDate: new Date(startDate.getTime() - durationMs),
    endDate: startDate,
  };
}

export function buildMessageContainsStages(params: {
  conversationIds: string[] | null;
  mode: BulkAnalyticsMessageContainsMode;
}): PipelineStage[] {
  if (params.conversationIds === null) return [];

  const ids = toObjectIds(params.conversationIds);

  if (params.mode === "not_contains") {
    return [{ $match: { conversation: { $nin: ids } } }];
  }
  if (ids.length === 0) {
    return [{ $match: { _id: { $exists: false } } }];
  }
  return [{ $match: { conversation: { $in: ids } } }];
}

export type BulkAnalyticsRecordsCursor = {
  sortAt: Date;
  id: string | mongoose.Types.ObjectId;
};

function toCursorObjectId(
  value: string | mongoose.Types.ObjectId
): mongoose.Types.ObjectId | null {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

function buildRecordsCursorStages(
  sortField: "date" | "sortAt",
  cursor: BulkAnalyticsRecordsCursor | null
): PipelineStage[] {
  if (!cursor || !Number.isFinite(cursor.sortAt.getTime())) return [];

  const id = toCursorObjectId(cursor.id);
  if (!id) return [];

  return [
    {
      $match: {
        $or: [
          { [sortField]: { $lt: cursor.sortAt } },
          { [sortField]: cursor.sortAt, _id: { $lt: id } },
        ],
      },
    },
  ];
}

function buildSendRecordsProjectStage(): PipelineStage.Project {
  return {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      conversationId: "$conversationIdString",
      messageId: 1,
      providerMessageId: 1,
      deliveryStatus: 1,
      deliveryErrorCode: 1,
      deliveryErrorMessage: 1,
      outcomeBucket: 1,
      providerRecipient: 1,
      providerRecipients: 1,
      recipientConflict: 1,
      deliveredAt: "$delivery.deliveredAt",
      readAt: "$delivery.readAt",
      failedAt: "$delivery.failedAt",
      recipient: 1,
      templateName: 1,
      sentAt: "$date",
      replied: 1,
      replyCount: 1,
      firstReplyAt: "$firstReply.date",
      firstReplyText: 1,
      replyCategory: 1,
      replyDelayMinutes: 1,
      matchedMessageCount: { $ifNull: ["$matchedMessageCount", 0] },
      firstMatchedMessageAt: "$firstMatchedMessage.date",
      firstMatchedMessageText: "$firstMatchedMessage.text",
      firstMatchedMessageDirection: "$firstMatchedMessage.direction",
      conversationStatus: "$conversationDoc.status",
      isReadByManager: "$conversationDoc.is_read_by_manager",
      engagementScore: "$conversationDoc.engagement_metrics.score",
      cursorSortAt: "$date",
      cursorId: { $toString: "$_id" },
    },
  };
}

export function buildSendRecordsPipeline(params: {
  baseStages: PipelineStage[];
  messageContainsStages: PipelineStage[];
  postFilterStages: PipelineStage[];
  workspaceId: string;
  replyWindowHours: number;
  limit: number;
  cursor: BulkAnalyticsRecordsCursor | null;
  observedThrough?: Date;
}): PipelineStage[] {
  const cursorStages = buildRecordsCursorStages("date", params.cursor);
  const sortAndLimitStages: PipelineStage[] = [
    { $sort: { date: -1 as const, _id: -1 as const } },
    { $limit: params.limit + 1 },
  ];
  const enrichmentStages = buildEnrichmentStages({
    workspaceId: params.workspaceId,
    replyWindowHours: params.replyWindowHours,
    observedThrough: params.observedThrough,
    outboundMessageIdsField: "providerMessageIds",
  });

  if (params.postFilterStages.length === 0) {
    return [
      ...params.baseStages,
      ...params.messageContainsStages,
      ...cursorStages,
      ...sortAndLimitStages,
      ...enrichmentStages,
      buildSendRecordsProjectStage(),
    ];
  }

  return [
    ...params.baseStages,
    ...params.messageContainsStages,
    ...enrichmentStages,
    ...params.postFilterStages,
    ...cursorStages,
    ...sortAndLimitStages,
    buildSendRecordsProjectStage(),
  ];
}

export function buildConversationRecordsPipeline(params: {
  candidateStages: PipelineStage[];
  limit: number;
  cursor: BulkAnalyticsRecordsCursor | null;
}): PipelineStage[] {
  return [
    ...params.candidateStages,
    ...buildRecordsCursorStages("sortAt", params.cursor),
    { $sort: { sortAt: -1 as const, _id: -1 as const } },
    { $limit: params.limit + 1 },
    {
      $project: {
        _id: 0,
        id: {
          $concat: ["conversation:", "$conversationIdString"],
        },
        conversationId: "$conversationIdString",
        messageId: { $ifNull: ["$campaignSend.messageId", ""] },
        deliveryStatus: { $literal: "unknown" },
        deliveryErrorCode: { $literal: null },
        deliveryErrorMessage: { $literal: null },
        deliveredAt: { $literal: null },
        readAt: { $literal: null },
        failedAt: { $literal: null },
        providerRecipient: { $literal: null },
        recipientConflict: { $literal: false },
        outcomeBucket: { $literal: null },
        recipient: 1,
        templateName: {
          $ifNull: [
            "$campaignSend.templateName",
            {
              $cond: [
                "$isFreshConversation",
                "Fresh conversation",
                "No selected campaign",
              ],
            },
          ],
        },
        sentAt: "$sortAt",
        replied: 1,
        replyCount: 1,
        firstReplyAt: "$firstReply.date",
        firstReplyText: { $ifNull: ["$firstReply.text", ""] },
        replyCategory: 1,
        replyDelayMinutes: 1,
        matchedMessageCount: {
          $ifNull: ["$matchedMessageCount", 0],
        },
        firstMatchedMessageAt: "$firstMatchedMessage.date",
        firstMatchedMessageText: "$firstMatchedMessage.text",
        firstMatchedMessageDirection: "$firstMatchedMessage.direction",
        conversationStatus: "$status",
        isReadByManager: "$is_read_by_manager",
        engagementScore: "$engagement_metrics.score",
        conversationSource: {
          $cond: ["$isFreshConversation", "fresh", "campaign_or_existing"],
        },
        cursorSortAt: "$sortAt",
        cursorId: { $toString: "$_id" },
      },
    },
  ];
}

function toObjectIds(values: readonly string[]): mongoose.Types.ObjectId[] {
  const ids: mongoose.Types.ObjectId[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (mongoose.Types.ObjectId.isValid(value)) {
      const normalized = new mongoose.Types.ObjectId(value).toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        ids.push(new mongoose.Types.ObjectId(normalized));
      }
    }
  }
  return ids;
}

export function buildAcceptedSendLookupPipeline(params: {
  workspaceId: string;
  campaignMessageIds?: string[] | null;
  templateNames?: string[];
}): LookupPipeline {
  const messageMatch: Record<string, unknown> = params.campaignMessageIds
    ? { messageId: { $in: params.campaignMessageIds } }
    : buildAcceptedWhatsAppMessageIdMatch();
  const templateNames = params.templateNames || [];
  const templateMatch =
    templateNames.length > 0 ? buildHasTemplateNameMatch(templateNames) : null;

  return [
    {
      $match: {
        workspaceId: params.workspaceId,
        channel: "whatsapp",
        direction: "outbound",
        ...messageMatch,
        ...(templateMatch || {}),
      },
    },
    // Base match already applied template predicates when present; skip the
    // duplicate prefilter and only normalize/extract templateName.
    ...buildTemplateNameStages(templateNames, { skipPrefilter: true }),
    { $sort: { date: -1 as const, _id: -1 as const } },
    { $limit: 1 },
    { $project: { messageId: 1, date: 1, templateName: 1 } },
  ] as LookupPipeline;
}

export function buildConversationMessageContainsStages(params: {
  conversationIds: string[] | null;
  mode: BulkAnalyticsMessageContainsMode;
}): PipelineStage[] {
  if (params.conversationIds === null) return [];

  const ids = toObjectIds(params.conversationIds);

  if (params.mode === "not_contains") {
    return [{ $match: { _id: { $nin: ids } } }];
  }
  if (ids.length === 0) {
    return [{ $match: { _id: { $exists: false } } }];
  }
  return [{ $match: { _id: { $in: ids } } }];
}

export function buildConversationCandidateStages(params: {
  workspaceId: string;
  startDate: Date;
  endDate: Date;
  conversationScope: BulkAnalyticsConversationScope;
  campaignMessageIds: string[] | null;
  templateNames: string[];
  messageContainsConversationIds: string[] | null;
  messageContainsMode: BulkAnalyticsMessageContainsMode;
  status: BulkAnalyticsStatus;
  engagement: BulkAnalyticsEngagement;
  excludeRecentClientMessageWithin24h: boolean;
  excludeTemplates: boolean;
  replyWindowHours: number;
}): PipelineStage[] {
  const engagementMatch = buildEngagementScoreMatch(
    "engagement_metrics.score",
    params.engagement
  );
  const textPrefilterStages = buildConversationMessageContainsStages({
    conversationIds: params.messageContainsConversationIds,
    mode: params.messageContainsMode,
  });
  const hasDistinctMatchingSends =
    params.campaignMessageIds !== null || params.templateNames.length > 0;
  const stages: PipelineStage[] = [
    {
      $match: {
        workspaceId: params.workspaceId,
        channel: "whatsapp",
        $or: [
          { lastMessageAt: { $gte: params.startDate, $lte: params.endDate } },
          {
            $and: [
              {
                $or: [
                  { lastMessageAt: null },
                  { lastMessageAt: { $exists: false } },
                ],
              },
              { createdAt: { $gte: params.startDate, $lte: params.endDate } },
            ],
          },
        ],
      },
    },
    ...textPrefilterStages,
    ...(engagementMatch ? [{ $match: engagementMatch }] : []),
    {
      $lookup: {
        from: "messages",
        localField: "_id",
        foreignField: "conversation",
        pipeline: buildAcceptedSendLookupPipeline({
          workspaceId: params.workspaceId,
        }),
        as: "anyAcceptedSends",
      },
    },
    ...(hasDistinctMatchingSends
      ? [
          {
            $lookup: {
              from: "messages",
              localField: "_id",
              foreignField: "conversation",
              pipeline: buildAcceptedSendLookupPipeline({
                workspaceId: params.workspaceId,
                campaignMessageIds: params.campaignMessageIds,
                templateNames: params.templateNames,
              }),
              as: "matchingCampaignSends",
            },
          } satisfies PipelineStage,
        ]
      : []),
    {
      $lookup: {
        from: "messages",
        localField: "_id",
        foreignField: "conversation",
        pipeline: [
          {
            $match: {
              workspaceId: params.workspaceId,
              channel: "whatsapp",
            },
          },
          { $sort: { date: -1 as const, _id: -1 as const } },
          { $limit: 1 },
          { $project: { text: 1, date: 1, direction: 1, mediaType: 1 } },
        ],
        as: "lastMessage",
      },
    },
    {
      $addFields: {
        conversationIdString: { $toString: "$_id" },
        historyCount: { $size: { $ifNull: ["$bulk_campaign_history", []] } },
        anyAcceptedSendCount: { $size: "$anyAcceptedSends" },
        ...(hasDistinctMatchingSends
          ? {
              matchingCampaignSendCount: { $size: "$matchingCampaignSends" },
              campaignSend: { $arrayElemAt: ["$matchingCampaignSends", 0] },
            }
          : {
              matchingCampaignSends: "$anyAcceptedSends",
              matchingCampaignSendCount: { $size: "$anyAcceptedSends" },
              campaignSend: { $arrayElemAt: ["$anyAcceptedSends", 0] },
            }),
        lastMessage: { $arrayElemAt: ["$lastMessage", 0] },
        lastOutboundAny: {
          $cond: [
            { $ne: [{ $ifNull: ["$last_outbound_at", null] }, null] },
            { date: "$last_outbound_at" },
            null,
          ],
        },
        lastInbound: {
          $cond: [
            { $ne: [{ $ifNull: ["$last_inbound_at", null] }, null] },
            { date: "$last_inbound_at" },
            null,
          ],
        },
      },
    },
    {
      $addFields: {
        anchorSend: { $ifNull: ["$campaignSend", "$lastOutboundAny"] },
        isFreshConversation: {
          $and: [
            { $eq: ["$anyAcceptedSendCount", 0] },
            { $eq: ["$historyCount", 0] },
            { $eq: [{ $ifNull: ["$last_bulk_sent_at", null] }, null] },
          ],
        },
        recipient: {
          $convert: {
            input: { $ifNull: ["$user", "$chat"] },
            to: "string",
            onError: "",
            onNull: "",
          },
        },
        sortAt: { $ifNull: ["$campaignSend.date", "$lastMessageAt"] },
      },
    },
  ];

  if (params.conversationScope === "fresh") {
    stages.push({ $match: { isFreshConversation: true } });
  } else if (params.conversationScope === "campaign_or_fresh") {
    stages.push({
      $match: {
        $or: [
          { isFreshConversation: true },
          { matchingCampaignSendCount: { $gt: 0 } },
        ],
      },
    });
  } else if (
    params.conversationScope === "all" &&
    (params.campaignMessageIds !== null || params.templateNames.length > 0)
  ) {
    stages.push({ $match: { matchingCampaignSendCount: { $gt: 0 } } });
  }

  if (params.excludeTemplates) {
    stages.push({ $match: { anyAcceptedSendCount: 0 } });
  }

  stages.push(
    buildIndexedConversationMessageLookup({
      as: "nextOutboundAfterAnchor",
      localField: "_id",
      workspaceId: params.workspaceId,
      direction: "outbound",
      let: { anchorDate: "$anchorSend.date" },
      dateExpr: [
        { $ne: ["$$anchorDate", null] },
        { $gt: ["$date", "$$anchorDate"] },
      ],
      pipelineTail: [
        { $sort: { date: 1 as const, _id: 1 as const } },
        { $limit: 1 },
        { $project: { _id: 0, date: 1 } },
      ],
    }),
    {
      $addFields: {
        anchorDate: "$anchorSend.date",
        nextOutboundAfterAnchorAt: firstLookupDateOrNull(
          "$nextOutboundAfterAnchor.date"
        ),
      },
    },
    {
      $addFields: {
        replyWindowEndsAt: {
          $cond: [
            { $ne: ["$anchorDate", null] },
            {
              $dateAdd: {
                startDate: "$anchorDate",
                unit: "hour",
                amount: params.replyWindowHours,
              },
            },
            null,
          ],
        },
      },
    },
    {
      $addFields: {
        attributionEndsAt: {
          $cond: [
            {
              $and: [
                { $ne: ["$nextOutboundAfterAnchorAt", null] },
                { $ne: ["$replyWindowEndsAt", null] },
                { $lt: ["$nextOutboundAfterAnchorAt", "$replyWindowEndsAt"] },
              ],
            },
            "$nextOutboundAfterAnchorAt",
            "$replyWindowEndsAt",
          ],
        },
      },
    },
    buildIndexedConversationMessageLookup({
      as: "replyStats",
      localField: "_id",
      workspaceId: params.workspaceId,
      direction: "inbound",
      let: {
        anchorDate: "$anchorDate",
        attributionEndsAt: "$attributionEndsAt",
      },
      dateExpr: [
        { $ne: ["$$anchorDate", null] },
        { $ne: ["$$attributionEndsAt", null] },
        { $gt: ["$date", "$$anchorDate"] },
        { $lte: ["$date", "$$attributionEndsAt"] },
      ],
      pipelineTail: [
        { $sort: { date: 1 as const } },
        {
          $group: {
            _id: null,
            replyCount: { $sum: 1 },
            firstReply: {
              $first: {
                text: "$text",
                date: "$date",
                mediaType: "$mediaType",
                messageId: "$messageId",
                whatsappFlowReply: "$whatsappFlowReply",
              },
            },
          },
        },
        { $project: { _id: 0, replyCount: 1, firstReply: 1 } },
      ],
    }),
    {
      $addFields: {
        replyStats: { $arrayElemAt: ["$replyStats", 0] },
      },
    },
    {
      $addFields: {
        replyCount: { $ifNull: ["$replyStats.replyCount", 0] },
        firstReply: "$replyStats.firstReply",
      },
    },
    {
      $addFields: {
        replied: { $gt: ["$replyCount", 0] },
        replyDelayMinutes: {
          $cond: [
            {
              $and: [
                { $gt: ["$replyCount", 0] },
                { $ne: ["$anchorDate", null] },
                { $ne: ["$firstReply.date", null] },
              ],
            },
            {
              $divide: [
                { $subtract: ["$firstReply.date", "$anchorDate"] },
                1000 * 60,
              ],
            },
            null,
          ],
        },
      },
    },
    {
      $addFields: {
        replyCategory: REPLY_CATEGORY_EXPR,
      },
    }
  );

  if (params.status === "replied") {
    stages.push({ $match: { replied: true } });
  } else if (params.status === "not_replied") {
    stages.push({ $match: { replied: false } });
  }

  if (params.excludeRecentClientMessageWithin24h) {
    stages.push(
      buildExcludeRecentClientMessageWithin24hStage({
        field: "lastInbound",
        cutoffDate: new Date(
          Date.now() - CLIENT_MESSAGE_WINDOW_HOURS * 60 * 60 * 1000
        ),
      })
    );
  }

  return stages;
}

export async function resolveBulkAnalyticsAudience(params: {
  workspaceId: string;
  filters: BulkAnalyticsAudienceFilters;
  templateCategory?: string | null;
  maxRecipients?: number;
}): Promise<BulkAnalyticsResolvedAudience> {
  if (
    (params.filters.deliveryStatus &&
      params.filters.deliveryStatus !== "all") ||
    String(params.filters.deliveryErrorCode || "").trim() ||
    String(params.filters.recipientSearch || "").trim()
  ) {
    throw new BulkAnalyticsAudienceUnavailableError(
      "campaign_send_audience_rollup_required",
      "Recipient/delivery-filtered audience sending requires a materialized audience rollup. Use campaign history retry policy or manual recipients."
    );
  }
  let filters = normalizeBulkAnalyticsAudienceFilters(params.filters);
  if (filters.campaignIds.length > 0) {
    const expandedWindow = await expandAnalyticsWindowForCampaigns({
      campaignIds: filters.campaignIds,
      startDate: filters.startDate,
      endDate: filters.endDate,
      replyWindowHours: filters.replyWindowHours,
    });
    filters = {
      ...filters,
      startDate: expandedWindow.startDate,
      endDate: expandedWindow.endDate,
    };
  }
  if (filters.startDate.getTime() > filters.endDate.getTime()) {
    throw new Error("from must be before to");
  }
  const requestedMaxRecipients =
    params.maxRecipients || MAX_BULK_CAMPAIGN_RECIPIENTS;
  const maxRecipients = Math.min(
    MAX_BULK_CAMPAIGN_RECIPIENTS,
    Math.max(1, Math.floor(requestedMaxRecipients))
  );

  if (filters.conversationScope === "campaign_sends") {
    if (!canResolveCampaignSendAudienceFromHistory(filters)) {
      throw new BulkAnalyticsAudienceUnavailableError(
        "campaign_send_audience_rollup_required",
        getCampaignSendAudienceUnavailableMessage(filters)
      );
    }

    return resolveCampaignSendAudienceFromHistory({
      workspaceId: params.workspaceId,
      filters,
      templateCategory: params.templateCategory,
      maxRecipients,
    });
  }

  throw new BulkAnalyticsAudienceUnavailableError(
    "conversation_audience_rollup_required",
    getConversationAudienceUnavailableMessage(filters)
  );
}
