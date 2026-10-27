import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCacheKey, cache } from "@/lib/cache";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { META_ADS_SOURCE_TYPE } from "@/lib/meta-ads/meta-ads-source";
import { Conversation } from "@/models/conversation";
import {
  DASHBOARD_RECOMMENDATION_RULES,
  parseDashboardRecommendation,
  recommendDashboardTemplate,
  type DashboardRecommendation,
  type DashboardRecommendationSignals,
} from "./dashboard-recommendation";

const CACHE_TTL_SECONDS = 60 * 60;
const SIGNAL_TIMEOUT_MS = 2_000;
const DAY_MS = 86_400_000;

type SupabaseRead<T> = PromiseLike<{
  data: T | null;
  error: unknown;
  count?: number | null;
}>;

async function readSupabase<T, V>(
  query: SupabaseRead<T>,
  select: (result: { data: T | null; count?: number | null }) => V | null
): Promise<V | null> {
  const result = await query;
  if (result.error) throw result.error;
  return select(result);
}

/**
 * Read the workspace's existing signals with bounded queries: one row, an exact
 * member count, LIMIT 1 existence checks and a conversation count capped at the
 * early-stage threshold. Supabase reads use the member's own RLS-scoped client.
 */
export async function readDashboardRecommendationSignals(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date
): Promise<{
  signals: DashboardRecommendationSignals;
  unavailable: (keyof DashboardRecommendationSignals)[];
}> {
  const rules = DASHBOARD_RECOMMENDATION_RULES;
  const signal = AbortSignal.timeout(SIGNAL_TIMEOUT_MS);
  const since = new Date(now.getTime() - rules.lookbackDays * DAY_MS);
  const reads = {
    workspaceAgeDays: readSupabase(
      supabase
        .from("workspaces")
        .select("created_at")
        .eq("id", workspaceId)
        .abortSignal(signal)
        .maybeSingle<{ created_at: string | null }>(),
      ({ data }) => {
        const createdAt = Date.parse(data?.created_at ?? "");
        return Number.isFinite(createdAt)
          ? Math.max(0, (now.getTime() - createdAt) / DAY_MS)
          : null;
      }
    ),
    members: readSupabase(
      supabase
        .from("company_users")
        .select("user_id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .abortSignal(signal),
      ({ count }) => (typeof count === "number" ? count : null)
    ),
    metaAdsConnected: readSupabase(
      supabase
        .from("sources")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("type", META_ADS_SOURCE_TYPE)
        .limit(1)
        .abortSignal(signal),
      ({ data }) => (Array.isArray(data) ? data.length > 0 : null)
    ),
    recentWhatsAppCampaigns: readSupabase(
      supabase
        .from("campaign_history")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("channel", "whatsapp")
        .gte("sent_at", since.toISOString())
        .limit(1)
        .abortSignal(signal),
      ({ data }) => (Array.isArray(data) ? data.length > 0 : null)
    ),
    recentConversations: connectDB().then(() =>
      Conversation.countDocuments({ workspaceId, createdAt: { $gte: since } })
        .limit(rules.earlyStageConversations)
        .maxTimeMS(SIGNAL_TIMEOUT_MS)
        .exec()
    ),
  } satisfies Record<keyof DashboardRecommendationSignals, Promise<unknown>>;
  const names = Object.keys(reads) as (keyof typeof reads)[];
  const settled = await Promise.allSettled(names.map(name => reads[name]));
  const signals: DashboardRecommendationSignals = {
    workspaceAgeDays: null,
    recentConversations: null,
    metaAdsConnected: null,
    recentWhatsAppCampaigns: null,
    members: null,
  };
  const unavailable: (keyof DashboardRecommendationSignals)[] = [];
  names.forEach((name, index) => {
    const result = settled[index];
    const value = result.status === "fulfilled" ? result.value : null;
    if (value === null || value === undefined) unavailable.push(name);
    else (signals as Record<string, unknown>)[name] = value;
  });
  return { signals, unavailable };
}

/**
 * Starting dashboard for members without a saved layout. Workspace-level and
 * cached for an hour; any failure returns null so the preference read never fails.
 */
export async function getDashboardRecommendation({
  supabase,
  workspaceId,
  now = new Date(),
}: {
  supabase: SupabaseClient;
  workspaceId: string;
  now?: Date;
}): Promise<DashboardRecommendation | null> {
  const key = buildCacheKey("analytics:dashboard-recommendation:v1", [
    workspaceId,
  ]);
  try {
    const cached = parseDashboardRecommendation(await cache.get<unknown>(key));
    if (cached) return cached;
    const { signals, unavailable } = await readDashboardRecommendationSignals(
      supabase,
      workspaceId,
      now
    );
    const recommendation = recommendDashboardTemplate(signals);
    if (unavailable.length) {
      logger.warn("Analytics dashboard recommendation signals unavailable", {
        workspaceId,
        unavailable,
      });
    } else if (recommendation) {
      await cache.set(key, recommendation, CACHE_TTL_SECONDS);
    }
    return recommendation;
  } catch (error) {
    logger.warn("Analytics dashboard recommendation failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
