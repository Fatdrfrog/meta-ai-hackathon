import "server-only";
import { randomUUID } from "node:crypto";
import { decryptMaybeString } from "@/lib/crypto";
import {
  extractMetaAdsMcpCredentialFields,
  mergeMetaAdsMcpReadinessEvidence,
} from "@/lib/meta-ads/meta-ads-mcp-credentials";
import {
  canRetryMetaAdsMcpReadiness,
  evaluateMetaAdsMcpReadiness,
  normalizeMetaAdsMcpSelectedAdAccount,
} from "@/lib/meta-ads/meta-ads-mcp-readiness";
import { getMetaAdsAppConfig } from "@/lib/meta-ads/meta-ads-login-config";
import { META_ADS_SOURCE_TYPE } from "@/lib/meta-ads/meta-ads-source";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { closeMetaAdsMcpSession } from "./client";
import {
  probeMetaAdsMcpReadiness,
  type MetaAdsMcpLiveSession,
} from "./readiness-probe";
import type {
  MetaAdsAdAccount,
  MetaAdsMcpReadiness,
} from "@icecore/shared/types/sources";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asRecord, readNonEmptyString } from "@icecore/shared/lib/value-utils";

// The Settings route already owned persistence and revision checks. Reuse that
// owner for chat freshness, rather than a second transient or unguarded probe.
const SOURCE_SELECT = "id, company_id, credentials, updated_at";

export type MetaAdsMcpSource = {
  id: string;
  company_id: string;
  credentials: unknown;
  updated_at: string;
};

type CredentialContext = {
  connectionId: string | null;
  selectedAdAccountId: string | null;
  assetsCheckedAt: string | null;
  companyId: string;
  updatedAt: string;
};

const optionalString = (value: unknown, maxLength = 100) =>
  readNonEmptyString(value, { trim: true, maxLength });

export function metaAdsMcpCredentialContext(
  source: MetaAdsMcpSource
): CredentialContext {
  const raw = asRecord(source.credentials);
  return {
    connectionId: optionalString(raw.mcp_connection_id),
    selectedAdAccountId: optionalString(raw.selected_ad_account_id),
    assetsCheckedAt: optionalString(raw.mcp_assets_checked_at),
    companyId: source.company_id,
    updatedAt: source.updated_at,
  };
}

function withCredentialContextFilters<
  T extends {
    eq(column: string, value: string): T;
    is(column: string, value: null): T;
  },
>(query: T, context: CredentialContext): T {
  let filtered = query
    .eq("company_id", context.companyId)
    .eq("updated_at", context.updatedAt);
  filtered = context.connectionId
    ? filtered.eq("credentials->>mcp_connection_id", context.connectionId)
    : filtered.is("credentials->>mcp_connection_id", null);
  filtered = context.selectedAdAccountId
    ? filtered.eq(
        "credentials->>selected_ad_account_id",
        context.selectedAdAccountId
      )
    : filtered.is("credentials->>selected_ad_account_id", null);
  filtered = context.assetsCheckedAt
    ? filtered.eq(
        "credentials->>mcp_assets_checked_at",
        context.assetsCheckedAt
      )
    : filtered.is("credentials->>mcp_assets_checked_at", null);
  return filtered;
}

export async function loadMetaAdsMcpSource(
  supabase: SupabaseClient,
  workspaceId: string,
  sourceId?: string
): Promise<{ source: MetaAdsMcpSource | null; error: boolean }> {
  let query = supabase
    .from("sources")
    .select(SOURCE_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("type", META_ADS_SOURCE_TYPE);
  if (sourceId) query = query.eq("id", sourceId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    source: data ? (data as MetaAdsMcpSource) : null,
    error: Boolean(error),
  };
}

export async function compareAndSetMetaAdsMcpCredentials(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  sourceId: string;
  expected: CredentialContext;
  credentials: Record<string, unknown>;
}): Promise<{ source: MetaAdsMcpSource | null; error: boolean }> {
  let query = params.supabase
    .from("sources")
    .update({ credentials: params.credentials })
    .eq("id", params.sourceId)
    .eq("workspace_id", params.workspaceId)
    .eq("type", META_ADS_SOURCE_TYPE);
  query = withCredentialContextFilters(query, params.expected);
  const { data, error } = await query.select(SOURCE_SELECT).maybeSingle();
  return {
    source: data ? (data as MetaAdsMcpSource) : null,
    error: Boolean(error),
  };
}

export type MetaAdsMcpRefreshResult = {
  source: MetaAdsMcpSource | null;
  tokenUsable?: boolean;
  error?: string;
  status?: number;
  /** Only with retainSession, after the probe's evidence was saved. */
  liveSession?: MetaAdsMcpLiveSession;
};

async function closeLiveSession(live: MetaAdsMcpLiveSession) {
  try {
    await closeMetaAdsMcpSession(live.session);
  } catch {
    /* lifecycle cleanup must not mask the readiness result */
  }
}

/**
 * With retainSession, a verified probe's open session is handed to the caller
 * once its evidence is saved; on every other path it is closed here.
 */
export async function refreshMetaAdsMcpSourceReadiness(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  source: MetaAdsMcpSource;
  signal?: AbortSignal;
  retainSession?: boolean;
}): Promise<MetaAdsMcpRefreshResult> {
  let liveSession: MetaAdsMcpLiveSession | undefined;
  let handedOver = false;
  try {
    const refreshed = await refreshSourceReadiness(params, live => {
      liveSession = live;
    });
    handedOver = Boolean(
      liveSession &&
        refreshed.source &&
        !refreshed.error &&
        refreshed.tokenUsable === undefined
    );
    return handedOver ? { ...refreshed, liveSession } : refreshed;
  } finally {
    if (liveSession && !handedOver) await closeLiveSession(liveSession);
  }
}

async function refreshSourceReadiness(
  params: {
    supabase: SupabaseClient;
    workspaceId: string;
    source: MetaAdsMcpSource;
    signal?: AbortSignal;
    retainSession?: boolean;
  },
  onLiveSession: (live: MetaAdsMcpLiveSession) => void
): Promise<MetaAdsMcpRefreshResult> {
  let source = params.source;
  const { supabase, workspaceId, signal } = params;
  signal?.throwIfAborted();
  let context = metaAdsMcpCredentialContext(source);
  let fields = extractMetaAdsMcpCredentialFields(source.credentials);
  const accessToken = decryptMaybeString(fields.mcp_access_token);
  if (!accessToken) {
    return { source, tokenUsable: false };
  }

  if (!context.connectionId) {
    const connectionId = randomUUID();
    const bootstrappedCredentials = {
      ...asRecord(source.credentials),
      mcp_connection_id: connectionId,
    };
    const bootstrapped = await compareAndSetMetaAdsMcpCredentials({
      supabase,
      workspaceId,
      sourceId: source.id,
      expected: context,
      credentials: bootstrappedCredentials,
    });
    if (bootstrapped.error) {
      return { source, error: "Failed to update Meta Ads source", status: 500 };
    }
    if (!bootstrapped.source) {
      return { source, error: "mcp_session_conflict", status: 409 };
    }
    source = bootstrapped.source;
    context = metaAdsMcpCredentialContext(source);
    fields = extractMetaAdsMcpCredentialFields(source.credentials);
  }

  const appConfig = getMetaAdsAppConfig();
  if (!appConfig || !context.connectionId) {
    return { source };
  }

  const raw = asRecord(source.credentials);
  const liveResult = await probeMetaAdsMcpReadiness({
    accessToken,
    signal,
    ...(params.retainSession ? { retainSession: true } : {}),
    connectionId: context.connectionId,
    appConfig,
    selectedAdAccountId: context.selectedAdAccountId,
    expectedMcpUserId: fields.mcp_user_id || null,
    graphUserId: optionalString(raw.user_id),
    // This deadline belongs to the unchanged MCP token and connection. Keep it
    // available when debug_token omits lifetime metadata on a later check.
    oauthClaims: {
      expiresAt: fields.mcp_expires_at || null,
      authoritativeScope: false,
    },
  });
  if (liveResult.kind !== "invalid_credentials" && liveResult.liveSession)
    onLiveSession(liveResult.liveSession);
  signal?.throwIfAborted();
  const loaded = await loadMetaAdsMcpSource(supabase, workspaceId, source.id);
  if (loaded.error || !loaded.source) {
    return {
      source: null,
      error: loaded.error
        ? "Failed to load Meta Ads source"
        : "Source not found",
      status: loaded.error ? 500 : 404,
    };
  }
  const latestContext = metaAdsMcpCredentialContext(loaded.source);
  if (
    latestContext.connectionId !== context.connectionId ||
    latestContext.selectedAdAccountId !== context.selectedAdAccountId ||
    latestContext.assetsCheckedAt !== context.assetsCheckedAt ||
    latestContext.updatedAt !== context.updatedAt ||
    latestContext.companyId !== context.companyId
  ) {
    return { source, error: "mcp_session_conflict", status: 409 };
  }

  const sameGraphToken =
    decryptMaybeString(asRecord(loaded.source.credentials).access_token) ===
    accessToken;
  if (
    liveResult.kind === "invalid_credentials" &&
    !liveResult.graphAccessInvalid
  ) {
    // Incomplete provider metadata cannot durably revoke a customer's token.
    return { source: loaded.source, tokenUsable: false };
  }
  const confirmedInvalidity = liveResult.kind === "invalid_credentials";
  const checkedAt = new Date().toISOString();
  const credentials = mergeMetaAdsMcpReadinessEvidence({
    existing: loaded.source.credentials,
    expectedConnectionId: context.connectionId,
    evidence: confirmedInvalidity
      ? {
          ...extractMetaAdsMcpCredentialFields(loaded.source.credentials),
          mcp_provider_probe: {
            outcome: "unauthorized",
            checkedAt,
            warnings: [],
          },
        }
      : liveResult.evidence,
  });
  if (!credentials) {
    return { source, error: "mcp_session_conflict", status: 409 };
  }
  if (confirmedInvalidity && sameGraphToken) {
    credentials.ads_access_invalidated_at = checkedAt;
  } else if (
    liveResult.kind !== "invalid_credentials" &&
    sameGraphToken &&
    liveResult.graphTokenEvidence
  ) {
    const verified = liveResult.graphTokenEvidence;
    if (verified.scope !== undefined) {
      credentials.scope = verified.scope;
      credentials.ads_scopes_verified_at = verified.verifiedAt;
    }
    if (verified.expiresAt !== undefined) {
      credentials.expires_at = verified.expiresAt;
      credentials.ads_never_expires = verified.neverExpires === true;
    }
  }
  signal?.throwIfAborted();
  const saved = await compareAndSetMetaAdsMcpCredentials({
    supabase,
    workspaceId,
    sourceId: source.id,
    expected: latestContext,
    credentials: asRecord(credentials),
  });
  if (saved.error)
    return { source, error: "Failed to update Meta Ads source", status: 500 };
  if (!saved.source) {
    return { source, error: "mcp_session_conflict", status: 409 };
  }
  return { source: saved.source };
}

export type MetaAdsMcpWorkspaceAccess = {
  accessToken: string | null;
  sourceId: string | null;
  credentials: Record<string, unknown> | null;
  selectedAdAccount: MetaAdsAdAccount | null;
  readiness: MetaAdsMcpReadiness;
  /** A readiness probe this request just ran, still open (retainProbeSession). */
  liveSession?: MetaAdsMcpLiveSession;
};

function workspaceAccess(
  source: MetaAdsMcpSource | null,
  options?: { tokenUsable?: boolean; refreshFailed?: boolean }
): MetaAdsMcpWorkspaceAccess {
  const credentials = source ? asRecord(source.credentials) : null;
  const token = credentials?.mcp_access_token
    ? decryptMaybeString(credentials.mcp_access_token)
    : null;
  const readiness = evaluateMetaAdsMcpReadiness({
    hasMetaAdsSource: Boolean(source),
    credentials,
    tokenUsable: options?.tokenUsable ?? Boolean(token),
  });
  return {
    accessToken: options?.refreshFailed ? null : token,
    sourceId: source?.id ?? null,
    credentials,
    selectedAdAccount:
      normalizeMetaAdsMcpSelectedAdAccount(
        credentials?.mcp_selected_ad_account
      ) ?? null,
    readiness: options?.refreshFailed
      ? {
          ...readiness,
          state: "stale",
          canRead: false,
          canWrite: false,
          reconnectRequired: false,
        }
      : readiness,
  };
}

/** A selected skill remains available while stale; execution refreshes the
 * canonical stored evidence before handing a token to the tool harness. */
export async function resolveWorkspaceMetaAdsMcpAccessToken(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  expectedSourceId?: string;
  refresh?: "if_stale" | "force" | "never";
  signal?: AbortSignal;
  /** Return a probe run by this call as liveSession; the caller must close it. */
  retainProbeSession?: boolean;
}): Promise<MetaAdsMcpWorkspaceAccess> {
  params.signal?.throwIfAborted();
  const loaded = await loadMetaAdsMcpSource(
    params.supabase,
    params.workspaceId,
    params.expectedSourceId
  );
  if (loaded.error || !loaded.source) return workspaceAccess(null);
  const companyId = await getCompanyIdForWorkspace(
    params.supabase,
    params.workspaceId
  );
  params.signal?.throwIfAborted();
  if (!companyId || loaded.source.company_id !== companyId)
    return workspaceAccess(null);

  const access = workspaceAccess(loaded.source);
  const mode = params.refresh ?? "if_stale";
  if (
    !access.accessToken ||
    mode === "never" ||
    (mode !== "force" && !canRetryMetaAdsMcpReadiness(access.readiness))
  )
    return access;

  const refreshed = await refreshMetaAdsMcpSourceReadiness({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    source: loaded.source,
    signal: params.signal,
    ...(params.retainProbeSession ? { retainSession: true } : {}),
  });
  const refreshedAccess = workspaceAccess(refreshed.source, {
    tokenUsable: refreshed.tokenUsable,
    refreshFailed: Boolean(refreshed.error),
  });
  const live = refreshed.liveSession;
  if (!live) {
    params.signal?.throwIfAborted();
    return refreshedAccess;
  }
  // The session belongs to the token the probe used; hand it over only when
  // that token is still the usable one.
  if (
    params.signal?.aborted ||
    !refreshedAccess.readiness.canRead ||
    refreshedAccess.accessToken !== access.accessToken
  ) {
    await closeLiveSession(live);
    params.signal?.throwIfAborted();
    return refreshedAccess;
  }
  return { ...refreshedAccess, liveSession: live };
}
