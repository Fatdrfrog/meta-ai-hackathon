import { decryptMaybeString } from "@/lib/crypto";
import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import {
  fetchMetaAdsAdAccountInventory,
  getSelectedMetaAdsAccountId,
  orderMetaAdsAccounts,
} from "@/lib/meta-ads/meta-ads-accounts";
import { normalizeMetaAdsAdAccounts } from "@/lib/meta-ads/meta-ads-source";
import { normalizeMetaAdsMcpScopes } from "@/lib/meta-ads/meta-ads-mcp-readiness";
import { getMetaAdsReportingReadiness } from "@/lib/meta-ads/meta-ads-reporting-readiness";
import { createServerLogger } from "@/lib/observability/server-logs";
import {
  collectMetaGraphEdge,
  getWhatsAppGraphClient,
  isMetaGraphAuthorizationError,
  MetaGraphPaginationError,
} from "@icecore/shared/lib/meta/api";
import {
  readNonEmptyStringOrUndefined as normalizeOptionalString,
  asRecord,
} from "@icecore/shared/lib/value-utils";
import type { ScenarioMetaAdsDataStatus } from "@icecore/scenario-contracts";

const MAX_LIVE_META_AD_ACCOUNTS = 20;
const MAX_EDGE_ITEMS = 1000;
const MAX_EDGE_PAGES = 5;
const MAX_GRAPH_REQUESTS = 60;
const GRAPH_PAGE_SIZE = 200;
const CATALOG_DEADLINE_MS = 12_000;
const ACCOUNT_CONCURRENCY = 2;
const graphClient = getWhatsAppGraphClient();
const META_CAMPAIGN_FIELDS = [
  "id",
  "name",
  "effective_status",
  "configured_status",
  "updated_time",
].join(",");
const META_AD_SET_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "campaign{id,name}",
  "effective_status",
  "configured_status",
  "updated_time",
].join(",");
const META_AD_LABEL_FIELDS = ["id", "name"].join(",");
const META_AD_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "campaign{id,name}",
  "adset_id",
  "adset{id,name}",
  "effective_status",
  "configured_status",
  "updated_time",
  "creative{id,name,effective_instagram_media_id,instagram_permalink_url,link_url,url_tags}",
].join(",");
const metaAdsAudienceLogger = createServerLogger("meta-ads.audience");

export type RawMetaReferralAdForScenario = {
  sourceId?: string | null;
  sourceType?: string | null;
  sourcePlatform?: string | null;
  sourceUrl?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  headline?: string | null;
  body?: string | null;
  mediaUrl?: string | null;
  channel?: string | null;
  lastSeenAt?: Date | string | null;
  count?: number | null;
  adCount?: number | null;
};

export type RawMetaCampaignLabel = {
  id: string;
  name: string;
  adAccountId: string;
  adAccountName?: string;
};

export type LiveMetaReferralAudience = {
  ads: RawMetaReferralAdForScenario[];
  campaigns: RawMetaReferralAdForScenario[];
  adSets: RawMetaReferralAdForScenario[];
  campaignLabels: RawMetaCampaignLabel[];
  dataStatus: ScenarioMetaAdsDataStatus;
};

type CatalogBudget = {
  deadline: number;
  requests: number;
  reasons: Set<ScenarioMetaAdsDataStatus["reasons"][number]>;
};

async function fetchMetaGraphData(params: {
  path: string;
  fields: string;
  accessToken: string;
  budget: CatalogBudget;
}): Promise<unknown[]> {
  // The shared collector validates paging URLs and cycles. Keep accepted pages
  // because a later provider failure must not discard usable options.
  const accepted: unknown[] = [];
  try {
    await collectMetaGraphEdge({
      client: graphClient,
      accessToken: params.accessToken,
      path: params.path,
      initialQuery: { fields: params.fields, limit: GRAPH_PAGE_SIZE },
      maxPages: MAX_EDGE_PAGES,
      maxItems: MAX_EDGE_ITEMS,
      beforePage: () => {
        if (
          params.budget.requests >= MAX_GRAPH_REQUESTS ||
          Date.now() >= params.budget.deadline
        ) {
          throw new MetaGraphPaginationError("page_limit");
        }
        params.budget.requests += 1;
      },
      createRequestSignal: () =>
        AbortSignal.timeout(
          Math.max(1, Math.min(5000, params.budget.deadline - Date.now()))
        ),
      normalizePage: payload => {
        const raw = asRecord(payload);
        if (!Array.isArray(raw.data))
          throw new Error("Invalid Meta catalog response");
        const next = normalizeOptionalString(asRecord(raw.paging).next);
        const remaining = MAX_EDGE_ITEMS - accepted.length;
        accepted.push(...raw.data.slice(0, remaining));
        if (
          raw.data.length > remaining ||
          (accepted.length >= MAX_EDGE_ITEMS && next)
        ) {
          params.budget.reasons.add("limit_reached");
        }
        return { data: raw.data, next };
      },
    });
  } catch (error) {
    const reason =
      error instanceof MetaGraphPaginationError && error.reason === "page_limit"
        ? "limit_reached"
        : isMetaGraphAuthorizationError(error)
          ? "access_unavailable"
          : "provider_error";
    params.budget.reasons.add(reason);
    metaAdsAudienceLogger.error(
      "meta_ads_audience_graph_edge_fetch_failed",
      undefined,
      { path: params.path, reason }
    );
  }
  return accepted;
}

async function resolveMetaAdsAccounts(params: {
  rawCredentials: Record<string, unknown>;
  accessToken: string;
  budget: CatalogBudget;
}) {
  const selectedId = getSelectedMetaAdsAccountId(params.rawCredentials);
  const stored = orderMetaAdsAccounts(
    normalizeMetaAdsAdAccounts(params.rawCredentials.ad_accounts),
    selectedId,
    MAX_LIVE_META_AD_ACCOUNTS + 1
  );
  if (stored.length > 0) {
    if (stored.length > MAX_LIVE_META_AD_ACCOUNTS)
      params.budget.reasons.add("limit_reached");
    return stored.slice(0, MAX_LIVE_META_AD_ACCOUNTS);
  }
  const inventory = await fetchMetaAdsAdAccountInventory({
    accessToken: params.accessToken,
    grantedScopes: normalizeMetaAdsMcpScopes(params.rawCredentials.scope),
    maxAccounts: MAX_LIVE_META_AD_ACCOUNTS + 1,
    maxPages: 2,
    requestTimeoutMs: 3000,
    onError: error => {
      params.budget.reasons.add(
        error.authorizationFailure ? "access_unavailable" : "provider_error"
      );
      metaAdsAudienceLogger.error(
        "meta_ads_audience_ad_account_fetch_failed",
        undefined,
        { status: error.status }
      );
    },
  });
  if (
    inventory.truncated ||
    inventory.accounts.length > MAX_LIVE_META_AD_ACCOUNTS
  ) {
    params.budget.reasons.add("limit_reached");
  }
  return orderMetaAdsAccounts(
    inventory.accounts,
    selectedId,
    MAX_LIVE_META_AD_ACCOUNTS
  );
}

function buildLiveMetaCampaignRow(
  value: unknown
): RawMetaReferralAdForScenario | null {
  const record = asRecord(value);
  const campaignId = normalizeOptionalString(record.id);
  if (!campaignId) return null;
  return {
    campaignId,
    campaignName: normalizeOptionalString(record.name),
    lastSeenAt: normalizeOptionalString(record.updated_time) || null,
  };
}

function buildLiveMetaAdSetRow(
  value: unknown
): RawMetaReferralAdForScenario | null {
  const record = asRecord(value);
  const adSetId = normalizeOptionalString(record.id);
  if (!adSetId) return null;
  const campaign = asRecord(record.campaign);
  return {
    adSetId,
    adSetName: normalizeOptionalString(record.name),
    campaignId:
      normalizeOptionalString(record.campaign_id) ||
      normalizeOptionalString(campaign.id),
    campaignName: normalizeOptionalString(campaign.name),
    lastSeenAt: normalizeOptionalString(record.updated_time) || null,
  };
}

function buildLiveMetaAdRow(
  value: unknown
): RawMetaReferralAdForScenario | null {
  const record = asRecord(value);
  const sourceId = normalizeOptionalString(record.id);
  if (!sourceId) return null;

  const campaign = asRecord(record.campaign);
  const adSet = asRecord(record.adset);
  const creative = asRecord(record.creative);
  const campaignId =
    normalizeOptionalString(record.campaign_id) ||
    normalizeOptionalString(campaign.id);
  const adSetId =
    normalizeOptionalString(record.adset_id) ||
    normalizeOptionalString(adSet.id);
  const adName = normalizeOptionalString(record.name);
  const campaignName = normalizeOptionalString(campaign.name);
  const adSetName = normalizeOptionalString(adSet.name);
  const creativeName = normalizeOptionalString(creative.name);
  const sourceUrl =
    normalizeOptionalString(creative.instagram_permalink_url) ||
    normalizeOptionalString(creative.link_url);
  const status = normalizeOptionalString(record.effective_status);

  return {
    sourceId,
    sourceType: "ad",
    sourceUrl,
    campaignId,
    campaignName,
    adSetId,
    adSetName,
    headline: adName || creativeName,
    body: [campaignName, adSetName, status].filter(Boolean).join(" / "),
    lastSeenAt: normalizeOptionalString(record.updated_time) || null,
  };
}

function buildLiveMetaCampaignLabel(
  value: unknown,
  accountId: string,
  accountName?: string
): RawMetaCampaignLabel | null {
  const record = asRecord(value);
  const id = normalizeOptionalString(record.id);
  const adAccountId = normalizeMetaAdAccountId(accountId);
  if (!id || !adAccountId) return null;
  return {
    id,
    name: normalizeOptionalString(record.name) || id,
    adAccountId,
    ...(accountName ? { adAccountName: accountName } : {}),
  };
}

async function fetchLiveMetaReferralAudienceForAccount(params: {
  accountId: string;
  accountName?: string;
  accessToken: string;
  budget: CatalogBudget;
}): Promise<Omit<LiveMetaReferralAudience, "dataStatus">> {
  const [campaignRows, adSetRows, adRows, labelRows] = await Promise.all([
    fetchMetaGraphData({
      path: `${params.accountId}/campaigns`,
      fields: META_CAMPAIGN_FIELDS,
      accessToken: params.accessToken,
      budget: params.budget,
    }),
    fetchMetaGraphData({
      path: `${params.accountId}/adsets`,
      fields: META_AD_SET_FIELDS,
      accessToken: params.accessToken,
      budget: params.budget,
    }),
    fetchMetaGraphData({
      path: `${params.accountId}/ads`,
      fields: META_AD_FIELDS,
      accessToken: params.accessToken,
      budget: params.budget,
    }),
    fetchMetaGraphData({
      path: `${params.accountId}/adlabels`,
      fields: META_AD_LABEL_FIELDS,
      accessToken: params.accessToken,
      budget: params.budget,
    }),
  ]);

  return {
    campaigns: campaignRows
      .map(buildLiveMetaCampaignRow)
      .filter((row): row is RawMetaReferralAdForScenario => row !== null),
    adSets: adSetRows
      .map(buildLiveMetaAdSetRow)
      .filter((row): row is RawMetaReferralAdForScenario => row !== null),
    ads: adRows
      .map(buildLiveMetaAdRow)
      .filter((row): row is RawMetaReferralAdForScenario => row !== null),
    campaignLabels: labelRows
      .map(row =>
        buildLiveMetaCampaignLabel(row, params.accountId, params.accountName)
      )
      .filter((row): row is RawMetaCampaignLabel => row !== null),
  };
}

export async function fetchLiveMetaReferralAudience(
  credentials: unknown
): Promise<LiveMetaReferralAudience> {
  const rawCredentials = asRecord(credentials);
  const accessToken = decryptMaybeString(rawCredentials.access_token);
  const reporting = getMetaAdsReportingReadiness(rawCredentials);
  if (
    !accessToken ||
    ["not_connected", "missing_permission", "expired"].includes(
      reporting.reason
    )
  )
    return {
      ads: [],
      campaigns: [],
      adSets: [],
      campaignLabels: [],
      dataStatus: { state: "unavailable", reasons: ["access_unavailable"] },
    };
  const budget: CatalogBudget = {
    deadline: Date.now() + CATALOG_DEADLINE_MS,
    requests: 0,
    reasons: new Set(),
  };

  const accounts = await resolveMetaAdsAccounts({
    rawCredentials,
    accessToken,
    budget,
  });
  if (accounts.length === 0 && budget.reasons.size === 0)
    budget.reasons.add("access_unavailable");
  const rows: Array<Omit<LiveMetaReferralAudience, "dataStatus">> = [];
  for (
    let offset = 0;
    offset < accounts.length;
    offset += ACCOUNT_CONCURRENCY
  ) {
    if (
      budget.requests >= MAX_GRAPH_REQUESTS ||
      Date.now() >= budget.deadline
    ) {
      budget.reasons.add("limit_reached");
      break;
    }
    rows.push(
      ...(await Promise.all(
        accounts.slice(offset, offset + ACCOUNT_CONCURRENCY).map(account =>
          fetchLiveMetaReferralAudienceForAccount({
            accountId: account.id,
            accountName: account.name,
            accessToken,
            budget,
          })
        )
      ))
    );
  }
  const result = {
    ads: rows.flatMap(row => row.ads),
    campaigns: rows.flatMap(row => row.campaigns),
    adSets: rows.flatMap(row => row.adSets),
    campaignLabels: rows.flatMap(row => row.campaignLabels),
  };
  const hasRows =
    result.ads.length +
      result.campaigns.length +
      result.adSets.length +
      result.campaignLabels.length >
    0;
  return {
    ...result,
    dataStatus: {
      state:
        budget.reasons.size === 0
          ? "complete"
          : hasRows
            ? "partial"
            : "unavailable",
      reasons: Array.from(budget.reasons).sort(),
    },
  };
}
