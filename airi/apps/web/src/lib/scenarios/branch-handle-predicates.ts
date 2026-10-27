import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  FLOW_BRANCH_TRANSITION,
  getScenarioActionBranchTransitionsForNode,
  INSTAGRAM_BRANCH_TRANSITION,
  SCENARIO_ACTION_BRANCH_TRANSITIONS,
  TELEGRAM_BRANCH_TRANSITION,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION,
  whatsappTemplateOffersFormSubmittedRoute,
} from "@/lib/scenarios/transition-registry";
import { scenarioActionAwaitsWhatsAppFlowReply } from "@/lib/scenarios/whatsapp-service-message";
import {
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  normalizeScenarioActionOutcomes,
  parseScenarioActionOutcomeHandleId,
  readScenarioActionPromptInputAsk,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
export { extractInstagramBranchOptions } from "@/lib/scenarios/instagram-reply-config";
export { extractTelegramBranchOptions } from "@/lib/scenarios/telegram-quick-replies";
export { extractFlowBranchOptions } from "@/lib/scenarios/whatsapp-flow-branches";
export { extractWhatsAppTemplateQuickReplyBranchOptions } from "@/lib/scenarios/whatsapp-template-button-branches";

export function scenarioActionUsesWhatsAppFlowBranchHandles(
  nodeData: ScenarioNodeData
): boolean {
  return FLOW_BRANCH_TRANSITION.usesBranchHandles(nodeData);
}

export function scenarioActionUsesWhatsAppTemplateButtonBranchHandles(
  nodeData: ScenarioNodeData
): boolean {
  return WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION.usesBranchHandles(nodeData);
}

export function scenarioActionUsesInstagramBranchHandles(
  nodeData: ScenarioNodeData
): boolean {
  return INSTAGRAM_BRANCH_TRANSITION.usesBranchHandles(nodeData);
}

export function scenarioActionUsesWhatsAppServiceMessageBranchHandles(
  nodeData: ScenarioNodeData
): boolean {
  return WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.usesBranchHandles(nodeData);
}

export function scenarioActionUsesTelegramBranchHandles(
  nodeData: ScenarioNodeData
): boolean {
  return TELEGRAM_BRANCH_TRANSITION.usesBranchHandles(nodeData);
}

/**
 * The customer answers this action by choosing an option: a Flow choice field,
 * a Telegram or Instagram quick reply, a WhatsApp reply button or list row, or
 * a WhatsApp template quick-reply button.
 */
export function scenarioActionUsesInteractiveBranchHandles(
  nodeData: ScenarioNodeData
): boolean {
  return SCENARIO_ACTION_BRANCH_TRANSITIONS.some(transition =>
    transition.usesBranchHandles(nodeData)
  );
}

export type ScenarioActionDefaultRouteBlocker = "form_submitted" | "outcomes";

type ScenarioActionDefaultRouteParams = {
  nodeId: string;
  nodeData: ScenarioNodeData;
  /** The handles of the action's linked edges. */
  sourceHandleIds: readonly (string | null | undefined)[];
};

/**
 * Why the action's default route ("Reply", "Other reply" or "Then") can
 * never run, or null when it can.
 * - "form_submitted": a template's linked "Form submitted" route holds the
 *   step (`resolveScenarioDispatchTransition`), typed text keeps that wait,
 *   and its form's reply takes only the route. Quick replies already hold a
 *   template, so a template with them keeps the outcome rule.
 * - "outcomes": a linked outcome arms the Outcomes wait
 *   (`lowerActionOutcomes`), and dispatch returns that wait instead of the
 *   default edge. A form submission or collected details still continue on
 *   the default route past the wait, and options own a choice step's routes,
 *   so those steps never match.
 */
export function resolveScenarioActionDefaultRouteBlocker({
  nodeId,
  nodeData,
  sourceHandleIds,
}: ScenarioActionDefaultRouteParams): ScenarioActionDefaultRouteBlocker | null {
  if (nodeData.kind !== "action") return null;
  const actionType = resolveScenarioActionTypeFromNodeData(nodeData);
  // Dispatch returns for these before it reads the outcome wait.
  if (actionType === "generative_ai" || actionType === "end_scenario") {
    return null;
  }
  if (
    sourceHandleIds.some(handleId =>
      isWhatsAppTemplateFormSubmittedSourceHandleId(handleId)
    ) &&
    whatsappTemplateOffersFormSubmittedRoute(nodeData) &&
    getScenarioActionBranchTransitionsForNode(nodeData, nodeId).length === 0
  ) {
    return "form_submitted";
  }
  if (
    normalizeScenarioActionOutcomes(nodeData.actionOutcomes).status !==
    "supported"
  ) {
    return null;
  }
  // The compiler arms the wait only for a linked outcome.
  if (
    !sourceHandleIds.some(
      handleId => parseScenarioActionOutcomeHandleId(handleId) !== null
    )
  ) {
    return null;
  }
  if (readScenarioActionPromptInputAsk(nodeData) !== null) return null;
  if (scenarioActionAwaitsWhatsAppFlowReply(nodeData)) return null;
  return getScenarioActionBranchTransitionsForNode(nodeData, nodeId).every(
    transition => transition.kind === "whatsapp_template_button"
  )
    ? "outcomes"
    : null;
}

/** The action's default route can never run, for any reason. */
export function scenarioActionDefaultRouteCannotRun(
  params: ScenarioActionDefaultRouteParams
): boolean {
  return resolveScenarioActionDefaultRouteBlocker(params) !== null;
}
