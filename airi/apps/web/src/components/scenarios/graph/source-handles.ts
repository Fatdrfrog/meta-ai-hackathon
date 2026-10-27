import {
  getNoReplyAnswerMatchRules,
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  getVisiblePostActionConditionTypes,
  isPostActionConditionNodeData,
  parsePostActionAnswerMatchHandleId,
  resolvePostActionConditionTypeFromHandle,
} from "@icecore/scenario-contracts";
import {
  getRecipientColumnSplitConfig,
  isRecipientColumnSplitNodeData,
} from "@/lib/scenarios/recipient-column-split";
import {
  getRecipientColumnSplitSourceHandleIds,
  parseRecipientColumnSplitPathHandleId,
} from "@icecore/scenario-contracts";
import {
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_OUTCOME_HANDLE_PREFIX,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  PROMPT_INPUTS_UNMET_HANDLE,
  readScenarioActionPromptInputAsk,
  scenarioActionCollectsPromptInputs,
} from "@icecore/scenario-contracts";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  ACTION_OUTCOME_TRANSITION,
  getScenarioActionBranchTransitionsForNode,
  whatsappTemplateOffersFormSubmittedRoute,
} from "@/lib/scenarios/transition-registry";
import { SCENARIO_HANDLE_RULES } from "./config";
import type { ScenarioFlowNode, ScenarioNodeData } from "../types";
import {
  ACTION_BRANCH_SOURCE_HANDLE_DESCRIPTORS,
  ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS,
} from "./source-handle-descriptors";

export function getNodeKind(node: ScenarioFlowNode): ScenarioNodeData["kind"] {
  return (node.data as ScenarioNodeData).kind;
}

/**
 * Resolves the effective output handle ID for a node.
 * Action nodes with branch-capable interactive configs use a special branch
 * output handle instead of the default right-side source handle.
 */
export function resolveEffectiveOutputHandleId(
  node: ScenarioFlowNode
): string | null {
  const nodeData = node.data as ScenarioNodeData;
  const kind = nodeData.kind;
  if (!kind) return null;

  if (kind === "action") {
    if (
      ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS.some(descriptor =>
        descriptor.usesFixedHandles(nodeData)
      )
    ) {
      return null;
    }
    const branchDescriptor = ACTION_BRANCH_SOURCE_HANDLE_DESCRIPTORS.find(
      descriptor => descriptor.usesBranchHandles(nodeData)
    );
    if (branchDescriptor) {
      return branchDescriptor.outputHandleId;
    }
  }

  return SCENARIO_HANDLE_RULES[kind]?.outputHandleId ?? null;
}

export function resolveAvailableSourceHandleIds(
  node: ScenarioFlowNode
): string[] {
  const nodeData = node.data as ScenarioNodeData;

  if (isPostActionConditionNodeData(nodeData)) {
    return [
      ...getVisiblePostActionConditionTypes(nodeData).map(type =>
        getPostActionConditionHandleId(type)
      ),
      ...getNoReplyAnswerMatchRules(nodeData).map(rule =>
        getPostActionAnswerMatchHandleId(rule.id)
      ),
    ];
  }

  if (isRecipientColumnSplitNodeData(nodeData)) {
    return getRecipientColumnSplitSourceHandleIds(
      getRecipientColumnSplitConfig(nodeData)
    );
  }

  if (nodeData.kind === "bulk") {
    return [BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID];
  }

  if (nodeData.kind === "action") {
    const fixedOutputDescriptor =
      ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS.find(descriptor =>
        descriptor.usesFixedHandles(nodeData)
      );
    if (fixedOutputDescriptor) {
      return fixedOutputDescriptor.getSourceHandleIds(nodeData);
    }

    const sourceHandles =
      ACTION_OUTCOME_TRANSITION.getSourceHandleIds(nodeData);
    const branchTransitions = getScenarioActionBranchTransitionsForNode(
      nodeData,
      node.id
    );
    if (branchTransitions.length > 0) {
      const usesTemplateButtonBranches = branchTransitions.some(
        descriptor => descriptor.kind === "whatsapp_template_button"
      );
      const usesFlowBranches = branchTransitions.some(
        descriptor => descriptor.kind === "whatsapp_flow"
      );
      const defaultActionOutputHandleId =
        SCENARIO_HANDLE_RULES.action.outputHandleId;
      if (
        usesTemplateButtonBranches &&
        defaultActionOutputHandleId &&
        !usesFlowBranches
      ) {
        sourceHandles.push(defaultActionOutputHandleId);
      }
      for (const descriptor of branchTransitions) {
        sourceHandles.push(descriptor.outputHandleId);
        for (const option of descriptor.extractOptions(nodeData, node.id)) {
          const sourceHandleId = descriptor.buildSourceHandleForOption(option);
          if (sourceHandleId) sourceHandles.push(sourceHandleId);
        }
      }
    } else {
      const effectiveHandleId = resolveEffectiveOutputHandleId(node);
      if (effectiveHandleId) sourceHandles.push(effectiveHandleId);
    }
    // A template's form button adds its route beside any quick replies.
    if (whatsappTemplateOffersFormSubmittedRoute(nodeData)) {
      sourceHandles.push(ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID);
    }
    const promptInputAsk = readScenarioActionPromptInputAsk(nodeData);
    if (promptInputAsk) {
      const defaultActionOutputHandleId =
        SCENARIO_HANDLE_RULES.action.outputHandleId;
      // A choice ask continues on its options, not on a default output.
      if (
        promptInputAsk === "text" &&
        defaultActionOutputHandleId &&
        !sourceHandles.includes(defaultActionOutputHandleId)
      ) {
        sourceHandles.push(defaultActionOutputHandleId);
      }
      if (!sourceHandles.includes(PROMPT_INPUTS_UNMET_HANDLE)) {
        sourceHandles.push(PROMPT_INPUTS_UNMET_HANDLE);
      }
    }
    if (sourceHandles.length > 0) {
      return Array.from(new Set(sourceHandles));
    }
  }

  const effectiveHandleId = resolveEffectiveOutputHandleId(node);
  return effectiveHandleId ? [effectiveHandleId] : [];
}

export function isValidSourceHandleForNode(
  node: ScenarioFlowNode,
  handleId: string | null | undefined
): boolean {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  if (!normalizedHandleId) return false;

  return resolveAvailableSourceHandleIds(node).includes(normalizedHandleId);
}

export function resolveConnectionSourceHandleId(params: {
  node: ScenarioFlowNode;
  requestedSourceHandle?: string | null;
}): string | null {
  const { node, requestedSourceHandle } = params;
  const nodeData = node.data as ScenarioNodeData;
  const normalizedRequestedHandle =
    typeof requestedSourceHandle === "string"
      ? requestedSourceHandle.trim()
      : "";

  if (
    normalizedRequestedHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
  ) {
    return null;
  }

  // A form route never falls back to another output of the step.
  if (
    isWhatsAppTemplateFormSubmittedSourceHandleId(normalizedRequestedHandle)
  ) {
    return whatsappTemplateOffersFormSubmittedRoute(nodeData)
      ? normalizedRequestedHandle
      : null;
  }

  if (
    normalizedRequestedHandle === PROMPT_INPUTS_UNMET_HANDLE &&
    scenarioActionCollectsPromptInputs(nodeData)
  ) {
    return PROMPT_INPUTS_UNMET_HANDLE;
  }

  if (nodeData.kind === "action") {
    const fixedOutputDescriptor =
      ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS.find(descriptor =>
        descriptor.usesFixedHandles(nodeData)
      );
    if (fixedOutputDescriptor) {
      return fixedOutputDescriptor.matchesSourceHandle(
        normalizedRequestedHandle
      ) &&
        fixedOutputDescriptor
          .getSourceHandleIds(nodeData)
          .includes(normalizedRequestedHandle)
        ? normalizedRequestedHandle
        : null;
    }

    if (
      normalizedRequestedHandle.startsWith(`${ACTION_OUTCOME_HANDLE_PREFIX}::`)
    ) {
      return ACTION_OUTCOME_TRANSITION.matchesSourceHandle(
        normalizedRequestedHandle
      ) &&
        ACTION_OUTCOME_TRANSITION.getSourceHandleIds(nodeData).includes(
          normalizedRequestedHandle
        )
        ? normalizedRequestedHandle
        : null;
    }

    const branchDescriptor = ACTION_BRANCH_SOURCE_HANDLE_DESCRIPTORS.find(
      descriptor => {
        if (!descriptor.usesBranchHandles(nodeData)) return false;
        if (normalizedRequestedHandle === descriptor.outputHandleId) {
          return true;
        }
        return Boolean(
          descriptor.parseSourceHandleId?.(normalizedRequestedHandle) &&
            isValidSourceHandleForNode(node, normalizedRequestedHandle)
        );
      }
    );
    if (branchDescriptor) {
      return branchDescriptor.outputHandleId;
    }
  }

  if (isValidSourceHandleForNode(node, requestedSourceHandle)) {
    return requestedSourceHandle!.trim();
  }

  if (nodeData.kind === "bulk" && normalizedRequestedHandle) {
    return null;
  }

  if (isPostActionConditionNodeData(nodeData)) {
    if (parsePostActionAnswerMatchHandleId(requestedSourceHandle)) {
      return null;
    }

    const branchType = resolvePostActionConditionTypeFromHandle(
      requestedSourceHandle
    );
    if (branchType) {
      const visibleTypes = getVisiblePostActionConditionTypes(nodeData);
      if (!visibleTypes.includes(branchType)) {
        return null;
      }
    }
    if (
      branchType &&
      getVisiblePostActionConditionTypes(nodeData).includes(branchType)
    ) {
      return getPostActionConditionHandleId(branchType);
    }
  }

  if (isRecipientColumnSplitNodeData(nodeData)) {
    const parsed = parseRecipientColumnSplitPathHandleId(requestedSourceHandle);
    if (!parsed) return null;
    const available = getRecipientColumnSplitSourceHandleIds(
      getRecipientColumnSplitConfig(nodeData)
    );
    return available.includes(requestedSourceHandle!.trim())
      ? requestedSourceHandle!.trim()
      : null;
  }

  return resolveEffectiveOutputHandleId(node);
}

/**
 * Resolves source handles while hydrating persisted edges. The legacy
 * interactive no-reply handle is retained only for graphs that already store
 * it; new connections must use the canonical action outcome handles. A
 * template keeps its "Form submitted" edge even when it no longer offers the
 * route, so the step can flag it instead of turning it into its default
 * route.
 */
export function resolvePersistedConnectionSourceHandleId(params: {
  node: ScenarioFlowNode;
  requestedSourceHandle?: string | null;
}): string | null {
  const requestedSourceHandle =
    typeof params.requestedSourceHandle === "string"
      ? params.requestedSourceHandle.trim()
      : "";
  const nodeData = params.node.data as ScenarioNodeData;

  if (
    requestedSourceHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID &&
    nodeData.kind === "action" &&
    getScenarioActionBranchTransitionsForNode(nodeData, params.node.id).length >
      0
  ) {
    return ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID;
  }

  if (
    isWhatsAppTemplateFormSubmittedSourceHandleId(requestedSourceHandle) &&
    nodeData.kind === "action" &&
    resolveScenarioActionTypeFromNodeData(nodeData) === "whatsapp_template"
  ) {
    return ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
  }

  return resolveConnectionSourceHandleId(params);
}
