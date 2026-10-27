import {
  normalizeScenarioEntryPolicy,
  type ScenarioEntryPolicy,
  type ScenarioMatchingRole,
  type ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import {
  getClientMessageSpecificity,
  isClientMessageCriteriaMatchable,
  projectActiveClientMessageFilters,
  type ClientMessageTriggerCriteria,
} from "@/lib/scenarios/client-message-trigger-criteria";
import {
  type CompiledScenarioGraph,
  getCompiledScenarioGraph,
  getPrimaryTriggerNode,
  getTriggerNodes,
  type ScenarioRecord,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import { resolveEffectiveScenarioMatchingRoleForCriteria } from "@/lib/scenarios/matching-role";
import { normalizeScenarioPriority } from "@/lib/scenarios/normalization";
import {
  campaignProductFactsForCriteria,
  campaignProductRouteFromCriteria,
  matchesIncomingMessageStructure,
  matchesIncomingMessageTrigger,
  type ScenarioIngressContext,
} from "@/lib/scenarios/incoming-message-trigger-matcher";
import {
  hasCampaignProductRoute,
  resolveCampaignProductDecisions,
  type CampaignProductLog,
} from "@/lib/scenarios/campaign-product-routing";
import { resolveScenarioTrigger } from "@/lib/scenarios/trigger-utils";

export type ScenarioTriggerCandidate = Readonly<{
  node: ScenarioRuntimeNode;
  triggerConfig: Readonly<ScenarioTriggerConfig>;
  criteria: ClientMessageTriggerCriteria;
  specificity: number;
  graphOrder: number;
}>;

export type ScenarioCandidate = Readonly<{
  scenario: ScenarioRecord;
  graph: CompiledScenarioGraph;
  scenarioId: string;
  scenarioName: string;
  matchingRole: ScenarioMatchingRole;
  priority: number;
  entryPolicy: ScenarioEntryPolicy;
  topLevelSpecificity: number;
  compiledTriggerCandidates: readonly ScenarioTriggerCandidate[];
  triggerCandidates: readonly ScenarioTriggerCandidate[];
  topLevelEligible: boolean;
}>;

export type ScenarioCandidateSelection = Readonly<{
  candidate: ScenarioCandidate;
  selectedTrigger: ScenarioTriggerCandidate | null;
  productRoutingEvaluated?: boolean;
  productRoute?: CampaignProductLog | null;
}>;

function normalizeScenarioId(scenario: ScenarioRecord): string {
  return String(scenario._id || "").trim();
}

export function resolveScenarioDisplayName(scenario: ScenarioRecord): string {
  return typeof scenario.name === "string" && scenario.name.trim()
    ? scenario.name.trim()
    : "Scenario";
}

function hasPrimaryLinkedCondition(graph: CompiledScenarioGraph): boolean {
  const primaryTrigger = getPrimaryTriggerNode(graph);
  return Boolean(
    primaryTrigger?.data.kind === "trigger" &&
      typeof primaryTrigger.data.linkedConditionId === "string" &&
      primaryTrigger.data.linkedConditionId.trim()
  );
}

function projectScenarioTrigger(
  graph: CompiledScenarioGraph,
  node: ScenarioRuntimeNode
): ScenarioTriggerCandidate {
  const triggerConfig = resolveScenarioTrigger(node.data);
  const criteria = projectActiveClientMessageFilters(triggerConfig);
  return Object.freeze({
    node,
    triggerConfig,
    criteria,
    specificity: getClientMessageSpecificity(criteria).score,
    graphOrder: graph.nodeOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
  });
}

export function compileScenarioCandidate(
  scenario: ScenarioRecord
): ScenarioCandidate {
  const graph = getCompiledScenarioGraph(scenario);
  const projectedTriggers = getTriggerNodes(graph).map(node =>
    projectScenarioTrigger(graph, node)
  );
  const matchingRole = resolveEffectiveScenarioMatchingRoleForCriteria({
    matchingRole: scenario.matchingRole,
    criteria: projectedTriggers.map(trigger => trigger.criteria),
  });
  const compiledTriggerCandidates = Object.freeze([...projectedTriggers]);
  const triggerCandidates = Object.freeze(
    projectedTriggers
      .filter(trigger => trigger.triggerConfig.entryPointType !== "whatsapp_qr")
      .filter(trigger => isClientMessageCriteriaMatchable(trigger.criteria))
      .sort((left, right) => {
        if (right.specificity !== left.specificity) {
          return right.specificity - left.specificity;
        }
        return left.graphOrder - right.graphOrder;
      })
  );

  return Object.freeze({
    scenario,
    graph,
    scenarioId: normalizeScenarioId(scenario),
    scenarioName: resolveScenarioDisplayName(scenario),
    matchingRole,
    priority: normalizeScenarioPriority(scenario.priority),
    entryPolicy: normalizeScenarioEntryPolicy(scenario.entryPolicy),
    topLevelSpecificity: triggerCandidates[0]?.specificity ?? 0,
    compiledTriggerCandidates,
    triggerCandidates,
    topLevelEligible: !hasPrimaryLinkedCondition(graph),
  });
}

export function selectMatchingTrigger(
  candidate: ScenarioCandidate,
  ingress: ScenarioIngressContext,
  triggerNodeId?: string | null
): ScenarioTriggerCandidate | null {
  const explicitTriggerNodeId =
    typeof triggerNodeId === "string" ? triggerNodeId.trim() : "";
  if (explicitTriggerNodeId) {
    const requestedTrigger =
      candidate.compiledTriggerCandidates.find(
        trigger => trigger.node.id === explicitTriggerNodeId
      ) ??
      candidate.compiledTriggerCandidates.find(
        trigger => trigger.node.id === candidate.graph.triggerNodeIds[0]
      ) ??
      null;
    return requestedTrigger &&
      matchesIncomingMessageTrigger(requestedTrigger.criteria, ingress)
      ? requestedTrigger
      : null;
  }

  for (const trigger of candidate.triggerCandidates) {
    if (matchesIncomingMessageTrigger(trigger.criteria, ingress)) {
      return trigger;
    }
  }

  return null;
}

function compareScenarioCandidateSelections(
  left: ScenarioCandidateSelection,
  right: ScenarioCandidateSelection
): number {
  if (left.candidate.matchingRole !== right.candidate.matchingRole) {
    return left.candidate.matchingRole === "default" ? -1 : 1;
  }
  const leftSpecificity = left.selectedTrigger?.specificity ?? 0;
  const rightSpecificity = right.selectedTrigger?.specificity ?? 0;
  if (rightSpecificity !== leftSpecificity) {
    return rightSpecificity - leftSpecificity;
  }
  if (right.candidate.priority !== left.candidate.priority) {
    return right.candidate.priority - left.candidate.priority;
  }
  return left.candidate.scenarioId.localeCompare(right.candidate.scenarioId);
}

function productRouteKey(scenarioId: string, nodeId: string): string {
  return `${scenarioId}\n${nodeId}`;
}

export function selectScenarioTriggerSelections(
  candidates: readonly ScenarioCandidate[],
  ingress: ScenarioIngressContext
): readonly ScenarioCandidateSelection[] {
  const structural = candidates.flatMap(candidate =>
    candidate.triggerCandidates.flatMap(trigger => {
      if (!matchesIncomingMessageStructure(trigger.criteria, ingress)) {
        return [];
      }
      const route = campaignProductRouteFromCriteria(trigger.criteria);
      if (!hasCampaignProductRoute(route)) return [];
      return [
        {
          key: productRouteKey(candidate.scenarioId, trigger.node.id),
          route,
          facts: campaignProductFactsForCriteria(trigger.criteria, ingress),
        },
      ];
    })
  );
  const decisions = resolveCampaignProductDecisions(structural);

  const selections = candidates.map(candidate => {
    let selectedTrigger: ScenarioTriggerCandidate | null = null;
    let productRoute: CampaignProductLog | null = null;
    let deniedRoute: CampaignProductLog | null = null;
    for (const trigger of candidate.triggerCandidates) {
      if (!matchesIncomingMessageStructure(trigger.criteria, ingress)) continue;
      const route = campaignProductRouteFromCriteria(trigger.criteria);
      if (hasCampaignProductRoute(route)) {
        const decision = decisions.get(
          productRouteKey(candidate.scenarioId, trigger.node.id)
        );
        if (decision?.allow) {
          selectedTrigger = trigger;
          productRoute = decision;
          break;
        }
        deniedRoute = decision ?? deniedRoute;
        continue;
      }
      selectedTrigger = trigger;
      productRoute = null;
      break;
    }
    return Object.freeze({
      candidate,
      selectedTrigger,
      productRoutingEvaluated: true,
      productRoute: selectedTrigger ? productRoute : deniedRoute,
    });
  });

  return Object.freeze(selections.sort(compareScenarioCandidateSelections));
}

export function selectTopLevelScenarioCandidates(
  candidates: readonly ScenarioCandidate[],
  ingress: ScenarioIngressContext
): readonly ScenarioCandidateSelection[] {
  return selectScenarioTriggerSelections(
    candidates.filter(candidate => candidate.topLevelEligible),
    ingress
  );
}

export function orderTopLevelScenarioCandidates(
  candidates: readonly ScenarioCandidate[]
): ScenarioCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.matchingRole !== right.matchingRole) {
      return left.matchingRole === "default" ? -1 : 1;
    }
    if (right.topLevelSpecificity !== left.topLevelSpecificity) {
      return right.topLevelSpecificity - left.topLevelSpecificity;
    }
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.scenarioId.localeCompare(right.scenarioId);
  });
}
