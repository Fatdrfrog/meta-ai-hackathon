import "server-only";

import type { AIChatLifecycleEvent } from "@/lib/ai";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import type { AiriLanguage } from "@/lib/airi/shared/language-policy";
import { parseAiriCreativeAssetUri } from "@/lib/airi-chats/creative-asset-refs";
import { listAiriMetaAdsMcpPendingTransactions } from "@/lib/airi-chats/meta-ads-mcp-confirmation-store";
import type { createClient } from "@/lib/supabase/server";
import type {
  MetaAdsAdAccount,
  MetaAdsMcpReadiness,
} from "@icecore/shared/types/sources";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import {
  MetaAdsMcpClientError,
  MetaAdsMcpToolResultError,
  type MetaAdsMcpTool,
} from "./client";
import type { resolveWorkspaceMetaAdsMcpAccessToken } from "./readiness-service";
import { getMetaAdsMcpAccountIds } from "./preconditions";
import type { MetaAdsMcpCoverage } from "./result-ledger";
import {
  isMetaAdsMcpTransactionExpired,
  META_ADS_MCP_TRANSACTION_TTL_MS,
  type MetaAdsMcpTransactionV2,
} from "./confirmation-contract";
import { sha256CanonicalJson } from "./confirmation-contract.server";

/**
 * Turn helpers of the native Claude tool-use turn (native-turn.ts) and the
 * confirmed-write path (agent-loop.ts).
 */

export const MAX_GROUNDING_SECTION_CHARS = 6_000;
export const EXISTING_PENDING_WRITE_NOTICE =
  "An identical change is already waiting for your review in an earlier message, so it was not prepared again. Use **Review changes** on that card.";
export const NO_LIVE_DATA_NOTICE =
  "\n\n_Answered without live Meta Ads data: Airi did not read your ad account for this reply._";
/** An earlier card replaces a new one only while it has this long left to confirm. */
export const PENDING_DUPLICATE_MIN_VALIDITY_MS = 10 * 60 * 1_000;
/** Query-level blocks a different read can fix; account availability blocks cannot. */
export const CORRECTABLE_PRECONDITION_CODES = new Set([
  "invalid_entity_query",
  "noncanonical_field",
  "unsupported_field",
  "field_metadata_unavailable",
  "unsupported_field_level",
  "field_not_filterable",
  "unsupported_filter_operator",
  "field_not_sortable",
]);
/** Account availability, then field metadata, before one planned call. */
export const MAX_PREREQUISITE_READS = 2;
export const FIELD_CONTEXT_TOOL = "ads_get_field_context";
export const FIELD_CONTEXT_CACHE_TTL_SECONDS = 30 * 60;
/** A slow cache must cost less than the provider read it would save. */
export const FIELD_CONTEXT_CACHE_READ_MS = 250;
export const MAX_CACHED_FIELD_CONTEXT_CHARS = 64_000;

export type MetaAdsMcpPendingMutation = MetaAdsMcpTransactionV2;

export type MetaAdsMcpTurnResult = {
  content: string;
  pendingMutations: MetaAdsMcpPendingMutation[];
  coverage?: MetaAdsMcpCoverage;
  clientConversationId?: string;
  failureCode?: string;
  toolTrace: Array<{
    name: string;
    sideEffect: "read" | "write";
    status: "executed" | "pending_confirmation" | "error";
    detail?: string;
  }>;
};

export type MetaAdsMcpTurnParams = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  workspaceId: string;
  userMessage: string;
  groundingContext?: MetaAdsMcpGroundingContext;
  creativeAssetIds?: string[];
  emitProgress?: ProgressEmit;
  onLifecycle?: (event: AIChatLifecycleEvent) => void | Promise<void>;
  signal?: AbortSignal;
  clientConversationId?: string;
  /**
   * The Airi thread this turn answers in. Pending-write dedupe only looks at
   * cards in this thread (the only ones the requester is sure to see); without
   * it every write gets its own card.
   */
  threadId?: string;
  /** Airi thread/message ids for per-call LLM cost events. */
  analytics?: { conversationId?: string | null; messageId?: string | null };
  loadBusinessEvidence?: (input: {
    selectedAdAccount: MetaAdsAdAccount;
    sourceId: string;
    signal: AbortSignal;
  }) => Promise<string>;
  /**
   * Streams the answer as it is written: the full text so far, never an
   * increment. A later model step restarts it with a shorter text, and the
   * returned content replaces it. Native tool use only.
   */
  onTextDelta?: (text: string) => void | Promise<void>;
  /**
   * Workspace Airi language for server-owned notices (the Claude-required
   * failure). Defaults to the script of the user message.
   */
  language?: AiriLanguage;
};

export type MetaAdsMcpGroundingContext = {
  threadHistory?: string | null;
  attachedSources?: string | null;
  attachedFiles?: string | null;
  workspaceKnowledge?: string | null;
  customerContext?: string | null;
};

export type ProgressEmit = (event: {
  type: "stage";
  id: string;
  label: string;
  status: "running" | "complete" | "error";
  detail?: string | null;
  at: string;
}) => void | Promise<void>;

export function nowIso() {
  return new Date().toISOString();
}

export function truncateGroundingSection(
  value: string | null | undefined
): string {
  const text = String(value || "").trim();
  if (!text) return "none";
  return text.length > MAX_GROUNDING_SECTION_CHARS
    ? `${text.slice(0, MAX_GROUNDING_SECTION_CHARS)}...`
    : text;
}

export function buildMetaAdsMcpGroundingPrompt(params: {
  context?: MetaAdsMcpGroundingContext;
  creativeAssetContext: string;
}): string {
  return [
    "THREAD HISTORY:",
    truncateGroundingSection(params.context?.threadHistory),
    "",
    "USER-ATTACHED SOURCES:",
    truncateGroundingSection(params.context?.attachedSources),
    "",
    "USER-ATTACHED FILES:",
    truncateGroundingSection(params.context?.attachedFiles),
    "",
    "WORKSPACE KNOWLEDGE:",
    truncateGroundingSection(params.context?.workspaceKnowledge),
    "",
    "RECENT CUSTOMER CONTEXT:",
    truncateGroundingSection(params.context?.customerContext),
    "",
    params.creativeAssetContext,
  ].join("\n");
}

export function boundedCredentialString(
  credentials: Record<string, unknown> | null,
  key: string,
  maxLength = 256
): string | undefined {
  const value = credentials?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

export function readinessGuidance(readiness: MetaAdsMcpReadiness): string {
  if (readiness.state === "not_connected") {
    return "Connect Meta Ads and enable Ads MCP, then try again.";
  }
  if (
    readiness.state === "asset_unavailable" &&
    readiness.provider?.selectedAccountEnabled === false
  ) {
    return "Meta has not made Ads MCP available for this ad account yet. Access is being rolled out by Meta; check again later. Your Meta Ads connection does not need to be reconnected for this restriction.";
  }
  if (readiness.state === "asset_unavailable") {
    return "Select an accessible ad account in Integrations, then choose Check again before retrying.";
  }
  if (
    readiness.state === "stale" ||
    readiness.state === "checking" ||
    readiness.state === "provider_unreachable" ||
    readiness.state === "invalid_catalog"
  ) {
    return "Meta Ads could not be checked right now. Please retry shortly; Airi checks the connection automatically.";
  }
  return "Reconnect Ads MCP in Integrations, complete the readiness check, then retry.";
}

/**
 * The stored readiness probe verified Ads MCP availability for the selected
 * account (switching accounts clears that evidence). Only a positive result
 * seeds the account precondition; anything else still runs the live check.
 */
export function readinessAccountSeed(
  readiness: MetaAdsMcpReadiness
): Record<string, unknown> | undefined {
  const adAccountId = readiness.selectedAsset?.adAccountId;
  const provider = readiness.provider;
  if (!adAccountId || provider?.selectedAccountEnabled !== true)
    return undefined;
  return {
    ad_accounts: [
      {
        ad_account_id: adAccountId.replace(/^act_/, ""),
        is_ads_mcp_enabled: true,
        ...(typeof provider.selectedAccountQueryable === "boolean"
          ? { is_queryable: provider.selectedAccountQueryable }
          : {}),
      },
    ],
  };
}

/**
 * Field metadata is provider schema, not account data. Reusing a recent
 * lookup for the same connection and tool definition saves a provider read
 * on follow-up turns; the precondition still validates every field use.
 */
export function fieldContextCacheKey(params: {
  auth: Awaited<ReturnType<typeof resolveWorkspaceMetaAdsMcpAccessToken>>;
  tool: MetaAdsMcpTool;
  args: Record<string, unknown>;
}): string | null {
  const connectionId = boundedCredentialString(
    params.auth.credentials,
    "mcp_connection_id"
  );
  if (
    params.tool.name !== FIELD_CONTEXT_TOOL ||
    !params.auth.sourceId ||
    !connectionId
  )
    return null;
  const queryArgs = Object.fromEntries(
    Object.entries(params.args).filter(
      ([key]) => !["client_conversation_id", "advertiser_request"].includes(key)
    )
  );
  return buildCacheKey("meta_ads_mcp_field_context", [
    params.auth.sourceId,
    connectionId,
    params.tool.definitionSha256,
    sha256CanonicalJson(queryArgs),
  ]);
}

/**
 * Bounded cache lookup: a timeout, cache error or abort is a miss. The caller
 * re-checks its own signal, so a user cancel still ends the turn.
 */
export async function readCachedFieldContext(
  key: string,
  signal: AbortSignal
): Promise<unknown> {
  try {
    return (
      (await awaitWithCancellation(
        cache.get<unknown>(key),
        AbortSignal.any([
          signal,
          AbortSignal.timeout(FIELD_CONTEXT_CACHE_READ_MS),
        ])
      )) ?? null
    );
  } catch {
    return null;
  }
}

export function writeCachedFieldContext(key: string, result: unknown) {
  let chars: number;
  try {
    chars = JSON.stringify(result)?.length ?? Infinity;
  } catch {
    return;
  }
  if (chars > MAX_CACHED_FIELD_CONTEXT_CHARS) return;
  void cache
    .set(key, result, FIELD_CONTEXT_CACHE_TTL_SECONDS)
    .catch(() => undefined);
}

export function operationErrorCode(error: unknown): string {
  if (error instanceof MetaAdsMcpClientError) return error.code;
  if (error instanceof MetaAdsMcpToolResultError) return "tool_result_error";
  return "operation_failed";
}

export function collectCreativeAssetIds(
  value: unknown,
  output = new Set<string>()
): Set<string> {
  if (typeof value === "string") {
    const id = parseAiriCreativeAssetUri(value);
    if (id) output.add(id);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCreativeAssetIds(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectCreativeAssetIds(item, output);
  }
  return output;
}

export function transactionTarget(params: {
  auth: Awaited<ReturnType<typeof resolveWorkspaceMetaAdsMcpAccessToken>>;
}): MetaAdsMcpTransactionV2["target"] | null {
  const { auth } = params;
  const identity = auth.readiness.identity;
  const asset = auth.readiness.selectedAsset;
  const selected = auth.selectedAdAccount;
  const connectionId = boundedCredentialString(
    auth.credentials,
    "mcp_connection_id"
  );
  if (
    !auth.sourceId ||
    !auth.readiness.canWrite ||
    !identity?.id ||
    !asset?.adAccountId ||
    !asset.currency ||
    !selected ||
    !connectionId
  ) {
    return null;
  }
  return {
    sourceId: auth.sourceId,
    connectionId,
    mcpUserId: identity.id,
    ...(identity.name ? { mcpUserName: identity.name } : {}),
    adAccountId: asset.adAccountId,
    ...(selected.name ? { adAccountName: selected.name } : {}),
    ...(asset.businessId ? { businessId: asset.businessId } : {}),
    ...(asset.businessName ? { businessName: asset.businessName } : {}),
    currency: asset.currency,
    ...(asset.timezone ? { timezone: asset.timezone } : {}),
  };
}

export function exactTargetStillMatches(params: {
  transaction: MetaAdsMcpTransactionV2;
  auth: Awaited<ReturnType<typeof resolveWorkspaceMetaAdsMcpAccessToken>>;
}): boolean {
  const current = transactionTarget({ auth: params.auth });
  if (!current) return false;
  return (
    params.transaction.target.sourceId === current.sourceId &&
    params.transaction.target.connectionId === current.connectionId &&
    params.transaction.target.mcpUserId === current.mcpUserId &&
    params.transaction.target.mcpUserName === current.mcpUserName &&
    params.transaction.target.adAccountId === current.adAccountId &&
    params.transaction.target.adAccountName === current.adAccountName &&
    params.transaction.target.businessId === current.businessId &&
    params.transaction.target.businessName === current.businessName &&
    params.transaction.target.currency === current.currency &&
    params.transaction.target.timezone === current.timezone
  );
}

/** Same operation on the same target, ignoring server-owned telemetry fields. */
export function pendingWriteKey(
  toolName: string,
  args: Record<string, unknown>,
  target: Pick<
    MetaAdsMcpTransactionV2["target"],
    "sourceId" | "connectionId" | "adAccountId"
  >
): string {
  return sha256CanonicalJson({
    tool: toolName,
    target: {
      sourceId: target.sourceId,
      connectionId: target.connectionId,
      adAccountId: target.adAccountId,
    },
    arguments: Object.fromEntries(
      Object.entries(args).filter(
        ([key]) =>
          !["client_conversation_id", "advertiser_request"].includes(key)
      )
    ),
  });
}

/** A failed read that the single correction re-plan may replace. */
export type CorrectionTarget = {
  key: string;
  toolName: string;
  args: Record<string, unknown>;
};

export function accountScope(args: Record<string, unknown>): string {
  const ids = (getMetaAdsMcpAccountIds(args) ?? []).map(id =>
    id.replace(/^act_/, "")
  );
  return Array.from(new Set(ids)).sort().join(",");
}

/**
 * Removes and returns the key of the failed read that a successful corrected
 * read replaces: the same tool on the same accounts, preferring the target
 * whose other arguments it keeps. One read replaces one failure; a corrected
 * read of anything else replaces none.
 */
export function takeCorrectedTarget(
  targets: CorrectionTarget[],
  toolName: string,
  args: Record<string, unknown>
): string | undefined {
  const scope = accountScope(args);
  let best = -1;
  let bestShared = -1;
  targets.forEach((target, index) => {
    if (target.toolName !== toolName || accountScope(target.args) !== scope)
      return;
    const shared = Object.entries(target.args).filter(
      ([key, value]) =>
        key in args &&
        sha256CanonicalJson(value) === sha256CanonicalJson(args[key])
    ).length;
    if (shared > bestShared) {
      best = index;
      bestShared = shared;
    }
  });
  return best < 0 ? undefined : targets.splice(best, 1)[0]!.key;
}

export function creativeDisclosureFacts(
  references: Array<{ id: string; kind: string; name: string }>
): Array<{ id: string; kind: string; name: string }> {
  return references
    .map(reference => ({
      id: reference.id,
      kind: reference.kind,
      name: reference.name,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * An earlier message in this thread already holds the same change for
 * review, and that card can still be confirmed: it stays valid for a
 * while longer and was prepared against the current tool contract and
 * the exact current target (the checks confirmation re-runs). Cards in
 * other threads are ignored because the requester may not be able to
 * open them. A failed lookup never blocks a new proposal; each write
 * still requires its own explicit confirmation.
 */
export async function hasPendingMetaAdsMcpDuplicate(params: {
  workspaceId: string;
  threadId?: string;
  tool: MetaAdsMcpTool;
  args: Record<string, unknown>;
  target: MetaAdsMcpTransactionV2["target"];
  catalogSha256: string;
  auth: Awaited<ReturnType<typeof resolveWorkspaceMetaAdsMcpAccessToken>>;
  /** Bounds the lookup; its expiry is a miss. */
  lookupSignal: AbortSignal;
  /** The turn itself; its cancellation still ends the turn. */
  turnSignal: AbortSignal;
}): Promise<boolean> {
  const { threadId, tool, args, target, auth } = params;
  if (!threadId) return false;
  try {
    const nowMs = Date.now();
    const pending = await awaitWithCancellation(
      listAiriMetaAdsMcpPendingTransactions({
        workspaceId: params.workspaceId,
        threadId,
        toolName: tool.name,
        connectionId: target.connectionId,
        adAccountId: target.adAccountId,
        preparedAfter: new Date(
          nowMs -
            META_ADS_MCP_TRANSACTION_TTL_MS +
            PENDING_DUPLICATE_MIN_VALIDITY_MS
        ).toISOString(),
      }),
      params.lookupSignal
    );
    const key = pendingWriteKey(tool.name, args, target);
    return pending.some(
      ({ threadId: pendingThreadId, transaction }) =>
        pendingThreadId === threadId &&
        !isMetaAdsMcpTransactionExpired(transaction, nowMs) &&
        !isMetaAdsMcpTransactionExpired(
          transaction,
          nowMs + PENDING_DUPLICATE_MIN_VALIDITY_MS
        ) &&
        transaction.tool.definitionSha256 === tool.definitionSha256 &&
        transaction.tool.catalogSha256 === params.catalogSha256 &&
        exactTargetStillMatches({ transaction, auth }) &&
        pendingWriteKey(
          transaction.tool.name,
          transaction.logicalArguments,
          transaction.target
        ) === key
    );
  } catch {
    params.turnSignal.throwIfAborted();
    return false;
  }
}

/**
 * The banner for a report whose coverage is not complete. Summary-only
 * failures say the data is shown but the written report is missing.
 */
export function metaAdsMcpPartialNotice(c: MetaAdsMcpCoverage): string {
  if (
    !c.pendingPages &&
    !c.pendingContinuations &&
    c.reasons.length &&
    c.reasons.every(reason => reason.startsWith("summary_"))
  )
    return "\n\n**Summary unavailable:** The retrieved data is shown above, but Airi could not finish the written report. Retry the report.";
  return c.complete
    ? ""
    : `\n\n**Partial report:** ${c.pendingPages ? `${c.pendingPages} page(s) remain. ` : ""}${c.pendingContinuations ? `${c.pendingContinuations} follow-up check(s) remain. ` : ""}I could not verify the full requested coverage. Retry or choose a smaller date range.`;
}
