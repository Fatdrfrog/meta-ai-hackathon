import type {
  ScenarioActionSelectorType,
  ScenarioActionType,
  ScenarioNodeData,
  ScenarioReplyCtaType,
  ScenarioReplyMode,
} from "@/components/scenarios/types";
import { normalizeScenarioActionAttachments } from "@/lib/scenarios/action-attachments";
import {
  resolveScenarioActionDefaultRouteBlocker,
  type ScenarioActionDefaultRouteBlocker,
} from "@/lib/scenarios/branch-handle-predicates";
import type { ScenarioGraphValidationErrorKey } from "@/lib/scenarios/graph-validation";
import { extractInstagramBranchOptions } from "@/lib/scenarios/instagram-reply-config";
import { normalizeActionReplyChannelForActionNode } from "@/lib/scenarios/normalization";
import { extractTelegramBranchOptions } from "@/lib/scenarios/telegram-quick-replies";
import { extractFlowBranchOptions } from "@/lib/scenarios/whatsapp-flow-branches";
import {
  extractWhatsAppTemplateQuickReplyBranchOptions,
  type WhatsAppTemplateButtonBranchOption,
} from "@/lib/scenarios/whatsapp-template-button-branches";
import { canEditFlowForWhatsAppTemplateComponents } from "@/lib/scenarios/whatsapp-template-flow";
import {
  resolveScenarioWhatsAppInteractiveFlowConfig,
  resolveScenarioWhatsAppServiceFlowConfig,
  resolveScenarioWhatsAppServiceMessage,
} from "@/lib/scenarios/whatsapp-service-message";
import {
  getScenarioActionBranchTransitionsForNode,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION,
  whatsappTemplateOffersFormSubmittedRoute,
} from "@/lib/scenarios/transition-registry";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildScenarioActionAnswerOutcomeHandleId,
  isGenerativeAIActionMode,
  normalizeScenarioActionOutcomes,
  normalizeScenarioActionRunConditions,
  PROMPT_INPUTS_UNMET_HANDLE,
  readScenarioActionPromptInputAsk,
  SCENARIO_ACTION_ROUTING_VERSION,
  scenarioActionCollectsPromptInputs,
  type GenerativeAIActionMode,
  type ScenarioActionOutcomes,
} from "@icecore/scenario-contracts";
import { WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS } from "../../builders/whatsapp/service-message/service-message-labels";
import type { TranslateFn } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import {
  resolveActionSelectorTypeForNode,
  resolveActionSourceIdForSelector,
} from "../../view/action/selector-utils";
import { resolveCompactActionTitle } from "../../scenario-node-labels";
import {
  anyReplyReplacesContinueRoute,
  createScenarioBranchOptionLabeler,
  resolveAnyReplyLabel,
  resolveContinueLabel,
  type ScenarioSourceHandleCopy,
} from "../../view/scenario-source-handle-copy";
import { resolveReplyCtaTypeFromNodeData } from "../../view/scenario-template-utils";
import { resolveReplyModeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import { buildBranchHandleSignature, uniqueStrings } from "./action-node-utils";
import { SCENARIO_HANDLE_RULES } from "../../graph/config";
import { ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS } from "../../graph/source-handle-descriptors";
import type { ScenarioNodeSourceHandle } from "../node-handlers";
import { formatNoReplyDuration } from "./no-reply-timeout";

function toStringSet(
  values: readonly string[] | null | undefined
): Set<string> {
  return new Set(values ?? []);
}

export type ActionNodeOutcomeRow = {
  kind: "any_reply" | "no_reply" | "answer" | "payment_detected";
  handleId: string;
  label: string;
  /** No reply only: the quiet period, as "30 min". */
  detail?: string;
  /** No reply only: the quiet period in minutes. */
  timeoutMinutes?: number;
  mode?: "exact" | "intent";
  /** Answer only: the rule's words; empty for an untitled rule. */
  answerText?: string;
  connected: boolean;
};

/** Outcomes the editor may change: empty when absent, null when unsupported. */
export function readEditableActionOutcomes(
  value: unknown
): ScenarioActionOutcomes | null {
  const normalized = normalizeScenarioActionOutcomes(value);
  if (normalized.status === "supported") return normalized.value;
  return normalized.status === "absent"
    ? { version: SCENARIO_ACTION_ROUTING_VERSION }
    : null;
}

export const DEFAULT_NO_REPLY_TIMEOUT_MINUTES = 30;

/** Outcomes with No reply switched on after its default quiet period. */
export function withDefaultNoReplyOutcome(
  outcomes: ScenarioActionOutcomes
): ScenarioActionOutcomes {
  return {
    ...outcomes,
    noReply: {
      enabled: true,
      timeoutMinutes: DEFAULT_NO_REPLY_TIMEOUT_MINUTES,
    },
  };
}

export type ActionNodeRoutingState = {
  runConditionCount: number;
  actionOutcomeRows: ActionNodeOutcomeRow[];
  actionOutcomeHandleSignature: string;
};

export function resolveActionNodeRoutingState(
  nodeData: ScenarioActionEditorNodeData,
  t: TranslateFn
): ActionNodeRoutingState {
  const normalizedRunConditions = normalizeScenarioActionRunConditions(
    nodeData.actionRunConditions
  );
  const normalizedOutcomes = normalizeScenarioActionOutcomes(
    nodeData.actionOutcomes
  );
  const outcomes =
    normalizedOutcomes.status === "supported" ? normalizedOutcomes.value : null;
  const connectedHandles = toStringSet(nodeData.uiConnections.sourceHandleIds);
  const actionOutcomeRows: ActionNodeOutcomeRow[] = [];
  const isGenerativeAI =
    resolveActionSelectorTypeForNode(nodeData) === "generative_ai";

  if (!isGenerativeAI && outcomes?.anyReply?.enabled) {
    actionOutcomeRows.push({
      kind: "any_reply",
      handleId: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      label: resolveAnyReplyLabel(nodeData, t),
      connected: connectedHandles.has(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID),
    });
  }
  if (!isGenerativeAI && outcomes?.noReply?.enabled) {
    actionOutcomeRows.push({
      kind: "no_reply",
      handleId: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      label: t("actionOutcomeNoReply"),
      detail: formatNoReplyDuration(outcomes.noReply.timeoutMinutes, t),
      timeoutMinutes: outcomes.noReply.timeoutMinutes,
      connected: connectedHandles.has(ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
    });
  }
  for (const rule of isGenerativeAI ? [] : (outcomes?.answerMatches ?? [])) {
    const handleId = buildScenarioActionAnswerOutcomeHandleId(rule.id);
    actionOutcomeRows.push({
      kind: "answer",
      handleId,
      label: rule.text.trim() || t("sourceHandleConditionAnswerMatchAny"),
      mode: rule.mode,
      answerText: rule.text.trim(),
      connected: connectedHandles.has(handleId),
    });
  }
  if (!isGenerativeAI && outcomes?.paymentDetected?.enabled) {
    actionOutcomeRows.push({
      kind: "payment_detected",
      handleId: ACTION_PAYMENT_OUTCOME_HANDLE_ID,
      label: t("actionOutcomePayment"),
      connected: connectedHandles.has(ACTION_PAYMENT_OUTCOME_HANDLE_ID),
    });
  }

  return {
    runConditionCount:
      normalizedRunConditions.status === "supported"
        ? normalizedRunConditions.value.conditions.length
        : 0,
    actionOutcomeRows,
    actionOutcomeHandleSignature: buildBranchHandleSignature(
      actionOutcomeRows,
      row => row.handleId
    ),
  };
}

/** End scenario has no outgoing routes and nothing to configure. */
export function isTerminalActionNode(nodeData: ScenarioNodeData): boolean {
  return resolveActionSelectorTypeForNode(nodeData) === "end_scenario";
}

/** Every attachment an action sends: uploaded, linked and generated. */
export function resolveActionNodeAttachmentCount(
  nodeData: ScenarioNodeData
): number {
  return normalizeScenarioActionAttachments({
    attachments: nodeData.actionAttachments,
    legacyUrls: nodeData.actionImageUrls,
    generatedAssets: nodeData.actionMediaAssets,
    limit: Number.MAX_SAFE_INTEGER,
  }).length;
}

/**
 * A long No reply reaches this step, and it is a WhatsApp chat message: after
 * 24 hours without a reply WhatsApp only delivers templates.
 */
export function showsActionNodeLongWaitNotice(
  nodeData: ScenarioActionEditorNodeData
): boolean {
  return (
    nodeData.uiReachedAfterLongNoReply === true &&
    resolveActionSelectorTypeForNode(nodeData) === "whatsapp_service_message"
  );
}

/**
 * Why the step's default route can't run, or null: a linked outcome or a
 * template's linked Form submitted route keeps the step waiting. Steps whose
 * outcomes come from legacy routing keep their routes until they are
 * converted: their saved graph arms no outcome wait. As at runtime, the Form
 * submitted route stops neither a default route into a post-action condition,
 * which arms the step's follow-up wait, nor one on a saved step that offers
 * no Form submitted route.
 */
export function actionNodeDefaultRouteCannotRun(
  id: string,
  nodeData: ScenarioActionEditorNodeData
): ScenarioActionDefaultRouteBlocker | null {
  const { sourceHandleIds, destinationsBySourceHandle } =
    nodeData.uiConnections;
  const formRouteHoldsDefaultRoute =
    nodeData.uiSavedStepOffersFormSubmittedRoute !== false &&
    destinationsBySourceHandle?.get(
      SCENARIO_HANDLE_RULES.action.outputHandleId ?? "right-source"
    )?.postActionCondition !== true;
  const blocker = resolveScenarioActionDefaultRouteBlocker({
    nodeId: id,
    nodeData,
    sourceHandleIds: formRouteHoldsDefaultRoute
      ? sourceHandleIds
      : sourceHandleIds.filter(
          handleId =>
            handleId !== ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
        ),
  });
  return blocker === "outcomes" &&
    nodeData.uiLegacyActionRouting?.actionOutcomesSource
    ? null
    : blocker;
}

export type ActionNodeContinueRoute = "shown" | "hidden" | "cannot_run";

/**
 * How the card and the inline editor show a step's default route. An
 * unlinked one keeps only its anchor when Any reply stands in for it or when
 * it can't run. A linked one that can't run stays, flagged, so its edge can
 * still be deleted.
 */
export function resolveActionNodeContinueRoute({
  id,
  nodeData,
  usesTemplateButtons,
  hasAnyReply,
  connected,
}: {
  id: string;
  nodeData: ScenarioActionEditorNodeData;
  usesTemplateButtons: boolean;
  hasAnyReply: boolean;
  connected: boolean;
}): ActionNodeContinueRoute {
  const cannotRun = actionNodeDefaultRouteCannotRun(id, nodeData) !== null;
  if (connected) return cannotRun ? "cannot_run" : "shown";
  return cannotRun ||
    anyReplyReplacesContinueRoute({
      nodeData,
      usesTemplateButtons,
      hasAnyReply,
      continueConnected: false,
    })
    ? "hidden"
    : "shown";
}

/** The activation error a linked Form submitted route with no row raises. */
export type ActionNodeFormSubmittedRouteError = Extract<
  ScenarioGraphValidationErrorKey,
  "whatsappTemplateFormRouteUnavailable" | "whatsappTemplateFormRouteInBulk"
>;

export type ActionNodeFormSubmittedRoute = {
  /**
   * "row" gives the route its own row; "anchor" keeps only a hidden handle
   * on the node's top right corner, so a saved edge stays drawn, can be
   * deleted, and doesn't seem to leave another route's dot.
   */
  placement: "row" | "anchor" | "none";
  connected: boolean;
  /** Why a linked anchor-only route can't run; the step warns with it. */
  error?: ActionNodeFormSubmittedRouteError;
};

/**
 * How a template step shows its "Form submitted" route. A bulk send's
 * template gets no row for it, and a template that no longer opens one form
 * keeps only the anchor of an edge it still has. The saved step decides, as
 * graph validation and the runtime read it, though a step that saved no
 * buttons shows the approved template's FLOW button.
 */
export function resolveActionNodeFormSubmittedRoute(
  nodeData: ScenarioActionEditorNodeData
): ActionNodeFormSubmittedRoute {
  const handleId = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
  const connected =
    nodeData.uiConnections.sourceHandleIds.includes(handleId) ||
    nodeData.uiConnections.destinationsBySourceHandle?.has(handleId) === true;
  const offered =
    nodeData.uiSavedStepOffersFormSubmittedRoute ??
    whatsappTemplateOffersFormSubmittedRoute(nodeData);
  if (!offered) {
    return connected
      ? {
          placement: "anchor",
          connected,
          error: "whatsappTemplateFormRouteUnavailable",
        }
      : { placement: "none", connected };
  }
  if (!nodeData.uiBulkPrimaryWhatsAppTemplate) {
    return { placement: "row", connected };
  }
  return {
    placement: "anchor",
    connected,
    ...(connected ? { error: "whatsappTemplateFormRouteInBulk" as const } : {}),
  };
}

/** Label key of a builder action's kind; null for other actions or an unreadable service message. */
export function resolveActionNodeBuilderLabelKey(
  nodeData: ScenarioNodeData
): string | null {
  switch (resolveActionSelectorTypeForNode(nodeData)) {
    case "whatsapp_template":
      return "whatsappActionKindTemplate";
    case "whatsapp_service_message": {
      const serviceMessage = resolveScenarioWhatsAppServiceMessage(nodeData);
      return serviceMessage.status === "canonical"
        ? WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS[
            serviceMessage.value.message.kind
          ]
        : null;
    }
    case "telegram_builder":
      return "presetActionTelegramBuilder";
    case "instagram_reply":
      return "presetActionInstagramReply";
    default:
      return null;
  }
}

const ACTION_CARD_LABEL_KEYS: Partial<
  Record<ScenarioActionSelectorType, string>
> = {
  assign_human: "presetActionAssignHuman",
  end_scenario: "actionTypeEndScenario",
};

/** A generative step is named by what it creates. */
const GENERATIVE_AI_TITLE_KEYS: Record<GenerativeAIActionMode, string> = {
  text_to_image: "generativeAITitleImage",
  text_to_video: "generativeAITitleVideo",
  image_to_video: "generativeAITitleVideoFromPhoto",
};

function resolveActionNodeCardLabelKey(
  nodeData: ScenarioActionEditorNodeData,
  selectorType: ScenarioActionSelectorType
): string {
  if (selectorType === "generative_ai") {
    const mode = nodeData.actionGenerativeAIConfig?.mode;
    return isGenerativeAIActionMode(mode)
      ? GENERATIVE_AI_TITLE_KEYS[mode]
      : "presetActionGenerativeAI";
  }
  return (
    resolveActionNodeBuilderLabelKey(nodeData) ??
    ACTION_CARD_LABEL_KEYS[selectorType] ??
    "presetActionReply"
  );
}

/** The name of an action on its read-only card and in its settings. */
export function resolveActionNodeCardTitle(
  nodeData: ScenarioActionEditorNodeData,
  t: TranslateFn
): string {
  const selectorType = resolveActionSelectorTypeForNode(nodeData);
  return resolveCompactActionTitle({
    actionLabel: t(resolveActionNodeCardLabelKey(nodeData, selectorType)),
    actionType: resolveActionNodeModeState(nodeData).actionType,
    nodeData,
  });
}

export type ActionNodeModeState = {
  actionSelectorType: ScenarioActionSelectorType;
  actionType: ScenarioActionType;
  replyMode: ScenarioReplyMode;
  replyCtaType: ScenarioReplyCtaType;
  resolvedActionSourceId: ReturnType<typeof resolveActionSourceIdForSelector>;
  selectedActionSourceOption:
    | NonNullable<ScenarioActionEditorNodeData["uiActionSourceOptions"]>[number]
    | null;
  selectedActionSourceId: string | undefined;
  showWhatsAppActionKindSelect: boolean;
  instagramReplyDisabledReason: string | null;
  isInstagramReplyDisabled: boolean;
  isTelegramBuilder: boolean;
  isInstagramReply: boolean;
  isEmailReply: boolean;
  isWebWidgetReply: boolean;
  isWhatsAppServiceMessage: boolean;
  isWhatsAppTemplateAction: boolean;
  isGenerativeAI: boolean;
  canEditTemplateFlow: boolean;
  templateEditorWorkspaceId: string;
};

export function resolveActionNodeModeState(
  nodeData: ScenarioActionEditorNodeData
): ActionNodeModeState {
  const actionSelectorType: ScenarioActionSelectorType =
    resolveActionSelectorTypeForNode(nodeData);
  const isTelegramBuilder = actionSelectorType === "telegram_builder";
  const isInstagramReply = actionSelectorType === "instagram_reply";
  const isEmailReply = actionSelectorType === "email_reply";
  const isWebWidgetReply = actionSelectorType === "web_widget_reply";
  const isWhatsAppServiceMessage =
    actionSelectorType === "whatsapp_service_message";
  const isGenerativeAI = actionSelectorType === "generative_ai";
  const resolvedActionSourceId =
    resolveActionSourceIdForSelector(actionSelectorType);
  const selectedActionSourceOption =
    nodeData.uiActionSourceOptions?.find(
      option => option.id === resolvedActionSourceId
    ) ?? null;
  const selectedActionSourceId = selectedActionSourceOption?.id;
  const actionType: ScenarioActionType =
    isTelegramBuilder ||
    isInstagramReply ||
    isEmailReply ||
    isWebWidgetReply ||
    isWhatsAppServiceMessage
      ? "reply"
      : actionSelectorType;
  const replyMode = isTelegramBuilder
    ? "fixed"
    : resolveReplyModeFromNodeData(nodeData);
  const replyCtaType: ScenarioReplyCtaType =
    actionType === "reply" && replyMode === "fixed"
      ? resolveReplyCtaTypeFromNodeData(nodeData)
      : "none";
  const isWhatsAppTemplateAction = actionType === "whatsapp_template";
  const instagramReplyDisabledReason = isInstagramReply
    ? (nodeData.uiInstagramReplyDisabledReason ?? null)
    : null;

  return {
    actionSelectorType,
    actionType,
    replyMode,
    replyCtaType,
    resolvedActionSourceId,
    selectedActionSourceOption,
    selectedActionSourceId,
    showWhatsAppActionKindSelect: selectedActionSourceId === "whatsapp",
    instagramReplyDisabledReason,
    isInstagramReplyDisabled: Boolean(instagramReplyDisabledReason),
    isTelegramBuilder,
    isInstagramReply,
    isEmailReply,
    isWebWidgetReply,
    isWhatsAppServiceMessage,
    isWhatsAppTemplateAction,
    isGenerativeAI,
    canEditTemplateFlow:
      isWhatsAppTemplateAction &&
      canEditFlowForWhatsAppTemplateComponents(
        nodeData.actionWhatsAppTemplateComponents
      ),
    templateEditorWorkspaceId: nodeData.uiWorkspaceId?.trim() || "",
  };
}

export type ActionNodeBranchState = {
  flowBranchOptions: ReturnType<typeof extractFlowBranchOptions>;
  hasTemplateFlowBranchControls: boolean;
  whatsAppTemplateButtonBranchOptions: ReturnType<
    typeof extractWhatsAppTemplateQuickReplyBranchOptions
  >;
  /** The saved quick replies' routes, by button id. */
  savedTemplateButtonBranchesById: Map<
    number,
    WhatsAppTemplateButtonBranchOption
  >;
  connectedTemplateButtonPayloads: Set<string>;
  hasWhatsAppTemplateButtonBranches: boolean;
  showBulkTemplateFollowUpHint: boolean;
  telegramBranchOptions: ReturnType<typeof extractTelegramBranchOptions>;
  connectedTelegramBranchPayloads: Set<string>;
  hasTelegramBranches: boolean;
  instagramBranchOptions: ReturnType<typeof extractInstagramBranchOptions>;
  hasInstagramBranches: boolean;
  whatsAppServiceMessageBranchOptions: ReturnType<
    typeof WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.extractOptions
  >;
  connectedWhatsAppServiceMessagePayloads: Set<string>;
  hasWhatsAppServiceMessageBranches: boolean;
  suppressDefaultActionOutputHandle: boolean;
  hiddenActionSourceHandles: string[];
  /** The hidden handles anchored on the top right corner, as on the card. */
  cornerActionSourceHandles: string[];
  actionSourceHandles: ScenarioNodeSourceHandle[] | undefined;
  outputHandleOverride: string | null | undefined;
  defaultActionSourceHandleCopy: ScenarioSourceHandleCopy | null;
  runConditionCount: number;
  actionOutcomeRows: ActionNodeOutcomeRow[];
  actionOutcomeHandleSignature: string;
  branchCount: number;
  flowBranchHandleSignature: string;
  whatsAppTemplateButtonBranchHandleSignature: string;
  telegramBranchHandleSignature: string;
  whatsAppServiceMessageBranchHandleSignature: string;
  nodeHandleLayoutSignature: string;
};

export function resolveActionNodeBranchState({
  id,
  mode,
  nodeData,
  renderMode,
  t,
}: {
  id: string;
  mode: ActionNodeModeState;
  nodeData: ScenarioActionEditorNodeData;
  renderMode: "compact" | "expanded";
  t: TranslateFn;
}): ActionNodeBranchState {
  const routingState = resolveActionNodeRoutingState(nodeData, t);
  const fixedOutputDescriptor =
    ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS.find(descriptor =>
      descriptor.usesFixedHandles(nodeData)
    );
  const fixedOutputHandleIds =
    fixedOutputDescriptor?.getSourceHandleIds(nodeData) ?? [];
  const serviceFlowConfig = resolveScenarioWhatsAppServiceFlowConfig(nodeData);
  const flowConfig = resolveScenarioWhatsAppInteractiveFlowConfig(nodeData);
  const flowBranchOptions =
    serviceFlowConfig || mode.canEditTemplateFlow
      ? extractFlowBranchOptions(flowConfig)
      : [];
  const hasFlowBranches = flowBranchOptions.length > 0;
  const hasTemplateFlowBranchControls =
    mode.isWhatsAppTemplateAction &&
    mode.canEditTemplateFlow &&
    hasFlowBranches;
  const whatsAppTemplateButtonBranchOptions = mode.isWhatsAppTemplateAction
    ? extractWhatsAppTemplateQuickReplyBranchOptions({
        actionNodeId: id,
        nodeData,
      })
    : [];
  const savedTemplateButtonBranchesById = new Map(
    whatsAppTemplateButtonBranchOptions.map(option => [option.buttonId, option])
  );
  const connectedTemplateButtonPayloads = toStringSet(
    nodeData.uiConnections.templateButtonPayloads
  );
  const hasWhatsAppTemplateButtonBranches =
    whatsAppTemplateButtonBranchOptions.length > 0;
  const telegramBranchOptions =
    mode.actionType === "reply" &&
    normalizeActionReplyChannelForActionNode(nodeData) === "telegram"
      ? extractTelegramBranchOptions(nodeData.actionTelegramQuickReplies)
      : [];
  const connectedTelegramBranchPayloads = toStringSet(
    nodeData.uiConnections.telegramPayloads
  );
  const hasTelegramBranches = telegramBranchOptions.length > 0;
  const instagramBranchOptions =
    mode.actionType === "reply" && mode.isInstagramReply
      ? extractInstagramBranchOptions(nodeData.actionInstagramConfig)
      : [];
  const connectedInstagramBranchPayloads = toStringSet(
    nodeData.uiConnections.instagramPayloads
  );
  const hasInstagramBranches = instagramBranchOptions.length > 0;
  const whatsAppServiceMessageBranchOptions =
    WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.extractOptions(nodeData, id);
  const connectedWhatsAppServiceMessagePayloads = toStringSet(
    nodeData.uiConnections.whatsAppChoicePayloads
  );
  const hasWhatsAppServiceMessageBranches =
    whatsAppServiceMessageBranchOptions.length > 0;
  const connectedSourceHandleIds = toStringSet(
    nodeData.uiConnections.sourceHandleIds
  );
  const connectedFlowBranchIds = toStringSet(
    nodeData.uiConnections.flowBranchIds
  );
  const branchTransitionEntries = getScenarioActionBranchTransitionsForNode(
    nodeData,
    id
  ).map(transition => ({
    transition,
    options: transition.extractOptions(nodeData, id),
  }));
  const labelBranchOption = createScenarioBranchOptionLabeler(nodeData, t);
  let nextPrimaryBranch:
    | {
        label: string;
        sourceHandleId: string;
        usesAggregateHandle: boolean;
      }
    | undefined;
  for (const { transition, options } of branchTransitionEntries) {
    const connectedOptionIds =
      transition.kind === "whatsapp_flow"
        ? connectedFlowBranchIds
        : transition.kind === "telegram_quick_reply"
          ? connectedTelegramBranchPayloads
          : transition.kind === "instagram_reply"
            ? connectedInstagramBranchPayloads
            : transition.kind === "whatsapp_service_message"
              ? connectedWhatsAppServiceMessagePayloads
              : connectedTemplateButtonPayloads;
    const nextOption = options.find(
      option => !connectedOptionIds.has(option.id)
    );
    if (!nextOption) continue;

    nextPrimaryBranch = {
      label: labelBranchOption(transition.kind, nextOption).label,
      sourceHandleId: transition.outputHandleId,
      usesAggregateHandle:
        transition.buildSourceHandleForOption(nextOption) ===
        transition.outputHandleId,
    };
    break;
  }
  const showPrimaryBranchSourceHandle = Boolean(
    nextPrimaryBranch &&
      (renderMode === "compact" || nextPrimaryBranch.usesAggregateHandle)
  );
  const promptInputAsk = readScenarioActionPromptInputAsk(nodeData);
  const unmetLabel = t("whatsappServicePromptInputsUnmet");
  const unmetSourceHandle: ScenarioNodeSourceHandle = {
    id: PROMPT_INPUTS_UNMET_HANDLE,
    top: "72%",
    title: unmetLabel,
    ariaLabel: unmetLabel,
    connected: connectedSourceHandleIds.has(PROMPT_INPUTS_UNMET_HANDLE),
    connectedLabel: unmetLabel,
  };
  // A choice ask continues on its options; only a missing detail needs a route.
  const choiceAskHandles =
    promptInputAsk === "choice" ? [unmetSourceHandle] : [];
  let actionSourceHandles: ScenarioNodeSourceHandle[] | undefined;
  if (fixedOutputHandleIds.length > 0) {
    actionSourceHandles = fixedOutputHandleIds.map((handleId, index) => {
      const isSuccess = handleId.endsWith("::success");
      const label = t(
        isSuccess ? "generativeAISuccess" : "generativeAIFailure"
      );
      return {
        id: handleId,
        top: index === 0 ? "42%" : "72%",
        title: label,
        ariaLabel: label,
        connected: connectedSourceHandleIds.has(handleId),
        connectedLabel: label,
      };
    });
  } else if (showPrimaryBranchSourceHandle && nextPrimaryBranch) {
    const label = t("sourceHandleNextBranch", {
      label: nextPrimaryBranch.label,
    });
    actionSourceHandles = [
      {
        id: nextPrimaryBranch.sourceHandleId,
        top: "38%",
        title: label,
        ariaLabel: label,
        connected: false,
        connectedLabel: label,
      },
      ...choiceAskHandles,
    ];
  } else if (promptInputAsk === "text") {
    const metLabel = t("whatsappServicePromptInputsMet");
    const continueHandleId =
      SCENARIO_HANDLE_RULES.action.outputHandleId ?? "right-source";
    actionSourceHandles = [
      {
        id: continueHandleId,
        top: "42%",
        title: metLabel,
        ariaLabel: metLabel,
        connected: connectedSourceHandleIds.has(continueHandleId),
        connectedLabel: metLabel,
      },
      unmetSourceHandle,
    ];
  } else if (promptInputAsk === "choice") {
    actionSourceHandles = choiceAskHandles;
  }

  const outputHandleOverride = actionSourceHandles
    ? null
    : (branchTransitionEntries.find(({ transition, options }) =>
        options.some(
          option =>
            transition.buildSourceHandleForOption(option) ===
            transition.outputHandleId
        )
      )?.transition.outputHandleId ?? null);
  const visibleActionSourceHandleIds = new Set([
    ...(actionSourceHandles?.map(handle => handle.id) ?? []),
    ...(outputHandleOverride ? [outputHandleOverride] : []),
  ]);
  const canonicalBranchOutputHandleIds = branchTransitionEntries.map(
    ({ transition }) => transition.outputHandleId
  );
  const canonicalBranchOptionSourceHandleIds = branchTransitionEntries.flatMap(
    ({ transition, options }) =>
      options.map(option => transition.buildSourceHandleForOption(option))
  );
  const canonicalBranchSourceHandleIds = uniqueStrings([
    ...canonicalBranchOutputHandleIds,
    ...canonicalBranchOptionSourceHandleIds,
  ]);
  const routesReplaceDefaultOutput =
    fixedOutputHandleIds.length > 0 ||
    hasFlowBranches ||
    hasWhatsAppServiceMessageBranches ||
    hasTelegramBranches ||
    scenarioActionCollectsPromptInputs(nodeData);
  const defaultOutputHandleId =
    SCENARIO_HANDLE_RULES.action.outputHandleId ?? "right-source";
  const defaultOutputConnected =
    connectedSourceHandleIds.has(defaultOutputHandleId) ||
    nodeData.uiConnections.destinationsBySourceHandle?.has(
      defaultOutputHandleId
    ) === true;
  const hasAnyReplyRow = routingState.actionOutcomeRows.some(
    row => row.kind === "any_reply"
  );
  const usesTemplateButtons = branchTransitionEntries.some(
    ({ transition }) => transition.kind === "whatsapp_template_button"
  );
  const defaultRoute = routesReplaceDefaultOutput
    ? null
    : resolveActionNodeContinueRoute({
        id,
        nodeData,
        usesTemplateButtons,
        hasAnyReply: hasAnyReplyRow,
        connected: defaultOutputConnected,
      });
  // As on the card, an unlinked default output that Any reply stands in for,
  // or that can't run, keeps only its anchor.
  const hidesDefaultOutput = defaultRoute === "hidden";
  // The template section draws a Form submitted route on its FLOW row; a
  // bulk send's or a stale one keeps only its anchor, as on the card.
  const formSubmittedRoute = resolveActionNodeFormSubmittedRoute(nodeData);
  const hiddenActionSourceHandles = mode.isGenerativeAI
    ? []
    : uniqueStrings([
        ...canonicalBranchOutputHandleIds,
        ...(renderMode === "compact"
          ? canonicalBranchOptionSourceHandleIds
          : []),
        ...(connectedSourceHandleIds.has(
          ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
        )
          ? [ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID]
          : []),
        ...(hidesDefaultOutput ? [defaultOutputHandleId] : []),
        ...(formSubmittedRoute.placement === "anchor"
          ? [ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID]
          : []),
      ]).filter(handleId => !visibleActionSourceHandleIds.has(handleId));
  // Its anchor sits on the top right corner, away from every route dot.
  const cornerActionSourceHandles = hiddenActionSourceHandles.filter(
    handleId => handleId === ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
  );
  const suppressDefaultActionOutputHandle =
    routesReplaceDefaultOutput || hidesDefaultOutput;
  const nodeHandleLayoutSignature = [
    canonicalBranchSourceHandleIds
      .map(handleId => `branch:${handleId}`)
      .join(","),
    hiddenActionSourceHandles.map(handleId => `hidden:${handleId}`).join(","),
    (actionSourceHandles ?? [])
      .map(handle => `visible:${handle.id}@${handle.top}`)
      .join(","),
    `output:${outputHandleOverride ?? ""}`,
    `suppress:${String(suppressDefaultActionOutputHandle)}`,
    `outcomes:${routingState.actionOutcomeHandleSignature}`,
    `form:${formSubmittedRoute.placement}:${String(formSubmittedRoute.connected)}`,
  ].join("|");

  return {
    flowBranchOptions,
    hasTemplateFlowBranchControls,
    whatsAppTemplateButtonBranchOptions,
    savedTemplateButtonBranchesById,
    connectedTemplateButtonPayloads,
    hasWhatsAppTemplateButtonBranches,
    showBulkTemplateFollowUpHint:
      Boolean(nodeData.uiBulkPrimaryAction) && mode.isWhatsAppTemplateAction,
    telegramBranchOptions,
    connectedTelegramBranchPayloads,
    hasTelegramBranches,
    instagramBranchOptions,
    hasInstagramBranches,
    whatsAppServiceMessageBranchOptions,
    connectedWhatsAppServiceMessagePayloads,
    hasWhatsAppServiceMessageBranches,
    suppressDefaultActionOutputHandle,
    hiddenActionSourceHandles,
    cornerActionSourceHandles,
    actionSourceHandles,
    outputHandleOverride,
    // A linked route that can't run is named, so the notice's route is
    // findable on its dot.
    defaultActionSourceHandleCopy:
      mode.isWhatsAppTemplateAction &&
      hasWhatsAppTemplateButtonBranches &&
      !hidesDefaultOutput
        ? resolveDefaultActionSourceHandleCopy(nodeData, t, {
            usesTemplateButtons: true,
            linkedBesideAnyReply: hasAnyReplyRow && defaultOutputConnected,
          })
        : defaultRoute === "cannot_run"
          ? resolveDefaultActionSourceHandleCopy(nodeData, t, {
              usesTemplateButtons,
              linkedBesideAnyReply: hasAnyReplyRow,
            })
          : null,
    ...routingState,
    branchCount:
      flowBranchOptions.length +
      telegramBranchOptions.length +
      instagramBranchOptions.length +
      whatsAppServiceMessageBranchOptions.length +
      whatsAppTemplateButtonBranchOptions.length +
      routingState.actionOutcomeRows.length +
      fixedOutputHandleIds.length,
    flowBranchHandleSignature: buildBranchHandleSignature(
      flowBranchOptions,
      option => `${option.fieldId}:${option.optionId}`
    ),
    whatsAppTemplateButtonBranchHandleSignature: buildBranchHandleSignature(
      whatsAppTemplateButtonBranchOptions,
      option => `${option.index}:${option.payload}`
    ),
    telegramBranchHandleSignature: buildBranchHandleSignature(
      telegramBranchOptions,
      option => option.payload
    ),
    whatsAppServiceMessageBranchHandleSignature: buildBranchHandleSignature(
      whatsAppServiceMessageBranchOptions,
      option => option.id
    ),
    nodeHandleLayoutSignature,
  };
}

/**
 * A template's default output, named as its route row names it. It reads
 * "Then" only when it is linked beside an Other reply route.
 */
function resolveDefaultActionSourceHandleCopy(
  nodeData: ScenarioActionEditorNodeData,
  t: TranslateFn,
  {
    usesTemplateButtons,
    linkedBesideAnyReply,
  }: { usesTemplateButtons: boolean; linkedBesideAnyReply: boolean }
): ScenarioSourceHandleCopy {
  const label = resolveContinueLabel({
    nodeData,
    t,
    usesTemplateButtons,
    besideAnyReply: linkedBesideAnyReply,
  });
  return { label, tooltip: label };
}
