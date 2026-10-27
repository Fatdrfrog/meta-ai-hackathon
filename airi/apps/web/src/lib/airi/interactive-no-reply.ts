import { type ScenarioNodeData } from "@icecore/scenario-contracts";
import {
  flattenTelegramQuickReplyRows,
  normalizeActionReplyChannelForActionNode,
  normalizeActionType,
  normalizeTelegramQuickReplies,
} from "@/lib/scenarios/normalization";
import {
  scenarioActionUsesInstagramBranchHandles,
  scenarioActionUsesWhatsAppServiceMessageBranchHandles,
} from "@/lib/scenarios/branch-handle-predicates";
import {
  getInteractiveNoReplySurface,
  isInteractiveNoReplyConditionNodeData,
  isScenarioActionBranchDelayVirtualNodeId,
  isScenarioActionOutcomeVirtualNodeId,
  postActionConditionUsesMissingText,
} from "@icecore/scenario-contracts";
import {
  resolveWhatsAppFlowProviderId,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioTriggerEventKind,
} from "@icecore/scenario-contracts";
import {
  isScenarioInboundTriggerEventKind,
  isScenarioInteractiveReplyEventKind,
} from "@icecore/scenario-contracts";
import { hasWhatsAppTemplateQuickReplyButtons } from "@/lib/scenarios/whatsapp-template-button-branches";
import { resolveScenarioWhatsAppServiceFlowConfig } from "@/lib/scenarios/whatsapp-service-message";

export type PendingConditionEventDisposition =
  | "ignore"
  | "user_replied"
  | "payment_detected"
  | "no_reply_timeout"
  /** A choice from the waiting action's own buttons, quick replies or Flow. */
  | "interactive_reply"
  /** A choice the waiting action did not offer, such as an older button. */
  | "unowned_interactive_reply";

function pendingSourceActionHasFlowRadioBranches(
  data: Partial<ScenarioNodeData> | null | undefined
): boolean {
  if (!data || data.kind !== "action") return false;
  const serviceFlowConfig = resolveScenarioWhatsAppServiceFlowConfig(
    data as ScenarioNodeData
  );
  if (serviceFlowConfig) {
    return serviceFlowConfig.screens.some(screen =>
      screen.fields?.some(
        field =>
          field.fieldType === "RadioButtonsGroup" &&
          Array.isArray(field.options) &&
          field.options.length > 0
      )
    );
  }
  if (data.actionWhatsAppServiceMessage !== undefined) return false;

  const actionType = normalizeActionType(data);
  if (actionType === "whatsapp_template") {
    const ctaType =
      typeof data.actionReplyCtaType === "string"
        ? data.actionReplyCtaType.trim()
        : "";
    const flowId = resolveWhatsAppFlowProviderId({
      flowConfig: data.actionFlowConfig,
      legacyFlowId: data.actionReplyCtaFlowId,
    });
    if (ctaType === "flow" && flowId) return true;
    if (flowId) return true;
  }
  return false;
}

function pendingSourceActionHasTelegramInlineBranches(
  data: Partial<ScenarioNodeData> | null | undefined
): boolean {
  if (!data || data.kind !== "action") return false;
  if (normalizeActionType(data) !== "reply") return false;
  if (normalizeActionReplyChannelForActionNode(data) !== "telegram") {
    return false;
  }
  const rows = normalizeTelegramQuickReplies(data.actionTelegramQuickReplies);
  return flattenTelegramQuickReplyRows(rows).length > 0;
}

function pendingSourceActionHasWhatsAppTemplateButtonBranches(
  data: Partial<ScenarioNodeData> | null | undefined
): boolean {
  if (!data || data.kind !== "action") return false;
  return (
    normalizeActionType(data) === "whatsapp_template" &&
    hasWhatsAppTemplateQuickReplyButtons(data.actionWhatsAppTemplateComponents)
  );
}

function pendingSourceActionHasWhatsAppServiceMessageBranches(
  data: Partial<ScenarioNodeData> | null | undefined
): boolean {
  return (
    data?.kind === "action" &&
    scenarioActionUsesWhatsAppServiceMessageBranchHandles(
      data as ScenarioNodeData
    )
  );
}

function pendingSourceActionHasInstagramBranches(
  data: Partial<ScenarioNodeData> | null | undefined
): boolean {
  return (
    data?.kind === "action" &&
    scenarioActionUsesInstagramBranchHandles(data as ScenarioNodeData)
  );
}

/**
 * An action's Outcomes wait answers typed text only through its reply branch
 * (Any reply). Without one, text keeps the wait, whether or not the action
 * offers choices; answer rules are matched before this. A legacy condition
 * keeps its own reply branch.
 */
function pendingOutcomeWaitHasNoReplyBranch(params: {
  conditionNodeId?: string | null;
  conditionNodeData?: Partial<ScenarioNodeData> | null;
}): boolean {
  return (
    isScenarioActionOutcomeVirtualNodeId(params.conditionNodeId) &&
    !params.conditionNodeData?.conditionBranches?.some(
      branch => branch.id === "user_replied"
    )
  );
}

function pendingWaitOwnsInteractiveReply(params: {
  triggerEventKind?: ScenarioTriggerEventKind;
  conditionNodeData?: Partial<ScenarioNodeData> | null;
  pendingSourceActionData?: Partial<ScenarioNodeData> | null;
}): boolean {
  const source = params.pendingSourceActionData;
  const legacySurface = isInteractiveNoReplyConditionNodeData(
    params.conditionNodeData
  )
    ? getInteractiveNoReplySurface(params.conditionNodeData)
    : null;
  switch (params.triggerEventKind) {
    case SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply:
      return (
        pendingSourceActionHasFlowRadioBranches(source) ||
        legacySurface === "whatsapp_flow"
      );
    case SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply:
      return (
        pendingSourceActionHasTelegramInlineBranches(source) ||
        legacySurface === "telegram_builder"
      );
    case SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply:
      return pendingSourceActionHasInstagramBranches(source);
    case SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply:
      return (
        pendingSourceActionHasWhatsAppTemplateButtonBranches(source) ||
        pendingSourceActionHasWhatsAppServiceMessageBranches(source)
      );
    default:
      return false;
  }
}

/**
 * Classifies an event that arrives while a conversation waits on an action.
 * A button tap, quick reply or Flow submission is never ordinary text: the
 * waiting action either owns it or leaves it to normal scenario routing, and
 * neither outcome ends the wait by itself. Typed text answers an action's
 * wait only through its Any reply outcome, choices or not. A delayed CTA
 * follow-up waits only for quiet, so typed text never answers it; that Any
 * reply belongs to the action's own wait.
 */
export function resolvePendingConditionEventDisposition(params: {
  triggerEventKind?: ScenarioTriggerEventKind;
  /** The waiting condition, which identifies a delayed CTA follow-up. */
  conditionNodeId?: string | null;
  conditionNodeData?: Partial<ScenarioNodeData> | null;
  /** Action node that produced the interactive wait (for branch-style clears). */
  pendingSourceActionData?: Partial<ScenarioNodeData> | null;
  /** The caller verified the authoritative conversion and exact pending wait. */
  confirmedPayment?: boolean;
}): PendingConditionEventDisposition {
  if (
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout
  ) {
    return "no_reply_timeout";
  }

  if (isScenarioInteractiveReplyEventKind(params.triggerEventKind)) {
    return pendingWaitOwnsInteractiveReply(params)
      ? "interactive_reply"
      : "unowned_interactive_reply";
  }

  if (
    params.triggerEventKind === "payment_detected" &&
    params.confirmedPayment
  ) {
    return "payment_detected";
  }

  if (isInteractiveNoReplyConditionNodeData(params.conditionNodeData)) {
    return "ignore";
  }

  if (
    (!params.triggerEventKind ||
      isScenarioInboundTriggerEventKind(params.triggerEventKind)) &&
    (isScenarioActionBranchDelayVirtualNodeId(params.conditionNodeId) ||
      pendingOutcomeWaitHasNoReplyBranch(params))
  ) {
    return "ignore";
  }

  if (
    postActionConditionUsesMissingText(params.conditionNodeData) &&
    (!params.triggerEventKind ||
      isScenarioInboundTriggerEventKind(params.triggerEventKind))
  ) {
    return "ignore";
  }

  if (
    !params.triggerEventKind ||
    isScenarioInboundTriggerEventKind(params.triggerEventKind)
  ) {
    return "user_replied";
  }

  return "ignore";
}
