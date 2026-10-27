import type {
  ScenarioDetailApiResponse,
  ScenarioDocumentDTO,
  ScenarioEntryPolicy,
  ScenarioGraphEdge,
  ScenarioCanvasNode,
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge,
  ScenarioListApiResponse,
  ScenarioMatchingRole,
  ScenarioMode,
  ScenarioPreviewResult,
  ScenarioStatus,
  ScenarioSummaryDTO,
  ScenarioApiFullUpdateBody,
  ScenarioApiPersistBody,
} from "@icecore/scenario-contracts";
import type { ScenarioTriggerLogEntry } from "@/lib/scenarios/trigger-log-meta";
import { stripScenarioEditorGraphNodes } from "@/lib/scenarios/strip-editor-fields";
import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  type ScenarioActionRoutingPatch,
  type ScenarioMessageIngressEventKind,
} from "@icecore/scenario-contracts";
import {
  asArray,
  JSON_HEADERS,
  NO_STORE_OPTIONS,
  parseScenarioResponseError,
  readResponseJson,
  readScenarioDetailOrThrow,
  readScenarioDocumentOrThrow,
} from "./http";
import {
  noteConfirmedScenarioRevision,
  trackScenarioWrite,
} from "./scenario-revision-tracker";

type ScenarioCreateInput = ScenarioApiPersistBody<
  ScenarioCanvasNode,
  ScenarioGraphEdge
>;

type ScenarioUpdateInput = ScenarioApiFullUpdateBody<
  ScenarioCanvasNode,
  ScenarioGraphEdge
> & {
  scenarioId: string;
};

export type ScenarioSidebarPatch = Partial<
  Pick<
    ScenarioApiPersistBody,
    "name" | "status" | "priority" | "matchingRole" | "entryPolicy"
  >
>;

export async function fetchScenarios(
  workspaceId: string,
  mode?: ScenarioMode,
  options?: { limit?: number; cursor?: string }
): Promise<ScenarioSummaryDTO[]> {
  const pageSize =
    typeof options?.limit === "number" ? Math.max(1, options.limit) : 200;

  const allItems: ScenarioSummaryDTO[] = [];
  let nextCursor: string | undefined = options?.cursor;
  let hasMore = true;

  while (hasMore) {
    const query = new URLSearchParams({ workspaceId });
    if (mode) query.set("mode", mode);
    query.set("limit", String(pageSize));
    if (nextCursor) {
      query.set("cursor", nextCursor);
    }

    const response = await fetch(
      `/api/scenarios?${query.toString()}`,
      NO_STORE_OPTIONS
    );

    if (!response.ok) {
      throw new Error("Failed to load scenarios");
    }

    const data = (await readResponseJson(response)) as
      | (Partial<ScenarioListApiResponse> & {
          scenarios?: ScenarioSummaryDTO[];
        })
      | null;
    const pageItems =
      asArray<ScenarioSummaryDTO>(data?.items).length > 0 ||
      data?.hasMore !== undefined
        ? asArray<ScenarioSummaryDTO>(data?.items)
        : asArray<ScenarioSummaryDTO>(data?.scenarios);

    allItems.push(...pageItems);

    hasMore = Boolean(data?.hasMore);
    nextCursor =
      typeof data?.nextCursor === "string" ? data.nextCursor : undefined;

    if (!hasMore) break;
    if (!nextCursor) break;
  }

  return allItems;
}

export async function fetchScenarioById(params: {
  scenarioId: string;
  workspaceId: string;
  signal?: AbortSignal;
  /**
   * "deferred" answers without waiting long for media signing. Media not
   * signed in time keeps its durable ref and the response metadata sets
   * mediaDisplayUrlsPending; asking again shortly returns it signed.
   */
  mediaSigning?: "deferred";
}): Promise<ScenarioDetailApiResponse<
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge
> | null> {
  const mediaSigning = params.mediaSigning ? "&mediaSigning=deferred" : "";
  const response = await fetch(
    `/api/scenarios/${params.scenarioId}?workspaceId=${params.workspaceId}${mediaSigning}`,
    {
      ...NO_STORE_OPTIONS,
      signal: params.signal,
    }
  );

  if (!response.ok) {
    throw new Error("Failed to load scenario");
  }

  return readScenarioDetailOrThrow(response, "Failed to load scenario");
}

export async function createScenarioRequest(
  input: ScenarioCreateInput
): Promise<ScenarioDocumentDTO<ScenarioRawGraphNode, ScenarioRawGraphEdge>> {
  const response = await trackScenarioWrite(
    fetch("/api/scenarios", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...input,
        nodes: stripScenarioEditorGraphNodes(input.nodes),
        entryPolicy: input.entryPolicy ?? DEFAULT_SCENARIO_ENTRY_POLICY,
      }),
    })
  );

  return readConfirmedScenarioDocument(response, "Failed to create scenario");
}

async function readConfirmedScenarioDocument(
  response: Response,
  errorFallback: string
): Promise<ScenarioDocumentDTO<ScenarioRawGraphNode, ScenarioRawGraphEdge>> {
  const scenario = await readScenarioDocumentOrThrow(response, errorFallback);
  noteConfirmedScenarioRevision(scenario._id, scenario.updatedAt);
  return scenario;
}

export async function updateScenarioRequest(
  input: ScenarioUpdateInput
): Promise<ScenarioDocumentDTO<ScenarioRawGraphNode, ScenarioRawGraphEdge>> {
  const response = await trackScenarioWrite(
    fetch(`/api/scenarios/${input.scenarioId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        expectedUpdatedAt: input.expectedUpdatedAt ?? null,
        name: input.name,
        description: input.description,
        status: input.status,
        mode: input.mode,
        timezone: input.timezone,
        priority: input.priority,
        presetId: input.presetId ?? null,
        presetVersion: input.presetVersion ?? null,
        segmentKey: input.segmentKey ?? null,
        matchingRole: input.matchingRole ?? "default",
        entryPolicy: input.entryPolicy ?? DEFAULT_SCENARIO_ENTRY_POLICY,
        nodes: stripScenarioEditorGraphNodes(input.nodes),
        edges: input.edges,
        viewport: input.viewport,
      }),
    })
  );

  return readConfirmedScenarioDocument(response, "Failed to save scenario");
}

export async function convertLegacyActionRoutingRequest(
  input: {
    scenarioId: string;
    workspaceId: string;
    expectedUpdatedAt: string;
    sourceActionNodeId: string;
    sourceNodeId: string;
    sourceKind: "post_action_condition" | "audience_filter";
  } & ScenarioActionRoutingPatch
): Promise<
  ScenarioDetailApiResponse<ScenarioRawGraphNode, ScenarioRawGraphEdge>
> {
  const response = await trackScenarioWrite(
    fetch(`/api/scenarios/${input.scenarioId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        operation: "convert_legacy_action_routing",
        workspaceId: input.workspaceId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        sourceActionNodeId: input.sourceActionNodeId,
        sourceNodeId: input.sourceNodeId,
        sourceKind: input.sourceKind,
        actionOutcomes: input.actionOutcomes,
        actionRunConditions: input.actionRunConditions,
      }),
    })
  );

  const detail = await readScenarioDetailOrThrow(
    response,
    "Failed to convert legacy scenario routing"
  );
  noteConfirmedScenarioRevision(detail.scenario._id, detail.scenario.updatedAt);
  return detail;
}

export async function retryScenarioTimerReplanRecoveryRequest(params: {
  scenarioId: string;
  workspaceId: string;
}): Promise<{
  ok: true;
  outstanding: {
    status: "pending" | "failed" | null;
    affectedConversationIds: string[];
    hasMore: boolean;
  };
}> {
  const response = await trackScenarioWrite(
    fetch(`/api/scenarios/${params.scenarioId}/timer-replan-recovery`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspaceId: params.workspaceId }),
    })
  );
  if (!response.ok) {
    await parseScenarioResponseError(
      response,
      "Failed to retry timer recovery"
    );
  }
  const payload = (await readResponseJson(response)) as {
    ok?: unknown;
    outstanding?: {
      status?: unknown;
      affectedConversationIds?: unknown;
      hasMore?: unknown;
    };
  } | null;
  const status = payload?.outstanding?.status;
  if (
    payload?.ok !== true ||
    !payload.outstanding ||
    (status !== null && status !== "pending" && status !== "failed") ||
    typeof payload.outstanding.hasMore !== "boolean"
  ) {
    throw new Error("Timer recovery response missing");
  }
  return {
    ok: true,
    outstanding: {
      status,
      affectedConversationIds: Array.isArray(
        payload.outstanding.affectedConversationIds
      )
        ? Array.from(
            new Set(
              payload.outstanding.affectedConversationIds
                .filter((value): value is string => typeof value === "string")
                .map(value => value.trim())
                .filter(Boolean)
            )
          )
        : [],
      hasMore: payload.outstanding.hasMore,
    },
  };
}

export async function patchScenarioSidebarRequest(input: {
  scenarioId: string;
  workspaceId: string;
  patch: ScenarioSidebarPatch;
}): Promise<ScenarioDocumentDTO<ScenarioRawGraphNode, ScenarioRawGraphEdge>> {
  const response = await trackScenarioWrite(
    fetch(`/api/scenarios/${input.scenarioId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        ...input.patch,
      }),
    })
  );

  return readConfirmedScenarioDocument(
    response,
    "Failed to save scenario sidebar fields"
  );
}

export async function deleteScenarioRequest(params: {
  scenarioId: string;
  workspaceId: string;
  scenarioName: string;
  expectedUpdatedAt?: string | null;
}): Promise<void> {
  const response = await trackScenarioWrite(
    fetch(
      `/api/scenarios/${params.scenarioId}?workspaceId=${params.workspaceId}`,
      {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          confirmationToken: "delete_scenario",
          scenarioName: params.scenarioName,
          expectedUpdatedAt: params.expectedUpdatedAt ?? null,
        }),
      }
    )
  );

  if (!response.ok) {
    await parseScenarioResponseError(response, "Failed to delete scenario");
  }
}

export async function fetchScenarioTriggerLogs(params: {
  workspaceId: string;
  scenarioId: string;
  days?: number;
  limit?: number;
  cursor?: string;
}): Promise<{
  logs: ScenarioTriggerLogEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const query = new URLSearchParams({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    days: String(params.days ?? 14),
    limit: String(params.limit ?? 120),
  });
  if (params.cursor) {
    query.set("cursor", params.cursor);
  }
  const response = await fetch(
    `/api/scenarios/trigger-logs?${query.toString()}`,
    NO_STORE_OPTIONS
  );
  if (!response.ok) {
    throw new Error("Failed to load scenario trigger logs");
  }
  const payload = (await readResponseJson(response)) as Record<
    string,
    unknown
  > | null;
  return {
    logs: asArray<ScenarioTriggerLogEntry>(payload?.logs),
    hasMore: Boolean(payload?.hasMore),
    nextCursor:
      typeof payload?.nextCursor === "string" ? payload.nextCursor : null,
  };
}

export async function previewScenarioEvaluationRequest(
  params: {
    workspaceId: string;
    channel: string;
    eventKind: ScenarioMessageIngressEventKind;
    messageText?: string;
    classificationCategory?: string | null;
    internalLabels?: string[];
    funnelStage?: string | null;
    isNewCustomer?: boolean;
    hasPurchaseHistory?: boolean;
    quickReplyPayload?: string | null;
    whatsAppFlowResponseJson?: string | null;
    draftScenario?: {
      scenarioId?: string | null;
      name: string;
      status: ScenarioStatus;
      priority: number;
      matchingRole?: ScenarioMatchingRole;
      entryPolicy?: ScenarioEntryPolicy;
      nodes: ScenarioCanvasNode[];
      edges: ScenarioGraphEdge[];
    } | null;
  },
  options?: { signal?: AbortSignal }
): Promise<ScenarioPreviewResult> {
  const response = await fetch("/api/scenarios/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(params),
    signal: options?.signal,
  });

  if (!response.ok) {
    await parseScenarioResponseError(response, "Failed to preview scenarios");
  }

  const payload = (await readResponseJson(response)) as Record<
    string,
    unknown
  > | null;
  return {
    eventKind: (typeof payload?.eventKind === "string"
      ? payload.eventKind
      : params.eventKind) as ScenarioPreviewResult["eventKind"],
    evaluations: asArray<ScenarioPreviewResult["evaluations"][number]>(
      payload?.evaluations
    ),
    winner:
      payload?.winner && typeof payload.winner === "object"
        ? (payload.winner as ScenarioPreviewResult["winner"])
        : null,
  };
}
