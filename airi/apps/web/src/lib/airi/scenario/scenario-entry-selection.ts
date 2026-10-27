import type {
  ScenarioEntryPolicy,
  ScenarioMatchingRole,
  ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import {
  evaluateScenarioEntryPolicy,
  type ScenarioEntryPolicyEvaluation,
} from "@/lib/airi/scenario/scenario-entry-policy";
import {
  getStageLabelFromInternalLabels,
  resolveConversationCustomerFacts,
  resolveConversationSegmentRouting,
} from "@/lib/airi/scenario/scenario-audience";
import type { ScenarioEvaluationContextSnapshot } from "@/lib/airi/scenario/scenario-runtime-types";
import { toStringArray } from "@/lib/scenarios/normalization";
import {
  type ConversationScenarioState,
  type ScenarioCompletionEntry,
} from "@icecore/airi-runtime/scenario-state";
import { readEntityId } from "@/lib/scenarios/task-utils";
import {
  buildScenarioTriggerLogFilterSummary,
  buildScenarioTriggerLogPathMeta,
  buildScenarioTriggerLogTemplateButtonTap,
  type ScenarioTriggerLogMeta,
} from "@/lib/scenarios/trigger-log-meta";
import Message from "@/models/message";
import type { Channel, ConversationDocument } from "@/types/models";
import type { CompiledScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
// ---------------------------------------------------------------------------
// Eligibility helpers
// ---------------------------------------------------------------------------

function getLatestScenarioCompletion(params: {
  state: ConversationScenarioState | null;
  scenarioId: string;
}): ScenarioCompletionEntry | null {
  const entries = params.state?.completedScenarios;
  if (!entries || entries.length === 0) return null;
  let latest: ScenarioCompletionEntry | null = null;
  for (const entry of entries) {
    if (entry.scenarioId !== params.scenarioId) continue;
    if (!latest) {
      latest = entry;
      continue;
    }
    const currentTime = new Date(entry.completedAt).getTime();
    const latestTime = new Date(latest.completedAt).getTime();
    if (currentTime > latestTime) {
      latest = entry;
    }
  }
  return latest;
}

const FALLBACK_SESSION_RESET_WINDOW_MS = 24 * 60 * 60 * 1000;

export function buildScenarioTriggerEvaluationMeta(params: {
  graph: CompiledScenarioGraph;
  triggerNodeId?: string | null;
  triggerConfig?: ScenarioTriggerConfig | null;
  pathNodeIds?: string[] | null;
  preferredActionNodeId?: string | null;
  lockedByConversationState?: boolean;
  evaluationContext?: ScenarioTriggerLogMeta["evaluationContext"] | null;
  productRoute?: ScenarioTriggerLogMeta["productRoute"];
}): ScenarioTriggerLogMeta | null {
  const candidateActionNodeIds = params.graph.runtimeActionNodes.map(
    node => node.id
  );
  const pathMeta = buildScenarioTriggerLogPathMeta({
    graph: params.graph,
    pathNodeIds: params.pathNodeIds,
  });
  const filters = buildScenarioTriggerLogFilterSummary(params.triggerConfig);
  const triggerNodeId =
    typeof params.triggerNodeId === "string" && params.triggerNodeId.trim()
      ? params.triggerNodeId.trim()
      : null;
  const preferredActionNodeId =
    typeof params.preferredActionNodeId === "string" &&
    params.preferredActionNodeId.trim()
      ? params.preferredActionNodeId.trim()
      : null;

  const templateButtonTap = buildScenarioTriggerLogTemplateButtonTap({
    graph: params.graph,
    quickReplyPayload: params.evaluationContext?.quickReplyPayload,
  });

  const meta: ScenarioTriggerLogMeta = {
    triggerNodeId,
    filters,
    ...pathMeta,
    candidateActionNodeIds,
    preferredActionNodeId,
    lockedByConversationState: Boolean(params.lockedByConversationState),
    evaluationContext: params.evaluationContext || null,
    ...(params.productRoute ? { productRoute: params.productRoute } : {}),
    ...(templateButtonTap ? { templateButtonTap } : {}),
  };

  const hasAnyValue = Object.values(meta).some(value => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") {
      return Object.values(value).some(nested => {
        if (Array.isArray(nested)) return nested.length > 0;
        return nested !== null && nested !== undefined;
      });
    }
    return value !== null && value !== undefined && value !== false;
  });

  return hasAnyValue ? meta : null;
}

function buildScenarioEvaluationContextSnapshot(
  conversation: ConversationDocument
): ScenarioEvaluationContextSnapshot {
  const conversationAny = conversation as ConversationDocument & {
    internal_labels?: string[] | null;
    history_summary?: string | null;
  };
  const internalLabels = toStringArray(conversationAny.internal_labels);
  const { classificationCategory, hasPurchaseHistory, isNewCustomer } =
    resolveConversationCustomerFacts(conversationAny);
  const funnelStage =
    getStageLabelFromInternalLabels(internalLabels) ||
    resolveConversationSegmentRouting({
      internalLabels,
      classificationCategory,
    }).segmentKey;

  return {
    classificationCategory,
    internalLabels,
    funnelStage,
    hasPurchaseHistory,
    isNewCustomer,
  };
}

export function buildScenarioTriggerLogEvaluationContext(params: {
  conversation: ConversationDocument;
  channel: Channel;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
  triggerLanguage?: string | null;
}): NonNullable<ScenarioTriggerLogMeta["evaluationContext"]> | null {
  const snapshot = buildScenarioEvaluationContextSnapshot(params.conversation);
  const quickReplyPayload =
    typeof params.quickReplyPayload === "string"
      ? params.quickReplyPayload.trim()
      : "";
  const triggerLanguage =
    typeof params.triggerLanguage === "string"
      ? params.triggerLanguage.trim()
      : "";
  const hasWhatsAppFlowResponse =
    typeof params.whatsAppFlowResponseJson === "string" &&
    params.whatsAppFlowResponseJson.trim().length > 0;

  const evaluationContext: NonNullable<
    ScenarioTriggerLogMeta["evaluationContext"]
  > = {
    channel: params.channel,
    classificationCategory: snapshot.classificationCategory,
    internalLabels: snapshot.internalLabels,
    funnelStage: snapshot.funnelStage,
    isNewCustomer: snapshot.isNewCustomer,
    hasPurchaseHistory: snapshot.hasPurchaseHistory,
    quickReplyPayload: quickReplyPayload || null,
    hasWhatsAppFlowResponse,
    triggerLanguage: triggerLanguage || null,
  };

  const hasAnyValue = Object.values(evaluationContext).some(value => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== false;
  });

  return hasAnyValue ? evaluationContext : null;
}

export function getLatestCompletedSpecificScenario(params: {
  scenarioFacts: ReadonlyArray<{
    scenarioId: string;
    matchingRole: ScenarioMatchingRole;
  }>;
  normalizedScenarioState: ConversationScenarioState | null;
}): ScenarioCompletionEntry | null {
  let latest: ScenarioCompletionEntry | null = null;

  for (const scenario of params.scenarioFacts) {
    if (scenario.matchingRole !== "default") {
      continue;
    }

    const completion = getLatestScenarioCompletion({
      state: params.normalizedScenarioState,
      scenarioId: scenario.scenarioId,
    });
    if (!completion) {
      continue;
    }

    if (!latest) {
      latest = completion;
      continue;
    }

    const completionTime = new Date(completion.completedAt).getTime();
    const latestTime = new Date(latest.completedAt).getTime();
    if (completionTime > latestTime) {
      latest = completion;
    }
  }

  return latest;
}

export async function hasFallbackSessionResetElapsed(params: {
  conversationId: string;
}): Promise<boolean> {
  const inboundMessages = await Message.find({
    conversation: params.conversationId,
    direction: "inbound",
  })
    .sort({ date: -1 })
    .limit(10)
    .select("date author")
    .lean<Array<{ date?: Date | string | null; author?: unknown }>>();

  const customerInboundDates = inboundMessages
    .filter(message => {
      const authorId = readEntityId(message.author);
      return Boolean(authorId) && authorId !== "0";
    })
    .map(message => {
      if (message.date instanceof Date) return message.date;
      const parsed = message.date ? new Date(message.date) : null;
      return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    })
    .filter((value): value is Date => value instanceof Date);

  if (customerInboundDates.length < 2) {
    return false;
  }

  const [latestInboundAt, previousInboundAt] = customerInboundDates;
  return (
    latestInboundAt.getTime() - previousInboundAt.getTime() >=
    FALLBACK_SESSION_RESET_WINDOW_MS
  );
}

export async function shouldSuppressFallbackForCurrentSession(params: {
  matchingRole: ScenarioMatchingRole;
  scenarioFacts: ReadonlyArray<{
    scenarioId: string;
    matchingRole: ScenarioMatchingRole;
  }>;
  normalizedScenarioState: ConversationScenarioState | null;
  conversationId: string;
}): Promise<boolean> {
  if (params.matchingRole !== "fallback") {
    return false;
  }

  const latestSpecificCompletion = getLatestCompletedSpecificScenario({
    scenarioFacts: params.scenarioFacts,
    normalizedScenarioState: params.normalizedScenarioState,
  });
  if (!latestSpecificCompletion) {
    return false;
  }

  const cooldownElapsed = await hasFallbackSessionResetElapsed({
    conversationId: params.conversationId,
  });
  return !cooldownElapsed;
}

export function evaluateScenarioEntryEligibility(params: {
  scenarioId: string;
  entryPolicy: ScenarioEntryPolicy;
  normalizedScenarioState: ConversationScenarioState | null;
  allowCurrentLockedScenario?: boolean;
}): ScenarioEntryPolicyEvaluation {
  if (!params.scenarioId) {
    return { eligible: true };
  }
  return evaluateScenarioEntryPolicy({
    scenarioId: params.scenarioId,
    entryPolicy: params.entryPolicy,
    state: params.normalizedScenarioState,
    allowCurrentLockedScenario: params.allowCurrentLockedScenario,
  });
}
