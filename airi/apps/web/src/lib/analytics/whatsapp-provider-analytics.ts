import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import {
  acquireWhatsAppMetaReadLock,
  getCachedWhatsAppMetaReadCooldownUntil,
  releaseWhatsAppMetaReadPermit,
  buildWhatsAppMetaRateLimitCredentialPatch,
  META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD,
  setCachedWhatsAppMetaReadCooldownUntil,
} from "@/lib/whatsapp/meta-read-policy";
import {
  WhatsAppTemplateAnalyticsDaily,
  ensureWhatsAppTemplateAnalyticsIndexes,
} from "@/models/whatsapp-template-analytics-daily";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import {
  collectMetaGraphEdge,
  getWhatsAppGraphClient,
  MetaGraphRequestError,
  getMetaGraphRateLimitMetadata,
} from "@icecore/shared/lib/meta/api";
import { asRecord } from "@icecore/shared/lib/value-utils";
import {
  normalizeProviderPricing,
  normalizeTemplateAnalytics,
} from "./whatsapp-analytics";
import type {
  WhatsAppProviderAccount,
  WhatsAppProviderSpendAccount,
  WhatsAppProviderStatus,
} from "./whatsapp-analytics-contract";

export type WhatsAppAnalyticsSource = {
  id: string;
  name?: string | null;
  workspace_id: string;
  credentials: Record<string, unknown>;
};
type Row = Record<string, unknown>;
const asList = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(asRecord) : [];
const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;
const client = getWhatsAppGraphClient();
// Meta refuses some operations, such as enabling template insights, for
// WhatsApp Business app (SMB) accounts with #10. Reconnecting cannot help.
const SMB_BUSINESS_TYPE = /\bSMB business type\b/i;

export function statusForError(error: unknown): WhatsAppProviderStatus {
  if (error instanceof MetaGraphRequestError) {
    const code = error.metaError?.code;
    if (code === 10 && SMB_BUSINESS_TYPE.test(String(error.metaError?.message)))
      return "unsupported";
    if ([10, 190, 200].includes(code ?? 0) || [401, 403].includes(error.status))
      return "permission_required";
    if ([100, 803].includes(code ?? 0)) return "unsupported";
  }
  return "unavailable";
}
const timeout = () => AbortSignal.timeout(8000);
export async function protectRateLimit(
  wabaId: string,
  credentials: Row,
  error: unknown
): Promise<boolean> {
  if (!getMetaGraphRateLimitMetadata(error)) return false;
  const patch = buildWhatsAppMetaRateLimitCredentialPatch(credentials, {
    error,
  });
  await setCachedWhatsAppMetaReadCooldownUntil(
    wabaId,
    String(patch[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD])
  );
  return true;
}

export function buildTemplateObservationWrites(
  workspaceId: string,
  wabaId: string,
  payload: unknown,
  currency: string | null,
  now: Date
) {
  const root = asRecord(payload);
  const body = asRecord(root.template_analytics ?? payload);
  return asList(body.data)
    .flatMap(group => asList(group.data_points))
    .flatMap(point => {
      const templateId = text(point.template_id),
        start = Number(point.start),
        end = Number(point.end);
      if (
        !templateId ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      )
        return [];
      const metrics = normalizeTemplateAnalytics(
        { template_analytics: { data: [{ data_points: [point] }] } },
        currency
      )[0];
      if (!metrics) return [];
      // A provider reset outside retention cannot establish that nobody read or
      // clicked an older send. Existing observations remain in the daily owner.
      const engagementInRetention = now.getTime() - end * 1000 <= 7 * 86400000;
      return [
        {
          updateOne: {
            filter: {
              workspaceId,
              wabaId,
              templateId,
              periodStart: new Date(start * 1000),
            },
            update: {
              $set: {
                periodEnd: new Date(end * 1000),
                lastObservedAt: now,
                ...(metrics.cost === null
                  ? {}
                  : { cost: metrics.cost, currency }),
              },
              ...(metrics.cost === null ? { $setOnInsert: { currency } } : {}),
              $max: {
                sent: metrics.sent,
                delivered: metrics.delivered,
                ...(!engagementInRetention || metrics.read === null
                  ? {}
                  : { read: metrics.read }),
                ...(!engagementInRetention || metrics.clicked === null
                  ? {}
                  : { clicked: metrics.clicked }),
                ...(!engagementInRetention || metrics.uniqueClicked === null
                  ? {}
                  : { uniqueClicked: metrics.uniqueClicked }),
                ...(!engagementInRetention || metrics.quickReplyClicked === null
                  ? {}
                  : { quickReplyClicked: metrics.quickReplyClicked }),
              },
            },
            upsert: true,
          },
        },
      ];
    });
}

const INSIGHTS_ENABLED_MARKER_TTL_SECONDS = 600;
const insightsEnabledMarkerKey = (wabaId: string) =>
  buildCacheKey("whatsapp:insights-enabled:v1", [wabaId]);

/** Lets the next read skip a cached "activation required" right after enabling. */
export async function markWhatsAppTemplateInsightsEnabled(wabaId: string) {
  await cache.set(
    insightsEnabledMarkerKey(wabaId),
    true,
    INSIGHTS_ENABLED_MARKER_TTL_SECONDS
  );
}

// An account type rarely changes; re-offer activation after a month.
const INSIGHTS_UNSUPPORTED_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
const insightsUnsupportedMarkerKey = (wabaId: string) =>
  buildCacheKey("whatsapp:insights-unsupported:v1", [wabaId]);

/** Meta refused activation for this account type; stop offering it. */
export async function markWhatsAppTemplateInsightsUnsupported(wabaId: string) {
  await cache.set(
    insightsUnsupportedMarkerKey(wabaId),
    true,
    INSIGHTS_UNSUPPORTED_MARKER_TTL_SECONDS
  );
}

export async function isWhatsAppTemplateInsightsUnsupported(
  wabaId: string
): Promise<boolean> {
  return Boolean(
    await cache.get<boolean>(insightsUnsupportedMarkerKey(wabaId))
  );
}

type ProviderWindowKey = {
  workspaceId: string;
  wabaId: string;
  start: Date;
  end: Date;
};
const providerCacheKey = (prefix: string, window: ProviderWindowKey) =>
  buildCacheKey(prefix, [
    window.workspaceId,
    window.wabaId,
    window.start.toISOString().slice(0, 10),
    window.end.toISOString().slice(0, 10),
  ]);

function emptyProviderAccount(
  source: WhatsAppAnalyticsSource,
  wabaId: string | undefined,
  start: Date,
  end: Date
): WhatsAppProviderAccount {
  return {
    sourceId: source.id,
    sourceName: source.name || "WhatsApp",
    accountKey: wabaId || source.id,
    scope: "waba",
    providerWindow: { start: start.toISOString(), end: end.toISOString() },
    status: "not_connected",
    pricingStatus: "not_connected",
    templateStatus: "not_connected",
    activationStatus: "unknown",
    currency: null,
    approximateSpend: null,
    pricing: [],
    templates: [],
    templatesTruncated: false,
    fetchedAt: null,
  };
}

function providerRequestSignal(signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(20000);
  return () =>
    AbortSignal.any([timeout(), deadline, ...(signal ? [signal] : [])]);
}

/**
 * Account currency/activation and pricing_analytics, read under the caller's
 * WABA permit. `done` means nothing further should be requested from Meta.
 */
async function readAccountPricing(params: {
  source: WhatsAppAnalyticsSource;
  wabaId: string;
  accessToken: string;
  start: Date;
  end: Date;
  requestSignal: () => AbortSignal;
  empty: WhatsAppProviderAccount;
}): Promise<{
  result: WhatsAppProviderAccount;
  done: boolean;
  rateLimited: boolean;
}> {
  const { source, wabaId, accessToken, start, end, requestSignal, empty } =
    params;
  let account: Row;
  try {
    account = await client.getJson<Row>(wabaId, {
      token: accessToken,
      query: { fields: "currency,timezone_id,is_enabled_for_insights" },
      signal: requestSignal(),
    });
  } catch (error) {
    const rateLimited = await protectRateLimit(
      wabaId,
      source.credentials,
      error
    );
    const status = statusForError(error);
    return {
      result: {
        ...empty,
        status,
        pricingStatus: status,
        templateStatus: status,
      },
      done: true,
      rateLimited,
    };
  }
  const currency = text(account.currency);
  const result: WhatsAppProviderAccount = {
    ...empty,
    status: "available",
    currency,
    activationStatus:
      account.is_enabled_for_insights === true
        ? "enabled"
        : account.is_enabled_for_insights === false
          ? "required"
          : "unknown",
    fetchedAt: new Date().toISOString(),
  };
  const startTimestamp = Math.floor(start.getTime() / 1000),
    endTimestamp = Math.floor(end.getTime() / 1000);
  const field = `pricing_analytics.start(${startTimestamp}).end(${endTimestamp}).granularity(DAILY).metric_types(["COST","VOLUME"]).dimensions(["COUNTRY","PRICING_CATEGORY","PRICING_TYPE","TIER"])`;
  try {
    const response = await client.getJson(wabaId, {
      token: accessToken,
      query: { fields: field },
      signal: requestSignal(),
    });
    result.pricing = normalizeProviderPricing(response, currency);
    result.pricingStatus = "available";
    result.approximateSpend =
      result.pricing.length > 0 &&
      result.pricing.every(point => point.cost !== null)
        ? result.pricing.reduce((total, point) => total + (point.cost ?? 0), 0)
        : null;
  } catch (error) {
    if (await protectRateLimit(wabaId, source.credentials, error)) {
      result.pricingStatus = "unavailable";
      result.templateStatus = "unavailable";
      return { result, done: true, rateLimited: true };
    }
    // Partner-credit WABAs can expose volume while withholding cost.
    try {
      const response = await client.getJson(wabaId, {
        token: accessToken,
        query: { fields: field.replace('["COST","VOLUME"]', '["VOLUME"]') },
        signal: requestSignal(),
      });
      result.pricing = normalizeProviderPricing(response, currency);
      result.pricingStatus = "available";
    } catch (fallbackError) {
      await protectRateLimit(wabaId, source.credentials, fallbackError);
      result.pricingStatus = statusForError(fallbackError);
    }
  }
  return { result, done: false, rateLimited: false };
}

/** Template status/quality problems; unknown when the catalog is incomplete. */
export function countWhatsAppTemplateIssues(
  catalog: Row[],
  truncated: boolean
): number | null {
  if (truncated) return null;
  return catalog.filter(
    template =>
      (text(template.quality_rating) ||
        text(asRecord(template.quality_rating).score)) === "RED" ||
      ["PAUSED", "REJECTED", "DISABLED"].includes(
        String(template.status || "").toUpperCase()
      )
  ).length;
}

const activationTemplateStatus = (
  account: WhatsAppProviderAccount,
  insightsUnsupported: boolean
): WhatsAppProviderStatus =>
  account.activationStatus === "required"
    ? insightsUnsupported
      ? "unsupported"
      : "activation_required"
    : "unavailable";

/**
 * Reads provider analytics. Activation is never requested here: the template
 * catalog (status and quality) is read regardless, and template analytics only
 * once the WABA has enabled insights.
 */
export async function readWhatsAppProviderAnalytics(params: {
  source: WhatsAppAnalyticsSource;
  start: Date;
  end: Date;
  refresh?: boolean;
  signal?: AbortSignal;
}): Promise<WhatsAppProviderAccount> {
  const { source, start, end } = params;
  const requestSignal = providerRequestSignal(params.signal);
  const credentials = normalizeWhatsAppCredentials(source.credentials);
  const { wabaId, accessToken } = credentials;
  const empty = emptyProviderAccount(source, wabaId, start, end);
  if (!wabaId || !accessToken) return empty;
  // Account-level provider totals are fetched once per WABA by the service.
  const key = providerCacheKey("whatsapp:analytics:v1", {
    workspaceId: source.workspace_id,
    wabaId,
    start,
    end,
  });
  const cached = await cache.get<WhatsAppProviderAccount>(key);
  const enabledSinceCached =
    cached &&
    cached.activationStatus !== "enabled" &&
    Boolean(await cache.get<boolean>(insightsEnabledMarkerKey(wabaId)));
  if (
    cached &&
    !enabledSinceCached &&
    (!params.refresh || Date.now() - Date.parse(cached.fetchedAt || "") < 30000)
  )
    return { ...cached, sourceId: source.id, sourceName: empty.sourceName };
  const cooldownUntil = await getCachedWhatsAppMetaReadCooldownUntil(wabaId);
  const permit = await acquireWhatsAppMetaReadLock({
    sourceId: source.id,
    wabaId,
    additionalCooldownUntil: cooldownUntil,
  });
  if (permit.outcome !== "acquired")
    return {
      ...empty,
      status: "unavailable",
      pricingStatus: "unavailable",
      templateStatus: "unavailable",
    };
  try {
    const { result, done, rateLimited } = await readAccountPricing({
      source,
      wabaId,
      accessToken,
      start,
      end,
      requestSignal,
      empty,
    });
    if (done) {
      if (rateLimited && result.status === "available")
        await cache.set(key, result, 300);
      return result;
    }
    const insightsUnsupported =
      result.activationStatus === "required" &&
      (await isWhatsAppTemplateInsightsUnsupported(wabaId));
    let catalog: Row[];
    try {
      catalog = await collectMetaGraphEdge<Row>({
        client,
        accessToken,
        path: `${wabaId}/message_templates`,
        initialQuery: {
          fields: "id,name,language,category,status,quality_rating",
          limit: 100,
        },
        maxPages: 2,
        maxItems: 101,
        createRequestSignal: requestSignal,
        normalizePage: payload => {
          const body = asRecord(payload);
          return {
            data: asList(body.data),
            next: text(asRecord(body.paging).next) || undefined,
          };
        },
      });
    } catch (error) {
      await protectRateLimit(wabaId, source.credentials, error);
      result.templateIssues = null;
      result.templateStatus =
        result.activationStatus === "enabled"
          ? statusForError(error)
          : activationTemplateStatus(result, insightsUnsupported);
      await cache.set(key, result, 300);
      return result;
    }
    result.templatesTruncated = catalog.length > 100;
    const templates = catalog.slice(0, 100);
    result.templateIssues = countWhatsAppTemplateIssues(
      templates,
      result.templatesTruncated
    );
    if (result.activationStatus !== "enabled") {
      // Template analytics need insights; the catalog health does not.
      result.templateStatus = activationTemplateStatus(
        result,
        insightsUnsupported
      );
      await cache.set(key, result, 300);
      return result;
    }
    const startTimestamp = Math.floor(start.getTime() / 1000),
      endTimestamp = Math.floor(end.getTime() / 1000);
    try {
      await ensureWhatsAppTemplateAnalyticsIndexes();
      for (let offset = 0; offset < templates.length; offset += 10) {
        const ids = templates
          .slice(offset, offset + 10)
          .map(template => text(template.id))
          .filter((id): id is string => Boolean(id));
        if (!ids.length) continue;
        const templateField = `template_analytics.start(${startTimestamp}).end(${endTimestamp}).granularity(DAILY).template_ids(${JSON.stringify(ids)}).metric_types(["SENT","DELIVERED","READ","CLICKED","COST"])`;
        const response = await client.getJson(wabaId, {
          token: accessToken,
          query: { fields: templateField },
          signal: requestSignal(),
        });
        const observations = buildTemplateObservationWrites(
          source.workspace_id,
          wabaId,
          response,
          result.currency,
          new Date()
        );
        // Persist each completed request before another batch can fail.
        for (
          let writeOffset = 0;
          writeOffset < observations.length;
          writeOffset += 1000
        )
          await WhatsAppTemplateAnalyticsDaily.bulkWrite(
            observations.slice(writeOffset, writeOffset + 1000),
            { ordered: false }
          );
      }
      const daily = await WhatsAppTemplateAnalyticsDaily.find({
        workspaceId: source.workspace_id,
        wabaId,
        templateId: { $in: templates.map(template => template.id) },
        periodStart: { $gte: start, $lt: end },
      })
        .select(
          "templateId currency sent delivered read clicked uniqueClicked quickReplyClicked cost periodStart periodEnd"
        )
        .limit(9100)
        .lean();
      const restored = normalizeTemplateAnalytics(
        {
          template_analytics: {
            data: [
              {
                data_points: daily.map(row => ({
                  template_id: row.templateId,
                  currency: row.currency,
                  sent: row.sent,
                  delivered: row.delivered,
                  read: row.read,
                  clicked:
                    row.clicked === null &&
                    row.uniqueClicked === null &&
                    row.quickReplyClicked === null
                      ? undefined
                      : [
                          { type: "url_button", count: row.clicked },
                          {
                            type: "unique_url_button",
                            count: row.uniqueClicked,
                          },
                          {
                            type: "quick_reply_button",
                            count: row.quickReplyClicked,
                          },
                        ],
                  cost:
                    row.cost === null
                      ? []
                      : [{ type: "amount_spent", value: row.cost }],
                })),
              },
            ],
          },
        },
        result.currency
      );
      const byId = new Map(restored.map(template => [template.id, template]));
      result.templates = templates.map(template => {
        const metric = byId.get(String(template.id)) || {
          id: String(template.id),
          sent: 0,
          delivered: 0,
          read: null,
          clicked: null,
          uniqueClicked: null,
          quickReplyClicked: null,
          cost: null,
          currency: result.currency,
          readRate: null,
          clickRate: null,
          costPerDelivered: null,
        };
        return {
          ...metric,
          name: text(template.name) || "",
          language: text(template.language) || "",
          category: text(template.category) || "",
          quality:
            text(template.quality_rating) ||
            text(asRecord(template.quality_rating).score),
          status: text(template.status) || "unknown",
          ...(!["MARKETING", "UTILITY"].includes(
            String(template.category).toUpperCase()
          )
            ? {
                clicked: null,
                uniqueClicked: null,
                quickReplyClicked: null,
                clickRate: null,
              }
            : {}),
        };
      });
      result.templateStatus = "available";
    } catch (error) {
      await protectRateLimit(wabaId, source.credentials, error);
      result.templateStatus = statusForError(error);
    }
    await cache.set(key, result, 300);
    return result;
  } finally {
    await releaseWhatsAppMetaReadPermit(permit);
  }
}

const SPEND_FIELDS = [
  "sourceId",
  "sourceName",
  "accountKey",
  "scope",
  "providerWindow",
  "status",
  "pricingStatus",
  "currency",
  "approximateSpend",
  "pricing",
  "fetchedAt",
] as const;
const pickSpend = (
  account: WhatsAppProviderSpendAccount
): WhatsAppProviderSpendAccount =>
  Object.fromEntries(
    SPEND_FIELDS.map(field => [field, account[field]])
  ) as WhatsAppProviderSpendAccount;

/**
 * Account-level spend only (pricing_analytics), for campaign surfaces. Shares
 * the WABA read lock, cooldown and analytics cache; never reads templates.
 */
export async function readWhatsAppProviderSpend(params: {
  source: WhatsAppAnalyticsSource;
  start: Date;
  end: Date;
  signal?: AbortSignal;
}): Promise<WhatsAppProviderSpendAccount> {
  const { source, start, end } = params;
  const credentials = normalizeWhatsAppCredentials(source.credentials);
  const { wabaId, accessToken } = credentials;
  const empty = emptyProviderAccount(source, wabaId, start, end);
  if (!wabaId || !accessToken) return pickSpend(empty);
  const window = { workspaceId: source.workspace_id, wabaId, start, end };
  const key = providerCacheKey("whatsapp:spend:v1", window);
  // A same-window analytics read already holds the pricing totals.
  const cached =
    (await cache.get<WhatsAppProviderSpendAccount>(key)) ||
    (await cache.get<WhatsAppProviderAccount>(
      providerCacheKey("whatsapp:analytics:v1", window)
    ));
  if (cached)
    return pickSpend({
      ...cached,
      sourceId: source.id,
      sourceName: empty.sourceName,
    });
  const cooldownUntil = await getCachedWhatsAppMetaReadCooldownUntil(wabaId);
  const permit = await acquireWhatsAppMetaReadLock({
    sourceId: source.id,
    wabaId,
    additionalCooldownUntil: cooldownUntil,
  });
  if (permit.outcome !== "acquired")
    return pickSpend({
      ...empty,
      status: "unavailable",
      pricingStatus: "unavailable",
    });
  try {
    const { result } = await readAccountPricing({
      source,
      wabaId,
      accessToken,
      start,
      end,
      requestSignal: providerRequestSignal(params.signal),
      empty,
    });
    const spend = pickSpend(result);
    // Failures are cached briefly so page revisits do not hammer Meta.
    await cache.set(key, spend, spend.pricingStatus === "available" ? 300 : 60);
    return spend;
  } finally {
    await releaseWhatsAppMetaReadPermit(permit);
  }
}
