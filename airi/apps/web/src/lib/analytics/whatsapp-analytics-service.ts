import { readCachedLocalAnalytics } from "./analytics-query-service";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import {
  normalizeDashboardCustomCalendarRange,
  resolveDashboardCalendarDays,
} from "@/lib/dashboard-comparison";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  deriveWhatsAppAccountHealth,
  type WhatsAppAccountHealthReason,
} from "@/lib/whatsapp/account/health";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import Message from "@/models/message";
import { WhatsAppTemplateAuditLog } from "@/models/whatsapp-template";
import {
  WhatsAppAnalyticsHealthDaily,
  ensureWhatsAppAnalyticsHealthIndexes,
} from "@/models/whatsapp-analytics-health-daily";
import { buildCacheKey } from "@icecore/shared/lib/cache";
import {
  buildWhatsAppAnalyticsPipeline,
  normalizeWhatsAppLocalAnalytics,
} from "./whatsapp-analytics";
import {
  readWhatsAppProviderAnalytics,
  type WhatsAppAnalyticsSource,
} from "./whatsapp-provider-analytics";
import type { WhatsAppAnalyticsResult } from "./whatsapp-analytics-contract";

const LOCAL_AGGREGATE_MAX_TIME_MS = 25_000;
/**
 * The webhook cron is the only writer of these keys: webhook_subscribed plus
 * the reconnect and field-coverage results that account health turns into
 * webhook reasons.
 */
export function deriveWhatsAppWebhookStatus(
  credentials: Record<string, unknown>,
  reasons: WhatsAppAccountHealthReason[]
): WhatsAppAnalyticsResult["health"][number]["webhookStatus"] {
  if (
    credentials.webhook_subscribed === false ||
    credentials.webhook_coverage_ok === false ||
    reasons.some(reason =>
      ["webhook_subscription", "webhook_coverage"].includes(reason.source)
    )
  )
    return "action_required";
  return credentials.webhook_subscribed === true ? "healthy" : "unknown";
}

async function observeHealth(
  sources: WhatsAppAnalyticsSource[],
  providers: WhatsAppAnalyticsResult["templates"],
  now: Date,
  start?: Date,
  sourceTotals?: Array<{ sourceId: string; pending: number; failed: number }>
): Promise<WhatsAppAnalyticsResult["health"]> {
  const health = sources.map(source => {
    const credentials = source.credentials || {},
      normalized = normalizeWhatsAppCredentials(credentials);
    const account = providers.find(
      item => item.accountKey === (normalized.wabaId || source.id)
    );
    const checkedAt =
      typeof credentials.webhook_last_checked === "string"
        ? credentials.webhook_last_checked
        : typeof credentials.diagnostics_last_checked_at === "string"
          ? credentials.diagnostics_last_checked_at
          : null;
    const verifiedAt = checkedAt ? Date.parse(checkedAt) : NaN;
    const accountHealth = deriveWhatsAppAccountHealth(credentials);
    return {
      sourceId: source.id,
      sourceName: source.name || "WhatsApp",
      phoneQuality:
        typeof credentials.quality_rating === "string"
          ? credentials.quality_rating
          : null,
      portfolioLimit: normalized.messagingLimit || null,
      accountStatus: accountHealth.state,
      webhookStatus: deriveWhatsAppWebhookStatus(
        credentials,
        accountHealth.reasons
      ),
      lastVerifiedAt: Number.isFinite(verifiedAt)
        ? new Date(verifiedAt).toISOString()
        : null,
      verificationFreshness: Number.isFinite(verifiedAt)
        ? now.getTime() - verifiedAt < 0
          ? ("unknown" as const)
          : now.getTime() - verifiedAt <= 24 * 3600000
            ? ("fresh" as const)
            : ("stale" as const)
        : ("unknown" as const),
      // The provider counts catalog issues even without insights (null when
      // the catalog is incomplete); older cached reads lack the field.
      templateIssues:
        account?.templateIssues !== undefined
          ? account.templateIssues
          : account?.templateStatus === "available" &&
              !account.templatesTruncated
            ? account.templates.filter(
                template =>
                  template.quality === "RED" ||
                  ["PAUSED", "REJECTED", "DISABLED"].includes(template.status)
              ).length
            : null,
      activationStatus: account?.activationStatus || ("unknown" as const),
      history: [] as WhatsAppAnalyticsResult["health"][number]["history"],
    };
  });
  if (!sources.length) return health;
  await ensureWhatsAppAnalyticsHealthIndexes();
  const day = now.toISOString().slice(0, 10),
    workspaceId = sources[0].workspace_id;
  // Compare both groups against the stored document in one atomic update.
  // A health-only refresh cannot block a newer delivery observation or erase it.
  const publishNewer = (clock: string, fields: Record<string, unknown>) => {
    const newer = {
      $or: [
        { $eq: [{ $ifNull: [`$${clock}`, null] }, null] },
        { $lt: [`$${clock}`, { $literal: now }] },
      ],
    };
    return Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [
        field,
        {
          $cond: [newer, { $literal: value }, { $ifNull: [`$${field}`, null] }],
        },
      ])
    );
  };
  await WhatsAppAnalyticsHealthDaily.bulkWrite(
    health.map(item => ({
      updateOne: {
        filter: { workspaceId, sourceId: item.sourceId, day },
        update: [
          {
            $set: {
              ...publishNewer("observedAt", {
                observedAt: now,
                accountStatus: item.accountStatus,
                phoneQuality: item.phoneQuality,
                portfolioLimit: item.portfolioLimit,
                webhookStatus: item.webhookStatus,
                templateIssues: item.templateIssues,
              }),
              ...(sourceTotals
                ? publishNewer("deliveryObservedAt", {
                    deliveryObservedAt: now,
                    pending7d:
                      sourceTotals.find(row => row.sourceId === item.sourceId)
                        ?.pending ?? 0,
                    failed7d:
                      sourceTotals.find(row => row.sourceId === item.sourceId)
                        ?.failed ?? 0,
                  })
                : Object.fromEntries(
                    ["deliveryObservedAt", "pending7d", "failed7d"].map(
                      field => [field, { $ifNull: [`$${field}`, null] }]
                    )
                  )),
            },
          },
        ],
        upsert: true,
      },
    })),
    { ordered: false }
  );
  if (!start) return health;
  const observations = await WhatsAppAnalyticsHealthDaily.find({
    workspaceId,
    sourceId: { $in: sources.map(source => source.id) },
    day: { $gte: start.toISOString().slice(0, 10), $lte: day },
  })
    .select(
      "sourceId day observedAt deliveryObservedAt accountStatus phoneQuality portfolioLimit webhookStatus templateIssues pending7d failed7d"
    )
    .sort({ day: 1 })
    .limit(9100)
    .lean();
  for (const item of health)
    item.history = observations
      .filter(row => row.sourceId === item.sourceId)
      .map(row => ({
        day: row.day,
        observedAt: new Date(row.observedAt).toISOString(),
        deliveryObservedAt: row.deliveryObservedAt
          ? new Date(row.deliveryObservedAt).toISOString()
          : null,
        accountStatus: row.accountStatus,
        phoneQuality: row.phoneQuality,
        portfolioLimit: row.portfolioLimit,
        webhookStatus: row.webhookStatus,
        templateIssues: row.templateIssues,
        pending7d: row.pending7d ?? null,
        failed7d: row.failed7d ?? null,
      }));
  return health;
}

/** Bounded operator/worker page; callers persist the cursor and schedule the next page. */
export async function syncWhatsAppAnalyticsSources(params: {
  workspaceId: string;
  afterSourceId?: string;
  limit?: number;
  now?: Date;
  signal?: AbortSignal;
}): Promise<{
  processed: number;
  available: number;
  unavailable: number;
  activationRequired: number;
  hasMore: boolean;
  nextSourceId: string | null;
}> {
  params.signal?.throwIfAborted();
  const limit = Math.max(1, Math.min(10, Math.floor(params.limit || 5)));
  let query = supabaseAdmin
    .from("sources")
    .select("id,name,workspace_id,credentials")
    .eq("workspace_id", params.workspaceId)
    .eq("type", "whatsapp")
    .order("id")
    .limit(limit + 1);
  if (params.afterSourceId) query = query.gt("id", params.afterSourceId);
  const deadline = AbortSignal.timeout(25_000);
  const requestSignal = params.signal
    ? AbortSignal.any([params.signal, deadline])
    : deadline;
  const { data, error } = await query.abortSignal(requestSignal);
  requestSignal.throwIfAborted();
  if (error) throw new Error("WhatsApp source sync unavailable");
  const page = (data || []) as WhatsAppAnalyticsSource[];
  const sources = page.slice(0, limit);
  await connectDB();
  params.signal?.throwIfAborted();
  const end = params.now || new Date(),
    start = new Date(end.getTime() - 7 * 86400000);
  const localStart = new Date(start);
  start.setUTCHours(0, 0, 0, 0);
  let available = 0,
    unavailable = 0,
    activationRequired = 0;
  const providers: WhatsAppAnalyticsResult["templates"] = [];
  for (let offset = 0; offset < sources.length; offset += 2) {
    params.signal?.throwIfAborted();
    const results = await Promise.allSettled(
      sources.slice(offset, offset + 2).map(async source => {
        params.signal?.throwIfAborted();
        return readWhatsAppProviderAnalytics({
          source,
          start,
          end,
          signal: params.signal,
        });
      })
    );
    params.signal?.throwIfAborted();
    for (const result of results) {
      if (result.status === "fulfilled") {
        providers.push(result.value);
        if (result.value.status === "available") available++;
        else unavailable++;
        if (result.value.templateStatus === "activation_required")
          activationRequired++;
      } else unavailable++;
    }
  }
  let sourceTotals:
    | Array<{ sourceId: string; pending: number; failed: number }>
    | undefined;
  if (sources.length) {
    params.signal?.throwIfAborted();
    const [local] = await Message.aggregate(
      buildWhatsAppAnalyticsPipeline({
        workspaceId: params.workspaceId,
        sourceIds: sources.map(source => source.id),
        start: localStart,
        end,
      })
    )
      .allowDiskUse(true)
      .option({ maxTimeMS: 25000 });
    params.signal?.throwIfAborted();
    sourceTotals = (local?.sourceTotals || []).map(
      (row: { _id: string; pending: number; failed: number }) => ({
        sourceId: row._id,
        pending: row.pending,
        failed: row.failed,
      })
    );
  }
  params.signal?.throwIfAborted();
  await observeHealth(sources, providers, end, undefined, sourceTotals);
  params.signal?.throwIfAborted();
  return {
    processed: sources.length,
    available,
    unavailable,
    activationRequired,
    hasMore: page.length > limit,
    nextSourceId: sources.length ? sources[sources.length - 1].id : null,
  };
}

export async function queryWhatsAppAnalytics(params: {
  workspaceId: string;
  days: number;
  sourceId?: string;
  refresh?: boolean;
  /** Viewer's IANA zone: the window starts at local midnight and days are local. */
  timeZone?: string;
  signal?: AbortSignal;
}): Promise<WhatsAppAnalyticsResult> {
  params.signal?.throwIfAborted();
  const days = Math.min(90, Math.max(1, Math.floor(params.days) || 30));
  const timeZone = params.timeZone || "UTC";
  const end = new Date();
  const calendar = resolveDashboardCalendarDays(days, timeZone, end);
  const start = normalizeDashboardCustomCalendarRange(
    calendar.from,
    calendar.to,
    timeZone
  ).start;
  let query = supabaseAdmin
    .from("sources")
    .select("id,name,workspace_id,credentials")
    .eq("workspace_id", params.workspaceId)
    .eq("type", "whatsapp")
    .order("id")
    .limit(101);
  if (params.sourceId) query = query.eq("id", params.sourceId);
  const { data, error } = await query;
  if (error) throw new Error("WhatsApp sources unavailable");
  const sourcesTruncated = (data || []).length > 100;
  const sources = (data || []).slice(0, 100) as WhatsAppAnalyticsSource[];
  if (params.sourceId && sources.length === 0)
    throw new Error("WhatsApp source not found in workspace");
  await connectDB();
  const key = buildCacheKey("whatsapp:analytics-local:v2", [
    params.workspaceId,
    params.sourceId || "all",
    String(days),
    timeZone,
  ]);
  const raw = await readCachedLocalAnalytics({
    key,
    refresh: params.refresh,
    signal: params.signal,
    run: async () => {
      const result = await awaitWithCancellation(
        Message.aggregate(
          buildWhatsAppAnalyticsPipeline({
            workspaceId: params.workspaceId,
            start,
            end,
            sourceId: params.sourceId,
            timeZone,
          })
        )
          .allowDiskUse(true)
          .option({
            maxTimeMS: LOCAL_AGGREGATE_MAX_TIME_MS,
            ...(params.signal ? { signal: params.signal } : {}),
          }),
        params.signal
      );
      return result[0] || {};
    },
  });
  const local = normalizeWhatsAppLocalAnalytics(raw);
  // Duplicate phone connections must not double count WABA-level provider spend.
  const accountSources = new Map<string, WhatsAppAnalyticsSource>();
  for (const source of sources) {
    const normalized = normalizeWhatsAppCredentials(source.credentials);
    accountSources.set(
      normalized.wabaId || source.id,
      accountSources.get(normalized.wabaId || source.id) || source
    );
  }
  const providerAccounts: WhatsAppAnalyticsResult["pricing"]["providerAccounts"] =
    [];
  const providerStart = new Date(start);
  providerStart.setUTCHours(0, 0, 0, 0);
  if (end.getTime() - providerStart.getTime() > 90 * 86400000)
    providerStart.setUTCDate(providerStart.getUTCDate() + 1);
  const providerSources = Array.from(accountSources.values()).slice(0, 10);
  const providerDeadline = params.signal
    ? AbortSignal.any([params.signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  for (let offset = 0; offset < providerSources.length; offset += 2) {
    if (providerDeadline.aborted) break;
    const accounts = await Promise.allSettled(
      providerSources.slice(offset, offset + 2).map(source =>
        readWhatsAppProviderAnalytics({
          source,
          start: providerStart,
          end,
          refresh: params.refresh,
          signal: providerDeadline,
        })
      )
    );
    for (const account of accounts)
      if (account.status === "fulfilled") providerAccounts.push(account.value);
  }
  params.signal?.throwIfAborted();
  const health = await observeHealth(sources, providerAccounts, end, start);
  // Reuse lifecycle's durable audit owner; never return template bodies or arbitrary changes.
  const audits = await WhatsAppTemplateAuditLog.find({
    workspaceId: params.workspaceId,
    createdAt: { $gte: start, $lte: end },
    "changes.kind": {
      $in: [
        "status_update",
        "quality_update",
        "category_update",
        "components_update",
      ],
    },
  })
    .select(
      "createdAt templateId templateName changes.kind changes.event changes.new_quality changes.new_category"
    )
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const asString = (value: unknown) =>
    typeof value === "string" && value ? value : null;
  const templateLifecycle = audits.map(row => ({
    at: new Date(row.createdAt).toISOString(),
    templateId: asString(row.templateId),
    name: row.templateName,
    kind: asString(row.changes?.kind) || "unknown",
    status: asString(row.changes?.event),
    quality: asString(row.changes?.new_quality),
    category: asString(row.changes?.new_category),
  }));
  return {
    window: {
      days,
      start: start.toISOString(),
      end: end.toISOString(),
      replyWindowHours: 168,
    },
    generatedAt: end.toISOString(),
    delivery: local.delivery,
    pricing: { ...local.pricing, providerAccounts },
    templates: providerAccounts,
    health,
    templateLifecycle,
    limitations: {
      sourcesTruncated,
      providerAccountsTruncated:
        providerAccounts.length < accountSources.size || sourcesTruncated,
      providerTemplateLookbackDays: 90,
      providerReadClickWindowDays: 7,
      flowOpenMeasured: false,
    },
  };
}
