import { BulkCampaignSendError } from "@/lib/campaign/bulk-campaign-client";
import type { BulkCampaignSendResponse } from "@/lib/campaign/bulk-campaign-contracts";
import type {
  ScenarioDocumentDTO,
  ScenarioCanvasNode,
  ScenarioGraphEdge,
  ScenarioGeneratorBlueprint,
  ScenarioGeneratorCanvaTemplatesResult,
  ScenarioGeneratorCreateInput,
  ScenarioGeneratorPlanInput,
  ScenarioGeneratorPlanResult,
  ScenarioGenerationStatus,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { readScenarioGraphEnvelope } from "@icecore/scenario-contracts";
import {
  errorMessageOrFallback,
  JSON_HEADERS,
  NO_STORE_OPTIONS,
  readResponseJson,
} from "./http";
import type {
  GeneratedTemplateScenarioUpdate,
  GeneratedTemplateSubmissionResult,
} from "../generated-template-submission";
import { readGeneratedTemplateScenarioUpdate } from "../generated-template-submission";

export type {
  GeneratedTemplateScenarioUpdate,
  GeneratedTemplateSubmissionResult,
} from "../generated-template-submission";

export class GeneratedTemplateSubmissionError extends Error {
  readonly status: number;
  readonly scenarioUpdate?: GeneratedTemplateScenarioUpdate;

  constructor(
    message: string,
    status: number,
    scenarioUpdate?: GeneratedTemplateScenarioUpdate
  ) {
    super(message);
    this.name = "GeneratedTemplateSubmissionError";
    this.status = status;
    this.scenarioUpdate = scenarioUpdate;
  }
}

export type {
  ScenarioGeneratorAssetRef,
  ScenarioGeneratorBlueprint,
  ScenarioGeneratorCanvaTemplateRef,
  ScenarioGeneratorCanvaTemplatesResult,
  ScenarioGeneratorCreateInput,
  ScenarioGeneratorPlanInput,
  ScenarioGeneratorPlanResult,
  ScenarioGeneratorPresetSeed,
  ScenarioGeneratorRecipient,
} from "@icecore/scenario-contracts";

export type ScenarioGeneratorCreateResult = {
  scenario: ScenarioDocumentDTO<ScenarioCanvasNode, ScenarioGraphEdge>;
  jobId: string;
  generatedRecipientCount: number;
};

export async function planScenarioGeneratorRequest(
  input: ScenarioGeneratorPlanInput
): Promise<ScenarioGeneratorPlanResult> {
  const response = await fetch(
    `/api/workspaces/${input.workspaceId}/scenario-generator/plan`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }
  );
  const data = (await readResponseJson(response)) as
    | ScenarioGeneratorPlanResult
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new Error(errorMessageOrFallback(data, "Failed to plan scenario"));
  }
  return data as ScenarioGeneratorPlanResult;
}

export async function searchCanvaBrandTemplatesRequest(input: {
  workspaceId: string;
  prompt: string;
  blueprint?: ScenarioGeneratorBlueprint;
  query?: string;
  continuation?: string | null;
}): Promise<ScenarioGeneratorCanvaTemplatesResult> {
  const response = await fetch(
    `/api/workspaces/${input.workspaceId}/scenario-generator/canva/templates`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }
  );
  const data = (await readResponseJson(response)) as
    | ScenarioGeneratorCanvaTemplatesResult
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(data, "Failed to search Canva templates")
    );
  }
  return data as ScenarioGeneratorCanvaTemplatesResult;
}

export async function createScenarioFromGeneratorRequest(
  input: ScenarioGeneratorCreateInput
): Promise<ScenarioGeneratorCreateResult> {
  const response = await fetch(
    `/api/workspaces/${input.workspaceId}/scenario-generator/create`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }
  );
  const data = (await readResponseJson(response)) as
    | ScenarioGeneratorCreateResult
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(data, "Failed to generate scenario")
    );
  }
  return data as ScenarioGeneratorCreateResult;
}

export async function sendGeneratedScenarioCampaignRequest(params: {
  workspaceId: string;
  scenarioId: string;
  idempotencyKey: string;
  scheduledAt?: string;
  audienceConfirmationFingerprint?: string;
  acknowledgeMediaFailures?: boolean;
  errorFallback: string;
}): Promise<BulkCampaignSendResponse> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/scenario-generator/send`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        scenarioId: params.scenarioId,
        idempotencyKey: params.idempotencyKey,
        ...(params.scheduledAt ? { scheduledAt: params.scheduledAt } : {}),
        ...(params.audienceConfirmationFingerprint
          ? {
              audienceConfirmationFingerprint:
                params.audienceConfirmationFingerprint,
            }
          : {}),
        ...(params.acknowledgeMediaFailures === true
          ? { acknowledgeMediaFailures: true }
          : {}),
      }),
    }
  );
  const payload = (await readResponseJson(response)) as
    | BulkCampaignSendResponse
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new BulkCampaignSendError(
      errorMessageOrFallback(payload, params.errorFallback),
      payload,
      response.status
    );
  }
  return (
    payload && typeof payload === "object" ? payload : {}
  ) as BulkCampaignSendResponse;
}

export async function submitGeneratedScenarioTemplateRequest(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  expectedUpdatedAt?: string;
}): Promise<GeneratedTemplateSubmissionResult> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/scenario-generator/submit-template`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        scenarioId: params.scenarioId,
        nodeId: params.nodeId,
        ...(params.expectedUpdatedAt
          ? { expectedUpdatedAt: params.expectedUpdatedAt }
          : {}),
      }),
    }
  );
  const payload = (await readResponseJson(response)) as {
    error?: string;
    templateId?: string;
    status?: string;
    scenarioUpdate?: GeneratedTemplateScenarioUpdate;
  } | null;
  const scenarioUpdate = readGeneratedTemplateScenarioUpdate(
    payload?.scenarioUpdate
  );
  if (!response.ok) {
    throw new GeneratedTemplateSubmissionError(
      errorMessageOrFallback(payload, "Failed to submit template"),
      response.status,
      scenarioUpdate ?? undefined
    );
  }
  if (!scenarioUpdate) {
    throw new GeneratedTemplateSubmissionError(
      "Invalid generated template submission response",
      response.status
    );
  }
  const validStatuses = new Set([
    "draft",
    "submitting",
    "submitted",
    "pending",
    "approved",
    "rejected",
  ]);
  if (
    (payload?.templateId !== undefined &&
      typeof payload.templateId !== "string") ||
    (payload?.status !== undefined && !validStatuses.has(payload.status))
  ) {
    throw new GeneratedTemplateSubmissionError(
      "Invalid generated template submission response",
      response.status
    );
  }
  return {
    templateId: payload?.templateId,
    status: payload?.status as GeneratedTemplateSubmissionResult["status"],
    scenarioUpdate,
  };
}

export type ScenarioGeneratorJobRefreshPayload = {
  error?: string;
  job?: { status?: ScenarioGenerationStatus };
  generationJobId?: string;
  previousScenarioUpdatedAt?: string | null;
  scenarioUpdatedAt?: string | null;
  scenarioRevisionConflict?: boolean;
  nodeUpdates?: Array<{ id?: string; data?: ScenarioNodeData }>;
};

export async function fetchScenarioGeneratorJobRequest(params: {
  workspaceId: string;
  jobId: string;
  errorFallback: string;
}): Promise<ScenarioGeneratorJobRefreshPayload> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/scenario-generator/jobs/${encodeURIComponent(params.jobId)}`,
    NO_STORE_OPTIONS
  );
  const payload = (await readResponseJson(
    response
  )) as ScenarioGeneratorJobRefreshPayload | null;
  if (!response.ok) {
    throw new Error(errorMessageOrFallback(payload, params.errorFallback));
  }
  if (
    payload?.nodeUpdates !== undefined &&
    !readScenarioGraphEnvelope({ nodes: payload.nodeUpdates, edges: [] })
  ) {
    throw new Error("Invalid scenario generation update");
  }
  return payload ?? {};
}

export type ScenarioGeneratorRecipientMessage = {
  id: string;
  channel: string;
  recipient: string;
  recipientName?: string | null;
  text: string;
  sendStatus?: string;
};

export type ScenarioGeneratorRecipientMessagesPage = {
  items: ScenarioGeneratorRecipientMessage[];
  total: number;
  truncated: boolean;
};

export async function fetchScenarioGeneratorRecipientMessages(params: {
  workspaceId: string;
  scenarioId: string;
  branchId: string;
  limit?: number;
}): Promise<ScenarioGeneratorRecipientMessagesPage> {
  const query = new URLSearchParams({
    scenarioId: params.scenarioId,
    branchId: params.branchId,
    limit: String(params.limit ?? 100),
  });
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/scenario-generator/recipient-messages?${query.toString()}`,
    NO_STORE_OPTIONS
  );
  const payload = (await readResponseJson(response)) as {
    error?: string;
    items?: ScenarioGeneratorRecipientMessage[];
    total?: number;
  } | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(payload, "Failed to load recipient messages")
    );
  }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const total =
    typeof payload?.total === "number" && Number.isFinite(payload.total)
      ? Math.max(0, Math.floor(payload.total))
      : items.length;
  return {
    items,
    total,
    truncated: total > items.length,
  };
}

export async function patchScenarioGeneratorRecipientMessage(params: {
  workspaceId: string;
  scenarioId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/scenario-generator/recipient-messages`,
    {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        scenarioId: params.scenarioId,
        messageId: params.messageId,
        text: params.text,
      }),
    }
  );
  const payload = (await readResponseJson(response)) as {
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(
      errorMessageOrFallback(payload, "Failed to save recipient message")
    );
  }
}
