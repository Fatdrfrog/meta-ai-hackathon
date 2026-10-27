import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import {
  acquireWhatsAppMetaReadLock,
  getCachedWhatsAppMetaReadCooldownUntil,
  releaseWhatsAppMetaReadPermit,
} from "@/lib/whatsapp/meta-read-policy";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import {
  isWhatsAppTemplateInsightsUnsupported,
  markWhatsAppTemplateInsightsEnabled,
  markWhatsAppTemplateInsightsUnsupported,
  protectRateLimit,
  statusForError,
  type WhatsAppAnalyticsSource,
} from "./whatsapp-provider-analytics";

export type WhatsAppInsightsActivationOutcome =
  | "enabled"
  | "already_enabled"
  | "would_enable"
  | "not_found"
  | "not_connected"
  | "permission_required"
  | "unsupported"
  | "rate_limited"
  | "busy"
  | "unavailable";

export type WhatsAppInsightsActivationResult = {
  outcome: WhatsAppInsightsActivationOutcome;
  sourceId: string;
  /** The WhatsApp Business Account id; never a credential. */
  accountKey: string | null;
  cooldownUntil?: string | null;
};

const client = getWhatsAppGraphClient();

/**
 * Turns on Meta template analytics (`POST /{waba-id}?is_enabled_for_insights=true`)
 * for a workspace's WhatsApp source. Meta cannot turn it off again, so callers
 * must confirm with the owner first. Idempotent: an enabled account is not
 * posted to. Runs under the same WABA read lock and cooldown as analytics reads.
 */
export async function enableWhatsAppTemplateInsights(params: {
  workspaceId: string;
  sourceId: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<WhatsAppInsightsActivationResult> {
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("id,name,workspace_id,credentials")
    .eq("id", params.sourceId)
    .eq("workspace_id", params.workspaceId)
    .eq("type", "whatsapp")
    .maybeSingle();
  if (error) throw new Error("WhatsApp source unavailable");
  const source = data as WhatsAppAnalyticsSource | null;
  if (!source)
    return {
      outcome: "not_found",
      sourceId: params.sourceId,
      accountKey: null,
    };
  const { wabaId, accessToken } = normalizeWhatsAppCredentials(
    source.credentials
  );
  const base = { sourceId: source.id, accountKey: wabaId || null };
  if (!wabaId || !accessToken) return { ...base, outcome: "not_connected" };
  const permit = await acquireWhatsAppMetaReadLock({
    sourceId: source.id,
    wabaId,
    additionalCooldownUntil:
      await getCachedWhatsAppMetaReadCooldownUntil(wabaId),
  });
  if (permit.outcome === "cooldown")
    return {
      ...base,
      outcome: "rate_limited",
      cooldownUntil: permit.cooldownUntil,
    };
  if (permit.outcome !== "acquired")
    return {
      ...base,
      outcome: permit.outcome === "in_progress" ? "busy" : "unavailable",
    };
  const signal = () =>
    AbortSignal.any([
      AbortSignal.timeout(8000),
      ...(params.signal ? [params.signal] : []),
    ]);
  try {
    const account = await client.getJson<Record<string, unknown>>(wabaId, {
      token: accessToken,
      query: { fields: "is_enabled_for_insights" },
      signal: signal(),
    });
    if (account.is_enabled_for_insights === true) {
      await markWhatsAppTemplateInsightsEnabled(wabaId);
      return { ...base, outcome: "already_enabled" };
    }
    if (params.dryRun)
      return {
        ...base,
        outcome: (await isWhatsAppTemplateInsightsUnsupported(wabaId))
          ? "unsupported"
          : "would_enable",
      };
    await client.postJson(wabaId, {
      token: accessToken,
      query: { is_enabled_for_insights: "true" },
      signal: signal(),
    });
    await markWhatsAppTemplateInsightsEnabled(wabaId);
    return { ...base, outcome: "enabled" };
  } catch (error) {
    if (await protectRateLimit(wabaId, source.credentials, error))
      return { ...base, outcome: "rate_limited" };
    const status = statusForError(error);
    // Meta refuses this account type (WhatsApp Business app); stop offering it.
    if (status === "unsupported")
      await markWhatsAppTemplateInsightsUnsupported(wabaId);
    return {
      ...base,
      outcome:
        status === "permission_required" || status === "unsupported"
          ? status
          : "unavailable",
    };
  } finally {
    await releaseWhatsAppMetaReadPermit(permit);
  }
}

/** Workspaces' WhatsApp sources for the operator rollout, one per WABA. */
export async function listWhatsAppInsightsSources(params: {
  workspaceId?: string;
  sourceId?: string;
  afterSourceId?: string;
  limit: number;
}): Promise<{
  sources: Array<{ id: string; workspaceId: string; accountKey: string }>;
  nextSourceId: string | null;
}> {
  let query = supabaseAdmin
    .from("sources")
    .select("id,workspace_id,credentials")
    .eq("type", "whatsapp")
    .order("id")
    .limit(params.limit);
  if (params.workspaceId) query = query.eq("workspace_id", params.workspaceId);
  if (params.sourceId) query = query.eq("id", params.sourceId);
  if (params.afterSourceId) query = query.gt("id", params.afterSourceId);
  const { data, error } = await query;
  if (error) throw new Error("WhatsApp sources unavailable");
  const rows = (data || []) as WhatsAppAnalyticsSource[];
  const seen = new Set<string>();
  return {
    sources: rows.flatMap(source => {
      const wabaId = normalizeWhatsAppCredentials(source.credentials).wabaId;
      const accountKey = wabaId || source.id;
      if (seen.has(accountKey)) return [];
      seen.add(accountKey);
      return [{ id: source.id, workspaceId: source.workspace_id, accountKey }];
    }),
    nextSourceId:
      rows.length === params.limit ? (rows.at(-1)?.id ?? null) : null,
  };
}
