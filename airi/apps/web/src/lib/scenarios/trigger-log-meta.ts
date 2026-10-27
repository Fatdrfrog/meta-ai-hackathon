import type { CampaignProductLog } from "@/lib/scenarios/campaign-product-routing";
import {
  parseWhatsAppTemplateButtonPayload,
  resolveWhatsAppTemplateButtons,
  type ScenarioMatchingRole,
  type ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import type { CompiledScenarioGraph } from "@icecore/airi-runtime/scenario-graph";

export type ScenarioTriggerLogFilterSummary = {
  channelFilter?: string[];
  messageMatchMode?: "any" | "exact" | "contains";
  keywordPattern?: string | null;
  keywordMatchMode?: "contains" | "regex" | null;
  keywordMatchStatus?:
    | "missing-pattern"
    | "empty-literal-pattern"
    | "invalid-regex";
  whatsappReferralSourceTypes?: string[];
  whatsappReferralSourcePlatforms?: string[];
  metaReferralSourceIds?: string[];
  metaReferralCampaignIds?: string[];
  metaReferralAdSetIds?: string[];
  metaCampaignAdAccountId?: string;
  metaCampaignLabelIds?: string[];
  metaCampaignLabelNames?: string[];
  metaCampaignNameFallbacks?: string[];
  onlyNewCustomers?: boolean;
};

export type ScenarioTriggerLogEvaluationContext = {
  channel?: string | null;
  classificationCategory?: string | null;
  internalLabels?: string[];
  funnelStage?: string | null;
  isNewCustomer?: boolean;
  hasPurchaseHistory?: boolean;
  quickReplyPayload?: string | null;
  hasWhatsAppFlowResponse?: boolean;
  triggerLanguage?: string | null;
};

export type ScenarioTriggerLogQrIngress = {
  anchored: boolean;
  reason?: string;
};

/** A template reply-button tap, for tracing which button a route ran for. */
export type ScenarioTriggerLogTemplateButtonTap = {
  actionNodeId: string;
  /** The step's id for the button, read from the tap payload. */
  buttonId: number;
  /**
   * The button's position in the step's saved template, or null when the
   * step no longer has a button with that id.
   */
  metaIndex: number | null;
};

export type ScenarioTriggerLogMeta = {
  triggerNodeId?: string | null;
  filters?: ScenarioTriggerLogFilterSummary | null;
  selectedPathNodeIds?: string[];
  selectedSourceHandleIds?: string[];
  selectedSourceHandleUsed?: string | null;
  candidateActionNodeIds?: string[];
  preferredActionNodeId?: string | null;
  lockedByConversationState?: boolean;
  evaluationContext?: ScenarioTriggerLogEvaluationContext | null;
  /** QR ingress attribution only — never store refs/bodies/deep links. */
  qrIngress?: ScenarioTriggerLogQrIngress;
  /** When true, persisted triggerType becomes whatsapp_qr. */
  qrAnchored?: boolean;
  entryPointType?: "message" | "whatsapp_qr";
  productRoute?: CampaignProductLog | null;
  templateButtonTap?: ScenarioTriggerLogTemplateButtonTap;
};

export function buildScenarioTriggerLogFilterSummary(
  triggerConfig: ScenarioTriggerConfig | null | undefined
): ScenarioTriggerLogFilterSummary | null {
  if (!triggerConfig) return null;
  const criteria = projectActiveClientMessageFilters(triggerConfig);
  const summary: ScenarioTriggerLogFilterSummary = {};
  if (criteria.channelFilter.length > 0) {
    summary.channelFilter = [...criteria.channelFilter];
  }
  if (criteria.text.mode === "exact") {
    summary.messageMatchMode = "exact";
    summary.keywordPattern =
      criteria.text.status === "valid" ? criteria.text.pattern : null;
    if (criteria.text.status !== "valid") {
      summary.keywordMatchStatus = criteria.text.status;
    }
  } else if (criteria.text.mode === "contains") {
    summary.messageMatchMode = "contains";
    summary.keywordPattern = criteria.text.matcher?.source ?? null;
    summary.keywordMatchMode =
      criteria.text.matcher?.kind === "regex" ? "regex" : "contains";
    if (criteria.text.status !== "valid") {
      summary.keywordMatchStatus = criteria.text.status;
    }
  }
  if (criteria.whatsappReferralSourceTypes.length > 0) {
    summary.whatsappReferralSourceTypes = [
      ...criteria.whatsappReferralSourceTypes,
    ];
  }
  if (criteria.whatsappReferralSourcePlatforms.length > 0) {
    summary.whatsappReferralSourcePlatforms = [
      ...criteria.whatsappReferralSourcePlatforms,
    ];
  }
  if (criteria.metaReferralSourceIds.length > 0) {
    summary.metaReferralSourceIds = [...criteria.metaReferralSourceIds];
  }
  if (criteria.metaReferralCampaignIds.length > 0) {
    summary.metaReferralCampaignIds = [...criteria.metaReferralCampaignIds];
  }
  if (criteria.metaReferralAdSetIds.length > 0) {
    summary.metaReferralAdSetIds = [...criteria.metaReferralAdSetIds];
  }
  if (criteria.metaCampaignAdAccountId) {
    summary.metaCampaignAdAccountId = criteria.metaCampaignAdAccountId;
  }
  if (criteria.metaCampaignLabels.length > 0) {
    summary.metaCampaignLabelIds = criteria.metaCampaignLabels.map(
      label => label.id
    );
    summary.metaCampaignLabelNames = criteria.metaCampaignLabels.map(
      label => label.name
    );
  }
  if (criteria.metaCampaignNameFallbacks.length > 0) {
    summary.metaCampaignNameFallbacks = [...criteria.metaCampaignNameFallbacks];
  }
  if (criteria.onlyNewCustomers) {
    summary.onlyNewCustomers = true;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildScenarioTriggerLogPathMeta(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds?: string[] | null;
}): Pick<
  ScenarioTriggerLogMeta,
  "selectedPathNodeIds" | "selectedSourceHandleIds" | "selectedSourceHandleUsed"
> {
  const pathNodeIds = Array.isArray(params.pathNodeIds)
    ? params.pathNodeIds
        .map(nodeId => String(nodeId || "").trim())
        .filter(Boolean)
    : [];

  if (pathNodeIds.length === 0) {
    return {
      selectedPathNodeIds: [],
      selectedSourceHandleIds: [],
      selectedSourceHandleUsed: null,
    };
  }

  const selectedSourceHandleIds: string[] = [];
  for (let index = 0; index < pathNodeIds.length - 1; index += 1) {
    const sourceId = pathNodeIds[index];
    const targetId = pathNodeIds[index + 1];
    const edge = params.graph.edges.find(
      candidate =>
        candidate.source === sourceId && candidate.target === targetId
    );
    const handleId =
      typeof edge?.sourceHandle === "string" ? edge.sourceHandle.trim() : "";
    if (handleId) {
      selectedSourceHandleIds.push(handleId);
    }
  }

  return {
    selectedPathNodeIds: pathNodeIds,
    selectedSourceHandleIds,
    selectedSourceHandleUsed:
      selectedSourceHandleIds.length > 0
        ? selectedSourceHandleIds[selectedSourceHandleIds.length - 1]
        : null,
  };
}

/** Null unless the payload is a tap on a template step in this graph. */
export function buildScenarioTriggerLogTemplateButtonTap(params: {
  graph: CompiledScenarioGraph;
  quickReplyPayload?: string | null;
}): ScenarioTriggerLogTemplateButtonTap | null {
  const tap = parseWhatsAppTemplateButtonPayload(params.quickReplyPayload);
  const action = tap ? params.graph.nodesById.get(tap.actionNodeId) : null;
  if (!tap || !action) return null;

  const button = resolveWhatsAppTemplateButtons(
    action.data.actionWhatsAppTemplateComponents,
    action.data.actionWhatsAppTemplateButtonIds
  ).find(candidate => candidate.id === tap.buttonId);
  return {
    actionNodeId: tap.actionNodeId,
    buttonId: tap.buttonId,
    metaIndex: button?.index ?? null,
  };
}

export type ScenarioTriggerLogEntry = {
  _id: string;
  workspaceId: string;
  conversationId: string;
  scenarioId: string;
  scenarioName?: string | null;
  evaluationId?: string | null;
  scenarioPriority?: number | null;
  candidateOrder?: number | null;
  matchingRole?: ScenarioMatchingRole | null;
  result?:
    | "winner"
    | "matched_but_shadowed"
    | "blocked"
    | "trigger_mismatch"
    | "no_action"
    | null;
  winnerScenarioId?: string | null;
  shadowedByScenarioId?: string | null;
  shadowedByOrder?: number | null;
  triggerType?: string | null;
  eventKind: string;
  matched: boolean;
  mismatchReason?: string | null;
  selectedActionNodeId?: string | null;
  selectedActionType?: string | null;
  branchNodeIds?: string[];
  meta?: ScenarioTriggerLogMeta | null;
  evaluatedAt?: string | Date | null;
  createdAt?: string | Date | null;
};
