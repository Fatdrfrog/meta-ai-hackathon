"use client";

import {
  normalizeScenarioActionRunConditions,
  parseScenarioActionOutcomeHandleId,
  SCENARIO_ACTION_ROUTING_VERSION,
  type ScenarioActionOutcomes,
} from "@icecore/scenario-contracts";
import { useMemo } from "react";
import { getScenarioActionBranchTransitionsForNode } from "@/lib/scenarios/transition-registry";
import { SCENARIO_HANDLE_RULES } from "../../graph/config";
import type { ScenarioAudienceOptions, TranslateFn } from "../../types";
import { resolveActionSelectorTypeForNode } from "../../view/action/selector-utils";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import {
  isActionNodeOutcomePort,
  resolveActionNodePorts,
  type ActionNodePort,
} from "./action-node-ports";
import { readEditableActionOutcomes } from "./action-node-state";

export const ACTION_NODE_DEFAULT_HANDLE_ID =
  SCENARIO_HANDLE_RULES.action.outputHandleId!;

const EMPTY_AUDIENCE_OPTIONS: ScenarioAudienceOptions = {
  channels: [],
  classificationCategories: [],
  funnelStages: [],
  internalLabels: [],
  customers: [],
  metaReferralAds: [],
  metaReferralCampaigns: [],
  metaReferralAdSets: [],
  metaCampaignLabels: [],
};

export type ActionNodeMessageBranch = {
  handleId: string;
  label: string;
  connected: boolean;
};

function isServiceMessageBranchConnected(params: {
  handleId: string;
  optionId: string;
  connectedHandleIds: ReadonlySet<string>;
  destinationsBySourceHandle?: ReadonlyMap<
    string,
    Readonly<{ nodeId: string; label: string }>
  >;
  connectedPayloads: readonly string[];
}): boolean {
  return (
    params.connectedHandleIds.has(params.handleId) ||
    params.destinationsBySourceHandle?.has(params.handleId) === true ||
    params.connectedPayloads.includes(params.optionId)
  );
}

/** Route rows of a service message's own choices, from the registry. */
function resolveServiceMessageBranches(
  nodeData: ScenarioActionEditorNodeData,
  nodeId: string,
  connectedHandleIds: ReadonlySet<string>
): ActionNodeMessageBranch[] {
  return getScenarioActionBranchTransitionsForNode(nodeData, nodeId).flatMap(
    transition =>
      transition.extractOptions(nodeData, nodeId).flatMap(option => {
        const handleId = transition.buildSourceHandleForOption(option);
        if (!handleId) return [];
        const connected = isServiceMessageBranchConnected({
          handleId,
          optionId: option.id,
          connectedHandleIds,
          destinationsBySourceHandle:
            nodeData.uiConnections.destinationsBySourceHandle,
          connectedPayloads: nodeData.uiConnections.whatsAppChoicePayloads,
        });
        return [{ handleId, label: option.label, connected }];
      })
  );
}

/**
 * The inline editor shows a service message's default output only for an
 * edge that already uses it.
 */
function resolveServiceDefaultPort({
  isService,
  messageBranches,
  nodeData,
  connectedHandleIds,
  ports,
}: {
  isService: boolean;
  messageBranches: readonly ActionNodeMessageBranch[];
  nodeData: ScenarioActionEditorNodeData;
  connectedHandleIds: ReadonlySet<string>;
  ports: readonly ActionNodePort[];
}): ActionNodePort | undefined {
  const hasConnectedOutcome = nodeData.uiConnections.sourceHandleIds.some(
    handleId => parseScenarioActionOutcomeHandleId(handleId) !== null
  );
  return isService &&
    messageBranches.length === 0 &&
    !hasConnectedOutcome &&
    connectedHandleIds.has(ACTION_NODE_DEFAULT_HANDLE_ID)
    ? ports.find(port => port.handleId === ACTION_NODE_DEFAULT_HANDLE_ID)
    : undefined;
}

/**
 * What the routing section edits: Only if conditions, outcomes and their
 * route rows. Unsupported saved routing is shown read-only.
 */
export function useActionNodeRouting({
  nodeId,
  nodeData,
  t,
  messageBranchesMode,
}: {
  nodeId: string;
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
  messageBranchesMode: "all" | "connected";
}) {
  const isService =
    resolveActionSelectorTypeForNode(nodeData) === "whatsapp_service_message";
  const normalizedRunConditions = normalizeScenarioActionRunConditions(
    nodeData.actionRunConditions
  );
  const editableOutcomes = readEditableActionOutcomes(nodeData.actionOutcomes);
  const outcomes: ScenarioActionOutcomes = editableOutcomes ?? {
    version: SCENARIO_ACTION_ROUTING_VERSION,
  };
  const connectedHandleIds = useMemo(
    () => new Set(nodeData.uiConnections.sourceHandleIds),
    [nodeData.uiConnections.sourceHandleIds]
  );
  const ports = useMemo(
    () => resolveActionNodePorts({ id: nodeId, nodeData, t }).ports,
    [nodeData, nodeId, t]
  );
  const outcomePorts = useMemo(
    () => ports.filter(isActionNodeOutcomePort),
    [ports]
  );
  const messageBranches = isService
    ? resolveServiceMessageBranches(nodeData, nodeId, connectedHandleIds)
    : [];

  return {
    isService,
    conditions:
      normalizedRunConditions.status === "supported"
        ? normalizedRunConditions.value.conditions
        : [],
    outcomes,
    readOnly:
      normalizedRunConditions.status === "unsupported" ||
      editableOutcomes === null,
    audienceOptions: nodeData.uiAudienceOptions ?? EMPTY_AUDIENCE_OPTIONS,
    connectedHandleIds,
    outcomePorts,
    visibleMessageBranches:
      messageBranchesMode === "connected"
        ? messageBranches.filter(branch => branch.connected)
        : messageBranches,
    defaultPort: resolveServiceDefaultPort({
      isService,
      messageBranches,
      nodeData,
      connectedHandleIds,
      ports,
    }),
  };
}

export type ActionNodeRouting = ReturnType<typeof useActionNodeRouting>;
