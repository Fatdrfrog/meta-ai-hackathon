import "server-only";

import { createServerLogger } from "@/lib/observability/server-logs";

const metaAdsMcpOperationLogger = createServerLogger("meta-ads.mcp");
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_METADATA_LENGTH = 200;
const MAX_MISSING_SCOPES = 64;
const MAX_COUNT = 10_000_000;
const MAX_LATENCY_MS = 7 * 24 * 60 * 60 * 1_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type MetaAdsMcpSafeOperationFields = {
  mcpUserId?: string;
  adAccountId?: string;
  businessId?: string;
  toolName?: string;
  readiness?: string;
  missingScopes?: string[];
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  latencyMs?: number;
  toolCount?: number;
  resultCount?: number;
  creativeAssetCount?: number;
  argumentPathCount?: number;
  warningCount?: number;
  attemptCount?: number;
  retryCount?: number;
  finishReason?: string;
  httpStatus?: number;
  incomplete?: boolean;
  transactionDigest?: string;
  definitionSha256?: string;
  catalogSha256?: string;
  logicalArgumentsSha256?: string;
  effectiveArgumentsSha256?: string;
  lifecycleStage?: string;
  dispatched?: boolean;
  reconciliationActorId?: string;
  reconciledAt?: string;
};

type SafeOperationContext = Record<
  string,
  string | number | boolean | string[] | undefined
>;

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function requiredIdentifier(value: string, name: string): string {
  const bounded = boundedString(value, MAX_IDENTIFIER_LENGTH);
  if (!bounded) throw new Error(`${name} must be a bounded identifier`);
  return bounded;
}

function safeDigest(value: unknown): string | undefined {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value)
    ? value
    : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNT
    ? value
    : undefined;
}

function safeLatency(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_LATENCY_MS
    ? Math.round(value)
    : undefined;
}

function safeMissingScopes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = Array.from(
    new Set(
      value.flatMap(scope => {
        const bounded = boundedString(scope, 128);
        return bounded ? [bounded] : [];
      })
    )
  ).slice(0, MAX_MISSING_SCOPES);
  return scopes.length > 0 ? scopes : undefined;
}

function sanitizeSafeFields(
  fields: MetaAdsMcpSafeOperationFields
): SafeOperationContext {
  const candidates: SafeOperationContext = {
    mcpUserId: boundedString(fields.mcpUserId, MAX_IDENTIFIER_LENGTH),
    adAccountId: boundedString(fields.adAccountId, MAX_IDENTIFIER_LENGTH),
    businessId: boundedString(fields.businessId, MAX_IDENTIFIER_LENGTH),
    toolName: boundedString(fields.toolName, MAX_METADATA_LENGTH),
    readiness: boundedString(fields.readiness, 80),
    missingScopes: safeMissingScopes(fields.missingScopes),
    protocolVersion: boundedString(fields.protocolVersion, 80),
    serverName: boundedString(fields.serverName, MAX_METADATA_LENGTH),
    serverVersion: boundedString(fields.serverVersion, 80),
    latencyMs: safeLatency(fields.latencyMs),
    toolCount: safeCount(fields.toolCount),
    resultCount: safeCount(fields.resultCount),
    creativeAssetCount: safeCount(fields.creativeAssetCount),
    argumentPathCount: safeCount(fields.argumentPathCount),
    warningCount: safeCount(fields.warningCount),
    attemptCount: safeCount(fields.attemptCount),
    retryCount: safeCount(fields.retryCount),
    finishReason: [
      "STOP",
      "MAX_TOKENS",
      "SAFETY",
      "RECITATION",
      "OTHER",
    ].includes(fields.finishReason || "")
      ? fields.finishReason
      : undefined,
    httpStatus:
      typeof fields.httpStatus === "number" &&
      Number.isInteger(fields.httpStatus) &&
      fields.httpStatus >= 400 &&
      fields.httpStatus <= 599
        ? fields.httpStatus
        : undefined,
    incomplete:
      typeof fields.incomplete === "boolean" ? fields.incomplete : undefined,
    transactionDigest: safeDigest(fields.transactionDigest),
    definitionSha256: safeDigest(fields.definitionSha256),
    catalogSha256: safeDigest(fields.catalogSha256),
    logicalArgumentsSha256: safeDigest(fields.logicalArgumentsSha256),
    effectiveArgumentsSha256: safeDigest(fields.effectiveArgumentsSha256),
    lifecycleStage: boundedString(fields.lifecycleStage, 80),
    dispatched:
      typeof fields.dispatched === "boolean" ? fields.dispatched : undefined,
    reconciliationActorId: boundedString(
      fields.reconciliationActorId,
      MAX_IDENTIFIER_LENGTH
    ),
    reconciledAt: boundedString(fields.reconciledAt, 64),
  };
  return Object.fromEntries(
    Object.entries(candidates).filter(([, value]) => value !== undefined)
  );
}

export function createMetaAdsMcpOperationEvent(initial: {
  operationId: string;
  operation:
    | "catalog"
    | "turn"
    | "plan"
    | "summary"
    | "read"
    | "write"
    | "readiness_probe"
    | "reconciliation";
  workspaceId?: string;
  sourceId?: string;
  connectionId?: string;
  transactionDigest?: string;
}): {
  add(fields: MetaAdsMcpSafeOperationFields): void;
  finish(
    outcome: "succeeded" | "not_executed" | "outcome_unknown" | "failed",
    errorCode?: string
  ): void;
} {
  const startedAt = Date.now();
  const context: SafeOperationContext = {
    operationId: requiredIdentifier(initial.operationId, "operationId"),
    operation: initial.operation,
    workspaceId: boundedString(initial.workspaceId, MAX_IDENTIFIER_LENGTH),
    sourceId: boundedString(initial.sourceId, MAX_IDENTIFIER_LENGTH),
    connectionId: boundedString(initial.connectionId, MAX_IDENTIFIER_LENGTH),
    transactionDigest: safeDigest(initial.transactionDigest),
  };
  let finished = false;

  return {
    add(fields) {
      if (finished) return;
      Object.assign(context, sanitizeSafeFields(fields));
    },
    finish(outcome, errorCode) {
      if (finished) return;
      finished = true;
      const finalContext = {
        ...context,
        outcome,
        errorCode: boundedString(errorCode, 120),
        durationMs: safeLatency(Date.now() - startedAt),
      };
      if (outcome === "outcome_unknown" || outcome === "failed") {
        metaAdsMcpOperationLogger.warn("meta_ads_mcp_operation", finalContext);
        return;
      }
      metaAdsMcpOperationLogger.info("meta_ads_mcp_operation", finalContext);
    },
  };
}
