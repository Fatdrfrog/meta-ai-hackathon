import type {
  ScenarioApiErrorPayload,
  ScenarioDetailApiResponse,
  ScenarioDetailResponseWarning,
  ScenarioDocumentDTO,
  ScenarioDocumentListMetadata,
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge,
} from "@icecore/scenario-contracts";
import {
  DEFAULT_SCENARIO_VIEWPORT,
  isScenarioEntryPolicy,
  isScenarioMatchingRole,
  isScenarioMode,
  isScenarioStatus,
  isScenarioViewport,
  normalizeScenarioEntryPolicy,
  readScenarioGraphEnvelope,
} from "@icecore/scenario-contracts";
import {
  asNullableRecord as asRecord,
  readUniqueStringArray,
  readArray,
} from "@icecore/shared/lib/value-utils";

export const NO_STORE_OPTIONS: RequestInit = { cache: "no-store" };
export const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const MAX_SCENARIO_ERROR_NODE_IDS = 100;

function normalizeScenarioErrorNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.flatMap(item => {
        if (typeof item !== "string") return [];
        const nodeId = item.trim();
        return nodeId && nodeId === item ? [nodeId] : [];
      })
    )
  ).slice(0, MAX_SCENARIO_ERROR_NODE_IDS);
}

export class ScenarioRequestError extends Error {
  status: number;
  code: string | null;
  codes: string[];
  /** Blocks the server named as the cause, so the editor can reveal them. */
  nodeIds: string[];

  constructor(params: {
    message: string;
    status: number;
    code?: string | null;
    codes?: string[] | null;
    nodeIds?: string[] | null;
  }) {
    super(params.message);
    this.name = "ScenarioRequestError";
    this.status = params.status;
    this.code = params.code?.trim() || null;
    this.codes = Array.from(
      new Set((params.codes || []).map(code => code.trim()).filter(Boolean))
    );
    this.nodeIds = normalizeScenarioErrorNodeIds(params.nodeIds);
  }
}

export async function readResponseJson(response: Response): Promise<unknown> {
  return (await response.json().catch(() => null)) as unknown;
}

export function errorMessageOrFallback(
  data: unknown,
  fallback: string
): string {
  const msg = (data as { error?: string } | null)?.error;
  return (typeof msg === "string" && msg.trim()) || fallback;
}

export const asArray = readArray;

export async function fetchListIfOk<T>(
  url: string,
  listKey: "options" | "items"
): Promise<T[]> {
  return (await fetchListResult<T>(url, listKey)).items;
}

/** Like fetchListIfOk, but tells an empty list apart from a failed one. */
export async function fetchListResult<T>(
  url: string,
  listKey: "options" | "items"
): Promise<{ ok: boolean; items: T[] }> {
  const response = await fetch(url, NO_STORE_OPTIONS);
  if (!response.ok) return { ok: false, items: [] };
  const data = (await readResponseJson(response)) as Record<
    string,
    unknown
  > | null;
  return { ok: true, items: asArray<T>(data?.[listKey]) };
}

export function sortByLocale2<T>(
  items: T[],
  a: (x: T) => string,
  b: (x: T) => string
) {
  return items.sort((x, y) => {
    const p = a(x).localeCompare(a(y));
    if (p !== 0) return p;
    return b(x).localeCompare(b(y));
  });
}

function normalizeScenarioErrorPayload(
  value: unknown
): ScenarioApiErrorPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    error: typeof raw.error === "string" ? raw.error : undefined,
    code: typeof raw.code === "string" ? raw.code : undefined,
    codes: Array.isArray(raw.codes)
      ? raw.codes.filter((code): code is string => typeof code === "string")
      : undefined,
    nodeIds: normalizeScenarioErrorNodeIds(raw.nodeIds),
    currentUpdatedAt:
      typeof raw.currentUpdatedAt === "string"
        ? raw.currentUpdatedAt
        : undefined,
  };
}

export async function parseScenarioResponseError(
  response: Response,
  fallbackMessage: string
): Promise<never> {
  const payload = normalizeScenarioErrorPayload(
    await readResponseJson(response)
  );
  const codes = payload?.codes ?? [];
  const primaryCode =
    (payload?.code && payload.code.trim()) || codes[0]?.trim() || null;

  throw new ScenarioRequestError({
    message: payload?.error?.trim() || fallbackMessage,
    status: response.status,
    code: primaryCode,
    codes,
    nodeIds: payload?.nodeIds ?? [],
  });
}

function readScenarioDocument(
  value: unknown
): ScenarioDocumentDTO<ScenarioRawGraphNode, ScenarioRawGraphEdge> {
  const raw = asRecord(value);
  const graph = readScenarioGraphEnvelope(raw);
  if (
    !raw ||
    !graph ||
    typeof raw._id !== "string" ||
    !raw._id.trim() ||
    typeof raw.name !== "string" ||
    (raw.description !== undefined && typeof raw.description !== "string") ||
    (raw.status !== undefined && !isScenarioStatus(raw.status)) ||
    (raw.mode !== undefined && !isScenarioMode(raw.mode)) ||
    (raw.matchingRole !== undefined &&
      !isScenarioMatchingRole(raw.matchingRole)) ||
    (raw.entryPolicy !== undefined &&
      !isScenarioEntryPolicy(raw.entryPolicy)) ||
    (raw.graphSchemaVersion !== undefined &&
      (typeof raw.graphSchemaVersion !== "number" ||
        !Number.isInteger(raw.graphSchemaVersion) ||
        raw.graphSchemaVersion < 0)) ||
    (raw.viewport !== undefined && !isScenarioViewport(raw.viewport))
  ) {
    throw new Error("Invalid scenario payload");
  }

  // Ancillary server metadata retains its existing DTO contract. Graph fields
  // remain raw until the editor's migration/projection boundary.
  const metadata = raw as unknown as ScenarioDocumentListMetadata &
    Pick<ScenarioDocumentDTO, "bulkFollowUpSettings">;
  return {
    ...metadata,
    ...graph,
    _id: raw._id,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    status: isScenarioStatus(raw.status) ? raw.status : "draft",
    entryPolicy: normalizeScenarioEntryPolicy(raw.entryPolicy),
    graphSchemaVersion:
      typeof raw.graphSchemaVersion === "number" ? raw.graphSchemaVersion : 0,
    viewport: isScenarioViewport(raw.viewport)
      ? raw.viewport
      : { ...DEFAULT_SCENARIO_VIEWPORT },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

function normalizeScenarioDetailWarning(
  value: unknown
): ScenarioDetailResponseWarning[] {
  if (!value || typeof value !== "object") return [];
  const warning = value as Record<string, unknown>;
  const message =
    typeof warning.message === "string" ? warning.message.trim() : "";
  if (!message) return [];

  if (
    warning.code === "legacy_action_routing_timer_replan_failed" ||
    warning.code === "legacy_action_routing_session_cleanup_failed"
  ) {
    const recoveryStatus =
      warning.recoveryStatus === "pending" ||
      warning.recoveryStatus === "failed"
        ? warning.recoveryStatus
        : undefined;
    return [
      {
        code: warning.code,
        message,
        affectedConversationIds: readUniqueStringArray(
          warning.affectedConversationIds
        ),
        ...(recoveryStatus ? { recoveryStatus } : {}),
        ...(typeof warning.retryable === "boolean"
          ? { retryable: warning.retryable }
          : {}),
      },
    ];
  }
  if (warning.code === "scenario_detail_enrichment_failed") {
    return [
      {
        code: warning.code,
        message,
      },
    ];
  }
  if (warning.code === "linked_condition_reconciliation_pending") {
    return [
      {
        code: warning.code,
        message,
        affectedScenarioIds: readUniqueStringArray(warning.affectedScenarioIds),
      },
    ];
  }
  return [];
}

export async function readScenarioDetailOrThrow(
  response: Response,
  errorFallback: string
): Promise<
  ScenarioDetailApiResponse<ScenarioRawGraphNode, ScenarioRawGraphEdge>
> {
  if (!response.ok) {
    await parseScenarioResponseError(response, errorFallback);
  }
  return readScenarioDetailPayload(await readResponseJson(response));
}

/**
 * Checks a scenario detail body, from the API or read while the page
 * rendered, the same way before the editor projects it.
 */
export function readScenarioDetailPayload(
  value: unknown
): ScenarioDetailApiResponse<ScenarioRawGraphNode, ScenarioRawGraphEdge> {
  const payload = asRecord(value);
  if (!payload?.scenario) {
    throw new Error("Scenario payload missing");
  }
  const scenario = readScenarioDocument(payload.scenario);
  const metadata = asRecord(payload.metadata);
  const rawParentCounts =
    asRecord(metadata?.linkedConditionParentCountByNodeId) ?? {};
  const linkedConditionParentCountByNodeId = Object.fromEntries(
    Object.entries(rawParentCounts).flatMap(([nodeId, count]) =>
      nodeId && typeof count === "number" && Number.isFinite(count)
        ? [[nodeId, Math.max(0, Math.trunc(count))]]
        : []
    )
  );
  const warnings = Array.isArray(metadata?.warnings)
    ? metadata.warnings.flatMap(normalizeScenarioDetailWarning)
    : [];

  return {
    scenario,
    metadata: {
      linkedConditionParentCountByNodeId,
      ...(warnings.length > 0 ? { warnings } : {}),
      // Media still holds durable refs; asking again returns signed URLs.
      ...(metadata?.mediaDisplayUrlsPending === true
        ? { mediaDisplayUrlsPending: true }
        : {}),
    },
  };
}

export async function readScenarioDocumentOrThrow(
  response: Response,
  errorFallback: string
): Promise<ScenarioDocumentDTO<ScenarioRawGraphNode, ScenarioRawGraphEdge>> {
  return (await readScenarioDetailOrThrow(response, errorFallback)).scenario;
}
