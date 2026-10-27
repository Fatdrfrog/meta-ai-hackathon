import {
  getCompanyConversationVisibilityGate,
  toPublicLimitPayload,
  type CompanyConversationVisibilityGate,
} from "@/lib/limits/company-limits";
import { buildCacheKey, cache } from "@/lib/cache";
import { awaitWithCancellation, throwIfCancelled } from "@/lib/ai/cancellation";
import { createInferenceDeadline } from "@/lib/ai/inference-deadline";
import { withCustomerMediaReadUrls } from "@/lib/media/customer-media-read-url";
import { readRequestsProjectionActivationDecision } from "@/lib/requests-projection/activation";
import { readRequestsProjectionCheckpoint } from "@/lib/requests-projection/checkpoint";
import Message from "@/models/message";
import { RequestListItem } from "@/models/request-list-item";
import type {
  RawConversation,
  RawRequestConversationMessage,
} from "@icecore/shared/types/requests";
import { parseProjectionGeneration } from "@icecore/shared/types/requests-realtime";
import type { Channel } from "@icecore/shared/types/sources";
import type { SupabaseClient } from "@supabase/supabase-js";
import mongoose from "mongoose";
import { createHash } from "node:crypto";

import {
  encodeRequestProjectionWatermark,
  type RequestListItemPayload,
  type RequestProjectionWorkState,
} from "@/lib/requests-projection/contract";
import { asRecord } from "@icecore/shared/lib/value-utils";

export interface RequestQueryParams {
  workspaceId: string;
  channel?: string | null;
  filter?: string | null;
  unread?: boolean | string | null;
  category?: string | null;
  internalLabel?: string | null;
  status?: string | null;
  searchType?: string | null;
  searchQuery?: string | null;
  airiReplied?: boolean | string | null;
  conversationIds?: string[] | null;
  page: number;
  limit: number;
}

export interface PaginationResponse {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export type RequestsPlanGate = {
  hiddenCount: number;
  reason: "trial_expired" | "conversation_limit";
  limit: ReturnType<typeof toPublicLimitPayload>;
};

export interface RequestsResponse {
  data: RawConversation[];
  pagination: PaginationResponse;
  availableChannels?: string[];
  availableCategories?: string[];
  planGate?: RequestsPlanGate;
}

interface GetRequestsDataOptions {
  includeChannels?: boolean;
  countOnly?: boolean;
  bypassCache?: boolean;
}

// The list only reads live rows (deletedAt null, projection ready), for which
// derive always writes createdAt, displayAt and status.
type ProjectionRow = Omit<
  RequestListItemPayload,
  "projection" | "createdAt" | "displayAt" | "status"
> &
  Required<
    Pick<RequestListItemPayload, "createdAt" | "displayAt" | "status">
  > & {
    projection: Omit<
      RequestProjectionWorkState,
      "sourceWatermark" | "readStateWatermark"
    > & {
      sourceWatermark?: unknown;
      readStateWatermark?: unknown;
    };
  };

type RequestProjectionWatermarkMode =
  | "strict_persisted"
  | "pre_migration_legacy_list";

const ZERO_REQUEST_PROJECTION_WATERMARK = "0000000000000000";

type ProjectionCollection = {
  find(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): {
    sort(sort: Record<string, 1 | -1>): {
      skip(value: number): {
        limit(value: number): { toArray(): Promise<ProjectionRow[]> };
      };
    };
  };
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  distinct(field: string, filter: Record<string, unknown>): Promise<unknown[]>;
};

function projectionCollection(): ProjectionCollection {
  return RequestListItem.collection as unknown as ProjectionCollection;
}

export class RequestsProjectionNotReadyError extends Error {
  readonly code = "requests_projection_not_ready";

  constructor() {
    super("requests_projection_not_ready");
    this.name = "RequestsProjectionNotReadyError";
  }
}

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

function safeDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function projectedInstagramThread(
  value: unknown
): RawConversation["external_thread"] | null {
  const meta = asRecord(value);
  if (Object.keys(meta).length === 0) return null;

  const commentTimestamp = safeDate(meta.commentTimestamp);
  const mediaTimestamp = safeDate(meta.mediaTimestamp);
  const mediaPreviewUrl = stringValue(meta.mediaPreviewUrl);
  const mediaPermalink = stringValue(meta.mediaPermalink);
  const mediaType = stringValue(meta.mediaType);
  const mediaProductType = stringValue(meta.mediaProductType);
  const mediaCaption = stringValue(meta.mediaCaption);
  const mediaShortcode = stringValue(meta.mediaShortcode);
  const mediaAuthorUsername = stringValue(meta.mediaAuthorUsername);
  const likeCount =
    typeof meta.likeCount === "number" && Number.isFinite(meta.likeCount)
      ? meta.likeCount
      : undefined;

  return {
    type: "comment",
    ...(mediaPermalink ? { permalink: mediaPermalink } : {}),
    comment: {
      ...(commentTimestamp ? { timestamp: commentTimestamp } : {}),
      ...(meta.isReply === true ? { parentId: "projected-reply" } : {}),
      ...(typeof meta.isHidden === "boolean" ? { hidden: meta.isHidden } : {}),
      ...(likeCount !== undefined ? { likeCount } : {}),
    },
    media: {
      ...(mediaType ? { mediaType } : {}),
      ...(mediaProductType ? { mediaProductType } : {}),
      ...(mediaTimestamp ? { timestamp: mediaTimestamp } : {}),
      ...(mediaCaption ? { caption: mediaCaption } : {}),
      ...(mediaPreviewUrl ? { thumbnailUrl: mediaPreviewUrl } : {}),
      ...(mediaShortcode ? { shortcode: mediaShortcode } : {}),
      ...(mediaAuthorUsername ? { username: mediaAuthorUsername } : {}),
    },
  };
}

function objectIdStrings(
  values: readonly unknown[]
): mongoose.Types.ObjectId[] {
  const result = new Map<string, mongoose.Types.ObjectId>();
  for (const value of values) {
    const text = String(value || "");
    if (!mongoose.Types.ObjectId.isValid(text)) continue;
    result.set(text, new mongoose.Types.ObjectId(text));
  }
  return [...result.values()];
}

function intersectIds(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined
): string[] | null | undefined {
  if (left == null) return right == null ? left : [...right];
  if (right == null) return [...left];
  const allowed = new Set(right);
  return left.filter(id => allowed.has(id));
}

export function assertRequestsProjectionReady(checkpoint: unknown): void {
  if (asRecord(checkpoint).state !== "ready") {
    throw new RequestsProjectionNotReadyError();
  }
}

const PROJECTION_METADATA_CACHE_TTL_SECONDS = 60;
const projectionMetadataInFlight = new Map<string, Promise<unknown>>();

async function getCachedProjectionMetadata<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
  options?: { bypassCache?: boolean }
): Promise<T> {
  if (options?.bypassCache || process.env.NODE_ENV === "test") {
    return fetcher();
  }
  const existing = projectionMetadataInFlight.get(cacheKey);
  if (existing) return existing as Promise<T>;

  const read = (async () => {
    const cached = await cache.get<T>(cacheKey).catch(() => null);
    if (cached) return cached;
    const data = await fetcher();
    await cache
      .set(cacheKey, data, PROJECTION_METADATA_CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return data;
  })();
  projectionMetadataInFlight.set(cacheKey, read);
  try {
    return await read;
  } finally {
    if (projectionMetadataInFlight.get(cacheKey) === read) {
      projectionMetadataInFlight.delete(cacheKey);
    }
  }
}

function getActivationDecision(options?: { bypassCache?: boolean }) {
  return getCachedProjectionMetadata(
    "requests_projection_activation_decision",
    readRequestsProjectionActivationDecision,
    options
  );
}

function getRequestsProjectionCheckpoint(options?: { bypassCache?: boolean }) {
  return getCachedProjectionMetadata(
    "requests_projection_checkpoint",
    readRequestsProjectionCheckpoint,
    options
  );
}

/** Digits-only match for phone search; needs at least four digits. */
function phoneDigitsPattern(phone: string): RegExp | undefined {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? new RegExp(digits) : undefined;
}

export function buildProjectionListQuery(
  params: Partial<RequestQueryParams> & Pick<RequestQueryParams, "workspaceId">
): {
  filter: Record<string, unknown>;
  sort: { sortAt: -1; _id: -1 };
  skip: number;
  limit: number;
} {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 50));
  const filter: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    deletedAt: null,
    "projection.status": "ready",
  };

  if (params.channel) filter.channel = params.channel;
  if (params.status) filter.status = params.status;
  if (params.category) filter.category = params.category;
  if (params.internalLabel && params.internalLabel !== "all") {
    filter.internalLabels = params.internalLabel;
  }
  if (bool(params.unread)) filter.unreadGeneration = { $type: "long" };
  if (bool(params.airiReplied)) filter.hasAiriReply = true;

  if (params.conversationIds !== undefined && params.conversationIds !== null) {
    filter._id = { $in: objectIdStrings(params.conversationIds) };
  }

  if (params.filter === "slaBreached") {
    filter.status = { $ne: "closed" };
    filter.slaDueAt = { $lt: new Date() };
  } else if (params.filter === "csatLow") {
    filter.customerSatisfactionScore = { $lte: 3 };
  } else if (params.filter === "bestPractice") {
    filter.isBestPractice = true;
  }

  const phonePattern =
    params.searchType === "phone_number"
      ? phoneDigitsPattern(params.searchQuery || "")
      : undefined;
  if (phonePattern) {
    filter.phoneDigits = { $regex: phonePattern };
  }

  const profileQuery =
    params.searchType === "profile_name" ? params.searchQuery?.trim() : null;
  if (profileQuery) {
    filter.profileSearchText = {
      $regex: new RegExp(
        profileQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      ),
    };
  }

  return {
    filter,
    sort: { sortAt: -1, _id: -1 },
    skip: (page - 1) * limit,
    limit,
  };
}

function mapProjectionWatermark(
  value: unknown,
  mode: RequestProjectionWatermarkMode
): string {
  if (value instanceof mongoose.mongo.Timestamp) {
    return encodeRequestProjectionWatermark(value);
  }
  if (mode === "pre_migration_legacy_list" && value === undefined) {
    return ZERO_REQUEST_PROJECTION_WATERMARK;
  }
  throw new Error("requests_projection_watermark_not_ready");
}

export function mapRequestProjectionRow(
  row: ProjectionRow,
  options: { watermarkMode: RequestProjectionWatermarkMode }
): RawConversation {
  const recentMessages = (row.recentMessages ||
    []) as RawRequestConversationMessage[];
  const customer = asRecord(row.customer);
  const chat = asRecord(row.chat);
  const classification = asRecord(row.classification);
  const sourceId = stringValue(row.sourceId);

  return {
    _id: row._id.toHexString(),
    projectionGeneration: parseProjectionGeneration(
      row.projection.generation.toString()
    ),
    readStateWatermark: mapProjectionWatermark(
      row.projection.readStateWatermark,
      options.watermarkMode
    ),
    createdAt: row.createdAt,
    ...(row.channel ? { channel: row.channel as Channel } : {}),
    ...(row.businessConnectionId
      ? { business_connection_id: row.businessConnectionId }
      : {}),
    internal_labels: stringArray(row.internalLabels),
    subject: row.subject ?? null,
    rename: row.rename ?? null,
    // derive sheds participants from rows over the 16 KiB cap.
    participants: row.participants || { from: [], to: [] },
    chat:
      Object.keys(chat).length > 0 || sourceId
        ? {
            ...(chat as NonNullable<RawConversation["chat"]>),
            ...(sourceId ? { sourceId } : {}),
          }
        : null,
    status: row.status,
    user:
      Object.keys(customer).length > 0
        ? (customer as NonNullable<RawConversation["user"]>)
        : null,
    awaiting_csat: row.awaitingCsat === true,
    customer_satisfaction_score: row.customerSatisfactionScore ?? null,
    classification: classification as RawConversation["classification"],
    lastInboundMessageAt: row.lastInboundAt ?? null,
    computedLastMessageAt: row.displayAt,
    is_read_by_manager: row.unreadGeneration == null,
    airiLastReplied: row.hasAiriReply === true,
    external_thread: projectedInstagramThread(row.instagram),
    // Mobile renders this directly; web derives it from messages.
    lastMessageText: recentMessages[0]?.text,
    messages: recentMessages,
  };
}

const MESSAGE_SEARCH_MAX_TIME_MS = 5_000;

async function resolveMessageConversationIds(
  workspaceId: string,
  query: string
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const deadline = createInferenceDeadline(MESSAGE_SEARCH_MAX_TIME_MS);
  const signal = AbortSignal.timeout(MESSAGE_SEARCH_MAX_TIME_MS);
  const remainingTimeMS = () => {
    throwIfCancelled(signal);
    const remaining = deadline.nextTimeoutMs(MESSAGE_SEARCH_MAX_TIME_MS, 1);
    if (remaining === null)
      throw new DOMException(
        "Request message search exceeded its execution budget.",
        "TimeoutError"
      );
    return remaining;
  };
  let rows: Array<{ conversation?: unknown }>;
  try {
    rows = await awaitWithCancellation(
      Message.aggregate(
        [
          {
            $search: {
              index: "messages_text_search",
              compound: {
                filter: [
                  { equals: { path: "workspaceId", value: workspaceId } },
                ],
                should: [
                  { phrase: { query: trimmed, path: "text" } },
                  {
                    wildcard: {
                      query: `*${trimmed.toLowerCase()}*`,
                      path: "text",
                      allowAnalyzedField: true,
                    },
                  },
                ],
                minimumShouldMatch: 1,
              },
            },
          },
          { $limit: 500 },
          { $project: { conversation: 1 } },
        ],
        { maxTimeMS: remainingTimeMS(), signal }
      ).exec(),
      signal
    );
  } catch (error) {
    // Cancellation and timeouts are terminal: a fallback must not restart work.
    throwIfCancelled(signal, error);
    const failure = asRecord(error);
    if (
      failure.code === 50 ||
      failure.codeName === "MaxTimeMSExpired" ||
      failure.codeName === "ExceededTimeLimit" ||
      failure.name === "MongoOperationTimeoutError" ||
      failure.name === "MongoNetworkTimeoutError"
    )
      throw error;
    const maxTimeMS = remainingTimeMS();
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rows = await awaitWithCancellation(
      Message.find(
        {
          workspaceId,
          text: { $regex: new RegExp(escaped, "i") },
        },
        undefined,
        { maxTimeMS, signal }
      )
        .select("conversation")
        .sort({ date: -1 })
        .limit(500)
        .lean<Array<{ conversation?: unknown }>>()
        .exec(),
      signal
    );
  }
  remainingTimeMS();
  return objectIdStrings(rows.map(row => row.conversation)).map(id =>
    id.toHexString()
  );
}

export function planGatePayload(
  gate: CompanyConversationVisibilityGate | null
): RequestsPlanGate | undefined {
  // At the free cap (e.g. 500 of 500) nothing is hidden yet, but new chats on
  // every channel, WhatsApp included, are refused, so the banner still shows.
  if (
    !gate ||
    (!gate.reason &&
      gate.hiddenConversationCount === 0 &&
      gate.limit.conversationExhausted !== true)
  ) {
    return undefined;
  }
  return {
    hiddenCount: gate.hiddenConversationCount,
    reason: gate.reason || "conversation_limit",
    limit: toPublicLimitPayload(gate.limit),
  };
}

function toWhatsAppSourceInfo(
  credentials: unknown
): RawConversation["sourceInfo"] | undefined {
  const record = asRecord(credentials);
  const displayPhoneNumber = stringValue(record.display_phone_number);
  const phoneNumberId = stringValue(record.phone_number_id);
  if (!displayPhoneNumber && !phoneNumberId) return undefined;
  return {
    ...(displayPhoneNumber ? { display_phone_number: displayPhoneNumber } : {}),
    ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}),
  };
}

const WHATSAPP_SOURCE_CACHE_TTL_SECONDS = 600;

async function enrichWhatsAppSources(
  rows: RawConversation[],
  supabaseClient?: SupabaseClient
): Promise<RawConversation[]> {
  if (!supabaseClient) return rows;
  const sourceIds = [
    ...new Set(
      rows.flatMap(row =>
        row.channel === "whatsapp" && row.chat?.sourceId
          ? [row.chat.sourceId]
          : []
      )
    ),
  ];
  if (sourceIds.length === 0) return rows;

  const sourceMap = new Map<string, RawConversation["sourceInfo"]>();
  const cachedEntries = await Promise.all(
    sourceIds.map(async id => ({
      id,
      cached: await cache
        .get<
          RawConversation["sourceInfo"]
        >(buildCacheKey("whatsapp_source_info", [id]))
        .catch(() => null),
    }))
  );

  const missingSourceIds: string[] = [];
  for (const { id, cached } of cachedEntries) {
    if (cached !== null && cached !== undefined) {
      sourceMap.set(id, toWhatsAppSourceInfo(cached));
    } else {
      missingSourceIds.push(id);
    }
  }

  if (missingSourceIds.length > 0) {
    const { data: sources } = await supabaseClient
      .from("sources")
      .select("id, credentials")
      .in("id", missingSourceIds)
      .eq("type", "whatsapp");

    await Promise.all(
      (sources || []).map(async source => {
        const id = String(source.id);
        const info = toWhatsAppSourceInfo(source.credentials);
        sourceMap.set(id, info);
        const cacheKey = buildCacheKey("whatsapp_source_info", [id]);
        await cache
          .set(cacheKey, info ?? {}, WHATSAPP_SOURCE_CACHE_TTL_SECONDS)
          .catch(() => undefined);
      })
    );
  }

  return rows.map(row => {
    const sourceId = row.chat?.sourceId;
    const sourceInfo = sourceId ? sourceMap.get(sourceId) : undefined;
    return sourceInfo ? { ...row, sourceInfo } : row;
  });
}

const WORKSPACE_CHANNELS_CATEGORIES_CACHE_TTL_SECONDS = 300;

async function getCachedWorkspaceChannelsAndCategories(
  workspaceId: string,
  visibilityFilter: Record<string, unknown>,
  collection: ProjectionCollection,
  options?: { bypassCache?: boolean }
): Promise<{ channels: string[]; categories: string[] }> {
  const cacheKey = buildCacheKey("workspace_channels_categories", [
    workspaceId,
  ]);
  const restrictedIds = asRecord(visibilityFilter._id).$in;
  const scope = options?.bypassCache
    ? undefined
    : createHash("sha256")
        .update(
          JSON.stringify(
            Array.isArray(restrictedIds)
              ? [...new Set(restrictedIds.map(id => String(id)))].sort()
              : null
          )
        )
        .digest("hex");
  const cached =
    scope === undefined
      ? null
      : await cache
          .get<{
            scope: string;
            channels: string[];
            categories: string[];
          }>(cacheKey)
          .catch(() => null);
  if (
    cached &&
    cached.scope === scope &&
    Array.isArray(cached.channels) &&
    Array.isArray(cached.categories)
  ) {
    return cached;
  }

  const [channels, categories] = await Promise.all([
    collection.distinct("channel", visibilityFilter),
    collection.distinct("category", visibilityFilter),
  ]);

  const result = {
    channels: (channels as string[])
      .filter(
        (value): value is string => typeof value === "string" && Boolean(value)
      )
      .sort(),
    categories: (categories as string[])
      .filter(
        (value): value is string => typeof value === "string" && Boolean(value)
      )
      .sort(),
  };

  if (scope !== undefined) {
    await cache
      .set(
        cacheKey,
        { scope, ...result },
        WORKSPACE_CHANNELS_CATEGORIES_CACHE_TTL_SECONDS
      )
      .catch(() => undefined);
  }

  return result;
}

export async function getRequestsData(
  workspaceId: string,
  params: Partial<RequestQueryParams>,
  supabaseClient?: SupabaseClient,
  options: GetRequestsDataOptions = {}
): Promise<RequestsResponse> {
  const queryParams: RequestQueryParams = {
    workspaceId,
    page: params.page || 1,
    limit: params.limit || 50,
    ...params,
  };
  const { default: connectDB } = await import("@/lib/mongoose");
  await connectDB();
  const checkpointPromise = getRequestsProjectionCheckpoint(options);
  const activationDecisionPromise = getActivationDecision(options).then(
    decision => ({ decision }),
    error => ({ error })
  );
  assertRequestsProjectionReady(await checkpointPromise);
  const activationResult = await activationDecisionPromise;
  if ("error" in activationResult) throw activationResult.error;
  const activationDecision = activationResult.decision;

  const gate = supabaseClient
    ? await getCompanyConversationVisibilityGate(supabaseClient, workspaceId)
    : null;
  let visibleConversationIds = gate?.visibleConversationIds;
  const messageSearch =
    queryParams.searchType === "message_within_chat"
      ? queryParams.searchQuery?.trim()
      : undefined;
  if (messageSearch) {
    visibleConversationIds = intersectIds(
      visibleConversationIds,
      await resolveMessageConversationIds(workspaceId, messageSearch)
    );
  }
  visibleConversationIds = intersectIds(
    visibleConversationIds,
    queryParams.conversationIds
  );

  const effectiveParams: RequestQueryParams = {
    ...queryParams,
    ...(visibleConversationIds !== null && visibleConversationIds !== undefined
      ? { conversationIds: visibleConversationIds }
      : {}),
  };
  const query = buildProjectionListQuery(effectiveParams);
  const collection = projectionCollection();
  const visibilityFilter: Record<string, unknown> = {
    workspaceId,
    deletedAt: null,
    "projection.status": "ready",
    ...(visibleConversationIds !== null && visibleConversationIds !== undefined
      ? { _id: { $in: objectIdStrings(visibleConversationIds) } }
      : {}),
  };

  const shouldCountTotal =
    Boolean(options.countOnly) || Boolean(queryParams.unread);

  const fetchLimit = shouldCountTotal ? query.limit : query.limit + 1;
  const rowsPromise = options.countOnly
    ? Promise.resolve([] as ProjectionRow[])
    : (collection
        .find(query.filter, { promoteLongs: false })
        .sort(query.sort)
        .skip(query.skip)
        .limit(fetchLimit)
        .toArray() as Promise<ProjectionRow[]>);
  const pageRowsPromise = rowsPromise.then(rawRows => ({
    rawRows,
    projectionRows:
      !shouldCountTotal && rawRows.length > query.limit
        ? rawRows.slice(0, query.limit)
        : rawRows,
  }));
  const dataPromise = pageRowsPromise.then(({ projectionRows }) =>
    options.countOnly
      ? []
      : enrichWhatsAppSources(
          projectionRows.map(row =>
            mapRequestProjectionRow(row, {
              watermarkMode: activationDecision.listWatermarkMode,
            })
          ),
          supabaseClient
        ).then(rows => withCustomerMediaReadUrls(rows))
  );

  const countPromise = shouldCountTotal
    ? collection.countDocuments(query.filter)
    : Promise.resolve(null);

  const channelsAndCategoriesPromise = options.includeChannels
    ? getCachedWorkspaceChannelsAndCategories(
        workspaceId,
        visibilityFilter,
        collection,
        {
          bypassCache:
            Boolean(messageSearch) ||
            (queryParams.conversationIds !== null &&
              queryParams.conversationIds !== undefined),
        }
      )
    : Promise.resolve({ channels: [], categories: [] });

  const [
    { rawRows, projectionRows },
    totalCountResult,
    channelsAndCategories,
    data,
  ] = await Promise.all([
    pageRowsPromise,
    countPromise,
    channelsAndCategoriesPromise,
    dataPromise,
  ]);

  const hasNextPage =
    totalCountResult !== null
      ? queryParams.page < Math.ceil(totalCountResult / query.limit)
      : rawRows.length > query.limit;

  const totalCount =
    totalCountResult !== null
      ? totalCountResult
      : hasNextPage
        ? query.skip + query.limit + 1
        : query.skip + projectionRows.length;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / query.limit);
  const planGate = planGatePayload(gate);

  return {
    data,
    pagination: {
      page: queryParams.page,
      limit: query.limit,
      totalCount,
      totalPages,
      hasNextPage,
      hasPrevPage: queryParams.page > 1,
    },
    ...(options.includeChannels
      ? {
          availableChannels: channelsAndCategories.channels,
          availableCategories: channelsAndCategories.categories,
        }
      : {}),
    ...(planGate ? { planGate } : {}),
  };
}
