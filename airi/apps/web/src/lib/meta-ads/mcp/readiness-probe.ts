import { createMetaAdsMcpConversationId } from "./conversation-id";
import "server-only";

import { randomUUID } from "node:crypto";
import { fetchMetaAdsAdAccountInventory } from "@/lib/meta-ads/meta-ads-accounts";
import type { MetaAdsMcpCredentialFields } from "@/lib/meta-ads/meta-ads-mcp-credentials";
import {
  evaluateMetaAdsMcpReadiness,
  META_ADS_MCP_EXPIRY_SKEW_MS,
  META_ADS_MCP_KNOWN_SCOPES,
  normalizeMetaAdsMcpScopes,
} from "@/lib/meta-ads/meta-ads-mcp-readiness";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import { evaluateMetaAccessToken } from "@icecore/shared/lib/meta/debug-token";
import {
  closeMetaAdsMcpSession,
  createMetaAdsMcpSession,
  initializeMetaAdsMcpSession,
  listMetaAdsMcpTools,
  META_ADS_MCP_URL,
  MetaAdsMcpClientError,
  type MetaAdsMcpCatalog,
  type MetaAdsMcpSession,
} from "@/lib/meta-ads/mcp/client";
import { createMetaAdsMcpOperationEvent } from "@/lib/meta-ads/mcp/operation-event";
import { readMetaAdsMcpAccountAccess } from "./account-access";
import { getMetaAdsMcpAccountEligibility } from "./preconditions";
import {
  getWhatsAppGraphClient,
  isMetaGraphAuthorizationError,
} from "@icecore/shared/lib/meta/api";
import type {
  MetaAdsMcpReadiness,
  MetaAdsMcpStoredProbe,
  MetaAdsMcpWarningCode,
} from "@icecore/shared/types/sources";
import {
  asRecord,
  readNonEmptyStringOrUndefined,
} from "@icecore/shared/lib/value-utils";

const GRAPH_READ_TIMEOUT_MS = 10_000;
const PROTECTED_RESOURCE_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_METADATA_SCOPES = 64;
const MAX_SCOPE_LENGTH = 128;

const graphClient = getWhatsAppGraphClient();

type ProbeOutcome = MetaAdsMcpStoredProbe["outcome"];

/** Current debugger claims, independently verified for this token's identity. */
type MetaAdsGraphTokenEvidence = {
  verifiedAt: string;
  scope?: string;
  expiresAt?: string | null;
  neverExpires?: boolean;
};

/**
 * The probe's open, initialized MCP session with its catalog and the complete
 * account inventory it just read. Only returned when the caller asked to
 * retain it; the receiver owns the session and must close it.
 */
export type MetaAdsMcpLiveSession = {
  session: MetaAdsMcpSession;
  catalog: MetaAdsMcpCatalog;
  accountInventory?: unknown;
};

export type MetaAdsMcpLiveReadinessResult =
  | {
      kind: "verified" | "connected_not_ready";
      evidence: Omit<MetaAdsMcpCredentialFields, "mcp_access_token">;
      readiness: MetaAdsMcpReadiness;
      catalog?: MetaAdsMcpCatalog;
      warnings: MetaAdsMcpWarningCode[];
      graphTokenEvidence?: MetaAdsGraphTokenEvidence;
      liveSession?: MetaAdsMcpLiveSession;
    }
  | {
      kind: "invalid_credentials";
      status: 400;
      error: string;
      graphAccessInvalid?: true;
    };

type ProbeParams = {
  accessToken: string;
  connectionId: string;
  appConfig: { appId: string; appSecret: string };
  selectedAdAccountId?: string | null;
  expectedMcpUserId?: string | null;
  /** Current Graph-source owner identity; Task 6 passes the stored source user ID. */
  graphUserId?: string | null;
  oauthClaims?: {
    scope?: string | null;
    expiresAt?: string | null;
    authoritativeScope: boolean;
  };
  now?: Date;
  signal?: AbortSignal;
  /** Keep a verified probe's session open for the caller (see MetaAdsMcpLiveSession). */
  retainSession?: boolean;
};

type ProtectedResourceEvidence = {
  advertisedScopes: string[];
  scopesAdvertised: boolean;
  resourceMatches: boolean;
};

class ProbeDeadlineError extends Error {
  constructor() {
    super("Meta Ads MCP readiness probe timed out");
    this.name = "ProbeDeadlineError";
  }
}

const normalizedString = (value: unknown, maxLength = 200) =>
  readNonEmptyStringOrUndefined(value, { trim: true, maxLength });

async function fetchMcpGraphUser(
  accessToken: string,
  signal?: AbortSignal
): Promise<{
  id: string;
  name?: string;
}> {
  const payload = await graphClient.getJson<unknown>("me", {
    token: accessToken,
    query: { fields: "id,name" },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(GRAPH_READ_TIMEOUT_MS)])
      : AbortSignal.timeout(GRAPH_READ_TIMEOUT_MS),
  });
  const raw = asRecord(payload);
  const id = normalizedString(raw.id, 100);
  if (!id) throw new Error("Meta Graph user identity is unavailable");
  const name = normalizedString(raw.name, 200);
  return { id, ...(name ? { name } : {}) };
}

function controlledWarnings(
  warnings: Iterable<MetaAdsMcpWarningCode>
): MetaAdsMcpWarningCode[] {
  return Array.from(new Set(warnings)).slice(0, 20);
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new ProbeDeadlineError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function authoritativeScopes(params: {
  introspectedScopes: unknown;
  oauthClaims?: ProbeParams["oauthClaims"];
}): { scopes: string[]; authoritative: boolean } {
  if (Array.isArray(params.introspectedScopes)) {
    return {
      scopes: normalizeMetaAdsMcpScopes(
        params.introspectedScopes
          .filter((scope): scope is string => typeof scope === "string")
          .join(" ")
      ),
      authoritative: true,
    };
  }
  if (params.oauthClaims?.authoritativeScope) {
    return {
      scopes: normalizeMetaAdsMcpScopes(params.oauthClaims.scope),
      authoritative: true,
    };
  }
  return { scopes: [], authoritative: false };
}

function protectedResourceMetadataUrl(): URL {
  const resource = new URL(META_ADS_MCP_URL);
  return new URL(
    `/.well-known/oauth-protected-resource${resource.pathname}`,
    resource.origin
  );
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) {
    throw new Error("Protected resource metadata is too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_METADATA_BYTES) {
        throw new Error("Protected resource metadata is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function discoverProtectedResourceMetadata(
  signal?: AbortSignal
): Promise<ProtectedResourceEvidence> {
  const response = await fetch(protectedResourceMetadataUrl(), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(PROTECTED_RESOURCE_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(PROTECTED_RESOURCE_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Protected resource metadata is unavailable");
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new Error("Protected resource metadata is not JSON");
  }

  const text = await readBoundedResponseText(response);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Protected resource metadata is invalid");
  }
  const metadata = parsed as Record<string, unknown>;
  const scopesAdvertised = Object.prototype.hasOwnProperty.call(
    metadata,
    "scopes_supported"
  );
  if (
    scopesAdvertised &&
    (!Array.isArray(metadata.scopes_supported) ||
      metadata.scopes_supported.length > MAX_METADATA_SCOPES ||
      metadata.scopes_supported.some(
        scope =>
          typeof scope !== "string" ||
          !scope.trim() ||
          scope.length > MAX_SCOPE_LENGTH
      ))
  ) {
    throw new Error("Protected resource metadata scopes are invalid");
  }
  const resource = normalizedString(metadata.resource, 2_000);
  if (!resource || resource !== metadata.resource) {
    throw new Error("Protected resource metadata resource is invalid");
  }

  return {
    advertisedScopes: normalizeMetaAdsMcpScopes(
      Array.isArray(metadata.scopes_supported)
        ? metadata.scopes_supported.join(" ")
        : undefined
    ),
    scopesAdvertised,
    resourceMatches: resource === META_ADS_MCP_URL,
  };
}

function providerOutcome(error: unknown): ProbeOutcome {
  if (error instanceof MetaAdsMcpClientError) {
    if (
      error.code === "provider_unauthorized" ||
      error.code === "insufficient_scope"
    ) {
      return "unauthorized";
    }
    if (error.code === "invalid_catalog" || error.code === "protocol_error") {
      return "invalid_catalog";
    }
  }
  return "unreachable";
}

function providerErrorCode(error: unknown): string {
  return error instanceof MetaAdsMcpClientError
    ? error.code
    : error instanceof ProbeDeadlineError ||
        (error instanceof DOMException && error.name === "TimeoutError")
      ? "request_timeout"
      : "provider_unreachable";
}

function challengeScopes(error: unknown): string[] {
  return error instanceof MetaAdsMcpClientError
    ? normalizeMetaAdsMcpScopes(error.requiredScopes?.join(" "))
    : [];
}

function buildEvidence(params: {
  connectionId: string;
  checkedAt: string;
  expiresAt?: string;
  neverExpires?: boolean;
  scopes: string[];
  authoritativeScope: boolean;
  user?: { id: string; name?: string };
  accountIds?: string[];
  accountsTruncated?: boolean;
  selectedAccount?: MetaAdsMcpCredentialFields["mcp_selected_ad_account"];
  assetsChecked: boolean;
  probe?: MetaAdsMcpStoredProbe;
}): Omit<MetaAdsMcpCredentialFields, "mcp_access_token"> {
  return {
    mcp_token_type: "bearer",
    mcp_expires_at: params.expiresAt || null,
    ...(params.neverExpires ? { mcp_never_expires: true } : {}),
    // An authoritative empty list must replace earlier OAuth scope claims.
    ...(params.authoritativeScope || params.scopes.length > 0
      ? { mcp_scope: params.scopes.join(" ") }
      : {}),
    mcp_connection_id: params.connectionId,
    ...(params.user
      ? {
          mcp_user_id: params.user.id,
          ...(params.user.name ? { mcp_user_name: params.user.name } : {}),
        }
      : {}),
    ...(params.authoritativeScope
      ? { mcp_scopes_verified_at: params.checkedAt }
      : {}),
    ...(params.accountIds ? { mcp_ad_account_ids: params.accountIds } : {}),
    ...(typeof params.accountsTruncated === "boolean"
      ? { mcp_ad_accounts_truncated: params.accountsTruncated }
      : {}),
    ...(params.selectedAccount
      ? { mcp_selected_ad_account: params.selectedAccount }
      : {}),
    ...(params.assetsChecked
      ? { mcp_assets_checked_at: params.checkedAt }
      : {}),
    ...(params.probe ? { mcp_provider_probe: params.probe } : {}),
  };
}

function readinessForEvidence(params: {
  evidence: Omit<MetaAdsMcpCredentialFields, "mcp_access_token">;
  selectedAdAccountId?: string | null;
  now: Date;
}): MetaAdsMcpReadiness {
  return evaluateMetaAdsMcpReadiness({
    hasMetaAdsSource: true,
    credentials: {
      ...params.evidence,
      // The pure evaluator needs only token presence; the live token never enters evidence.
      mcp_access_token: "live-probe-token-present",
    },
    selectedAdAccountId: params.selectedAdAccountId,
    tokenUsable: true,
    now: params.now,
  });
}

function asProviderUnauthorized(
  readiness: MetaAdsMcpReadiness
): MetaAdsMcpReadiness {
  return {
    ...readiness,
    state: "provider_unauthorized",
    canRead: false,
    canWrite: false,
    reconnectRequired: true,
  };
}

export async function probeMetaAdsMcpReadiness(
  params: ProbeParams
): Promise<MetaAdsMcpLiveReadinessResult> {
  params.signal?.throwIfAborted();
  const now = params.now || new Date();
  const checkedAt = now.toISOString();
  const oauthExpiryMs =
    typeof params.oauthClaims?.expiresAt === "string"
      ? Date.parse(params.oauthClaims.expiresAt)
      : NaN;
  const oauthExpiresAt =
    Number.isFinite(oauthExpiryMs) && oauthExpiryMs > 0
      ? new Date(oauthExpiryMs).toISOString()
      : undefined;
  const startedAt = Date.now();
  const event = createMetaAdsMcpOperationEvent({
    operationId: randomUUID(),
    operation: "readiness_probe",
    connectionId: params.connectionId,
  });
  const warnings = new Set<MetaAdsMcpWarningCode>();
  let session: MetaAdsMcpSession | undefined;
  let catalog: MetaAdsMcpCatalog | undefined;
  let accountInventory: unknown;
  let sessionRetained = false;
  let result: MetaAdsMcpLiveReadinessResult | undefined;
  let eventErrorCode: string | undefined;

  try {
    const accessToken = normalizedString(params.accessToken, 16_384);
    const connectionId = normalizedString(params.connectionId, 100);
    const expectedMcpUserId = normalizedString(params.expectedMcpUserId, 100);
    const sourceGraphUserId = normalizedString(params.graphUserId, 100);
    if (!accessToken || !connectionId) {
      eventErrorCode = "invalid_probe_input";
      result = {
        kind: "invalid_credentials",
        status: 400,
        error: "mcp_invalid_credentials",
      };
      return result;
    }

    let debugData;
    try {
      debugData = await withDeadline(
        debugConfiguredMetaAccessToken(accessToken, {
          appConfig: params.appConfig,
          signal: params.signal
            ? AbortSignal.any([
                params.signal,
                AbortSignal.timeout(GRAPH_READ_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(GRAPH_READ_TIMEOUT_MS),
        }),
        GRAPH_READ_TIMEOUT_MS
      );
      params.signal?.throwIfAborted();
    } catch (error) {
      params.signal?.throwIfAborted();
      eventErrorCode = providerErrorCode(error);
      if (isMetaGraphAuthorizationError(error)) {
        result = {
          kind: "invalid_credentials",
          status: 400,
          error: "mcp_invalid_credentials",
        };
        return result;
      }
      const probe: MetaAdsMcpStoredProbe = {
        checkedAt,
        outcome: "unreachable",
        latencyMs: Date.now() - startedAt,
        warnings: [],
      };
      const evidence = buildEvidence({
        connectionId,
        checkedAt,
        expiresAt: oauthExpiresAt,
        scopes: [],
        authoritativeScope: false,
        assetsChecked: false,
        probe,
      });
      const readiness = readinessForEvidence({
        evidence,
        selectedAdAccountId: params.selectedAdAccountId,
        now,
      });
      result = {
        kind: "connected_not_ready",
        evidence,
        readiness,
        warnings: [],
      };
      return result;
    }

    const introspectedUserId = normalizedString(
      debugData.user_id || debugData.profile_id,
      100
    );
    // Only the final token's own OAuth lifetime can fill absent metadata.
    // An explicit debugger deadline or zero takes precedence over that fallback.
    const tokenStatus = evaluateMetaAccessToken(
      {
        ...debugData,
        ...(debugData.expires_at === undefined && oauthExpiresAt
          ? { expires_at: oauthExpiryMs / 1_000 }
          : {}),
      },
      { appId: params.appConfig.appId, nowMs: now.getTime() }
    );
    const expiresAt = tokenStatus.expiresAt?.toISOString();
    const neverExpires =
      tokenStatus.neverExpires &&
      (debugData.data_access_expires_at === undefined ||
        debugData.data_access_expires_at === 0);
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : undefined;
    if (!tokenStatus.valid || !introspectedUserId) {
      eventErrorCode = "invalid_token_introspection";
      // Missing debugger metadata and the MCP expiry safety margin do not
      // establish Graph revocation. Share only explicit invalidity evidence.
      const graphAccessInvalid =
        debugData.is_valid === false ||
        tokenStatus.expired ||
        Boolean(
          normalizedString(debugData.app_id, 100) &&
            debugData.app_id !== params.appConfig.appId
        );
      result = {
        kind: "invalid_credentials",
        status: 400,
        error: "mcp_invalid_credentials",
        ...(graphAccessInvalid ? { graphAccessInvalid: true as const } : {}),
      };
      return result;
    }

    const scopeEvidence = authoritativeScopes({
      introspectedScopes: debugData.scopes,
      oauthClaims: params.oauthClaims,
    });
    if (!expiresAt && !neverExpires) warnings.add("expiry_unknown");
    if (!scopeEvidence.authoritative) warnings.add("scope_unverified");

    let mcpGraphUser: Awaited<ReturnType<typeof fetchMcpGraphUser>>;
    try {
      mcpGraphUser = await fetchMcpGraphUser(accessToken, params.signal);
      params.signal?.throwIfAborted();
    } catch (error) {
      params.signal?.throwIfAborted();
      const unauthorized = isMetaGraphAuthorizationError(error);
      const safeWarnings = controlledWarnings(warnings);
      const probe: MetaAdsMcpStoredProbe = {
        checkedAt,
        outcome: unauthorized ? "unauthorized" : "unreachable",
        latencyMs: Date.now() - startedAt,
        warnings: safeWarnings,
      };
      const evidence = buildEvidence({
        connectionId,
        checkedAt,
        expiresAt,
        neverExpires,
        scopes: scopeEvidence.scopes,
        authoritativeScope: scopeEvidence.authoritative,
        assetsChecked: false,
        probe,
      });
      const evaluatedReadiness = readinessForEvidence({
        evidence,
        selectedAdAccountId: params.selectedAdAccountId,
        now,
      });
      const readiness = unauthorized
        ? asProviderUnauthorized(evaluatedReadiness)
        : evaluatedReadiness;
      eventErrorCode = unauthorized
        ? "provider_unauthorized"
        : providerErrorCode(error);
      result = {
        kind: "connected_not_ready",
        evidence,
        readiness,
        warnings: safeWarnings,
      };
      return result;
    }
    if (mcpGraphUser.id !== introspectedUserId) {
      eventErrorCode = "identity_mismatch";
      result = {
        kind: "invalid_credentials",
        status: 400,
        error: "mcp_identity_mismatch",
      };
      return result;
    }

    if (expectedMcpUserId && expectedMcpUserId !== introspectedUserId) {
      const safeWarnings = controlledWarnings(warnings);
      const probe: MetaAdsMcpStoredProbe = {
        checkedAt,
        outcome: "unreachable",
        latencyMs: Date.now() - startedAt,
        warnings: safeWarnings,
      };
      const evidence = buildEvidence({
        connectionId,
        checkedAt,
        expiresAt,
        neverExpires,
        scopes: scopeEvidence.scopes,
        authoritativeScope: scopeEvidence.authoritative,
        assetsChecked: false,
        probe,
      });
      const readiness = readinessForEvidence({
        evidence,
        selectedAdAccountId: params.selectedAdAccountId,
        now,
      });
      eventErrorCode = "identity_unverified";
      result = {
        kind: "connected_not_ready",
        evidence,
        readiness,
        warnings: safeWarnings,
      };
      return result;
    }

    // This evidence must never come from OAuth fallbacks or an unverified user.
    // Missing lifetime metadata preserves Graph's last verified deadline.
    const validExpiryValue = (value: unknown) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      Number.isFinite(new Date(value * 1000).getTime());
    const expiryVerified =
      validExpiryValue(debugData.expires_at) &&
      (debugData.data_access_expires_at === undefined ||
        validExpiryValue(debugData.data_access_expires_at));
    const graphTokenEvidence: MetaAdsGraphTokenEvidence | undefined =
      Array.isArray(debugData.scopes) || expiryVerified
        ? {
            verifiedAt: checkedAt,
            ...(Array.isArray(debugData.scopes)
              ? { scope: scopeEvidence.scopes.join(" ") }
              : {}),
            ...(expiryVerified
              ? { expiresAt: expiresAt ?? null, neverExpires }
              : {}),
          }
        : undefined;

    if (
      expiresAtMs !== undefined &&
      expiresAtMs <= now.getTime() + META_ADS_MCP_EXPIRY_SKEW_MS
    ) {
      // Graph is valid until its actual deadline; MCP operations require enough
      // remaining time to finish safely. Save verified claims without calling MCP.
      const evidence = buildEvidence({
        connectionId,
        checkedAt,
        expiresAt,
        neverExpires,
        scopes: scopeEvidence.scopes,
        authoritativeScope: scopeEvidence.authoritative,
        user: mcpGraphUser,
        assetsChecked: false,
      });
      result = {
        kind: "connected_not_ready",
        evidence,
        readiness: readinessForEvidence({
          evidence,
          selectedAdAccountId: params.selectedAdAccountId,
          now,
        }),
        warnings: controlledWarnings(warnings),
        ...(graphTokenEvidence ? { graphTokenEvidence } : {}),
      };
      return result;
    }

    let accountFetchFailed = false;
    let accountAuthorizationFailed = false;
    const inventory = await fetchMetaAdsAdAccountInventory({
      accessToken,
      signal: params.signal,
      grantedScopes: scopeEvidence.scopes,
      selectedAdAccountId: params.selectedAdAccountId,
      onError: error => {
        accountFetchFailed = true;
        accountAuthorizationFailed ||=
          error.authorizationFailure === true ||
          error.status === 401 ||
          error.status === 403;
      },
    });
    params.signal?.throwIfAborted();
    if (inventory.truncated) warnings.add("account_inventory_truncated");
    if (
      inventory.selectedAccount &&
      !inventory.accounts.some(
        account => account.id === inventory.selectedAccount?.id
      )
    ) {
      warnings.add("selected_account_direct_only");
    }
    const selectedAccountAccessProven = Boolean(
      params.selectedAdAccountId &&
        inventory.selectedAccount &&
        inventory.selectedAccount.id.toLowerCase() ===
          params.selectedAdAccountId.trim().toLowerCase()
    );
    if (
      sourceGraphUserId &&
      sourceGraphUserId !== mcpGraphUser.id &&
      selectedAccountAccessProven
    ) {
      warnings.add("graph_user_mismatch");
    }
    if (accountAuthorizationFailed) {
      const safeWarnings = controlledWarnings(warnings);
      const probe: MetaAdsMcpStoredProbe = {
        checkedAt,
        outcome: "unauthorized",
        latencyMs: Date.now() - startedAt,
        warnings: safeWarnings,
      };
      const evidence = buildEvidence({
        connectionId,
        checkedAt,
        expiresAt,
        neverExpires,
        scopes: scopeEvidence.scopes,
        authoritativeScope: scopeEvidence.authoritative,
        user: mcpGraphUser,
        accountIds: inventory.accessibleAdAccountIds,
        accountsTruncated: inventory.truncated,
        selectedAccount: inventory.selectedAccount,
        assetsChecked: false,
        probe,
      });
      const readiness = asProviderUnauthorized(
        readinessForEvidence({
          evidence,
          selectedAdAccountId: params.selectedAdAccountId,
          now,
        })
      );
      eventErrorCode = "provider_unauthorized";
      result = {
        kind: "connected_not_ready",
        evidence,
        readiness,
        warnings: safeWarnings,
        ...(graphTokenEvidence ? { graphTokenEvidence } : {}),
      };
      return result;
    }

    let metadataContractBlocked = false;
    try {
      const metadata = await discoverProtectedResourceMetadata(params.signal);
      params.signal?.throwIfAborted();
      if (!metadata.resourceMatches) {
        warnings.add("provider_capability_drift");
        metadataContractBlocked = true;
      }
      const canonicalScopes = new Set<string>(META_ADS_MCP_KNOWN_SCOPES);
      if (
        metadata.advertisedScopes.some(scope => !canonicalScopes.has(scope))
      ) {
        warnings.add("scope_contract_added");
      }
      if (
        metadata.scopesAdvertised &&
        META_ADS_MCP_KNOWN_SCOPES.some(
          scope => !metadata.advertisedScopes.includes(scope)
        )
      ) {
        warnings.add("scope_contract_removed");
      }
    } catch {
      params.signal?.throwIfAborted();
      warnings.add("protected_resource_metadata_unavailable");
    }

    let outcome: ProbeOutcome = "success";
    let selectedAccountEnabled: boolean | undefined;
    let selectedAccountQueryable: boolean | undefined;
    session = createMetaAdsMcpSession(accessToken);
    try {
      await initializeMetaAdsMcpSession(session, { signal: params.signal });
      params.signal?.throwIfAborted();
      catalog = await listMetaAdsMcpTools(session, {
        cacheMode: "refresh",
        signal: params.signal,
      });
      params.signal?.throwIfAborted();
      if (catalog.protocol.era === "legacy") {
        warnings.add("provider_protocol_fallback");
      }
      if ((catalog.unsupportedTaskToolCount ?? 0) > 0) {
        warnings.add("provider_capability_drift");
      }
      const accountAccess = await readMetaAdsMcpAccountAccess({
        session,
        catalog,
        signal: params.signal,
        clientConversationId: createMetaAdsMcpConversationId(),
      });
      params.signal?.throwIfAborted();
      if (accountAccess.complete) accountInventory = accountAccess.inventory;
      if (!accountAccess.complete) {
        outcome = "unreachable";
        eventErrorCode = accountAccess.reason || "account_inventory_incomplete";
      } else if (params.selectedAdAccountId) {
        const eligibility = getMetaAdsMcpAccountEligibility({
          inventory: accountAccess.inventory,
          accountIds: [params.selectedAdAccountId],
        });
        if (eligibility.kind === "ready") {
          selectedAccountEnabled = true;
          const queryability = getMetaAdsMcpAccountEligibility({
            inventory: accountAccess.inventory,
            accountIds: [params.selectedAdAccountId],
            requireQueryable: true,
          });
          if (queryability.kind === "ready") selectedAccountQueryable = true;
          else if (queryability.code === "account_not_queryable")
            selectedAccountQueryable = false;
        } else if (eligibility.code === "account_not_enabled") {
          selectedAccountEnabled = false;
          warnings.add("account_not_enabled");
          eventErrorCode = eligibility.code;
        } else {
          outcome = "unreachable";
          eventErrorCode = eligibility.code;
        }
      }
    } catch (error) {
      params.signal?.throwIfAborted();
      outcome = providerOutcome(error);
      eventErrorCode = providerErrorCode(error);
      const requiredByChallenge = challengeScopes(error);
      if (
        requiredByChallenge.some(
          scope => !META_ADS_MCP_KNOWN_SCOPES.includes(scope as never)
        )
      ) {
        warnings.add("scope_challenge_added");
      }
    }
    if (metadataContractBlocked && outcome === "success") {
      outcome = "invalid_catalog";
      eventErrorCode = "scope_contract_drift";
    }

    const safeWarnings = controlledWarnings(warnings);
    const probe: MetaAdsMcpStoredProbe = {
      checkedAt,
      outcome,
      latencyMs: Date.now() - startedAt,
      ...(catalog ? { toolCount: catalog.tools.length } : {}),
      ...(catalog ? { catalogSha256: catalog.catalogSha256 } : {}),
      ...(catalog ? { protocolEra: catalog.protocol.era } : {}),
      ...(catalog ? { protocolVersion: catalog.protocol.protocolVersion } : {}),
      ...(catalog?.protocol.serverName
        ? { serverName: catalog.protocol.serverName }
        : {}),
      warnings: safeWarnings,
      ...(selectedAccountEnabled !== undefined
        ? { selectedAccountEnabled }
        : {}),
      ...(selectedAccountQueryable !== undefined
        ? { selectedAccountQueryable }
        : {}),
    };
    const evidence = buildEvidence({
      connectionId,
      checkedAt,
      expiresAt,
      neverExpires,
      scopes: scopeEvidence.scopes,
      authoritativeScope: scopeEvidence.authoritative,
      user: mcpGraphUser,
      accountIds: inventory.accessibleAdAccountIds,
      accountsTruncated: inventory.truncated,
      selectedAccount: inventory.selectedAccount,
      assetsChecked: !accountFetchFailed,
      probe,
    });
    const readiness = readinessForEvidence({
      evidence,
      selectedAdAccountId: params.selectedAdAccountId,
      now,
    });
    if (accountFetchFailed) eventErrorCode ||= "account_inventory_unavailable";
    sessionRetained = Boolean(
      params.retainSession &&
        session &&
        catalog &&
        outcome === "success" &&
        readiness.canRead
    );
    result = {
      kind: readiness.canRead ? "verified" : "connected_not_ready",
      evidence,
      readiness,
      ...(catalog ? { catalog } : {}),
      warnings: safeWarnings,
      ...(graphTokenEvidence ? { graphTokenEvidence } : {}),
      ...(sessionRetained && session && catalog
        ? {
            liveSession: {
              session,
              catalog,
              ...(accountInventory !== undefined ? { accountInventory } : {}),
            },
          }
        : {}),
    };
    return result;
  } finally {
    if (session && !sessionRetained) {
      await closeMetaAdsMcpSession(session);
    }
    const warningCount = controlledWarnings(warnings).length;

    if (result?.kind === "invalid_credentials") {
      event.add({
        readiness: "invalid_credentials",
        latencyMs: Date.now() - startedAt,
        warningCount,
      });
      event.finish("not_executed", eventErrorCode);
    } else if (result) {
      event.add({
        readiness: result.readiness.state,
        missingScopes: result.readiness.missingScopes,
        adAccountId: result.readiness.selectedAsset?.adAccountId,
        businessId: result.readiness.selectedAsset?.businessId,
        latencyMs: Date.now() - startedAt,
        warningCount,
        ...(result.catalog
          ? {
              protocolVersion: result.catalog.protocol.protocolVersion,
              serverName: result.catalog.protocol.serverName,
              serverVersion: result.catalog.protocol.serverVersion,
              toolCount: result.catalog.tools.length,
              catalogSha256: result.catalog.catalogSha256,
            }
          : {}),
      });
      event.finish(
        result.kind === "verified" ? "succeeded" : "failed",
        eventErrorCode ||
          (result.kind === "connected_not_ready"
            ? result.readiness.state
            : undefined)
      );
    } else {
      event.add({
        readiness: "provider_unreachable",
        latencyMs: Date.now() - startedAt,
        warningCount,
      });
      event.finish("failed", eventErrorCode || "probe_failed");
    }
  }
}
