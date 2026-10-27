import {
  extractWhatsAppQrReference,
  getScenarioWhatsAppServiceBodySource,
  isRagScenarioContextOptionId,
  captureFlowTextPromptInputs,
  listRunnableScenarioPromptInputs,
  parseWhatsAppSessionChoicePayload,
  readScenarioActionForm,
  readScenarioPromptInputAsk,
  resolveWhatsAppFlowProviderId,
  type ScenarioMatchingRole,
  type ScenarioNodeData,
  type ScenarioPreviewEvaluation,
  type ScenarioPreviewResult,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import {
  buildScenarioTriggerEvaluationMeta,
  buildScenarioTriggerLogEvaluationContext,
  evaluateScenarioEntryEligibility,
  shouldSuppressFallbackForCurrentSession,
} from "@/lib/airi/scenario/scenario-entry-selection";
import {
  compileScenarioCandidate,
  orderTopLevelScenarioCandidates,
  selectMatchingTrigger,
  selectTopLevelScenarioCandidates,
  type ScenarioCandidate,
  type ScenarioCandidateSelection,
  type ScenarioTriggerCandidate,
} from "@/lib/airi/scenario/scenario-candidate-selection";
import {
  evaluateScenarioFlow,
  readScenarioFormAnswerFieldMap,
  resolveInteractiveReplyConditionTarget,
  resolvePreferredContinuationActionNodeId,
  shouldPinLockedScenarioForEvent,
} from "@/lib/airi/scenario/scenario-interactive-replies";
import {
  collectRuntimeActionTypesForScenarioNodes,
  resolveFirstReachableActionFromNode,
  resolvePostActionConditionBranchTarget,
  resolvePostActionConditionNodeFromAction,
  resolvePostActionConditionSourceHandleTarget,
  resolveScenarioDispatchTransition,
  resolveScenarioLocationRouteTarget,
  resolveGenerativeAIOutcomeTransitions,
  resolvePromptInputsMetTransition,
  resolvePromptInputsUnmetTransition,
} from "@/lib/airi/scenario/scenario-post-action-routing";
import {
  isActionReplyChannelMismatch,
  isLockedBranchReplyEvent,
  isLockedStructuredReplyEvent,
  mapForcedBuildToSessionLogResult,
  mapRuntimeBuildToSessionLogResult,
  normalizeInteractiveTriggerPayloads,
  resolveConversationMetaReferral,
  resolveDefaultTriggerEventKind,
  shouldSkipTriggerMatchDuringRuntimeBuild,
} from "@/lib/airi/scenario/scenario-runtime-dispatch";
import {
  buildContextBindings,
  buildContextSourcePriority,
  fetchActiveScenarioById,
  fetchActiveScenariosForWorkspace,
  getBindingSelectionIds,
  loadQuickRepliesForScenario,
  shouldIncludeKBArticlesForScenarioRuntime,
} from "@/lib/airi/scenario/scenario-runtime-resources";
import type {
  AiriScenarioRuntimeConfig,
  AiriScenarioRuntimeResolution,
  ScenarioRuntimeBlockedAction,
} from "@icecore/airi-runtime/scenario-runtime-types";
import type { ScenarioRuntimeBuildResult } from "@/lib/airi/scenario/scenario-runtime-types";
import connectDB from "@/lib/mongoose";
import { normalizeDateIso } from "@/lib/airi/reply/runtime/context";
import { resolveScenarioReplyExecutionDecision } from "@/lib/airi/reply/runtime/reply-action-utils";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";
import { isScenarioInteractiveReplyEventKind } from "@icecore/scenario-contracts";
import {
  isScenarioMessageIngressEventKind,
  isScenarioPostActionEventKind,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioMessageIngressEventKind,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";
import { airiOrchestrationLogger } from "@icecore/airi-runtime/logging";
import { randomUUID } from "node:crypto";
import {
  buildScenarioRevisionFingerprint,
  type CanonicalJsonValue,
} from "@icecore/airi-runtime/scenario-generative-ai-identity";
import type { GenerativeAIInboundCandidate } from "@icecore/airi-runtime/scenario-generative-ai-input-types";
import type { ResolveActiveScenarioRuntimeParams } from "@icecore/airi-runtime/scenario-runtime-dependencies";
import { canStartUnavailableMessageScenario } from "@/lib/airi/reply/runtime/auto-reply-input";

import type { Channel, ConversationDocument } from "@/types/models";

// -- Sub-module imports -------------------------------------------------------
import {
  type FunnelSegmentKey,
  resolveConversationCustomerFacts,
  resolveConversationSegmentRouting,
} from "@/lib/airi/scenario/scenario-audience";
import {
  logScenarioTriggerEvaluations,
  type ScenarioTriggerLogEvaluationParams,
} from "@/lib/airi/scenario/scenario-trigger-logging";
import {
  type ScenarioRecord,
  type ScenarioRuntimeEdge,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import {
  DEFAULT_FLOW_BODY_TEXT,
  DEFAULT_FLOW_CTA_TEXT,
  normalizeActionReplyChannelForActionNode,
  normalizeFlowConfig,
  normalizeInstagramConfigForActionNode,
  normalizeOptionalNodeId,
  normalizeOptionalNodeText,
  normalizeReplyCtaTypeForActionNode,
  normalizeReplyModeForActionNode,
  normalizeTelegramQuickReplies,
  normalizeUrlArray,
  normalizeWhatsAppTemplateComponents,
} from "@/lib/scenarios/normalization";
import { normalizeConversationScenarioState } from "@icecore/airi-runtime/scenario-state";
import { normalizeScenarioActionAttachments } from "@/lib/scenarios/action-attachments";
import { buildScenarioFormResponseFieldMetadata } from "@/lib/scenarios/scenario-form-response-metadata";
import { resolveScenarioStructuredReplyActionNodeId } from "@/lib/scenarios/structured-replies";
import { resolveScenarioWhatsAppServiceMessage } from "@/lib/scenarios/whatsapp-service-message";
import {
  projectScenarioIngressContext,
  type ScenarioIngressContext,
} from "@/lib/scenarios/incoming-message-trigger-matcher";
import {
  campaignLabelLookupRequired,
  enrichIngressReferralPairWhenRequired,
  type IngressCampaignLabelCarrier,
} from "@/lib/scenarios/ingress-campaign-metadata";
import {
  resolveWhatsAppQrScenarioAnchor,
  type WhatsAppQrScenarioAnchorResult,
  WHATSAPP_QR_RUNTIME_MISSING_POINTER_FALLBACK_ENABLED,
} from "@/lib/whatsapp/qr-entry-points/runtime";
import type { ScenarioTriggerLogMeta } from "@/lib/scenarios/trigger-log-meta";

// -- Re-exports for backward compatibility ------------------------------------
export {
  collectRuntimeActionTypesForScenarioNodes,
  DEFAULT_FLOW_BODY_TEXT,
  DEFAULT_FLOW_CTA_TEXT,
  evaluateScenarioFlow,
  resolveInteractiveReplyConditionTarget,
  resolveFirstReachableActionFromNode,
  resolvePostActionConditionBranchTarget,
  resolvePostActionConditionNodeFromAction,
  resolvePostActionConditionSourceHandleTarget,
  resolvePreferredContinuationActionNodeId,
  resolveConversationSegmentRouting,
  resolveScenarioDispatchTransition,
  resolveScenarioLocationRouteTarget,
  resolveGenerativeAIOutcomeTransitions,
  shouldIncludeKBArticlesForScenarioRuntime,
  shouldPinLockedScenarioForEvent,
};

export function buildScenarioRevisionFingerprintFromRecord(
  scenario: Pick<ScenarioRecord, "nodes" | "edges">
): string {
  const snapshot = JSON.parse(
    JSON.stringify({
      version: 1,
      nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
      edges: Array.isArray(scenario.edges) ? scenario.edges : [],
    })
  ) as {
    version: number;
    nodes: CanonicalJsonValue[];
    edges: CanonicalJsonValue[];
  };
  return buildScenarioRevisionFingerprint(snapshot);
}

function attachWhatsAppQrTriggerLogMeta(
  meta: ScenarioTriggerLogMeta | null | undefined,
  anchor: WhatsAppQrScenarioAnchorResult | null
): ScenarioTriggerLogMeta | null {
  if (!anchor || anchor.kind === "none") {
    return meta ?? null;
  }
  const qrMeta: ScenarioTriggerLogMeta =
    anchor.kind === "anchored"
      ? {
          qrAnchored: true,
          entryPointType: "whatsapp_qr",
          qrIngress: { anchored: true },
        }
      : {
          entryPointType: "whatsapp_qr",
          qrIngress: { anchored: false, reason: anchor.reason },
        };
  return {
    ...(meta || {}),
    ...qrMeta,
  };
}

function resolveWhatsAppQrFailClosedLogResult(
  reason: string
): "blocked" | "trigger_mismatch" {
  switch (reason) {
    case "unknown_reference":
    case "ambiguous_reference":
    case "trigger_wrong_type":
    case "trigger_missing":
    case "trigger_entry_point_mismatch":
    case "entry_missing":
    case "scenario_missing":
    case "source_mismatch":
      return "trigger_mismatch";
    default:
      return "blocked";
  }
}

function attachWhatsAppQrTrace(
  resolution: AiriScenarioRuntimeResolution,
  anchor: WhatsAppQrScenarioAnchorResult | null
): AiriScenarioRuntimeResolution {
  if (!anchor || anchor.kind === "none") return resolution;
  return {
    ...resolution,
    whatsappQrTrace: {
      referencePresent: true,
      outcome: anchor.kind,
      ...(anchor.kind === "fail_closed" ? { reasonCode: anchor.reason } : {}),
      ...(anchor.entryPointId ? { entryPointId: anchor.entryPointId } : {}),
      ...(anchor.scenarioId ? { scenarioId: anchor.scenarioId } : {}),
      ...(anchor.nodeId ? { nodeId: anchor.nodeId } : {}),
      ...(anchor.codeId ? { codeId: anchor.codeId } : {}),
    },
  };
}

export type {
  FunnelSegmentKey,
  ScenarioRecord,
  ScenarioRuntimeEdge,
  ScenarioRuntimeNode,
};

// ---------------------------------------------------------------------------
// Flow evaluation
// ---------------------------------------------------------------------------

function getPrimaryCompiledTrigger(
  candidate: ScenarioCandidate
): ScenarioTriggerCandidate | null {
  const primaryTriggerNodeId = candidate.graph.triggerNodeIds[0];
  return (
    candidate.compiledTriggerCandidates.find(
      trigger => trigger.node.id === primaryTriggerNodeId
    ) ?? null
  );
}

function resolveSelectedTriggerForBuild(params: {
  candidate: ScenarioCandidate;
  ingress: ScenarioIngressContext | null;
  triggerNodeId?: string | null;
  skipTriggerMatch: boolean;
}): ScenarioTriggerCandidate | null {
  const explicitTriggerNodeId =
    typeof params.triggerNodeId === "string" ? params.triggerNodeId.trim() : "";
  const primaryTrigger = getPrimaryCompiledTrigger(params.candidate);

  if (params.skipTriggerMatch) {
    if (explicitTriggerNodeId) {
      return (
        params.candidate.compiledTriggerCandidates.find(
          trigger => trigger.node.id === explicitTriggerNodeId
        ) ??
        primaryTrigger ??
        null
      );
    }
    return params.candidate.graph.triggerNodeIds.length === 1
      ? primaryTrigger
      : null;
  }

  if (!params.ingress) return null;
  return selectMatchingTrigger(
    params.candidate,
    params.ingress,
    explicitTriggerNodeId || undefined
  );
}

async function enrichScenarioIngressReferrals<
  TWhatsApp extends IngressCampaignLabelCarrier | null | undefined,
  TMeta extends IngressCampaignLabelCarrier | null | undefined,
>(params: {
  workspaceId: string;
  whatsappReferral?: TWhatsApp;
  metaReferral?: TMeta;
  required?: boolean;
}): Promise<{
  whatsappReferral: TWhatsApp | null;
  metaReferral: TMeta | null;
}> {
  // Jest loads this runtime module without live Meta credentials. The lookup
  // gate itself is covered with an injected resolver.
  const enriched = await enrichIngressReferralPairWhenRequired({
    required: params.required !== false && !process.env.JEST_WORKER_ID,
    workspaceId: params.workspaceId,
    whatsappReferral: params.whatsappReferral,
    metaReferral: params.metaReferral,
  });
  return {
    whatsappReferral: (enriched.whatsappReferral ?? null) as TWhatsApp | null,
    metaReferral: (enriched.metaReferral ?? null) as TMeta | null,
  };
}

async function previewScenarioEvaluationImpl(params: {
  workspaceId: string;
  conversation: ConversationDocument;
  channel: Channel;
  eventKind: ScenarioMessageIngressEventKind;
  messageText?: string;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
  generativeInbound?: GenerativeAIInboundCandidate | null;
  triggerLanguage?: string | null;
  scenarioState?: unknown;
  scenarios?: ScenarioRecord[];
  isNewCustomer?: boolean;
  now?: Date;
}): Promise<ScenarioPreviewResult> {
  await connectDB();

  const normalizedScenarioState = normalizeConversationScenarioState(
    params.scenarioState
  );
  const now = params.now ?? new Date();
  const sourceScenarios =
    params.scenarios ??
    (await fetchActiveScenariosForWorkspace({
      workspaceId: params.workspaceId,
    }));
  const conversationAny = params.conversation as ConversationDocument & {
    classification?: { category?: string | null } | null;
    internal_labels?: string[];
    key_moments?: Array<{ type?: string | null }>;
    estimated_customer_ltv?: number | null;
    revenue_attribution_id?: string | null;
  };
  const { isNewCustomer } = resolveConversationCustomerFacts(conversationAny);
  const previewCandidates = sourceScenarios.map(compileScenarioCandidate);
  const enrichedPreviewReferrals = await enrichScenarioIngressReferrals({
    workspaceId: params.workspaceId,
    whatsappReferral: params.conversation.whatsappReferral,
    metaReferral: resolveConversationMetaReferral(params.conversation),
    required: campaignLabelLookupRequired({
      triggers: previewCandidates.flatMap(candidate =>
        candidate.compiledTriggerCandidates.map(
          trigger => trigger.triggerConfig
        )
      ),
    }),
  });
  const ingress = projectScenarioIngressContext({
    eventKind: params.eventKind,
    channel: params.channel,
    messageText: params.messageText,
    isNewCustomer: params.isNewCustomer ?? isNewCustomer,
    whatsappReferral: enrichedPreviewReferrals.whatsappReferral,
    metaReferral: enrichedPreviewReferrals.metaReferral,
  });
  const orderedSelections = selectTopLevelScenarioCandidates(
    previewCandidates,
    ingress
  );
  const conversationId = String(params.conversation._id || "");
  const evaluations: ScenarioPreviewEvaluation[] = [];
  let winner: ScenarioPreviewEvaluation | null = null;
  let fallbackSuppressedCurrentSession: boolean | null = null;

  for (const [index, selection] of orderedSelections.entries()) {
    const { candidate, selectedTrigger } = selection;
    const {
      scenarioId,
      scenarioName,
      matchingRole,
      priority: scenarioPriority,
    } = candidate;

    const previewEligibility = evaluateScenarioEntryEligibility({
      scenarioId,
      entryPolicy: candidate.entryPolicy,
      normalizedScenarioState,
      allowCurrentLockedScenario: false,
    });
    if (!previewEligibility.eligible) {
      evaluations.push({
        scenarioId,
        scenarioName,
        matchingRole,
        scenarioPriority,
        order: index + 1,
        result: "skipped",
        reason: previewEligibility.reason,
      });
      continue;
    }

    if (matchingRole === "fallback") {
      if (fallbackSuppressedCurrentSession === null) {
        fallbackSuppressedCurrentSession =
          await shouldSuppressFallbackForCurrentSession({
            matchingRole,
            scenarioFacts: orderedSelections.map(item => ({
              scenarioId: item.candidate.scenarioId,
              matchingRole: item.candidate.matchingRole,
            })),
            normalizedScenarioState,
            conversationId,
          });
      }
      if (fallbackSuppressedCurrentSession) {
        evaluations.push({
          scenarioId,
          scenarioName,
          matchingRole,
          scenarioPriority,
          order: index + 1,
          result: "skipped",
          reason: "fallback_suppressed_recent_specific_session",
        });
        continue;
      }
    }

    if (!selectedTrigger) {
      evaluations.push({
        scenarioId,
        scenarioName,
        matchingRole,
        scenarioPriority,
        order: index + 1,
        result: "skipped",
        reason:
          selection.productRoute && selection.productRoute.allow === false
            ? selection.productRoute.outcome
            : "trigger_mismatch",
      });
      continue;
    }

    const runtimeBuild = await buildRuntimeForScenario({
      candidate,
      selectedTrigger,
      workspaceId: params.workspaceId,
      conversation: params.conversation,
      channel: params.channel,
      lockedByConversationState: false,
      triggerEventKind: params.eventKind,
      quickReplyPayload: params.quickReplyPayload,
      whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
      triggerLanguage: params.triggerLanguage,
      skipTriggerMatch: false,
      now,
      productRoute: selection.productRoute,
    });

    if (!runtimeBuild.runtime) {
      evaluations.push({
        scenarioId,
        scenarioName,
        matchingRole,
        triggerNodeId: runtimeBuild.triggerNodeId || selectedTrigger.node.id,
        scenarioPriority,
        order: index + 1,
        result: "skipped",
        reason: runtimeBuild.mismatchReason || "flow_no_matching_action",
      });
      continue;
    }

    const evaluation: ScenarioPreviewEvaluation = {
      scenarioId,
      scenarioName,
      matchingRole,
      triggerNodeId: runtimeBuild.triggerNodeId || selectedTrigger.node.id,
      scenarioPriority,
      order: index + 1,
      result: winner ? "matched_but_shadowed" : "winner",
      reason: winner
        ? "shadowed_by_earlier_match"
        : selection.productRoute?.allow
          ? selection.productRoute.outcome
          : null,
      selectedActionNodeId: runtimeBuild.selectedActionNodeId || null,
      selectedActionType: runtimeBuild.selectedActionType || null,
      pathNodeIds: runtimeBuild.runtime.selectedPathNodeIds || [],
      branchNodeIds: runtimeBuild.selectedBranchNodeIds || [],
    };
    evaluations.push(evaluation);
    if (!winner) {
      winner = evaluation;
    }
  }

  return {
    eventKind: params.eventKind,
    evaluations,
    winner,
  };
}

// ---------------------------------------------------------------------------
// Runtime builder
// ---------------------------------------------------------------------------

/**
 * The buttons, list or carousel message a session-choice tap came from, when
 * that message also asks for details the tapped branch may need.
 */
function readChoicePromptInputSource(params: {
  pathNodes: readonly ScenarioRuntimeNode[];
  selectedActionNodeId: string;
  quickReplyPayload?: string | null;
}): AiriScenarioRuntimeConfig["choicePromptInputSource"] {
  const optionId = (params.quickReplyPayload || "").trim();
  const choice = parseWhatsAppSessionChoicePayload(optionId);
  if (!choice || choice.actionNodeId === params.selectedActionNodeId) {
    return undefined;
  }
  const node = params.pathNodes.find(item => item.id === choice.actionNodeId);
  if (node?.data.kind !== "action") return undefined;
  const resolution = resolveScenarioWhatsAppServiceMessage(node.data);
  if (resolution?.status !== "canonical") return undefined;
  const config = resolution.value;
  return readScenarioPromptInputAsk(config.message) === "choice" &&
    listRunnableScenarioPromptInputs(config)
    ? { actionNodeId: node.id, optionId, config }
    : undefined;
}

/**
 * The fields a template step's form send stores: its Flow config as the send
 * reads it, else the form saved from the Flow its one FLOW button opens.
 */
function readTemplateFormResponseFields(
  data: ScenarioNodeData,
  flowConfig: WhatsAppFlowConfig | null
): AiriScenarioRuntimeConfig["actionFormResponseFields"] {
  const form = readScenarioActionForm({
    ...data,
    actionType: "whatsapp_template",
    actionFlowConfig: flowConfig,
  });
  const fields = buildScenarioFormResponseFieldMetadata(form);
  if (!form || !fields) return undefined;
  return {
    flowId:
      form.snapshotFlowId ??
      resolveWhatsAppFlowProviderId({ flowConfig: data.actionFlowConfig }) ??
      null,
    fields,
  };
}

async function buildRuntimeForScenario(params: {
  candidate: ScenarioCandidate;
  selectedTrigger?: ScenarioTriggerCandidate | null;
  workspaceId: string;
  conversation: ConversationDocument;
  channel: Channel;
  preferredActionNodeId?: string;
  requiredActionNodeId?: string | null;
  continuationSourceActionNodeId?: string | null;
  lockedByConversationState: boolean;
  triggerEventKind?: ScenarioRuntimeEventKind | null;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
  /** The step of this scenario that sent the form a Flow reply submitted. */
  flowReplySourceActionNodeId?: string;
  generativeInbound?: GenerativeAIInboundCandidate | null;
  triggerLanguage?: string | null;
  skipTriggerMatch?: boolean;
  contentIndependentEntryOnly?: boolean;
  hydrateQuickReplies?: boolean;
  now: Date;
  productRoute?: ScenarioCandidateSelection["productRoute"];
}): Promise<ScenarioRuntimeBuildResult> {
  const { candidate } = params;
  const { graph } = candidate;
  // Draft business events have no ingress implementation. This guard also
  // covers forced/QR/locked continuations that intentionally skip matching.
  const pendingBusinessTrigger = candidate.compiledTriggerCandidates.find(
    trigger => trigger.triggerConfig.entryPointType === "business_event"
  );
  if (pendingBusinessTrigger) {
    return {
      runtime: null,
      triggerNodeId: pendingBusinessTrigger.node.id,
      mismatchReason: "trigger_mismatch",
    };
  }
  const primaryTrigger = getPrimaryCompiledTrigger(candidate);
  const matchedTriggerNode = params.selectedTrigger?.node ?? null;
  const matchedTriggerConfig = params.selectedTrigger?.triggerConfig ?? null;
  const evaluationContext = buildScenarioTriggerLogEvaluationContext({
    conversation: params.conversation,
    channel: params.channel,
    quickReplyPayload: params.quickReplyPayload,
    whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
    triggerLanguage: params.triggerLanguage,
  });
  const lockedBranchReplyEvent = isLockedBranchReplyEvent({
    lockedByConversationState: params.lockedByConversationState,
    preferredActionNodeId: params.preferredActionNodeId,
    triggerEventKind: params.triggerEventKind,
  });
  const skipTriggerMatch = shouldSkipTriggerMatchDuringRuntimeBuild({
    skipTriggerMatch: params.skipTriggerMatch,
    triggerEventKind: params.triggerEventKind,
    lockedByConversationState: params.lockedByConversationState,
    preferredActionNodeId: params.preferredActionNodeId,
    graph,
  });

  if (params.triggerEventKind && !skipTriggerMatch && !params.selectedTrigger) {
    return {
      runtime: null,
      triggerNodeId: primaryTrigger?.node.id || null,
      mismatchReason:
        params.productRoute && params.productRoute.allow === false
          ? params.productRoute.outcome
          : "trigger_mismatch",
      meta: buildScenarioTriggerEvaluationMeta({
        graph,
        triggerNodeId: primaryTrigger?.node.id,
        triggerConfig: primaryTrigger?.triggerConfig,
        preferredActionNodeId: params.preferredActionNodeId,
        lockedByConversationState: params.lockedByConversationState,
        evaluationContext,
        productRoute: params.productRoute,
      }),
    };
  }

  if (candidate.scenario.graphProjection === "triggers") {
    const scenario = await fetchActiveScenarioById({
      workspaceId: params.workspaceId,
      scenarioId: candidate.scenarioId,
      expectedUpdatedAt: candidate.scenario.updatedAt,
    });
    if (!scenario) return { runtime: null, mismatchReason: "trigger_mismatch" };
    const hydrated = compileScenarioCandidate(scenario);
    return buildRuntimeForScenario({
      ...params,
      candidate: hydrated,
      selectedTrigger:
        hydrated.compiledTriggerCandidates.find(
          trigger => trigger.node.id === params.selectedTrigger?.node.id
        ) ?? null,
    });
  }

  const baseMeta = buildScenarioTriggerEvaluationMeta({
    graph,
    triggerNodeId: matchedTriggerNode?.id,
    triggerConfig: matchedTriggerConfig,
    preferredActionNodeId: params.preferredActionNodeId,
    lockedByConversationState: params.lockedByConversationState,
    evaluationContext,
    productRoute:
      params.productRoute?.allow === true ? params.productRoute : null,
  });

  if (
    params.contentIndependentEntryOnly &&
    params.selectedTrigger?.criteria.text.mode !== "any"
  ) {
    return {
      runtime: null,
      mismatchReason: "trigger_mismatch",
      meta: baseMeta,
    };
  }

  let match = evaluateScenarioFlow({
    graph,
    conversation: params.conversation,
    channel: params.channel,
    preferredActionNodeId: params.preferredActionNodeId,
    requiredActionNodeId: params.requiredActionNodeId,
    continuationSourceActionNodeId: params.continuationSourceActionNodeId,
    matchedTriggerNodeId: matchedTriggerNode?.id,
    triggerEventKind: params.triggerEventKind || null,
    quickReplyPayload: params.quickReplyPayload,
    whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
    flowReplySourceActionNodeId: params.flowReplySourceActionNodeId,
    generativeInbound: params.generativeInbound,
  });
  if (!match && lockedBranchReplyEvent) {
    // Stored action anchors can become stale after a scenario keeps moving,
    // but the reply payload/flow response still uniquely identifies the
    // correct branch inside the locked scenario.
    match = evaluateScenarioFlow({
      graph,
      conversation: params.conversation,
      channel: params.channel,
      requiredActionNodeId: params.requiredActionNodeId,
      matchedTriggerNodeId: matchedTriggerNode?.id,
      triggerEventKind: params.triggerEventKind || null,
      quickReplyPayload: params.quickReplyPayload,
      whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
      generativeInbound: params.generativeInbound,
    });
  }
  if (!match) {
    return {
      runtime: null,
      triggerNodeId: matchedTriggerNode?.id || null,
      mismatchReason: "flow_no_matching_action",
      meta: baseMeta,
    };
  }

  const pathNodes = match.pathNodeIds.flatMap(nodeId => {
    const node = graph.nodesById.get(nodeId);
    return node ? [node] : [];
  });
  if (
    params.contentIndependentEntryOnly &&
    (match.selectedActionType !== "whatsapp_template" ||
      pathNodes.some(node => node.data.kind === "logic"))
  ) {
    return {
      runtime: null,
      mismatchReason: "flow_no_matching_action",
      meta: baseMeta,
    };
  }
  const bindings = buildContextBindings(pathNodes);
  const contextSourcePriority = buildContextSourcePriority(pathNodes);
  const recognizedContextOptionIds = Array.from(bindings.keys()).filter(
    isRagScenarioContextOptionId
  );
  const hasContextBinding = recognizedContextOptionIds.length > 0;
  const selectedActionReplyMode =
    match.selectedActionType === "reply"
      ? normalizeReplyModeForActionNode(match.selectedAction.data)
      : undefined;
  const actionReplyChannel =
    match.selectedActionType === "reply"
      ? normalizeActionReplyChannelForActionNode(match.selectedAction.data)
      : undefined;
  const ownsWhatsAppServiceMessage =
    match.selectedAction.data.actionWhatsAppServiceMessage !== undefined;
  const whatsAppServiceMessageResolution = ownsWhatsAppServiceMessage
    ? resolveScenarioWhatsAppServiceMessage(match.selectedAction.data)
    : null;
  if (
    ownsWhatsAppServiceMessage &&
    whatsAppServiceMessageResolution?.status !== "canonical"
  ) {
    const blockedScenarioAction: ScenarioRuntimeBlockedAction = {
      reason:
        whatsAppServiceMessageResolution?.status === "unsupported_version"
          ? "whatsapp_service_message_unsupported"
          : "whatsapp_service_message_invalid",
      scenarioId: candidate.scenarioId,
      actionNodeId: match.selectedAction.id,
    };
    return {
      runtime: null,
      blockedScenarioAction,
      triggerNodeId: matchedTriggerNode?.id || null,
      selectedActionNodeId: match.selectedAction.id,
      selectedActionType: match.selectedActionType,
      selectedBranchNodeIds: match.branchNodeIds,
      meta: baseMeta,
    };
  }
  const actionWhatsAppServiceMessage =
    match.selectedActionType === "reply" &&
    actionReplyChannel === "whatsapp" &&
    whatsAppServiceMessageResolution?.status === "canonical"
      ? whatsAppServiceMessageResolution.value
      : undefined;
  const whatsAppServiceBodySource = actionWhatsAppServiceMessage
    ? getScenarioWhatsAppServiceBodySource(actionWhatsAppServiceMessage)
    : undefined;

  if (
    isActionReplyChannelMismatch({
      actionReplyChannel,
      channel: params.channel,
    })
  ) {
    return {
      runtime: null,
      triggerNodeId: matchedTriggerNode?.id || null,
      mismatchReason: "action_channel_mismatch",
      selectedActionNodeId: match.selectedAction.id,
      selectedActionType: match.selectedActionType,
      selectedBranchNodeIds: match.branchNodeIds,
      meta: baseMeta,
    };
  }

  // conversation_timeline and customer_profile are unified as "Chat & Customer Info"
  const hasChatAndCustomer =
    bindings.has("conversation_timeline") || bindings.has("customer_profile");
  const includeConversationTimeline = hasContextBinding
    ? hasChatAndCustomer
    : true;
  const includeSnippets = hasContextBinding
    ? bindings.has("answer_snippets")
    : true;
  const includeKBArticles = shouldIncludeKBArticlesForScenarioRuntime({
    hasContextBinding,
    hasKBBinding: bindings.has("knowledge_base_articles"),
    selectedActionType: match.selectedActionType,
    replyMode: selectedActionReplyMode,
  });
  const includeIndexedUrls = hasContextBinding
    ? bindings.has("indexed_public_urls")
    : true;
  const includeQuickReplies =
    match.selectedActionType !== "end_scenario" &&
    (hasContextBinding ? bindings.has("quick_replies") : true);
  const includeCustomerProfile = hasContextBinding ? hasChatAndCustomer : false;
  const includePurchaseHistory = hasContextBinding
    ? bindings.has("purchase_history")
    : false;
  const includeActiveSubscriptions = hasContextBinding
    ? bindings.has("active_subscriptions")
    : false;
  const includeDynamicBusinessTags = true;

  const conversationIds = [
    ...getBindingSelectionIds(bindings, "conversation_timeline"),
    ...getBindingSelectionIds(bindings, "customer_profile"),
  ];
  const snippetIds = getBindingSelectionIds(bindings, "answer_snippets");
  const quickReplyIds = getBindingSelectionIds(bindings, "quick_replies");
  const kbArticleIds = getBindingSelectionIds(
    bindings,
    "knowledge_base_articles"
  );
  const indexedUrlIds = getBindingSelectionIds(bindings, "indexed_public_urls");
  const actionLinkUrls = actionWhatsAppServiceMessage
    ? []
    : normalizeUrlArray(match.selectedAction.data.actionLinkUrls);
  const actionImageUrls = normalizeUrlArray(
    match.selectedAction.data.actionImageUrls
  );
  const actionAttachments = normalizeScenarioActionAttachments({
    attachments: match.selectedAction.data.actionAttachments,
    legacyUrls: match.selectedAction.data.actionImageUrls,
    generatedAssets: match.selectedAction.data.actionMediaAssets,
  });
  const actionReplyCtaFlowId = actionWhatsAppServiceMessage
    ? undefined
    : normalizeOptionalNodeId(match.selectedAction.data.actionReplyCtaFlowId);
  const actionReplyCtaType = actionWhatsAppServiceMessage
    ? "none"
    : normalizeReplyCtaTypeForActionNode({
        nodeData: match.selectedAction.data,
        actionLinkUrls,
        actionReplyCtaFlowId,
      });
  const actionReplyCtaLabelBase = actionWhatsAppServiceMessage
    ? undefined
    : normalizeOptionalNodeText(match.selectedAction.data.actionReplyCtaLabel);
  const actionReplyCtaLabel = actionReplyCtaLabelBase
    ? actionReplyCtaLabelBase.slice(0, 30)
    : undefined;

  const templateSideFlowConfig =
    match.selectedActionType === "whatsapp_template"
      ? normalizeFlowConfig(match.selectedAction.data.actionFlowConfig)
      : null;
  const actionFormResponseFields =
    match.selectedActionType === "whatsapp_template"
      ? readTemplateFormResponseFields(
          match.selectedAction.data,
          templateSideFlowConfig
        )
      : undefined;
  const flowPromptInputCapture = captureFlowTextPromptInputs({
    pathNodes,
    selectedActionNodeId: match.selectedAction.id,
    responseJson: params.whatsAppFlowResponseJson,
  });
  const choicePromptInputSource = readChoicePromptInputSource({
    pathNodes,
    selectedActionNodeId: match.selectedAction.id,
    quickReplyPayload: params.quickReplyPayload,
  });
  // Stored form answers name their sending step; AI steps read them by key.
  const formAnswerFields = readScenarioFormAnswerFieldMap(graph);
  const runtime: AiriScenarioRuntimeConfig = {
    scenarioId: candidate.scenarioId,
    scenarioName: candidate.scenarioName,
    scenarioUpdatedAt: normalizeDateIso(candidate.scenario.updatedAt),
    scenarioPriority: candidate.priority,
    selectedActionNodeId: match.selectedAction.id,
    selectedPathNodeIds: match.pathNodeIds,
    selectedBranchNodeIds: match.branchNodeIds,
    lockedByConversationState: params.lockedByConversationState,
    actionType: match.selectedActionType,
    actionReplyMode: selectedActionReplyMode,
    actionReplyChannel,
    actionReplyInstruction: actionWhatsAppServiceMessage
      ? whatsAppServiceBodySource?.mode === "ai"
        ? normalizeOptionalNodeText(whatsAppServiceBodySource.instruction)
        : undefined
      : normalizeOptionalNodeText(
          match.selectedAction.data.actionReplyInstruction
        ),
    actionReplyText: actionWhatsAppServiceMessage
      ? whatsAppServiceBodySource?.mode === "fixed"
        ? normalizeOptionalNodeText(whatsAppServiceBodySource.text)
        : undefined
      : normalizeOptionalNodeText(match.selectedAction.data.actionReplyText) ||
        normalizeOptionalNodeText(
          match.selectedAction.data.actionSnippetAnswer
        ) ||
        normalizeOptionalNodeText(
          match.selectedAction.data.actionReplyTemplate
        ),
    actionInstruction: normalizeOptionalNodeText(
      match.selectedAction.data.actionInstruction
    ),
    ...(match.selectedActionType === "assign_human"
      ? {
          actionHandoffNotifyEmail: normalizeOptionalNodeText(
            match.selectedAction.data.actionHandoffNotifyEmail
          ),
          actionHandoffNotifyWhatsapp: normalizeOptionalNodeText(
            match.selectedAction.data.actionHandoffNotifyWhatsapp
          ),
        }
      : {}),
    actionReplyTemplate: actionWhatsAppServiceMessage
      ? undefined
      : normalizeOptionalNodeText(
          match.selectedAction.data.actionReplyTemplate
        ),
    actionReplyCtaType:
      (match.selectedActionType === "reply" ||
        match.selectedActionType === "whatsapp_template") &&
      actionReplyCtaType !== "none"
        ? actionReplyCtaType
        : undefined,
    actionReplyCtaLabel:
      (match.selectedActionType === "reply" ||
        match.selectedActionType === "whatsapp_template") &&
      actionReplyCtaType !== "none"
        ? actionReplyCtaLabel
        : undefined,
    actionReplyCtaFlowId:
      (match.selectedActionType === "reply" && actionReplyCtaType === "flow") ||
      (match.selectedActionType === "whatsapp_template" &&
        actionReplyCtaType === "flow")
        ? actionReplyCtaFlowId
        : undefined,
    actionSnippetId: actionWhatsAppServiceMessage
      ? undefined
      : normalizeOptionalNodeId(match.selectedAction.data.actionSnippetId),
    actionSnippetQuestion: actionWhatsAppServiceMessage
      ? undefined
      : normalizeOptionalNodeText(
          match.selectedAction.data.actionSnippetQuestion
        ),
    actionSnippetAnswer: actionWhatsAppServiceMessage
      ? undefined
      : normalizeOptionalNodeText(
          match.selectedAction.data.actionSnippetAnswer
        ),
    actionWhatsAppTemplateId: actionWhatsAppServiceMessage
      ? undefined
      : normalizeOptionalNodeId(
          match.selectedAction.data.actionWhatsAppTemplateId
        ),
    actionWhatsAppTemplateName: actionWhatsAppServiceMessage
      ? undefined
      : normalizeOptionalNodeText(
          match.selectedAction.data.actionWhatsAppTemplateName
        ),
    actionWhatsAppTemplateLanguage: actionWhatsAppServiceMessage
      ? undefined
      : normalizeOptionalNodeText(
          match.selectedAction.data.actionWhatsAppTemplateLanguage
        ),
    actionWhatsAppTemplateComponents: actionWhatsAppServiceMessage
      ? undefined
      : normalizeWhatsAppTemplateComponents(
          match.selectedAction.data.actionWhatsAppTemplateComponents
        ),
    actionWhatsAppTemplateBindings: actionWhatsAppServiceMessage
      ? undefined
      : match.selectedAction.data.actionWhatsAppTemplateBindings,
    actionWhatsAppTemplateButtonIds: actionWhatsAppServiceMessage
      ? undefined
      : match.selectedAction.data.actionWhatsAppTemplateButtonIds,
    actionFlowConfig:
      match.selectedActionType === "whatsapp_template"
        ? templateSideFlowConfig
        : undefined,
    actionLinkUrls: actionLinkUrls.length > 0 ? actionLinkUrls : undefined,
    actionAttachments:
      !actionWhatsAppServiceMessage && actionAttachments.length > 0
        ? actionAttachments
        : undefined,
    actionImageUrls: actionWhatsAppServiceMessage
      ? undefined
      : actionAttachments.length > 0
        ? actionAttachments.map(attachment => attachment.url)
        : actionImageUrls.length > 0
          ? actionImageUrls
          : undefined,
    includeConversationTimeline,
    includeConversationSummaries: includeConversationTimeline,
    includeSnippets,
    includeKBArticles,
    includeIndexedUrls,
    includeQuickReplies,
    includeCustomerProfile,
    includePurchaseHistory,
    includeActiveSubscriptions,
    includeDynamicBusinessTags,
    contextSourcePriority:
      contextSourcePriority.length > 0 ? contextSourcePriority : undefined,
    conversationIds: conversationIds.length > 0 ? conversationIds : undefined,
    snippetIds: snippetIds.length > 0 ? snippetIds : undefined,
    kbArticleIds: kbArticleIds.length > 0 ? kbArticleIds : undefined,
    indexedUrlIds: indexedUrlIds.length > 0 ? indexedUrlIds : undefined,
    actionTelegramQuickReplies:
      match.selectedActionType === "reply" && actionReplyChannel === "telegram"
        ? normalizeTelegramQuickReplies(
            match.selectedAction.data.actionTelegramQuickReplies
          )
        : undefined,
    actionInstagramConfig:
      match.selectedActionType === "reply" && actionReplyChannel === "instagram"
        ? normalizeInstagramConfigForActionNode(
            match.selectedAction.data.actionInstagramConfig
          )
        : undefined,
    actionWhatsAppServiceMessage,
    scenarioRevisionFingerprint:
      match.selectedActionType === "generative_ai"
        ? buildScenarioRevisionFingerprintFromRecord(candidate.scenario)
        : undefined,
    ...(match.generativeAI ? { actionGenerativeAI: match.generativeAI } : {}),
    ...(Object.keys(formAnswerFields).length > 0 ? { formAnswerFields } : {}),
    ...(actionFormResponseFields ? { actionFormResponseFields } : {}),
    ...(flowPromptInputCapture ? { flowPromptInputCapture } : {}),
    ...(choicePromptInputSource ? { choicePromptInputSource } : {}),
  };
  if (
    params.hydrateQuickReplies !== false &&
    includeQuickReplies &&
    resolveScenarioReplyExecutionDecision(runtime).kind !== "direct_fixed"
  ) {
    const quickReplies = await loadQuickRepliesForScenario({
      workspaceId: params.workspaceId,
      channel: params.channel,
      quickReplyIds: quickReplyIds.length > 0 ? quickReplyIds : undefined,
    });
    runtime.quickReplies = quickReplies.length > 0 ? quickReplies : undefined;
  }
  const dispatchTransition = resolveScenarioDispatchTransition({
    graph,
    selectedAction: match.selectedAction,
    selectedActionType: match.selectedActionType,
    selectedPathNodeIds: match.pathNodeIds,
    conversation: params.conversation,
    channel: params.channel,
  });
  runtime.nextActionNodeId = dispatchTransition.nextActionNodeId;
  runtime.completesScenario = dispatchTransition.completesScenario;
  runtime.pendingConditionNodeId =
    dispatchTransition.pendingConditionNodeId || null;
  runtime.pendingSourceActionNodeId =
    dispatchTransition.pendingSourceActionNodeId || null;
  runtime.pendingLinkedConditionId =
    dispatchTransition.pendingLinkedConditionId || null;
  runtime.pendingLegacyRouting =
    dispatchTransition.pendingLegacyRouting || null;
  if (match.selectedActionType === "generative_ai") {
    const transitions = resolveGenerativeAIOutcomeTransitions({
      graph,
      selectedAction: match.selectedAction,
      conversation: params.conversation,
      channel: params.channel,
    });
    runtime.actionGenerativeAISuccessTransition = transitions.successTransition;
    runtime.actionGenerativeAIFailureTransition = transitions.failureTransition;
  }
  if (
    actionWhatsAppServiceMessage &&
    listRunnableScenarioPromptInputs(actionWhatsAppServiceMessage)
  ) {
    runtime.actionPromptInputsUnmetTransition =
      resolvePromptInputsUnmetTransition({
        graph,
        selectedAction: match.selectedAction,
        conversation: params.conversation,
        channel: params.channel,
      });
    if (
      readScenarioPromptInputAsk(actionWhatsAppServiceMessage.message) ===
        "text" &&
      runtime.pendingSourceActionNodeId === match.selectedAction.id
    ) {
      runtime.actionPromptInputsMetTransition =
        resolvePromptInputsMetTransition({
          graph,
          selectedAction: match.selectedAction,
          conversation: params.conversation,
          channel: params.channel,
        });
    }
  }

  return {
    runtime,
    triggerNodeId: matchedTriggerNode?.id || null,
    selectedActionNodeId: match.selectedAction.id,
    selectedActionType: match.selectedActionType,
    selectedBranchNodeIds: match.branchNodeIds,
    meta: buildScenarioTriggerEvaluationMeta({
      graph,
      triggerNodeId: matchedTriggerNode?.id,
      triggerConfig: matchedTriggerConfig,
      pathNodeIds: match.pathNodeIds,
      preferredActionNodeId: params.preferredActionNodeId,
      lockedByConversationState: params.lockedByConversationState,
      evaluationContext,
    }),
  };
}

// ---------------------------------------------------------------------------
export const previewScenarioEvaluation = traceableChain(
  previewScenarioEvaluationImpl,
  {
    name: "airi.scenario.preview_evaluation",
    tags: ["airi", "scenario", "preview"],
    getMetadata: params => ({
      workspace_id: params.workspaceId,
      conversation_id: String(params.conversation._id),
      channel: params.channel,
      event_kind: params.eventKind,
      preferred_language: params.triggerLanguage || null,
    }),
    processInputs: inputs => {
      const payload = ("input" in inputs ? inputs.input : inputs) as {
        workspaceId: string;
        conversation: ConversationDocument;
        channel: Channel;
        eventKind: ScenarioMessageIngressEventKind;
        messageText?: string;
        quickReplyPayload?: string | null;
        whatsAppFlowResponseJson?: string | null;
        triggerLanguage?: string | null;
        scenarios?: ScenarioRecord[];
      };
      return {
        workspace_id: payload.workspaceId,
        conversation_id: String(payload.conversation._id),
        channel: payload.channel,
        event_kind: payload.eventKind,
        message_preview: previewText(payload.messageText, 240),
        quick_reply_payload_preview: previewText(
          payload.quickReplyPayload,
          160
        ),
        trigger_language: payload.triggerLanguage || null,
        scenario_count: payload.scenarios?.length || null,
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as ScenarioPreviewResult;
      return {
        winner_scenario_id: result.winner?.scenarioId || null,
        winner_trigger_type: result.winner ? "incoming_customer_message" : null,
        evaluation_count: result.evaluations.length,
        matched_scenarios: previewStringArray(
          result.evaluations
            .filter(item => item.result !== "skipped")
            .map(item => item.scenarioName),
          5,
          80
        ),
      };
    },
  }
);

// Main entry point
// ---------------------------------------------------------------------------

async function resolveActiveScenarioRuntimeImpl(
  params: ResolveActiveScenarioRuntimeParams<ConversationDocument>
): Promise<AiriScenarioRuntimeResolution> {
  if (
    params.contentIndependentEntryOnly &&
    (params.channel !== "whatsapp" ||
      (params.triggerEventKind &&
        params.triggerEventKind !==
          SCENARIO_TRIGGER_EVENT_KIND.inboundMessage) ||
      params.forcedScenarioId ||
      params.forcedTriggerNodeId ||
      params.forcedActionNodeId ||
      params.skipTriggerMatch ||
      params.quickReplyPayload ||
      params.whatsAppFlowResponseJson ||
      !canStartUnavailableMessageScenario({
        scenarioState:
          params.scenarioState ?? params.conversation.airi_scenario_state,
        handoffActive: params.conversation.airi_handoff_active,
        pendingGenerativeExecution:
          "airi_pending_generative_execution" in params.conversation
            ? params.conversation.airi_pending_generative_execution
            : undefined,
      }))
  )
    return { runtime: null };
  await connectDB();

  const {
    quickReplyPayload: normalizedQuickReplyPayload,
    whatsAppFlowResponseJson: normalizedWhatsAppFlowResponseJson,
  } = normalizeInteractiveTriggerPayloads({
    quickReplyPayload: params.quickReplyPayload,
    whatsAppFlowResponseJson: params.whatsAppFlowResponseJson,
  });
  const resolvedTriggerEventKind = resolveDefaultTriggerEventKind({
    channel: params.channel,
    triggerEventKind: params.triggerEventKind,
    quickReplyPayload: normalizedQuickReplyPayload,
    whatsAppFlowResponseJson: normalizedWhatsAppFlowResponseJson,
  });
  const now = new Date();
  const normalizedScenarioState = normalizeConversationScenarioState(
    params.scenarioState
  );
  const lockedScenarioId = normalizedScenarioState?.lockedScenarioId
    ? String(normalizedScenarioState.lockedScenarioId)
    : null;
  const forcedScenarioId =
    typeof params.forcedScenarioId === "string"
      ? params.forcedScenarioId.trim()
      : "";
  const forcedActionNodeId =
    typeof params.forcedActionNodeId === "string"
      ? params.forcedActionNodeId.trim()
      : "";
  const excludeScenarioIds = (params.excludeScenarioIds || [])
    .map(id => id.trim())
    .filter(Boolean);
  const excludedScenarioIdSet = new Set(excludeScenarioIds);
  const persistedCurrentActionNodeId =
    normalizedScenarioState?.currentActionNodeId || undefined;
  const lockedScenarioPromise = lockedScenarioId
    ? fetchActiveScenarioById({
        workspaceId: params.workspaceId,
        scenarioId: lockedScenarioId,
      })
    : Promise.resolve(null);
  const [lockedScenario, forcedScenario] = await Promise.all([
    lockedScenarioPromise,
    forcedScenarioId
      ? forcedScenarioId === lockedScenarioId
        ? lockedScenarioPromise
        : fetchActiveScenarioById({
            workspaceId: params.workspaceId,
            scenarioId: forcedScenarioId,
          })
      : Promise.resolve(null),
  ]);

  if (params.expectedScenarioUpdatedAt !== undefined) {
    const expected = normalizeDateIso(params.expectedScenarioUpdatedAt);
    if (
      !forcedScenarioId ||
      !forcedScenario ||
      !expected ||
      normalizeDateIso(forcedScenario.updatedAt) !== expected ||
      (lockedScenarioId === forcedScenarioId &&
        normalizeDateIso(lockedScenario?.updatedAt) !== expected)
    ) {
      return { runtime: null, staleScenarioRevision: true };
    }
  }

  const conversationId = String(params.conversation._id || "");
  const evaluationId = randomUUID();
  const evaluatedAt = new Date(now.getTime());
  const defaultEventKind = resolvedTriggerEventKind;
  const eventIsIngress = isScenarioMessageIngressEventKind(defaultEventKind);
  const eventIsPostAction = isScenarioPostActionEventKind(defaultEventKind);
  const { isNewCustomer: conversationIsNewCustomer } =
    resolveConversationCustomerFacts(params.conversation);
  const conversationSourceId =
    typeof params.conversation.sourceId === "string"
      ? params.conversation.sourceId.trim()
      : "";
  const rawTriggerMessageText = params.contentIndependentEntryOnly
    ? ""
    : typeof params.triggerMessageText === "string"
      ? params.triggerMessageText
      : undefined;
  let whatsappQrAnchor: WhatsAppQrScenarioAnchorResult | null = null;
  if (
    eventIsIngress &&
    params.channel === "whatsapp" &&
    conversationSourceId &&
    typeof rawTriggerMessageText === "string" &&
    rawTriggerMessageText.length > 0
  ) {
    whatsappQrAnchor = await resolveWhatsAppQrScenarioAnchor({
      workspaceId: params.workspaceId,
      sourceId: conversationSourceId,
      messageText: rawTriggerMessageText,
      allowLegacyMissingPointerFallback:
        WHATSAPP_QR_RUNTIME_MISSING_POINTER_FALLBACK_ENABLED,
    });
  }
  const triggerMessageTextForIngress =
    whatsappQrAnchor && whatsappQrAnchor.kind !== "none"
      ? whatsappQrAnchor.effectiveText
      : rawTriggerMessageText;
  let ingressReferrals = eventIsIngress
    ? {
        whatsappReferral: params.triggerWhatsAppReferral ?? null,
        metaReferral: resolveConversationMetaReferral(params.conversation),
      }
    : null;
  let campaignLabelIngressLoaded = false;
  const projectCurrentIngress = () =>
    eventIsIngress
      ? projectScenarioIngressContext({
          eventKind: defaultEventKind,
          channel: params.channel,
          messageText: triggerMessageTextForIngress,
          messageContentAvailable: !params.contentIndependentEntryOnly,
          isNewCustomer: conversationIsNewCustomer,
          whatsappReferral: ingressReferrals?.whatsappReferral,
          metaReferral: ingressReferrals?.metaReferral,
        })
      : null;
  let ingress = projectCurrentIngress();
  const ensureCampaignLabelIngress = async (match: {
    skipTriggerMatch?: boolean;
    triggers: ReadonlyArray<ScenarioTriggerCandidate["triggerConfig"]>;
  }) => {
    if (!eventIsIngress || !ingressReferrals) return;
    if (!campaignLabelIngressLoaded && campaignLabelLookupRequired(match)) {
      campaignLabelIngressLoaded = true;
      ingressReferrals = await enrichScenarioIngressReferrals({
        workspaceId: params.workspaceId,
        whatsappReferral: ingressReferrals.whatsappReferral,
        metaReferral: ingressReferrals.metaReferral,
        required: true,
      });
    }
    ingress = projectCurrentIngress();
  };
  const lockedCandidate = lockedScenario
    ? compileScenarioCandidate(lockedScenario)
    : null;
  const forcedCandidate = forcedScenario
    ? lockedCandidate &&
      lockedCandidate.scenarioId === String(forcedScenario._id || "").trim()
      ? lockedCandidate
      : compileScenarioCandidate(forcedScenario)
    : null;
  const lockedScenarioMissing =
    !params.ignoreLockedScenario && lockedScenarioId && !lockedCandidate
      ? {
          scenarioId: lockedScenarioId,
          scenarioName: normalizedScenarioState?.lockedScenarioName || null,
        }
      : null;
  const structuredReplyActionNodeId =
    resolveScenarioStructuredReplyActionNodeId({
      triggerEventKind: defaultEventKind,
      quickReplyPayload:
        normalizedQuickReplyPayload || params.quickReplyPayload,
      whatsAppFlowResponseJson:
        normalizedWhatsAppFlowResponseJson || params.whatsAppFlowResponseJson,
    });
  const evaluationContext = buildScenarioTriggerLogEvaluationContext({
    conversation: params.conversation,
    channel: params.channel,
    quickReplyPayload: normalizedQuickReplyPayload || params.quickReplyPayload,
    whatsAppFlowResponseJson:
      normalizedWhatsAppFlowResponseJson || params.whatsAppFlowResponseJson,
    triggerLanguage: params.triggerLanguage,
  });
  const sessionLogs: ScenarioTriggerLogEvaluationParams[] = [];
  const pushScenarioSessionLog = (
    entry: Omit<
      ScenarioTriggerLogEvaluationParams,
      | "workspaceId"
      | "conversationId"
      | "evaluationId"
      | "eventKind"
      | "evaluatedAt"
    >
  ) => {
    sessionLogs.push({
      workspaceId: params.workspaceId,
      conversationId,
      evaluationId,
      eventKind: defaultEventKind,
      evaluatedAt,
      ...entry,
    });
  };
  const flushScenarioSessionLogs = async () => {
    if (sessionLogs.length === 0) {
      return;
    }

    const winnerLog =
      sessionLogs.find(item => item.result === "winner") || null;
    const winnerScenarioId = winnerLog?.scenarioId || null;
    const winnerOrder =
      typeof winnerLog?.candidateOrder === "number"
        ? winnerLog.candidateOrder
        : null;

    for (const entry of sessionLogs) {
      entry.winnerScenarioId = winnerScenarioId;
      if (entry.result === "matched_but_shadowed") {
        entry.shadowedByScenarioId = winnerScenarioId;
        entry.shadowedByOrder = winnerOrder;
      }
    }

    await logScenarioTriggerEvaluations(sessionLogs);
  };
  const buildTopLevelScenarioMeta = (metaParams: {
    candidate: ScenarioCandidate;
    selectedTrigger?: ScenarioTriggerCandidate | null;
    lockedByConversationState?: boolean;
    productRoute?: ScenarioCandidateSelection["productRoute"];
  }) => {
    const trigger =
      metaParams.selectedTrigger ??
      getPrimaryCompiledTrigger(metaParams.candidate);
    const baseMeta = buildScenarioTriggerEvaluationMeta({
      graph: metaParams.candidate.graph,
      triggerNodeId: trigger?.node.id,
      triggerConfig: trigger?.triggerConfig,
      preferredActionNodeId:
        shouldConstrainBranchReply || metaParams.lockedByConversationState
          ? preferredActionNodeId
          : undefined,
      lockedByConversationState: metaParams.lockedByConversationState,
      evaluationContext,
      productRoute: metaParams.productRoute,
    });
    return attachWhatsAppQrTriggerLogMeta(baseMeta, whatsappQrAnchor);
  };
  // A Flow reply takes a step's "Form submitted" route only when it submits
  // the form that step of the locked scenario sent.
  const flowReplySourceActionNodeId =
    defaultEventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply &&
    lockedScenarioId &&
    params.whatsAppFlowReplySource?.scenarioId === lockedScenarioId
      ? params.whatsAppFlowReplySource.actionNodeId.trim() || undefined
      : undefined;
  const preferredActionNodeId =
    forcedActionNodeId ||
    structuredReplyActionNodeId ||
    resolvePreferredContinuationActionNodeId({
      scenario: lockedScenario,
      currentActionNodeId: persistedCurrentActionNodeId,
      currentPathNodeIds: normalizedScenarioState?.currentPathNodeIds,
      eventKind: defaultEventKind,
      flowReplySourceActionNodeId,
    });
  const shouldConstrainBranchReply =
    !params.ignoreLockedScenario &&
    isScenarioInteractiveReplyEventKind(defaultEventKind) &&
    Boolean(preferredActionNodeId);
  let containsTriggerMatchedNoAction = false;
  if (
    forcedScenarioId &&
    eventIsIngress &&
    whatsappQrAnchor?.kind === "fail_closed"
  ) {
    pushScenarioSessionLog({
      scenarioId: whatsappQrAnchor.scenarioId || "__whatsapp_qr_fail_closed__",
      scenarioName: "WhatsApp QR",
      scenarioPriority: null,
      candidateOrder: 1,
      matchingRole: null,
      result: resolveWhatsAppQrFailClosedLogResult(whatsappQrAnchor.reason),
      matched: false,
      mismatchReason: whatsappQrAnchor.reason,
      meta: attachWhatsAppQrTriggerLogMeta(
        whatsappQrAnchor.nodeId
          ? { triggerNodeId: whatsappQrAnchor.nodeId }
          : null,
        whatsappQrAnchor
      ),
    });
    await flushScenarioSessionLogs();
    return attachWhatsAppQrTrace({ runtime: null }, whatsappQrAnchor);
  }
  if (forcedScenarioId) {
    if (excludedScenarioIdSet.has(forcedScenarioId)) {
      return attachWhatsAppQrTrace({ runtime: null }, whatsappQrAnchor);
    }
    if (!forcedScenario || !forcedCandidate) {
      return attachWhatsAppQrTrace({ runtime: null }, whatsappQrAnchor);
    }

    const forcedEligibility = evaluateScenarioEntryEligibility({
      scenarioId: forcedCandidate.scenarioId,
      entryPolicy: forcedCandidate.entryPolicy,
      normalizedScenarioState,
      allowCurrentLockedScenario: lockedScenarioId === forcedScenarioId,
    });
    if (!forcedEligibility.eligible) {
      pushScenarioSessionLog({
        scenarioId: forcedCandidate.scenarioId,
        scenarioName: forcedCandidate.scenarioName,
        scenarioPriority: forcedCandidate.priority,
        candidateOrder: 1,
        matchingRole: forcedCandidate.matchingRole,
        result: "blocked",
        matched: false,
        mismatchReason: forcedEligibility.reason,
        meta: buildTopLevelScenarioMeta({
          candidate: forcedCandidate,
          lockedByConversationState: lockedScenarioId === forcedScenarioId,
        }),
      });
      await flushScenarioSessionLogs();
      return attachWhatsAppQrTrace({ runtime: null }, whatsappQrAnchor);
    }

    const forcedSkipTriggerMatch = shouldSkipTriggerMatchDuringRuntimeBuild({
      skipTriggerMatch: params.skipTriggerMatch || eventIsPostAction,
      triggerEventKind: defaultEventKind,
      lockedByConversationState: lockedScenarioId === forcedScenarioId,
      preferredActionNodeId:
        shouldConstrainBranchReply || lockedScenarioId === forcedScenarioId
          ? preferredActionNodeId
          : undefined,
      graph: forcedCandidate.graph,
    });
    await ensureCampaignLabelIngress({
      skipTriggerMatch: forcedSkipTriggerMatch,
      triggers: forcedCandidate.compiledTriggerCandidates.map(
        trigger => trigger.triggerConfig
      ),
    });
    const forcedSelectedTrigger = resolveSelectedTriggerForBuild({
      candidate: forcedCandidate,
      ingress,
      triggerNodeId: params.forcedTriggerNodeId,
      skipTriggerMatch: forcedSkipTriggerMatch,
    });
    // A forced post-action continuation leaves the wait the conversation
    // claimed; its state still names the waiting action.
    const continuationSourceActionNodeId =
      forcedActionNodeId &&
      eventIsPostAction &&
      lockedScenarioId === forcedScenarioId
        ? normalizedScenarioState?.pendingSourceActionNodeId || undefined
        : undefined;
    const forcedBuild = await buildRuntimeForScenario({
      candidate: forcedCandidate,
      selectedTrigger: forcedSelectedTrigger,
      workspaceId: params.workspaceId,
      conversation: params.conversation,
      channel: params.channel,
      preferredActionNodeId:
        shouldConstrainBranchReply || lockedScenarioId === forcedScenarioId
          ? preferredActionNodeId
          : undefined,
      requiredActionNodeId: forcedActionNodeId || undefined,
      continuationSourceActionNodeId,
      lockedByConversationState: lockedScenarioId === forcedScenarioId,
      triggerEventKind: defaultEventKind,
      quickReplyPayload:
        normalizedQuickReplyPayload || params.quickReplyPayload,
      whatsAppFlowResponseJson:
        normalizedWhatsAppFlowResponseJson || params.whatsAppFlowResponseJson,
      flowReplySourceActionNodeId:
        lockedScenarioId === forcedScenarioId
          ? flowReplySourceActionNodeId
          : undefined,
      generativeInbound: params.generativeInbound,
      triggerLanguage: params.triggerLanguage,
      skipTriggerMatch: forcedSkipTriggerMatch,
      now,
    });
    pushScenarioSessionLog({
      scenarioId: forcedCandidate.scenarioId,
      scenarioName: forcedCandidate.scenarioName,
      scenarioPriority: forcedCandidate.priority,
      candidateOrder: 1,
      matchingRole: forcedCandidate.matchingRole,
      result: forcedBuild.runtime
        ? "winner"
        : forcedBuild.blockedScenarioAction
          ? "blocked"
          : mapForcedBuildToSessionLogResult(forcedBuild.mismatchReason),
      matched: Boolean(forcedBuild.runtime),
      mismatchReason: forcedBuild.mismatchReason,
      selectedActionNodeId: forcedBuild.selectedActionNodeId,
      selectedActionType: forcedBuild.selectedActionType,
      branchNodeIds: forcedBuild.selectedBranchNodeIds,
      meta: forcedBuild.meta,
    });
    await flushScenarioSessionLogs();
    if (forcedBuild.blockedScenarioAction) {
      return attachWhatsAppQrTrace(
        {
          runtime: null,
          blockedScenarioAction: forcedBuild.blockedScenarioAction,
        },
        whatsappQrAnchor
      );
    }
    if (!forcedBuild.runtime) {
      if (
        forcedBuild.meta?.filters?.messageMatchMode === "contains" &&
        forcedBuild.mismatchReason === "flow_no_matching_action"
      ) {
        containsTriggerMatchedNoAction = true;
      }
      return attachWhatsAppQrTrace(
        {
          runtime: null,
          ...(containsTriggerMatchedNoAction
            ? { containsTriggerMatchedNoAction: true }
            : {}),
        },
        whatsappQrAnchor
      );
    }

    forcedBuild.runtime.evaluationId = evaluationId;
    return attachWhatsAppQrTrace(
      { runtime: forcedBuild.runtime },
      whatsappQrAnchor
    );
  }

  if (eventIsPostAction && lockedScenarioMissing) {
    await flushScenarioSessionLogs();
    return attachWhatsAppQrTrace(
      {
        runtime: null,
        lockedScenarioMissing,
      },
      whatsappQrAnchor
    );
  }

  if (
    (!eventIsIngress && !eventIsPostAction) ||
    (eventIsPostAction && (params.ignoreLockedScenario || !lockedCandidate))
  ) {
    await flushScenarioSessionLogs();
    return attachWhatsAppQrTrace({ runtime: null }, whatsappQrAnchor);
  }

  const lockedScenarioTakesEvent =
    !params.ignoreLockedScenario &&
    Boolean(lockedScenarioId) &&
    Boolean(lockedScenario) &&
    (eventIsPostAction ||
      shouldPinLockedScenarioForEvent({
        scenario: lockedScenario,
        currentActionNodeId: persistedCurrentActionNodeId,
        currentPathNodeIds: normalizedScenarioState?.currentPathNodeIds,
        eventKind: defaultEventKind,
        flowReplySourceActionNodeId,
      }));
  // A tap on an older campaign's button names a step the locked scenario
  // lacks; the payload anchor below finds the scenario that sent it. While
  // the locked scenario waits with a No-reply follow-up, the tap stays with
  // it instead: only an explicit stop may end that follow-up.
  const shouldPinToLockedScenario =
    lockedScenarioTakesEvent &&
    !(
      structuredReplyActionNodeId &&
      lockedCandidate &&
      !lockedCandidate.graph.nodesById.has(structuredReplyActionNodeId) &&
      !params.lockedScenarioFollowUpPending
    );
  const isLockedStructuredReply = isLockedStructuredReplyEvent({
    ignoreLockedScenario: params.ignoreLockedScenario,
    lockedScenarioId,
    triggerEventKind: defaultEventKind,
  });
  const shouldUseQrFailClosed = whatsappQrAnchor?.kind === "fail_closed";
  const shouldUseQrAnchor =
    whatsappQrAnchor?.kind === "anchored" &&
    !(
      shouldPinToLockedScenario &&
      lockedScenarioId !== whatsappQrAnchor.scenarioId
    );

  let fetchedCandidates: ScenarioCandidate[] = [];
  if (shouldUseQrFailClosed) {
    fetchedCandidates = [];
  } else if (shouldUseQrAnchor && whatsappQrAnchor?.kind === "anchored") {
    if (
      lockedCandidate &&
      lockedCandidate.scenarioId === whatsappQrAnchor.scenarioId
    ) {
      fetchedCandidates = [lockedCandidate];
    } else {
      const anchoredScenario = await fetchActiveScenarioById({
        workspaceId: params.workspaceId,
        scenarioId: whatsappQrAnchor.scenarioId,
      });
      fetchedCandidates = anchoredScenario
        ? [compileScenarioCandidate(anchoredScenario)]
        : [];
    }
  } else if (shouldPinToLockedScenario) {
    fetchedCandidates = lockedCandidate ? [lockedCandidate] : [];
  } else {
    fetchedCandidates = (
      await fetchActiveScenariosForWorkspace({
        workspaceId: params.workspaceId,
        limitToPriority: params.limitToPriority,
        excludeScenarioIds,
        triggerProjection:
          !structuredReplyActionNodeId && !params.skipTriggerMatch,
      })
    ).map(compileScenarioCandidate);
  }

  const payloadAnchoredActionNodeId =
    !shouldPinToLockedScenario &&
    !shouldUseQrAnchor &&
    !shouldUseQrFailClosed &&
    isScenarioInteractiveReplyEventKind(defaultEventKind)
      ? structuredReplyActionNodeId
      : null;
  const payloadAnchoredScenarioIdSet = new Set<string>();
  const payloadAnchoredCandidates = payloadAnchoredActionNodeId
    ? fetchedCandidates.filter(candidate => {
        const node = candidate.graph.nodesById.get(payloadAnchoredActionNodeId);
        const hasAnchor = node?.data.kind === "action";
        if (hasAnchor) {
          payloadAnchoredScenarioIdSet.add(candidate.scenarioId);
        }
        return hasAnchor;
      })
    : fetchedCandidates;

  let scenarioSelections: readonly ScenarioCandidateSelection[] = [];
  if (shouldUseQrFailClosed && whatsappQrAnchor?.kind === "fail_closed") {
    scenarioSelections = [];
    pushScenarioSessionLog({
      scenarioId: whatsappQrAnchor.scenarioId || "__whatsapp_qr_fail_closed__",
      scenarioName: "WhatsApp QR",
      scenarioPriority: null,
      candidateOrder: 1,
      matchingRole: null,
      result: resolveWhatsAppQrFailClosedLogResult(whatsappQrAnchor.reason),
      matched: false,
      mismatchReason: whatsappQrAnchor.reason,
      meta: attachWhatsAppQrTriggerLogMeta(
        whatsappQrAnchor.nodeId
          ? { triggerNodeId: whatsappQrAnchor.nodeId }
          : null,
        whatsappQrAnchor
      ),
    });
  } else if (shouldUseQrAnchor && whatsappQrAnchor?.kind === "anchored") {
    const anchoredScenarioId = whatsappQrAnchor.scenarioId;
    const anchoredNodeId = whatsappQrAnchor.nodeId;
    scenarioSelections = payloadAnchoredCandidates.map(candidate => {
      const selectedTrigger =
        candidate.compiledTriggerCandidates.find(
          trigger => trigger.node.id === anchoredNodeId
        ) ?? null;
      return Object.freeze({
        candidate,
        selectedTrigger,
      });
    });
    if (
      scenarioSelections.length === 0 ||
      !scenarioSelections[0]?.selectedTrigger
    ) {
      whatsappQrAnchor = {
        kind: "fail_closed",
        effectiveText: whatsappQrAnchor.effectiveText,
        reason:
          scenarioSelections.length === 0
            ? "scenario_missing"
            : "trigger_missing",
        scenarioId: anchoredScenarioId,
        nodeId: whatsappQrAnchor.nodeId,
        entryPointId: whatsappQrAnchor.entryPointId,
        codeId: whatsappQrAnchor.codeId,
      };
      pushScenarioSessionLog({
        scenarioId: anchoredScenarioId,
        scenarioName: "WhatsApp QR",
        scenarioPriority: null,
        candidateOrder: 1,
        matchingRole: null,
        result: "trigger_mismatch",
        matched: false,
        mismatchReason:
          scenarioSelections.length === 0
            ? "scenario_missing"
            : "trigger_missing",
        meta: attachWhatsAppQrTriggerLogMeta(
          { triggerNodeId: whatsappQrAnchor.nodeId },
          whatsappQrAnchor
        ),
      });
      scenarioSelections = [];
    }
  } else if (shouldPinToLockedScenario) {
    const lockedMatchSkipped = lockedCandidate
      ? shouldSkipTriggerMatchDuringRuntimeBuild({
          skipTriggerMatch:
            params.skipTriggerMatch ||
            (eventIsPostAction && shouldPinToLockedScenario),
          triggerEventKind: defaultEventKind,
          lockedByConversationState: true,
          preferredActionNodeId:
            shouldConstrainBranchReply || shouldPinToLockedScenario
              ? preferredActionNodeId
              : undefined,
          graph: lockedCandidate.graph,
        })
      : true;
    await ensureCampaignLabelIngress({
      skipTriggerMatch: lockedMatchSkipped,
      triggers: payloadAnchoredCandidates.flatMap(candidate =>
        candidate.compiledTriggerCandidates.map(
          trigger => trigger.triggerConfig
        )
      ),
    });
    scenarioSelections = payloadAnchoredCandidates.map(candidate => ({
      candidate,
      // An admitted continuation belongs to its action, not a different entry
      // root that happens to match this reply (for example, a catch-all root).
      selectedTrigger: resolveSelectedTriggerForBuild({
        candidate,
        ingress,
        skipTriggerMatch: lockedMatchSkipped,
      }),
    }));
  } else if (ingress) {
    if (!payloadAnchoredActionNodeId) {
      await ensureCampaignLabelIngress({
        triggers: payloadAnchoredCandidates.flatMap(candidate =>
          candidate.compiledTriggerCandidates.map(
            trigger => trigger.triggerConfig
          )
        ),
      });
    }
    scenarioSelections = payloadAnchoredActionNodeId
      ? orderTopLevelScenarioCandidates(payloadAnchoredCandidates).map(
          candidate => ({
            candidate,
            selectedTrigger: null,
          })
        )
      : selectTopLevelScenarioCandidates(payloadAnchoredCandidates, ingress);
  }

  if (!shouldPinToLockedScenario) {
    airiOrchestrationLogger.info("airi.orchestration.scenario", {
      workspaceId: params.workspaceId,
      conversationId,
      eventKind: defaultEventKind,
      note: "top_level_candidates",
      structuredReplyActionNodeId: structuredReplyActionNodeId || null,
      candidateSelection: shouldUseQrFailClosed
        ? "whatsapp_qr_fail_closed"
        : shouldUseQrAnchor
          ? "whatsapp_qr_anchor"
          : payloadAnchoredActionNodeId
            ? "structured_reply_anchor"
            : "default",
      triggerMessageTextPreview:
        typeof triggerMessageTextForIngress === "string"
          ? extractWhatsAppQrReference(triggerMessageTextForIngress)
              .effectiveText.trim()
              .slice(0, 120) || null
          : null,
      candidates: scenarioSelections.map(selection => ({
        scenarioId: selection.candidate.scenarioId,
        scenarioName: selection.candidate.scenarioName,
        scenarioPriority: selection.candidate.priority,
        matchingRole: selection.candidate.matchingRole,
        triggerSpecificity: selection.selectedTrigger?.specificity ?? 0,
      })),
    });
  }
  let fallbackSuppressedCurrentSession: boolean | null = null;
  let winningRuntime: AiriScenarioRuntimeConfig | null = null;
  let winningScenarioDetails: {
    scenarioId: string;
    scenarioName: string;
    scenarioPriority: number;
    matchingRole: ScenarioMatchingRole;
  } | null = null;

  for (const [index, selection] of scenarioSelections.entries()) {
    const { candidate } = selection;
    const {
      scenarioId,
      scenarioName,
      matchingRole,
      priority: scenarioPriority,
    } = candidate;
    if (excludedScenarioIdSet.has(scenarioId)) {
      continue;
    }
    const candidateOrder = index + 1;
    const isPayloadAnchoredContinuation =
      Boolean(payloadAnchoredActionNodeId) &&
      payloadAnchoredScenarioIdSet.has(scenarioId);
    const scenarioEligibility = isPayloadAnchoredContinuation
      ? { eligible: true as const }
      : evaluateScenarioEntryEligibility({
          scenarioId,
          entryPolicy: candidate.entryPolicy,
          normalizedScenarioState,
          allowCurrentLockedScenario:
            shouldPinToLockedScenario ||
            (isLockedStructuredReply && scenarioId === lockedScenarioId),
        });
    if (!scenarioEligibility.eligible) {
      pushScenarioSessionLog({
        scenarioId,
        scenarioName,
        scenarioPriority,
        candidateOrder,
        matchingRole,
        result: "blocked",
        matched: false,
        mismatchReason: scenarioEligibility.reason,
        meta: buildTopLevelScenarioMeta({
          candidate,
          selectedTrigger: selection.selectedTrigger,
          lockedByConversationState: shouldPinToLockedScenario,
        }),
      });
      continue;
    }

    if (!shouldPinToLockedScenario && matchingRole === "fallback") {
      if (fallbackSuppressedCurrentSession === null) {
        fallbackSuppressedCurrentSession =
          await shouldSuppressFallbackForCurrentSession({
            matchingRole,
            scenarioFacts: scenarioSelections.map(item => ({
              scenarioId: item.candidate.scenarioId,
              matchingRole: item.candidate.matchingRole,
            })),
            normalizedScenarioState,
            conversationId,
          });
      }
      if (fallbackSuppressedCurrentSession) {
        pushScenarioSessionLog({
          scenarioId,
          scenarioName,
          scenarioPriority,
          candidateOrder,
          matchingRole,
          result: "blocked",
          matched: false,
          mismatchReason: "fallback_suppressed_recent_specific_session",
          meta: buildTopLevelScenarioMeta({
            candidate,
            selectedTrigger: selection.selectedTrigger,
            lockedByConversationState: shouldPinToLockedScenario,
          }),
        });
        continue;
      }
    }

    const skipTriggerMatch = shouldSkipTriggerMatchDuringRuntimeBuild({
      skipTriggerMatch:
        params.skipTriggerMatch ||
        isPayloadAnchoredContinuation ||
        (eventIsPostAction && shouldPinToLockedScenario),
      triggerEventKind: defaultEventKind,
      lockedByConversationState: shouldPinToLockedScenario,
      preferredActionNodeId:
        shouldConstrainBranchReply || shouldPinToLockedScenario
          ? preferredActionNodeId
          : undefined,
      graph: candidate.graph,
    });
    const selectedTrigger =
      selection.selectedTrigger ??
      (selection.productRoutingEvaluated
        ? null
        : resolveSelectedTriggerForBuild({
            candidate,
            ingress,
            skipTriggerMatch,
          }));
    const runtimeBuild = await buildRuntimeForScenario({
      candidate,
      selectedTrigger,
      productRoute: selection.productRoute,
      contentIndependentEntryOnly: params.contentIndependentEntryOnly,
      hydrateQuickReplies: !winningRuntime,
      workspaceId: params.workspaceId,
      conversation: params.conversation,
      channel: params.channel,
      preferredActionNodeId:
        shouldConstrainBranchReply || shouldPinToLockedScenario
          ? preferredActionNodeId
          : undefined,
      // A typed continuation resumes this exact action. If its run conditions
      // fail, do not repeat an earlier question or start an unrelated root.
      // Interactive and post-action events still resolve their branch targets.
      requiredActionNodeId:
        shouldPinToLockedScenario &&
        defaultEventKind === SCENARIO_TRIGGER_EVENT_KIND.inboundMessage
          ? preferredActionNodeId
          : undefined,
      lockedByConversationState: shouldPinToLockedScenario,
      triggerEventKind: defaultEventKind,
      quickReplyPayload:
        normalizedQuickReplyPayload || params.quickReplyPayload,
      whatsAppFlowResponseJson:
        normalizedWhatsAppFlowResponseJson || params.whatsAppFlowResponseJson,
      flowReplySourceActionNodeId:
        scenarioId === lockedScenarioId
          ? flowReplySourceActionNodeId
          : undefined,
      generativeInbound: params.generativeInbound,
      triggerLanguage: params.triggerLanguage,
      skipTriggerMatch,
      now,
    });

    if (!runtimeBuild.runtime) {
      pushScenarioSessionLog({
        scenarioId,
        scenarioName,
        scenarioPriority,
        candidateOrder,
        matchingRole,
        result: runtimeBuild.blockedScenarioAction
          ? "blocked"
          : mapRuntimeBuildToSessionLogResult(runtimeBuild.mismatchReason),
        matched: false,
        mismatchReason: runtimeBuild.mismatchReason,
        selectedActionNodeId: runtimeBuild.selectedActionNodeId,
        selectedActionType: runtimeBuild.selectedActionType,
        branchNodeIds: runtimeBuild.selectedBranchNodeIds,
        meta: attachWhatsAppQrTriggerLogMeta(
          runtimeBuild.meta,
          shouldUseQrAnchor ? whatsappQrAnchor : null
        ),
      });
      if (runtimeBuild.blockedScenarioAction) {
        await flushScenarioSessionLogs();
        return attachWhatsAppQrTrace(
          {
            runtime: null,
            blockedScenarioAction: runtimeBuild.blockedScenarioAction,
          },
          whatsappQrAnchor
        );
      }
      if (
        runtimeBuild.meta?.filters?.messageMatchMode === "contains" &&
        runtimeBuild.mismatchReason === "flow_no_matching_action"
      ) {
        containsTriggerMatchedNoAction = true;
      }
      continue;
    }

    if (!winningRuntime) {
      runtimeBuild.runtime.evaluationId = evaluationId;
      winningRuntime = runtimeBuild.runtime;
      winningScenarioDetails = {
        scenarioId,
        scenarioName,
        scenarioPriority,
        matchingRole,
      };
      pushScenarioSessionLog({
        scenarioId,
        scenarioName,
        scenarioPriority,
        candidateOrder,
        matchingRole,
        result: "winner",
        matched: true,
        selectedActionNodeId: runtimeBuild.selectedActionNodeId,
        selectedActionType: runtimeBuild.selectedActionType,
        branchNodeIds: runtimeBuild.selectedBranchNodeIds,
        meta: attachWhatsAppQrTriggerLogMeta(
          runtimeBuild.meta,
          shouldUseQrAnchor ? whatsappQrAnchor : null
        ),
      });
      continue;
    }

    pushScenarioSessionLog({
      scenarioId,
      scenarioName,
      scenarioPriority,
      candidateOrder,
      matchingRole,
      result: "matched_but_shadowed",
      matched: false,
      selectedActionNodeId: runtimeBuild.selectedActionNodeId,
      selectedActionType: runtimeBuild.selectedActionType,
      branchNodeIds: runtimeBuild.selectedBranchNodeIds,
      meta: attachWhatsAppQrTriggerLogMeta(
        runtimeBuild.meta,
        shouldUseQrAnchor ? whatsappQrAnchor : null
      ),
    });
  }

  await flushScenarioSessionLogs();

  if (winningRuntime && winningScenarioDetails) {
    airiOrchestrationLogger.info("airi.orchestration.scenario", {
      workspaceId: params.workspaceId,
      conversationId,
      eventKind: defaultEventKind,
      note: "top_level_winner",
      scenarioId: winningScenarioDetails.scenarioId,
      scenarioName: winningScenarioDetails.scenarioName,
      scenarioPriority: winningScenarioDetails.scenarioPriority,
      matchingRole: winningScenarioDetails.matchingRole,
    });
    return attachWhatsAppQrTrace({ runtime: winningRuntime }, whatsappQrAnchor);
  }

  // A tap on a step no active scenario routes still misses the locked one.
  if (lockedScenarioTakesEvent) {
    return attachWhatsAppQrTrace(
      {
        runtime: null,
        ...(containsTriggerMatchedNoAction
          ? { containsTriggerMatchedNoAction: true }
          : {}),
        lockedScenarioNoMatch: {
          scenarioId: lockedScenarioId || "",
          scenarioName:
            typeof lockedScenario?.name === "string" &&
            lockedScenario.name.trim()
              ? lockedScenario.name.trim()
              : normalizedScenarioState?.lockedScenarioName || "Scenario",
          lastMatchedAt: normalizedScenarioState?.lastMatchedAt || null,
          lastActionNodeId:
            normalizedScenarioState?.currentActionNodeId || null,
          lastMessageId: normalizedScenarioState?.lastMessageId || null,
        },
      },
      whatsappQrAnchor
    );
  }

  if (lockedScenarioMissing) {
    return attachWhatsAppQrTrace(
      {
        runtime: null,
        ...(containsTriggerMatchedNoAction
          ? { containsTriggerMatchedNoAction: true }
          : {}),
        lockedScenarioMissing,
      },
      whatsappQrAnchor
    );
  }

  return attachWhatsAppQrTrace(
    {
      runtime: null,
      ...(containsTriggerMatchedNoAction
        ? { containsTriggerMatchedNoAction: true }
        : {}),
    },
    whatsappQrAnchor
  );
}

export const resolveActiveScenarioRuntime = traceableChain(
  resolveActiveScenarioRuntimeImpl,
  {
    name: "airi.scenario.resolve_runtime",
    tags: ["airi", "scenario", "runtime"],
    getMetadata: params => ({
      workspace_id: params.workspaceId,
      conversation_id: String(params.conversation._id),
      channel: params.channel,
      scenario_id: params.forcedScenarioId || null,
      event_kind:
        params.triggerEventKind || SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
      preferred_language: params.triggerLanguage || null,
    }),
    processInputs: inputs => {
      const payload = ("input" in inputs ? inputs.input : inputs) as {
        workspaceId: string;
        conversation: ConversationDocument;
        channel: Channel;
        forcedScenarioId?: string | null;
        triggerEventKind?: ScenarioRuntimeEventKind;
        triggerMessageText?: string;
        quickReplyPayload?: string | null;
        triggerLanguage?: string | null;
        excludeScenarioIds?: string[];
      };
      const triggerMessageText =
        typeof payload.triggerMessageText === "string"
          ? payload.triggerMessageText
          : undefined;
      const whatsappQrReference = triggerMessageText
        ? extractWhatsAppQrReference(triggerMessageText)
        : null;
      const whatsappQrReferencePresent = Boolean(
        whatsappQrReference &&
          whatsappQrReference.effectiveText !== whatsappQrReference.rawText
      );
      return {
        workspace_id: payload.workspaceId,
        conversation_id: String(payload.conversation._id),
        channel: payload.channel,
        forced_scenario_id: payload.forcedScenarioId || null,
        trigger_event_kind:
          payload.triggerEventKind ||
          SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
        whatsapp_qr_reference_present: whatsappQrReferencePresent,
        trigger_message_preview: whatsappQrReferencePresent
          ? null
          : previewText(triggerMessageText, 240),
        quick_reply_payload_preview: previewText(
          payload.quickReplyPayload,
          160
        ),
        trigger_language: payload.triggerLanguage || null,
        exclude_scenario_ids: previewStringArray(
          payload.excludeScenarioIds || [],
          6,
          48
        ),
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as AiriScenarioRuntimeResolution;
      return {
        runtime_scenario_id: result.runtime?.scenarioId || null,
        runtime_scenario_name: result.runtime?.scenarioName || null,
        contains_trigger_matched_no_action:
          result.containsTriggerMatchedNoAction || false,
        locked_scenario_no_match:
          result.lockedScenarioNoMatch?.scenarioId || null,
        locked_scenario_missing:
          result.lockedScenarioMissing?.scenarioId || null,
        whatsapp_qr_reference_present:
          result.whatsappQrTrace?.referencePresent || false,
        whatsapp_qr_outcome: result.whatsappQrTrace?.outcome || null,
        whatsapp_qr_reason_code: result.whatsappQrTrace?.reasonCode || null,
        whatsapp_qr_entry_point_id:
          result.whatsappQrTrace?.entryPointId || null,
        whatsapp_qr_scenario_id: result.whatsappQrTrace?.scenarioId || null,
        whatsapp_qr_node_id: result.whatsappQrTrace?.nodeId || null,
        whatsapp_qr_code_id: result.whatsappQrTrace?.codeId || null,
      };
    },
  }
);
