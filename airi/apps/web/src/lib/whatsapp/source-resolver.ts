import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  buildWhatsAppSourceResolutionFilters,
  compactWhatsAppAccountString,
  normalizeWhatsAppAccountIdentifiers,
  type WhatsAppAccountIdentifiers,
} from "@icecore/shared/lib/whatsapp/account-identifiers";
import type { Source } from "@icecore/shared/types/sources";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";

type ResolveWhatsAppSourceParams = WhatsAppAccountIdentifiers & {
  workspaceId?: string | null;
  limit?: number;
  /** Lifecycle-sensitive callers must not bind an event to cached credentials. */
  bypassCache?: boolean;
};

type SupabaseMaybeError = {
  code?: string;
  message?: string;
};

type SourceResolutionCacheEntry = {
  expiresAt: number;
  promise: Promise<Source[]>;
};

const SOURCE_RESOLUTION_CACHE_MAX_ENTRIES = 2_000;
const SOURCE_RESOLUTION_CACHE_HIT_TTL_MS = 15_000;
const SOURCE_RESOLUTION_CACHE_MISS_TTL_MS = 3_000;
const sourceResolutionCache = new Map<string, SourceResolutionCacheEntry>();

function isMissingAccountTableError(error: unknown): boolean {
  const code = (error as SupabaseMaybeError | null)?.code;
  const message = (error as SupabaseMaybeError | null)?.message || "";
  return code === "42P01" || message.includes("whatsapp_accounts");
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), 100));
}

function buildSourceResolutionCacheKey(params: {
  workspaceId?: string | null;
  limit: number;
  identifiers: WhatsAppAccountIdentifiers;
}): string | null {
  const workspaceId = compactWhatsAppAccountString(params.workspaceId) || "";
  const identifiers = params.identifiers;
  const values = [
    identifiers.phoneNumberId,
    identifiers.csId,
    identifiers.messagingAccountId,
    identifiers.wabaId,
    identifiers.waacId,
  ];
  if (!values.some(Boolean)) return null;

  return JSON.stringify({
    workspaceId,
    limit: params.limit,
    phoneNumberId: identifiers.phoneNumberId || "",
    csId: identifiers.csId || "",
    messagingAccountId: identifiers.messagingAccountId || "",
    wabaId: identifiers.wabaId || "",
    waacId: identifiers.waacId || "",
  });
}

function pruneSourceResolutionCache(now: number): void {
  for (const [key, entry] of sourceResolutionCache) {
    if (entry.expiresAt <= now) sourceResolutionCache.delete(key);
  }
  while (sourceResolutionCache.size > SOURCE_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = sourceResolutionCache.keys().next().value;
    if (!oldestKey) return;
    sourceResolutionCache.delete(oldestKey);
  }
}

/**
 * Source rows change rarely compared with inbound message volume. This cache
 * coalesces account lookup bursts without creating a second resolver path.
 */
export function invalidateWhatsAppSourceResolutionCache(): void {
  sourceResolutionCache.clear();
}

function buildAccountLookups(
  params: ResolveWhatsAppSourceParams
): Array<[string, string | undefined]> {
  const ids = normalizeWhatsAppAccountIdentifiers(params);
  return [
    ["phone_number_id", ids.phoneNumberId],
    ["cs_id", ids.csId],
    ["messaging_account_id", ids.messagingAccountId],
    ["legacy_waba_id", ids.wabaId],
    ["waac_id", ids.waacId],
  ];
}

async function resolveSourceIdsFromAccountTable(
  params: ResolveWhatsAppSourceParams,
  limit: number
): Promise<string[]> {
  const workspaceId = compactWhatsAppAccountString(params.workspaceId);
  const accountLookups = buildAccountLookups(params);

  for (const [column, value] of accountLookups) {
    if (!value) continue;
    try {
      // Offboarded and removed sources must still resolve, so the webhook
      // runtime can skip them with a reason instead of routing to a sibling
      // source on the same WABA. connection_status is state, not routability.
      let query = supabaseAdmin
        .from("whatsapp_accounts")
        .select("source_id")
        .eq(column, value)
        .not("source_id", "is", null);

      if (workspaceId) {
        query = query.eq("workspace_id", workspaceId);
      }

      const { data, error } = await query
        .order("last_observed_at", { ascending: false })
        .limit(limit);

      if (error) {
        if (isMissingAccountTableError(error)) return [];
        continue;
      }

      const sourceIds = readUniqueStringArray(
        (Array.isArray(data) ? data : []).map(row => row?.source_id)
      );
      if (sourceIds.length > 0) return sourceIds;
    } catch (error) {
      if (isMissingAccountTableError(error)) return [];
    }
  }

  return [];
}

async function fetchWhatsAppSourcesByIds(params: {
  sourceIds: string[];
  workspaceId?: string;
  limit: number;
}): Promise<Source[]> {
  if (params.sourceIds.length === 0) return [];

  try {
    let query = supabaseAdmin
      .from("sources")
      .select("*")
      .eq("type", "whatsapp")
      .in("id", params.sourceIds);

    if (params.workspaceId) {
      query = query.eq("workspace_id", params.workspaceId);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(params.limit);

    if (error || !Array.isArray(data)) return [];

    const byId = new Map<string, Source>();
    for (const source of data as Source[]) {
      byId.set(source.id, source);
    }
    return params.sourceIds
      .map(sourceId => byId.get(sourceId))
      .filter((source): source is Source => Boolean(source));
  } catch {
    return [];
  }
}

async function fetchWhatsAppSourcesByCredentialFilter(params: {
  filter: Record<string, string>;
  workspaceId?: string;
  limit: number;
}): Promise<Source[]> {
  try {
    let query = supabaseAdmin
      .from("sources")
      .select("*")
      .eq("type", "whatsapp");

    if (params.workspaceId) {
      query = query.eq("workspace_id", params.workspaceId);
    }

    for (const [key, value] of Object.entries(params.filter)) {
      query = query.eq(key, value);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(params.limit);

    if (error || !Array.isArray(data)) return [];
    return data as Source[];
  } catch {
    return [];
  }
}

async function resolveWhatsAppSourcesByAccountIdentifiersUncached(
  params: ResolveWhatsAppSourceParams
): Promise<Source[]> {
  const workspaceId = compactWhatsAppAccountString(params.workspaceId);
  const limit = normalizeLimit(params.limit, 50);

  const sourceIdsFromAccount = await resolveSourceIdsFromAccountTable(
    params,
    limit
  );
  const sourcesFromAccount = await fetchWhatsAppSourcesByIds({
    sourceIds: sourceIdsFromAccount,
    workspaceId,
    limit,
  });
  if (sourcesFromAccount.length > 0) {
    return sourcesFromAccount;
  }

  const filters = buildWhatsAppSourceResolutionFilters(params);
  for (const filter of filters) {
    const sources = await fetchWhatsAppSourcesByCredentialFilter({
      filter,
      workspaceId,
      limit,
    });
    if (sources.length > 0) return sources;
  }

  return [];
}

export async function resolveWhatsAppSourcesByAccountIdentifiers(
  params: ResolveWhatsAppSourceParams
): Promise<Source[]> {
  if (params.bypassCache) {
    return resolveWhatsAppSourcesByAccountIdentifiersUncached(params);
  }
  const limit = normalizeLimit(params.limit, 50);
  const identifiers = normalizeWhatsAppAccountIdentifiers(params);
  const cacheKey = buildSourceResolutionCacheKey({
    workspaceId: params.workspaceId,
    limit,
    identifiers,
  });
  if (!cacheKey) {
    return resolveWhatsAppSourcesByAccountIdentifiersUncached(params);
  }

  const now = Date.now();
  pruneSourceResolutionCache(now);
  const cached = sourceResolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Refresh insertion order so bounded eviction behaves like an LRU cache.
    sourceResolutionCache.delete(cacheKey);
    sourceResolutionCache.set(cacheKey, cached);
    return cached.promise;
  }

  const promise = resolveWhatsAppSourcesByAccountIdentifiersUncached(params);
  const entry: SourceResolutionCacheEntry = {
    expiresAt: now + SOURCE_RESOLUTION_CACHE_HIT_TTL_MS,
    promise,
  };
  sourceResolutionCache.set(cacheKey, entry);
  pruneSourceResolutionCache(now);

  try {
    const sources = await promise;
    entry.expiresAt =
      Date.now() +
      (sources.length > 0
        ? SOURCE_RESOLUTION_CACHE_HIT_TTL_MS
        : SOURCE_RESOLUTION_CACHE_MISS_TTL_MS);
    return sources;
  } catch (error) {
    sourceResolutionCache.delete(cacheKey);
    throw error;
  }
}

export async function resolveWhatsAppSourceByAccountIdentifiers(
  params: ResolveWhatsAppSourceParams
): Promise<Source | null> {
  const sources = await resolveWhatsAppSourcesByAccountIdentifiers({
    ...params,
    limit: 1,
  });
  return sources[0] || null;
}
