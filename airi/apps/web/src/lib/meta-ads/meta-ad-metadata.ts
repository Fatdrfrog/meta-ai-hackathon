import { decryptMaybeString } from "@/lib/crypto";
import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { META_GRAPH_BASE_URL } from "@icecore/shared/lib/meta/graph-version";
import { createLogger } from "@icecore/shared/lib/logger";
import {
  asRecord,
  readNonEmptyStringOrUndefined,
} from "@icecore/shared/lib/value-utils";

const logger = createLogger("meta-ads.ad-metadata");

const META_AD_METADATA_FIELDS = [
  "id",
  "name",
  "account_id",
  "campaign_id",
  "campaign{id,name,account_id,adlabels{id,name}}",
  "adset_id",
  "adset{id,name}",
].join(",");
const META_AD_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const META_AD_METADATA_CACHE_MAX = 1000;

export type MetaCampaignLabelStatus = "present" | "absent" | "unavailable";

export type MetaCampaignLabel = {
  id: string;
  name: string;
};

export type MetaAdMetadata = {
  campaignId?: string;
  campaignName?: string;
  adSetId?: string;
  adSetName?: string;
  adAccountId?: string;
  campaignLabels: MetaCampaignLabel[];
  campaignLabelStatus: MetaCampaignLabelStatus;
};

const metaAdMetadataCache = new Map<
  string,
  { expiresAt: number; metadata: MetaAdMetadata }
>();

function readNestedString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  return readNonEmptyStringOrUndefined(record[key]);
}

function readCampaignLabels(campaign: Record<string, unknown>): {
  labels: MetaCampaignLabel[];
  status: MetaCampaignLabelStatus;
} {
  if (!Object.prototype.hasOwnProperty.call(campaign, "adlabels")) {
    return { labels: [], status: "unavailable" };
  }
  const raw = campaign.adlabels;
  const items = Array.isArray(raw) ? raw : asRecord(raw).data;
  if (!Array.isArray(items)) return { labels: [], status: "unavailable" };
  if (!Array.isArray(raw)) {
    const paging = asRecord(asRecord(raw).paging);
    if (typeof paging.next === "string" && paging.next.trim()) {
      return { labels: [], status: "unavailable" };
    }
  }
  const labels: MetaCampaignLabel[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const id = readNonEmptyStringOrUndefined(record.id);
    if (!id) return { labels: [], status: "unavailable" };
    labels.push({ id, name: readNonEmptyStringOrUndefined(record.name) || id });
  }
  return {
    labels,
    status: labels.length > 0 ? "present" : "absent",
  };
}

export function isConfirmedCampaignLabelStatus(
  status: MetaCampaignLabelStatus | undefined
): boolean {
  return status === "present" || status === "absent";
}

function trimMetaAdMetadataCache() {
  if (metaAdMetadataCache.size <= META_AD_METADATA_CACHE_MAX) return;
  const removeCount = metaAdMetadataCache.size - META_AD_METADATA_CACHE_MAX;
  let removed = 0;
  for (const key of metaAdMetadataCache.keys()) {
    metaAdMetadataCache.delete(key);
    removed += 1;
    if (removed >= removeCount) break;
  }
}

export async function fetchMetaAdMetadata(params: {
  adId: string;
  accessToken: string;
}): Promise<MetaAdMetadata | null> {
  const adId = readNonEmptyStringOrUndefined(params.adId);
  const accessToken = readNonEmptyStringOrUndefined(params.accessToken);
  if (!adId || !accessToken) return null;

  const url = new URL(`${META_GRAPH_BASE_URL}/${adId}`);
  url.searchParams.set("fields", META_AD_METADATA_FIELDS);
  url.searchParams.set("access_token", accessToken);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const startedAt = Date.now();
  let failureKind:
    | "permission"
    | "http"
    | "malformed"
    | "timeout"
    | "transport"
    | "incomplete"
    | undefined;
  // Provider error strings and thrown errors can contain the token-bearing URL.
  // Keep diagnostics to known fields; never serialize the response or exception.
  const diagnostic: Record<string, unknown> = {
    adId: /^[0-9]{1,32}$/.test(adId) ? adId : undefined,
  };
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
    });
    diagnostic.httpStatus = response.status;
    const payload = asRecord(
      await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null;
        throw error;
      })
    );
    if (controller.signal.aborted) {
      failureKind = "timeout";
      return null;
    }
    if (!response.ok) {
      const providerError = asRecord(payload.error);
      const code = providerError.code;
      const subcode = providerError.error_subcode;
      if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0) {
        diagnostic.providerCode = code;
      }
      if (
        typeof subcode === "number" &&
        Number.isSafeInteger(subcode) &&
        subcode >= 0
      ) {
        diagnostic.providerSubcode = subcode;
      }
      if (typeof providerError.is_transient === "boolean") {
        diagnostic.providerTransient = providerError.is_transient;
      }
      failureKind =
        response.status === 401 ||
        response.status === 403 ||
        code === 10 ||
        code === 102 ||
        code === 190 ||
        (typeof code === "number" && code >= 200 && code <= 299)
          ? "permission"
          : "http";
      return null;
    }
    if (!readNonEmptyStringOrUndefined(payload.id)) {
      failureKind = "malformed";
      return null;
    }

    const campaign = asRecord(payload.campaign);
    const adSet = asRecord(payload.adset);
    const labels = readCampaignLabels(campaign);
    const adAccountId = normalizeMetaAdAccountId(
      readNestedString(payload, "account_id") ||
        readNestedString(campaign, "account_id")
    );
    const confirmedLabels =
      labels.status === "present" || labels.status === "absent";
    const campaignLabelStatus =
      confirmedLabels && !adAccountId ? "unavailable" : labels.status;
    if (campaignLabelStatus === "unavailable") {
      failureKind = "incomplete";
      diagnostic.campaignLabelStatus = campaignLabelStatus;
    }
    const campaignId =
      readNestedString(payload, "campaign_id") ||
      readNestedString(campaign, "id");
    const campaignName = readNestedString(campaign, "name");
    const adSetId =
      readNestedString(payload, "adset_id") || readNestedString(adSet, "id");
    const adSetName = readNestedString(adSet, "name");
    const metadata: MetaAdMetadata = {
      ...(campaignId ? { campaignId } : {}),
      ...(campaignName ? { campaignName } : {}),
      ...(adSetId ? { adSetId } : {}),
      ...(adSetName ? { adSetName } : {}),
      ...(adAccountId ? { adAccountId } : {}),
      campaignLabels: campaignLabelStatus === "present" ? labels.labels : [],
      campaignLabelStatus,
    };

    return metadata;
  } catch {
    failureKind = controller.signal.aborted ? "timeout" : "transport";
    return null;
  } finally {
    clearTimeout(timeout);
    if (failureKind) {
      logger.error("meta_ad_metadata_lookup_failed", undefined, {
        ...diagnostic,
        failureKind,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

export async function resolveMetaAdMetadataForWorkspace(params: {
  workspaceId: string;
  adId: string;
}): Promise<MetaAdMetadata | null> {
  const workspaceId = readNonEmptyStringOrUndefined(params.workspaceId);
  const adId = readNonEmptyStringOrUndefined(params.adId);
  if (!workspaceId || !adId) return null;

  const cacheKey = `${workspaceId}:${adId}`;
  const cached = metaAdMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;

  const { data } = await supabaseAdmin
    .from("sources")
    .select("credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "meta_ads")
    .limit(5);

  let incomplete: MetaAdMetadata | null = null;
  for (const row of data ?? []) {
    const credentials = asRecord(row.credentials);
    const accessToken = decryptMaybeString(credentials.access_token);
    if (!accessToken) continue;

    const metadata = await fetchMetaAdMetadata({
      adId,
      accessToken,
    });
    if (!metadata) continue;
    if (!isConfirmedCampaignLabelStatus(metadata.campaignLabelStatus)) {
      incomplete = metadata;
      continue;
    }
    metaAdMetadataCache.set(cacheKey, {
      expiresAt: Date.now() + META_AD_METADATA_CACHE_TTL_MS,
      metadata,
    });
    trimMetaAdMetadataCache();
    return metadata;
  }

  // Missing credentials, transport failures, and incomplete label payloads
  // must recover on the next event. Only a confirmed label list is cached.
  return incomplete;
}

export function clearMetaAdMetadataCacheForTests() {
  metaAdMetadataCache.clear();
}
