import {
  FUNNEL_SEGMENT_KEYS,
  type ScenarioMetaAdsDataStatus,
  type ScenarioMetaCampaignLabelOption,
} from "@icecore/scenario-contracts";
import {
  fetchLiveMetaReferralAudience,
  type RawMetaCampaignLabel,
  type RawMetaReferralAdForScenario,
} from "@/lib/meta-ads/meta-ads-audience";
import { logger } from "@/lib/logger";
import { ensureIndexes } from "@/lib/mongo";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { resolveWhatsAppReferralSourcePlatform } from "@icecore/whatsapp/referralFields";
import { Conversation } from "@/models/conversation";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  readNonEmptyStringOrUndefined as normalizeOptionalString,
  readUniqueStringArray,
} from "@icecore/shared/lib/value-utils";
import { CONVERSATION_CHANNELS } from "@icecore/shared/types/sources";
import { NextRequest, NextResponse, after } from "next/server";

export const runtime = "nodejs";

type Params = Promise<{ workspaceId: string }>;

type AudienceCustomer = {
  id: string;
  label: string;
  channel?: string;
  category?: string;
  segmentKey?: string | null;
  hasPurchaseHistory?: boolean;
  internalLabels?: string[];
  lastMessageAt?: string | null;
};

type MetaReferralAdOption = {
  id: string;
  label: string;
  sourceId: string;
  sourceType?: string;
  sourcePlatform?: string;
  channel?: string;
  campaignId?: string;
  campaignName?: string;
  adSetId?: string;
  adSetName?: string;
  headline?: string;
  body?: string;
  sourceUrl?: string;
  mediaUrl?: string;
  lastSeenAt?: string | null;
  conversationCount?: number;
};

type MetaReferralCampaignOption = {
  id: string;
  label: string;
  campaignId: string;
  campaignName?: string;
  lastSeenAt?: string | null;
  adCount?: number;
  conversationCount?: number;
};

type MetaReferralAdSetOption = {
  id: string;
  label: string;
  adSetId: string;
  adSetName?: string;
  campaignId?: string;
  campaignName?: string;
  lastSeenAt?: string | null;
  adCount?: number;
  conversationCount?: number;
};

type RawMetaReferralAd = RawMetaReferralAdForScenario;

type FunnelSegmentKey = (typeof FUNNEL_SEGMENT_KEYS)[number];

const MAX_META_REFERRAL_AD_OPTIONS = 1000;
const SEGMENT_LABEL_PREFIX = "seg:";
const FUNNEL_SEGMENT_SET = new Set<FunnelSegmentKey>(FUNNEL_SEGMENT_KEYS);
const CONVERSATION_CHANNEL_SET = new Set<string>(CONVERSATION_CHANNELS);

function rawCustomerFreshnessAlias(path: string): string {
  return path
    .split(/[._]/u)
    .map((part, index) =>
      index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`
    )
    .join("");
}

const RAW_CUSTOMER_CLASSIFICATION_PROJECTION = Object.fromEntries([
  ["classificationCategory", "$classification.category"],
  ...CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS.map(path => [
    rawCustomerFreshnessAlias(path),
    `$${path}`,
  ]),
]);

const RAW_CUSTOMER_CLASSIFICATION_GROUP = Object.fromEntries(
  Object.keys(RAW_CUSTOMER_CLASSIFICATION_PROJECTION).map(alias => [
    alias,
    { $first: `$${alias}` },
  ])
);

function assignOwnPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown
) {
  const parts = path.split(".");
  let target = root;
  for (const part of parts.slice(0, -1)) {
    const existing = target[part];
    const child =
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    if (child !== existing) target[part] = child;
    target = child;
  }
  target[parts[parts.length - 1]] = value;
}

function buildRawCustomerClassificationRoot(
  row: Record<string, unknown>
): Record<string, unknown> {
  const root: Record<string, unknown> = {
    classification: { category: row.classificationCategory },
  };
  for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
    assignOwnPath(root, path, row[rawCustomerFreshnessAlias(path)]);
  }
  return root;
}

function normalizeUniqueStrings(values: Array<string | null | undefined>) {
  return readUniqueStringArray(values).sort((a, b) => a.localeCompare(b));
}

function normalizeRawDate(
  value: Date | string | null | undefined
): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : value.trim();
}

function resolveMetaReferralAdLabel(params: {
  sourceId: string;
  headline?: string;
  body?: string;
}): string {
  return (
    params.headline ||
    params.body ||
    `Meta ad ${params.sourceId.slice(-6) || params.sourceId}`
  );
}

function compareNullableIsoDate(
  left: string | null | undefined,
  right: string | null | undefined
): number {
  const leftMs = left ? Date.parse(left) : 0;
  const rightMs = right ? Date.parse(right) : 0;
  return (
    (Number.isFinite(leftMs) ? leftMs : 0) -
    (Number.isFinite(rightMs) ? rightMs : 0)
  );
}

function mergeMetaReferralAdOptions(
  existing: MetaReferralAdOption,
  next: MetaReferralAdOption
): MetaReferralAdOption {
  const preferNext =
    compareNullableIsoDate(next.lastSeenAt, existing.lastSeenAt) >= 0;
  const newer = preferNext ? next : existing;
  const older = preferNext ? existing : next;

  return {
    ...older,
    ...newer,
    label: newer.label || older.label,
    headline: newer.headline || older.headline,
    body: newer.body || older.body,
    campaignId: newer.campaignId || older.campaignId,
    campaignName: newer.campaignName || older.campaignName,
    adSetId: newer.adSetId || older.adSetId,
    adSetName: newer.adSetName || older.adSetName,
    sourceUrl: newer.sourceUrl || older.sourceUrl,
    sourcePlatform: newer.sourcePlatform || older.sourcePlatform,
    channel: newer.channel || older.channel,
    mediaUrl: newer.mediaUrl || older.mediaUrl,
    conversationCount:
      (existing.conversationCount || 0) + (next.conversationCount || 0),
  };
}

function normalizeMetaReferralAds(
  rows: RawMetaReferralAd[]
): MetaReferralAdOption[] {
  const bySourceId = new Map<string, MetaReferralAdOption>();

  for (const row of rows) {
    const sourceId = normalizeOptionalString(row.sourceId);
    if (!sourceId) continue;

    const sourceType = normalizeOptionalString(row.sourceType);
    if (sourceType && sourceType.toLowerCase() !== "ad") continue;

    const sourceUrl = normalizeOptionalString(row.sourceUrl);
    const sourcePlatform =
      normalizeOptionalString(row.sourcePlatform) ||
      // A message referral URL is evidence of origin; a catalog creative URL
      // is not evidence that an ad was delivered on a particular platform.
      (row.channel
        ? resolveWhatsAppReferralSourcePlatform(sourceUrl || "")
        : undefined);

    const headline = normalizeOptionalString(row.headline);
    const body = normalizeOptionalString(row.body);
    const option: MetaReferralAdOption = {
      id: `ad:${sourceId}`,
      label: resolveMetaReferralAdLabel({ sourceId, headline, body }),
      sourceId,
      sourceType: "ad",
      sourcePlatform: normalizeOptionalString(sourcePlatform),
      channel: normalizeOptionalString(row.channel),
      campaignId: normalizeOptionalString(row.campaignId),
      campaignName: normalizeOptionalString(row.campaignName),
      adSetId: normalizeOptionalString(row.adSetId),
      adSetName: normalizeOptionalString(row.adSetName),
      headline,
      body,
      sourceUrl,
      mediaUrl: normalizeOptionalString(row.mediaUrl),
      lastSeenAt: normalizeRawDate(row.lastSeenAt),
      conversationCount:
        typeof row.count === "number" && Number.isFinite(row.count)
          ? row.count
          : undefined,
    };

    const key = sourceId.toLowerCase();
    const existing = bySourceId.get(key);
    bySourceId.set(
      key,
      existing ? mergeMetaReferralAdOptions(existing, option) : option
    );
  }

  return Array.from(bySourceId.values())
    .sort((left, right) => {
      const dateSort = compareNullableIsoDate(
        right.lastSeenAt,
        left.lastSeenAt
      );
      if (dateSort !== 0) return dateSort;
      return left.label.localeCompare(right.label);
    })
    .slice(0, MAX_META_REFERRAL_AD_OPTIONS + 1);
}

type MetaReferralGroupAccumulator<T> = T & {
  sourceIds: Set<string>;
  adCountValue: number;
  conversationCountValue: number;
};

function normalizePositiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function normalizeMetaCampaignLabels(
  rows: RawMetaCampaignLabel[] | undefined
): ScenarioMetaCampaignLabelOption[] {
  const seen = new Set<string>();
  const labels: ScenarioMetaCampaignLabelOption[] = [];
  for (const row of rows ?? []) {
    const labelId = normalizeOptionalString(row.id);
    const adAccountId = normalizeOptionalString(row.adAccountId);
    if (!labelId || !adAccountId) continue;
    const key = `${adAccountId.toLowerCase()}:${labelId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = normalizeOptionalString(row.name) || labelId;
    const adAccountName = normalizeOptionalString(row.adAccountName);
    labels.push({
      id: key,
      labelId,
      name,
      adAccountId,
      ...(adAccountName ? { adAccountName } : {}),
    });
  }
  return labels;
}

function normalizeMetaReferralCampaigns(
  rows: RawMetaReferralAd[]
): MetaReferralCampaignOption[] {
  const byCampaignId = new Map<
    string,
    MetaReferralGroupAccumulator<MetaReferralCampaignOption>
  >();

  for (const row of rows) {
    const campaignId = normalizeOptionalString(row.campaignId);
    const sourceId = normalizeOptionalString(row.sourceId);
    if (!campaignId) continue;

    const campaignName = normalizeOptionalString(row.campaignName);
    const lastSeenAt = normalizeRawDate(row.lastSeenAt);
    const key = campaignId.toLowerCase();
    const existing = byCampaignId.get(key);
    const count = normalizePositiveNumber(row.count);
    const adCount = normalizePositiveNumber(row.adCount);

    if (!existing) {
      byCampaignId.set(key, {
        id: `campaign:${campaignId}`,
        label: campaignName || `Campaign ${campaignId.slice(-6)}`,
        campaignId,
        campaignName,
        lastSeenAt,
        sourceIds: sourceId ? new Set([sourceId.toLowerCase()]) : new Set(),
        adCountValue: adCount,
        conversationCountValue: count,
      });
      continue;
    }

    if (sourceId) existing.sourceIds.add(sourceId.toLowerCase());
    existing.adCountValue = Math.max(existing.adCountValue, adCount);
    existing.conversationCountValue += count;
    if (!existing.campaignName && campaignName) {
      existing.campaignName = campaignName;
      existing.label = campaignName;
    }
    if (compareNullableIsoDate(lastSeenAt, existing.lastSeenAt) > 0) {
      existing.lastSeenAt = lastSeenAt;
    }
  }

  return Array.from(byCampaignId.values())
    .map(({ sourceIds, adCountValue, conversationCountValue, ...option }) => ({
      ...option,
      adCount:
        Math.max(sourceIds.size, Math.round(adCountValue)) > 0
          ? Math.max(sourceIds.size, Math.round(adCountValue))
          : undefined,
      conversationCount:
        conversationCountValue > 0 ? conversationCountValue : undefined,
    }))
    .sort((left, right) => {
      const dateSort = compareNullableIsoDate(
        right.lastSeenAt,
        left.lastSeenAt
      );
      if (dateSort !== 0) return dateSort;
      return left.label.localeCompare(right.label);
    })
    .slice(0, MAX_META_REFERRAL_AD_OPTIONS + 1);
}

function normalizeMetaReferralAdSets(
  rows: RawMetaReferralAd[]
): MetaReferralAdSetOption[] {
  const byAdSetId = new Map<
    string,
    MetaReferralGroupAccumulator<MetaReferralAdSetOption>
  >();

  for (const row of rows) {
    const adSetId = normalizeOptionalString(row.adSetId);
    const sourceId = normalizeOptionalString(row.sourceId);
    if (!adSetId) continue;

    const adSetName = normalizeOptionalString(row.adSetName);
    const campaignId = normalizeOptionalString(row.campaignId);
    const campaignName = normalizeOptionalString(row.campaignName);
    const lastSeenAt = normalizeRawDate(row.lastSeenAt);
    const key = adSetId.toLowerCase();
    const existing = byAdSetId.get(key);
    const count = normalizePositiveNumber(row.count);
    const adCount = normalizePositiveNumber(row.adCount);

    if (!existing) {
      byAdSetId.set(key, {
        id: `adset:${adSetId}`,
        label: adSetName || `Ad set ${adSetId.slice(-6)}`,
        adSetId,
        adSetName,
        campaignId,
        campaignName,
        lastSeenAt,
        sourceIds: sourceId ? new Set([sourceId.toLowerCase()]) : new Set(),
        adCountValue: adCount,
        conversationCountValue: count,
      });
      continue;
    }

    if (sourceId) existing.sourceIds.add(sourceId.toLowerCase());
    existing.adCountValue = Math.max(existing.adCountValue, adCount);
    existing.conversationCountValue += count;
    if (!existing.adSetName && adSetName) {
      existing.adSetName = adSetName;
      existing.label = adSetName;
    }
    if (!existing.campaignId && campaignId) existing.campaignId = campaignId;
    if (!existing.campaignName && campaignName) {
      existing.campaignName = campaignName;
    }
    if (compareNullableIsoDate(lastSeenAt, existing.lastSeenAt) > 0) {
      existing.lastSeenAt = lastSeenAt;
    }
  }

  return Array.from(byAdSetId.values())
    .map(({ sourceIds, adCountValue, conversationCountValue, ...option }) => ({
      ...option,
      adCount:
        Math.max(sourceIds.size, Math.round(adCountValue)) > 0
          ? Math.max(sourceIds.size, Math.round(adCountValue))
          : undefined,
      conversationCount:
        conversationCountValue > 0 ? conversationCountValue : undefined,
    }))
    .sort((left, right) => {
      const dateSort = compareNullableIsoDate(
        right.lastSeenAt,
        left.lastSeenAt
      );
      if (dateSort !== 0) return dateSort;
      return left.label.localeCompare(right.label);
    })
    .slice(0, MAX_META_REFERRAL_AD_OPTIONS + 1);
}

function normalizeSegmentKey(value: unknown): FunnelSegmentKey | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.startsWith(SEGMENT_LABEL_PREFIX)
    ? trimmed.slice(SEGMENT_LABEL_PREFIX.length)
    : trimmed;
  if (!FUNNEL_SEGMENT_SET.has(withoutPrefix as FunnelSegmentKey)) return null;
  return withoutPrefix as FunnelSegmentKey;
}

function resolveSegmentFromConversation(params: {
  internalLabels?: string[];
  classificationCategory?: string;
}): FunnelSegmentKey | null {
  for (const label of params.internalLabels || []) {
    const segment = normalizeSegmentKey(label);
    if (segment) return segment;
  }
  return normalizeSegmentKey(params.classificationCategory);
}

/**
 * The reads below work without these indexes (they only get faster), so a
 * cold instance creates them alongside the reads instead of before them.
 * ensureIndexes still runs once per process and retries after a failure.
 */
function ensureIndexesWithoutWaiting(workspaceId: string): void {
  const run = ensureIndexes().catch(error => {
    logger.error("scenarios.audience_options_index_setup_failed", error, {
      workspaceId,
    });
  });
  try {
    after(run);
  } catch {
    // Outside a request scope the index setup still settles on its own.
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }
    const { supabase } = access;
    ensureIndexesWithoutWaiting(workspaceId);

    const [sourcesResult, taxonomyResult, internalLabelsResult] =
      await Promise.all([
        supabase
          .from("sources")
          .select("type, credentials")
          .eq("workspace_id", workspaceId),
        supabase
          .from("taxonomies")
          .select("labels")
          .eq("workspace_id", workspaceId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("internal_labels")
          .select("name")
          .eq("workspace_id", workspaceId)
          .eq("is_active", true)
          .order("name", { ascending: true }),
      ]);

    await connectDB();

    const sourceRows = sourcesResult.data ?? [];
    const liveMetaAudienceRequests: Array<
      ReturnType<typeof fetchLiveMetaReferralAudience>
    > = [];
    for (const row of sourceRows) {
      if (row.type === "meta_ads") {
        liveMetaAudienceRequests.push(
          fetchLiveMetaReferralAudience(row.credentials)
        );
      }
    }
    const liveMetaAudienceResults = await Promise.allSettled(
      liveMetaAudienceRequests
    );
    const liveMetaAudienceRows = liveMetaAudienceResults.flatMap(result =>
      result.status === "fulfilled" ? [result.value] : []
    );
    const liveMetaAdRows = liveMetaAudienceRows.flatMap(row => row.ads);
    const liveMetaCampaignRows = liveMetaAudienceRows.flatMap(
      row => row.campaigns
    );
    const liveMetaAdSetRows = liveMetaAudienceRows.flatMap(row => row.adSets);

    const [
      mongoInternalLabels,
      whatsappMetaAdRows,
      instagramMetaAdRows,
      rawCustomers,
    ] = await Promise.all([
      Conversation.distinct("internal_labels", {
        workspaceId,
        internal_labels: { $exists: true, $ne: [] },
      }),
      Conversation.aggregate<RawMetaReferralAd>([
        {
          $match: {
            workspaceId,
            "whatsappReferral.sourceId": { $type: "string", $ne: "" },
            "whatsappReferral.sourceType": "ad",
          },
        },
        { $sort: { lastMessageAt: -1 } },
        {
          $project: {
            sourceId: "$whatsappReferral.sourceId",
            sourceType: "$whatsappReferral.sourceType",
            sourcePlatform: "$whatsappReferral.sourcePlatform",
            sourceUrl: "$whatsappReferral.sourceUrl",
            campaignId: "$whatsappReferral.campaignId",
            campaignName: "$whatsappReferral.campaignName",
            adSetId: "$whatsappReferral.adSetId",
            adSetName: "$whatsappReferral.adSetName",
            headline: "$whatsappReferral.headline",
            body: "$whatsappReferral.body",
            mediaUrl: {
              $ifNull: [
                "$whatsappReferral.imageUrl",
                "$whatsappReferral.thumbnailUrl",
              ],
            },
            channel: "$channel",
            lastSeenAt: {
              $ifNull: ["$whatsappReferral.capturedAt", "$lastMessageAt"],
            },
          },
        },
        {
          $group: {
            _id: "$sourceId",
            sourceId: { $first: "$sourceId" },
            sourceType: { $first: "$sourceType" },
            sourcePlatform: { $first: "$sourcePlatform" },
            sourceUrl: { $first: "$sourceUrl" },
            campaignId: { $first: "$campaignId" },
            campaignName: { $first: "$campaignName" },
            adSetId: { $first: "$adSetId" },
            adSetName: { $first: "$adSetName" },
            headline: { $first: "$headline" },
            body: { $first: "$body" },
            mediaUrl: { $first: "$mediaUrl" },
            channel: { $first: "$channel" },
            lastSeenAt: { $max: "$lastSeenAt" },
            count: { $sum: 1 },
          },
        },
        { $sort: { lastSeenAt: -1 } },
        { $limit: MAX_META_REFERRAL_AD_OPTIONS + 1 },
      ]),
      Conversation.aggregate<RawMetaReferralAd>([
        {
          $match: {
            workspaceId,
            channel: "instagram",
            "external_thread.referral.adId": { $type: "string", $ne: "" },
          },
        },
        { $sort: { lastMessageAt: -1 } },
        {
          $project: {
            sourceId: "$external_thread.referral.adId",
            sourceType: { $literal: "ad" },
            sourcePlatform: { $literal: "instagram" },
            sourceUrl: "$external_thread.referral.sourceUrl",
            campaignId: "$external_thread.referral.campaignId",
            campaignName: "$external_thread.referral.campaignName",
            adSetId: "$external_thread.referral.adSetId",
            adSetName: "$external_thread.referral.adSetName",
            headline: "$external_thread.referral.title",
            body: "$external_thread.referral.body",
            mediaUrl: "$external_thread.referral.mediaUrl",
            channel: "$channel",
            lastSeenAt: "$lastMessageAt",
          },
        },
        {
          $group: {
            _id: "$sourceId",
            sourceId: { $first: "$sourceId" },
            sourceType: { $first: "$sourceType" },
            sourcePlatform: { $first: "$sourcePlatform" },
            sourceUrl: { $first: "$sourceUrl" },
            campaignId: { $first: "$campaignId" },
            campaignName: { $first: "$campaignName" },
            adSetId: { $first: "$adSetId" },
            adSetName: { $first: "$adSetName" },
            headline: { $first: "$headline" },
            body: { $first: "$body" },
            mediaUrl: { $first: "$mediaUrl" },
            channel: { $first: "$channel" },
            lastSeenAt: { $max: "$lastSeenAt" },
            count: { $sum: 1 },
          },
        },
        { $sort: { lastSeenAt: -1 } },
        { $limit: MAX_META_REFERRAL_AD_OPTIONS + 1 },
      ]),
      Conversation.aggregate<{
        _id: string;
        [key: string]: unknown;
        channel?: string;
        chat?: string | number | null;
        internalLabels?: string[];
        estimatedCustomerLtv?: number | null;
        revenueAttributionId?: string | null;
        lastMessageAt?: Date | null;
      }>([
        {
          $match: {
            workspaceId,
            chat: { $exists: true, $ne: null },
          },
        },
        { $sort: { lastMessageAt: -1 } },
        {
          $project: {
            channel: 1,
            chat: 1,
            ...RAW_CUSTOMER_CLASSIFICATION_PROJECTION,
            internalLabels: "$internal_labels",
            estimatedCustomerLtv: "$estimated_customer_ltv",
            revenueAttributionId: "$revenue_attribution_id",
            lastMessageAt: 1,
            customerKey: {
              $ifNull: [
                { $toString: "$customerId" },
                {
                  $concat: [
                    { $ifNull: ["$channel", "unknown"] },
                    ":",
                    { $toString: "$chat" },
                  ],
                },
              ],
            },
          },
        },
        {
          $group: {
            _id: "$customerKey",
            channel: { $first: "$channel" },
            chat: { $first: "$chat" },
            ...RAW_CUSTOMER_CLASSIFICATION_GROUP,
            internalLabels: { $first: "$internalLabels" },
            estimatedCustomerLtv: { $first: "$estimatedCustomerLtv" },
            revenueAttributionId: { $first: "$revenueAttributionId" },
            lastMessageAt: { $first: "$lastMessageAt" },
          },
        },
        { $sort: { lastMessageAt: -1 } },
        { $limit: 250 },
      ]),
    ]);

    const taxonomyLabels = Array.isArray(taxonomyResult.data?.labels)
      ? taxonomyResult.data.labels.filter(
          (value): value is string => typeof value === "string"
        )
      : [];

    const sourceChannels = sourceRows
      .map(row => row.type)
      .filter(
        (value): value is string =>
          typeof value === "string" && CONVERSATION_CHANNEL_SET.has(value)
      );
    const supabaseInternalLabels = (internalLabelsResult.data ?? [])
      .map(row => row.name)
      .filter((value): value is string => typeof value === "string");

    const customers: AudienceCustomer[] = rawCustomers.map(item => {
      const chatValue = item.chat;
      const normalizedChat =
        chatValue === null || chatValue === undefined
          ? undefined
          : String(chatValue);
      const internalLabels = Array.isArray(item.internalLabels)
        ? item.internalLabels.filter(
            (label): label is string => typeof label === "string"
          )
        : [];
      const currentClassification = getCurrentConversationClassification<{
        category?: unknown;
      }>(buildRawCustomerClassificationRoot(item));
      const classificationCategory = normalizeOptionalString(
        currentClassification?.category
      );
      const segmentKey = resolveSegmentFromConversation({
        internalLabels,
        classificationCategory,
      });
      const ltv =
        typeof item.estimatedCustomerLtv === "number"
          ? item.estimatedCustomerLtv
          : 0;
      const revenueAttributionId =
        typeof item.revenueAttributionId === "string"
          ? item.revenueAttributionId.trim()
          : "";
      return {
        id: item._id,
        label: normalizedChat || item._id,
        channel: item.channel,
        category: classificationCategory,
        segmentKey,
        hasPurchaseHistory: ltv > 0 || Boolean(revenueAttributionId),
        internalLabels,
        lastMessageAt: item.lastMessageAt
          ? item.lastMessageAt.toISOString()
          : null,
      };
    });

    const funnelStages = normalizeUniqueStrings([
      ...FUNNEL_SEGMENT_KEYS,
      ...customers
        .map(customer => customer.segmentKey || null)
        .filter((value): value is string => Boolean(value)),
    ]);

    const metaReferralRows = [
      ...whatsappMetaAdRows,
      ...instagramMetaAdRows,
      ...liveMetaAdRows,
    ];
    const metaReferralCampaignRows = [
      ...metaReferralRows,
      ...liveMetaCampaignRows,
      ...liveMetaAdSetRows,
    ];
    const metaReferralAdSetRows = [...metaReferralRows, ...liveMetaAdSetRows];
    const metaCampaignLabels = normalizeMetaCampaignLabels(
      liveMetaAudienceRows.flatMap(row => row.campaignLabels ?? [])
    );
    const metaReferralAds = normalizeMetaReferralAds(metaReferralRows);
    const metaReferralCampaigns = normalizeMetaReferralCampaigns(
      metaReferralCampaignRows
    );
    const metaReferralAdSets = normalizeMetaReferralAdSets(
      metaReferralAdSetRows
    );
    const reasons = new Set<ScenarioMetaAdsDataStatus["reasons"][number]>(
      liveMetaAudienceRows.flatMap(row => row.dataStatus?.reasons || [])
    );
    if (liveMetaAudienceResults.some(result => result.status === "rejected"))
      reasons.add("provider_error");
    if (sourcesResult.error) reasons.add("provider_error");
    else if (liveMetaAudienceRequests.length === 0)
      reasons.add("not_connected");
    if (
      [
        whatsappMetaAdRows,
        instagramMetaAdRows,
        metaReferralAds,
        metaReferralCampaigns,
        metaReferralAdSets,
        metaCampaignLabels,
      ].some(rows => rows.length > MAX_META_REFERRAL_AD_OPTIONS)
    )
      reasons.add("limit_reached");
    const hasMetaRows =
      metaReferralAds.length +
        metaReferralCampaigns.length +
        metaReferralAdSets.length +
        metaCampaignLabels.length >
      0;
    const metaAdsDataStatus: ScenarioMetaAdsDataStatus = {
      state:
        reasons.size === 0
          ? "complete"
          : hasMetaRows
            ? "partial"
            : "unavailable",
      reasons: Array.from(reasons).sort(),
    };

    return NextResponse.json({
      options: {
        channels: normalizeUniqueStrings(sourceChannels),
        classificationCategories: normalizeUniqueStrings(taxonomyLabels),
        funnelStages,
        internalLabels: normalizeUniqueStrings([
          ...supabaseInternalLabels,
          ...mongoInternalLabels,
        ]),
        customers,
        metaReferralAds: metaReferralAds.slice(0, MAX_META_REFERRAL_AD_OPTIONS),
        metaReferralCampaigns: metaReferralCampaigns.slice(
          0,
          MAX_META_REFERRAL_AD_OPTIONS
        ),
        metaReferralAdSets: metaReferralAdSets.slice(
          0,
          MAX_META_REFERRAL_AD_OPTIONS
        ),
        metaCampaignLabels: metaCampaignLabels.slice(
          0,
          MAX_META_REFERRAL_AD_OPTIONS
        ),
        metaAdsDataStatus,
      },
    });
  } catch (error) {
    console.error("[Scenario Audience API] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load scenario audience options" },
      { status: 500 }
    );
  }
}
