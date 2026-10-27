import type {
  ScenarioEntryPolicy,
  ScenarioMatchingRole,
  ScenarioStatus,
  ScenarioPreviewResult,
} from "@icecore/scenario-contracts";
import { SCENARIO_TRIGGER_EVENT_KIND } from "@icecore/scenario-contracts";
import { SCENARIO_INTERACTIVE_REPLY_EVENT_KINDS } from "@icecore/scenario-contracts";
import { previewScenarioEvaluationRequest } from "@/lib/scenarios/client";
import { isScenarioEditorFieldKey } from "@/lib/scenarios/strip-editor-fields";
import type { ScenarioFlowEdge, ScenarioFlowNode } from "../../types";

export const DEFAULT_SCENARIO_PREVIEW_CHANNELS = [
  "whatsapp",
  "telegram",
] as const;

const TRANSIENT_NODE_KEYS = new Set([
  "className",
  "dragging",
  "height",
  "measured",
  "position",
  "positionAbsolute",
  "resizing",
  "selected",
  "style",
  "width",
  "zIndex",
]);

const TRANSIENT_EDGE_KEYS = new Set([
  "animated",
  "className",
  "selected",
  "style",
  "zIndex",
]);

export type ScenarioPreviewEventKind = Parameters<
  typeof previewScenarioEvaluationRequest
>[0]["eventKind"];

export const DEFAULT_SCENARIO_PREVIEW_EVENT_KIND =
  SCENARIO_TRIGGER_EVENT_KIND.inboundMessage satisfies ScenarioPreviewEventKind;

const SCENARIO_PREVIEW_EVENT_KINDS = [
  DEFAULT_SCENARIO_PREVIEW_EVENT_KIND,
  ...SCENARIO_INTERACTIVE_REPLY_EVENT_KINDS,
] as const satisfies readonly ScenarioPreviewEventKind[];

export type ScenarioPreviewSelectableEventKind =
  (typeof SCENARIO_PREVIEW_EVENT_KINDS)[number];

export function resolveScenarioPreviewEventKinds(): ScenarioPreviewSelectableEventKind[] {
  return [...SCENARIO_PREVIEW_EVENT_KINDS];
}

export type ScenarioDraftPreviewInput = {
  scenarioId?: string | null;
  name: string;
  status: ScenarioStatus;
  priority: number;
  matchingRole?: ScenarioMatchingRole;
  entryPolicy?: ScenarioEntryPolicy;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
};

export type ScenarioPreviewEvaluationInput = {
  workspaceId: string;
  channel: string;
  eventKind: ScenarioPreviewEventKind;
  messageText?: string | null;
  classificationCategory?: string | null;
  internalLabels?: string[] | string | null;
  funnelStage?: string | null;
  isNewCustomer?: boolean;
  hasPurchaseHistory?: boolean;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
  draftScenario?: ScenarioDraftPreviewInput | null;
  signal?: AbortSignal;
};

function normalizePreviewValue(
  value: unknown,
  options?: { transientKeys?: Set<string> }
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizePreviewValue(item, options));
  }

  if (typeof value === "function" || value === undefined) {
    return undefined;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, entryValue]) => {
        if (options?.transientKeys?.has(key)) {
          return false;
        }
        if (isScenarioEditorFieldKey(key)) {
          return false;
        }
        return typeof entryValue !== "function" && entryValue !== undefined;
      })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [
        key,
        normalizePreviewValue(entryValue, options),
      ])
      .filter(([, entryValue]) => entryValue !== undefined);

    return Object.fromEntries(entries);
  }

  return value;
}

function normalizeScenarioPreviewNode(
  node: ScenarioFlowNode
): ScenarioFlowNode {
  return {
    id: node.id,
    type: node.type,
    position: { x: 0, y: 0 },
    data: normalizePreviewValue(node.data) as ScenarioFlowNode["data"],
  } as ScenarioFlowNode;
}

function normalizeScenarioPreviewEdge(
  edge: ScenarioFlowEdge
): ScenarioFlowEdge {
  return normalizePreviewValue(
    {
      id: edge.id,
      type: edge.type,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle || null,
      targetHandle: edge.targetHandle || null,
      data: edge.data,
    },
    { transientKeys: TRANSIENT_EDGE_KEYS }
  ) as ScenarioFlowEdge;
}

export function normalizeScenarioPreviewLogicDraft(
  draftScenario: ScenarioDraftPreviewInput | null | undefined
): ScenarioDraftPreviewInput | null {
  if (!draftScenario) {
    return null;
  }

  const normalizedScenario = normalizePreviewValue(
    {
      scenarioId: draftScenario.scenarioId || null,
      name: draftScenario.name,
      status: draftScenario.status,
      priority: draftScenario.priority,
      matchingRole: draftScenario.matchingRole,
      entryPolicy: draftScenario.entryPolicy,
      nodes: draftScenario.nodes.map(normalizeScenarioPreviewNode),
      edges: draftScenario.edges.map(normalizeScenarioPreviewEdge),
    },
    { transientKeys: TRANSIENT_NODE_KEYS }
  ) as ScenarioDraftPreviewInput;

  return normalizedScenario;
}

export function buildScenarioPreviewLogicSignature(
  draftScenario: ScenarioDraftPreviewInput | null | undefined
): string {
  const normalizedDraft = normalizeScenarioPreviewLogicDraft(draftScenario);
  return normalizedDraft ? JSON.stringify(normalizedDraft) : "";
}

export function normalizeScenarioPreviewInternalLabels(
  value: string[] | string | null | undefined
): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];

  return Array.from(
    new Set(values.map(item => String(item || "").trim()).filter(Boolean))
  );
}

export function resolveScenarioPreviewChannelOptions(
  availableChannels?: string[]
): string[] {
  return Array.from(
    new Set(
      [
        ...(availableChannels || []).map(channel =>
          String(channel || "").trim()
        ),
        ...DEFAULT_SCENARIO_PREVIEW_CHANNELS,
      ].filter(Boolean)
    )
  );
}

export function resolveScenarioPreviewChannel(
  currentChannel: string | null | undefined,
  availableChannels?: string[]
): string {
  const channelOptions =
    resolveScenarioPreviewChannelOptions(availableChannels);
  const normalizedCurrentChannel = String(currentChannel || "").trim();
  if (
    normalizedCurrentChannel &&
    channelOptions.includes(normalizedCurrentChannel)
  ) {
    return normalizedCurrentChannel;
  }
  return channelOptions[0] || "whatsapp";
}

export function buildScenarioPreviewEvaluationPayload(
  params: ScenarioPreviewEvaluationInput
): Parameters<typeof previewScenarioEvaluationRequest>[0] {
  return {
    workspaceId: params.workspaceId,
    channel: params.channel,
    eventKind: params.eventKind,
    messageText: params.messageText || undefined,
    classificationCategory: params.classificationCategory || null,
    internalLabels: normalizeScenarioPreviewInternalLabels(
      params.internalLabels
    ),
    funnelStage: params.funnelStage || null,
    isNewCustomer: Boolean(params.isNewCustomer),
    hasPurchaseHistory: Boolean(params.hasPurchaseHistory),
    quickReplyPayload: params.quickReplyPayload || null,
    whatsAppFlowResponseJson: params.whatsAppFlowResponseJson || null,
    draftScenario: normalizeScenarioPreviewLogicDraft(params.draftScenario),
  };
}

export async function runScenarioPreviewEvaluation(
  params: ScenarioPreviewEvaluationInput
): Promise<ScenarioPreviewResult> {
  return previewScenarioEvaluationRequest(
    buildScenarioPreviewEvaluationPayload(params),
    { signal: params.signal }
  );
}
