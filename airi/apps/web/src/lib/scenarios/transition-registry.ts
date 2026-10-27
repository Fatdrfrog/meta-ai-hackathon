import type { ScenarioGraphValidationErrorKey } from "@/lib/scenarios/graph-validation";
import { extractInstagramBranchOptions } from "@/lib/scenarios/instagram-reply-config";
import { normalizeActionReplyChannelForActionNode } from "@/lib/scenarios/normalization";
import {
  getPostActionConditionHandleId,
  isPostActionReplyClaimHandleId,
  resolvePostActionConditionTypeFromHandle,
} from "@icecore/scenario-contracts";
import { extractTelegramBranchOptions } from "@/lib/scenarios/telegram-quick-replies";
import { extractFlowBranchOptions } from "@/lib/scenarios/whatsapp-flow-branches";
import {
  resolveScenarioWhatsAppInteractiveFlowConfig,
  resolveScenarioWhatsAppServiceFlowConfig,
  resolveScenarioWhatsAppServiceMessage,
} from "@/lib/scenarios/whatsapp-service-message";
import {
  extractWhatsAppTemplateQuickReplyBranchOptions,
  hasWhatsAppTemplateQuickReplyButtons,
} from "@/lib/scenarios/whatsapp-template-button-branches";
import { canEditFlowForWhatsAppTemplateComponents } from "@/lib/scenarios/whatsapp-template-flow";
import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  buildFlowBranchOptionKey,
  buildFlowBranchSourceHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  extractScenarioWhatsAppServiceBranchOptions,
  getConfiguredScenarioActionOutcomeHandleIds,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_OUTPUT_HANDLE_IDS,
  GENERATIVE_AI_SUCCESS_HANDLE,
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  PROMPT_INPUTS_UNMET_HANDLE,
  scenarioActionCollectsPromptInputs,
  parseFlowBranchOptionKey,
  parseFlowBranchSourceHandleId,
  parseTelegramBranchSourceHandleId,
  parseScenarioActionOutcomeHandleId,
  parseWhatsAppSessionChoiceSourceHandleId,
  parseWhatsAppTemplateButtonPayload,
  parseWhatsAppTemplateButtonSourceHandleId,
  type ScenarioNodeData,
  type ScenarioPostActionConditionType,
  type ScenarioTriggerEventKind,
  whatsAppTemplateOffersFormSubmittedRoute,
} from "@icecore/scenario-contracts";

import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";

export type ScenarioBranchTransitionKind =
  | "whatsapp_flow"
  | "telegram_quick_reply"
  | "instagram_reply"
  | "whatsapp_service_message"
  | "whatsapp_template_button";

export type ScenarioBranchOption = {
  id: string;
  label: string;
  sourceHandleId?: string;
  /** Set for a template carousel card's button: the card's position. */
  cardIndex?: number;
};

export type ScenarioActionBranchTransitionDescriptor = {
  kind: ScenarioBranchTransitionKind;
  usesBranchHandles: (nodeData: ScenarioNodeData) => boolean;
  extractOptions: (
    nodeData: ScenarioNodeData,
    actionNodeId?: string
  ) => ScenarioBranchOption[];
  getBranchId: (nodeData: ScenarioNodeData) => string | undefined;
  makeBranchNodeData: (
    option: ScenarioBranchOption
  ) => Partial<ScenarioNodeData>;
  outputHandleId: string;
  incompleteErrorKey?: ScenarioGraphValidationErrorKey;
  limitReachedKey: string;
  autoCreateMissingNodes?: boolean;
  autoRemoveOrphanedNodes?: boolean | "whenNoOptions";
  parseSourceHandleId?: (handleId: string | null | undefined) => unknown;
  matchesSourceHandle: (
    handleId: string | null | undefined,
    branchOptions?: ScenarioBranchOption[]
  ) => boolean;
  resolveBranchIdFromSourceHandle: (
    handleId: string | null | undefined,
    branchOptions: ScenarioBranchOption[]
  ) => string | null;
  buildSourceHandleForOption: (
    option: ScenarioBranchOption | null
  ) => string | null;
};

export type ScenarioActionOutcomeTransitionDescriptor = {
  kind: "action_outcome";
  limitReachedKey: "actionOutcomeAlreadyConnected";
  getSourceHandleIds: (nodeData: ScenarioNodeData) => string[];
  matchesSourceHandle: (handleId: string | null | undefined) => boolean;
};

export type ScenarioActionFixedOutputTransitionDescriptor = {
  kind: "generative_ai";
  limitReachedKey: "actionOutcomeAlreadyConnected";
  usesFixedHandles: (nodeData: ScenarioNodeData) => boolean;
  getSourceHandleIds: (nodeData: ScenarioNodeData) => string[];
  matchesSourceHandle: (handleId: string | null | undefined) => boolean;
};

export const ACTION_OUTCOME_TRANSITION: ScenarioActionOutcomeTransitionDescriptor =
  {
    kind: "action_outcome",
    limitReachedKey: "actionOutcomeAlreadyConnected",
    getSourceHandleIds: nodeData =>
      nodeData.kind === "action"
        ? getConfiguredScenarioActionOutcomeHandleIds(nodeData.actionOutcomes)
        : [],
    matchesSourceHandle: handleId =>
      parseScenarioActionOutcomeHandleId(handleId) !== null,
  };

export const GENERATIVE_AI_OUTPUT_TRANSITION: ScenarioActionFixedOutputTransitionDescriptor =
  {
    kind: "generative_ai",
    limitReachedKey: "actionOutcomeAlreadyConnected",
    usesFixedHandles: nodeData =>
      nodeData.kind === "action" &&
      resolveScenarioActionTypeFromNodeData(nodeData) === "generative_ai",
    getSourceHandleIds: nodeData =>
      nodeData.kind === "action" &&
      resolveScenarioActionTypeFromNodeData(nodeData) === "generative_ai"
        ? [GENERATIVE_AI_SUCCESS_HANDLE, GENERATIVE_AI_FAILURE_HANDLE]
        : [],
    matchesSourceHandle: handleId => {
      const normalized = typeof handleId === "string" ? handleId.trim() : "";
      return GENERATIVE_AI_OUTPUT_HANDLE_IDS.some(
        fixedHandleId => fixedHandleId === normalized
      );
    },
  };

export const SCENARIO_ACTION_FIXED_OUTPUT_TRANSITIONS = [
  GENERATIVE_AI_OUTPUT_TRANSITION,
] as const satisfies readonly ScenarioActionFixedOutputTransitionDescriptor[];

export type ScenarioPromptInputsUnmetTransitionDescriptor = {
  kind: "prompt_inputs_unmet";
  limitReachedKey: "actionOutcomeAlreadyConnected";
};

export const PROMPT_INPUTS_UNMET_OUTPUT_TRANSITION: ScenarioPromptInputsUnmetTransitionDescriptor =
  {
    kind: "prompt_inputs_unmet",
    limitReachedKey: "actionOutcomeAlreadyConnected",
  };

export type ScenarioWhatsAppTemplateFormSubmittedTransitionDescriptor = {
  kind: "whatsapp_template_form_submitted";
  limitReachedKey: "actionOutcomeAlreadyConnected";
};

/**
 * A template's "Form submitted" route leads to one next step, as an outcome
 * does. It is not a branch: a FLOW button alone never makes a template ask
 * for a choice.
 */
export const WHATSAPP_TEMPLATE_FORM_SUBMITTED_OUTPUT_TRANSITION: ScenarioWhatsAppTemplateFormSubmittedTransitionDescriptor =
  {
    kind: "whatsapp_template_form_submitted",
    limitReachedKey: "actionOutcomeAlreadyConnected",
  };

export type ScenarioActionOutputTransitionDescriptor =
  | ScenarioActionOutcomeTransitionDescriptor
  | ScenarioActionFixedOutputTransitionDescriptor
  | ScenarioPromptInputsUnmetTransitionDescriptor
  | ScenarioWhatsAppTemplateFormSubmittedTransitionDescriptor;

export function getScenarioActionOutputTransitionForSourceHandle(
  nodeData: ScenarioNodeData,
  sourceHandleId: string | null | undefined
): ScenarioActionOutputTransitionDescriptor | null {
  const normalized =
    typeof sourceHandleId === "string" ? sourceHandleId.trim() : "";
  if (!normalized || nodeData.kind !== "action") return null;

  const fixedTransition =
    SCENARIO_ACTION_FIXED_OUTPUT_TRANSITIONS.find(
      descriptor =>
        descriptor.usesFixedHandles(nodeData) &&
        descriptor.matchesSourceHandle(normalized) &&
        descriptor.getSourceHandleIds(nodeData).includes(normalized)
    ) ?? null;
  if (fixedTransition) return fixedTransition;

  if (
    normalized === PROMPT_INPUTS_UNMET_HANDLE &&
    scenarioActionCollectsPromptInputs(nodeData)
  ) {
    return PROMPT_INPUTS_UNMET_OUTPUT_TRANSITION;
  }

  if (
    isWhatsAppTemplateFormSubmittedSourceHandleId(normalized) &&
    whatsappTemplateOffersFormSubmittedRoute(nodeData)
  ) {
    return WHATSAPP_TEMPLATE_FORM_SUBMITTED_OUTPUT_TRANSITION;
  }

  return ACTION_OUTCOME_TRANSITION.matchesSourceHandle(normalized) &&
    ACTION_OUTCOME_TRANSITION.getSourceHandleIds(nodeData).includes(normalized)
    ? ACTION_OUTCOME_TRANSITION
    : null;
}

export type PostActionConditionBranchTransitionDescriptor = {
  kind: "post_action_condition";
  branchType: ScenarioPostActionConditionType;
  eventKind: ScenarioTriggerEventKind;
  eventKinds: readonly ScenarioTriggerEventKind[];
  outputHandleId: string;
  producesTimer: boolean;
};

const EMPTY_BRANCH_BINDING_PATCH = {
  flowBranchSourceFieldId: undefined,
  flowBranchOptionId: undefined,
  flowBranchOptionLabel: undefined,
  telegramBranchPayload: undefined,
  telegramBranchLabel: undefined,
  instagramBranchPayload: undefined,
  instagramBranchLabel: undefined,
  whatsAppSessionChoicePayload: undefined,
  whatsAppSessionChoiceLabel: undefined,
  whatsAppTemplateButtonPayload: undefined,
  whatsAppTemplateButtonLabel: undefined,
} satisfies Partial<Record<keyof ScenarioNodeData, undefined>>;

export const SCENARIO_BRANCH_BINDING_FIELDS = Object.keys(
  EMPTY_BRANCH_BINDING_PATCH
) as Array<keyof typeof EMPTY_BRANCH_BINDING_PATCH>;

export const SCENARIO_FLOW_BRANCH_BINDING_FIELDS = [
  "flowBranchSourceFieldId",
  "flowBranchOptionId",
  "flowBranchOptionLabel",
] as const satisfies ReadonlyArray<keyof typeof EMPTY_BRANCH_BINDING_PATCH>;

function hasStringField(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
  fields: ReadonlyArray<keyof typeof EMPTY_BRANCH_BINDING_PATCH>
): boolean {
  if (!nodeData) return false;
  return fields.some(field => typeof nodeData[field] === "string");
}

export function clearScenarioBranchBindingData(): Partial<ScenarioNodeData> {
  return { ...EMPTY_BRANCH_BINDING_PATCH };
}

export function hasScenarioBranchBindingData(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): boolean {
  return hasStringField(nodeData, SCENARIO_BRANCH_BINDING_FIELDS);
}

export function hasScenarioFlowBranchBindingData(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): boolean {
  return hasStringField(nodeData, SCENARIO_FLOW_BRANCH_BINDING_FIELDS);
}

export function hasSameScenarioBranchBindingData(
  previous: Partial<ScenarioNodeData>,
  next: Partial<ScenarioNodeData>
): boolean {
  return SCENARIO_BRANCH_BINDING_FIELDS.every(
    field => previous[field] === next[field]
  );
}

function getFlowBranchId(
  nodeData: Partial<ScenarioNodeData>
): string | undefined {
  const fieldId =
    typeof nodeData.flowBranchSourceFieldId === "string"
      ? nodeData.flowBranchSourceFieldId.trim()
      : "";
  const optionId =
    typeof nodeData.flowBranchOptionId === "string"
      ? nodeData.flowBranchOptionId.trim()
      : "";

  if (!fieldId || !optionId) {
    return undefined;
  }

  return buildFlowBranchOptionKey(fieldId, optionId);
}

function flowSourceHandleMatches(handleId: string | null | undefined): boolean {
  const normalized = typeof handleId === "string" ? handleId.trim() : "";
  return (
    normalized === ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID ||
    parseFlowBranchSourceHandleId(normalized) !== null
  );
}

function templateButtonSourceHandleMatches(
  handleId: string | null | undefined,
  branchOptions: ScenarioBranchOption[] = []
): boolean {
  const parsed = parseWhatsAppTemplateButtonSourceHandleId(handleId);
  if (!parsed) return false;
  if (branchOptions.length === 0) return true;
  return branchOptions.some(
    option =>
      option.sourceHandleId === handleId ||
      parseWhatsAppTemplateButtonPayload(option.id)?.buttonId ===
        parsed.buttonId
  );
}

function payloadSourceHandleMatches(params: {
  handleId: string | null | undefined;
  outputHandleId: string;
  parseSourceHandleId: (
    handleId: string | null | undefined
  ) => { payload: string } | null;
  branchOptions?: ScenarioBranchOption[];
}): boolean {
  const normalized =
    typeof params.handleId === "string" ? params.handleId.trim() : "";
  if (normalized === params.outputHandleId) return true;
  const parsed = params.parseSourceHandleId(normalized);
  if (!parsed) return false;
  if (!params.branchOptions?.length) return true;
  return params.branchOptions.some(option => option.id === parsed.payload);
}

function resolvePayloadBranchIdFromSourceHandle(params: {
  handleId: string | null | undefined;
  parseSourceHandleId: (
    handleId: string | null | undefined
  ) => { payload: string } | null;
  branchOptions: ScenarioBranchOption[];
}): string | null {
  const parsed = params.parseSourceHandleId(params.handleId);
  if (!parsed) return null;
  return (
    params.branchOptions.find(option => option.id === parsed.payload)?.id ??
    null
  );
}

export const FLOW_BRANCH_TRANSITION: ScenarioActionBranchTransitionDescriptor =
  {
    kind: "whatsapp_flow",
    usesBranchHandles: nodeData => {
      const actionType = resolveScenarioActionTypeFromNodeData(nodeData);
      const allowTemplateFlow =
        actionType === "whatsapp_template" &&
        canEditFlowForWhatsAppTemplateComponents(
          nodeData.actionWhatsAppTemplateComponents
        );
      const serviceFlowConfig =
        resolveScenarioWhatsAppServiceFlowConfig(nodeData);
      const flowConfig = resolveScenarioWhatsAppInteractiveFlowConfig(nodeData);
      return (
        Boolean(serviceFlowConfig || allowTemplateFlow) &&
        extractFlowBranchOptions(flowConfig).length > 0
      );
    },
    extractOptions: nodeData => {
      const actionType = resolveScenarioActionTypeFromNodeData(nodeData);
      const allowTemplateFlow =
        actionType === "whatsapp_template" &&
        canEditFlowForWhatsAppTemplateComponents(
          nodeData.actionWhatsAppTemplateComponents
        );
      const serviceFlowConfig =
        resolveScenarioWhatsAppServiceFlowConfig(nodeData);
      if (!serviceFlowConfig && !allowTemplateFlow) {
        return [];
      }

      return extractFlowBranchOptions(
        resolveScenarioWhatsAppInteractiveFlowConfig(nodeData)
      ).map(option => ({
        id: buildFlowBranchOptionKey(option.fieldId, option.optionId),
        label: option.optionTitle,
        sourceHandleId: buildFlowBranchSourceHandleId(
          option.fieldId,
          option.optionId
        ),
      }));
    },
    getBranchId: getFlowBranchId,
    makeBranchNodeData: option => {
      const branchKey = parseFlowBranchOptionKey(option.id);
      if (!branchKey) return {};

      return {
        flowBranchSourceFieldId: branchKey.fieldId,
        flowBranchOptionId: branchKey.optionId,
        flowBranchOptionLabel: option.label,
      };
    },
    outputHandleId: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
    limitReachedKey: "flowBranchLimitReached",
    autoCreateMissingNodes: false,
    autoRemoveOrphanedNodes: true,
    parseSourceHandleId: parseFlowBranchSourceHandleId,
    matchesSourceHandle: flowSourceHandleMatches,
    resolveBranchIdFromSourceHandle: handleId => {
      const requestedFlowBranch = parseFlowBranchSourceHandleId(handleId);
      return requestedFlowBranch
        ? buildFlowBranchOptionKey(
            requestedFlowBranch.fieldId,
            requestedFlowBranch.optionId
          )
        : null;
    },
    buildSourceHandleForOption: option => option?.sourceHandleId ?? null,
  };

export const TELEGRAM_BRANCH_TRANSITION: ScenarioActionBranchTransitionDescriptor =
  {
    kind: "telegram_quick_reply",
    usesBranchHandles: nodeData =>
      resolveScenarioActionTypeFromNodeData(nodeData) === "reply" &&
      normalizeActionReplyChannelForActionNode(nodeData) === "telegram" &&
      extractTelegramBranchOptions(nodeData.actionTelegramQuickReplies).length >
        0,
    extractOptions: nodeData => {
      if (resolveScenarioActionTypeFromNodeData(nodeData) !== "reply") {
        return [];
      }
      if (normalizeActionReplyChannelForActionNode(nodeData) !== "telegram") {
        return [];
      }

      return extractTelegramBranchOptions(
        nodeData.actionTelegramQuickReplies
      ).map(option => ({
        id: option.payload,
        label: option.text,
        sourceHandleId: buildTelegramBranchSourceHandleId(option.payload),
      }));
    },
    getBranchId: nodeData => nodeData.telegramBranchPayload,
    makeBranchNodeData: option => ({
      telegramBranchPayload: option.id,
      telegramBranchLabel: option.label,
    }),
    outputHandleId: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
    incompleteErrorKey: "telegramBranchIncomplete",
    limitReachedKey: "telegramBranchLimitReached",
    autoCreateMissingNodes: false,
    autoRemoveOrphanedNodes: "whenNoOptions",
    parseSourceHandleId: parseTelegramBranchSourceHandleId,
    matchesSourceHandle: (handleId, branchOptions) =>
      payloadSourceHandleMatches({
        handleId,
        outputHandleId: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
        parseSourceHandleId: parseTelegramBranchSourceHandleId,
        branchOptions,
      }),
    resolveBranchIdFromSourceHandle: (handleId, branchOptions) =>
      resolvePayloadBranchIdFromSourceHandle({
        handleId,
        parseSourceHandleId: parseTelegramBranchSourceHandleId,
        branchOptions,
      }),
    buildSourceHandleForOption: option =>
      option?.sourceHandleId ?? ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  };

export const WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION: ScenarioActionBranchTransitionDescriptor =
  {
    kind: "whatsapp_service_message",
    usesBranchHandles: nodeData => {
      const resolved = resolveScenarioWhatsAppServiceMessage(nodeData);
      return (
        resolved.status === "canonical" &&
        extractScenarioWhatsAppServiceBranchOptions({
          config: resolved.value,
        }).length > 0
      );
    },
    extractOptions: nodeData => {
      const resolved = resolveScenarioWhatsAppServiceMessage(nodeData);
      if (resolved.status !== "canonical") {
        return [];
      }
      return extractScenarioWhatsAppServiceBranchOptions({
        config: resolved.value,
      }).map(option => ({
        id: option.id,
        label: option.label,
        sourceHandleId: buildWhatsAppSessionChoiceSourceHandleId(option.id),
      }));
    },
    getBranchId: nodeData => nodeData.whatsAppSessionChoicePayload,
    makeBranchNodeData: option => ({
      whatsAppSessionChoicePayload: option.id,
      whatsAppSessionChoiceLabel: option.label,
    }),
    outputHandleId: ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
    limitReachedKey: "whatsAppSessionChoiceBranchLimitReached",
    autoCreateMissingNodes: false,
    autoRemoveOrphanedNodes: "whenNoOptions",
    parseSourceHandleId: parseWhatsAppSessionChoiceSourceHandleId,
    matchesSourceHandle: (handleId, branchOptions) =>
      payloadSourceHandleMatches({
        handleId,
        outputHandleId: ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
        parseSourceHandleId: parseWhatsAppSessionChoiceSourceHandleId,
        branchOptions,
      }),
    resolveBranchIdFromSourceHandle: (handleId, branchOptions) =>
      resolvePayloadBranchIdFromSourceHandle({
        handleId,
        parseSourceHandleId: parseWhatsAppSessionChoiceSourceHandleId,
        branchOptions,
      }),
    buildSourceHandleForOption: option =>
      option?.sourceHandleId ??
      ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  };

export const INSTAGRAM_BRANCH_TRANSITION: ScenarioActionBranchTransitionDescriptor =
  {
    kind: "instagram_reply",
    usesBranchHandles: nodeData =>
      resolveScenarioActionTypeFromNodeData(nodeData) === "reply" &&
      nodeData.actionReplyChannel === "instagram" &&
      extractInstagramBranchOptions(nodeData.actionInstagramConfig).length > 0,
    extractOptions: nodeData => {
      if (
        resolveScenarioActionTypeFromNodeData(nodeData) !== "reply" ||
        nodeData.actionReplyChannel !== "instagram"
      ) {
        return [];
      }

      return extractInstagramBranchOptions(nodeData.actionInstagramConfig);
    },
    getBranchId: nodeData => nodeData.instagramBranchPayload,
    makeBranchNodeData: option => ({
      instagramBranchPayload: option.id,
      instagramBranchLabel: option.label,
    }),
    outputHandleId: ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
    incompleteErrorKey: "instagramBranchIncomplete",
    limitReachedKey: "instagramBranchLimitReached",
    autoCreateMissingNodes: false,
    autoRemoveOrphanedNodes: "whenNoOptions",
    matchesSourceHandle: handleId => {
      const normalized = typeof handleId === "string" ? handleId.trim() : "";
      return normalized === ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID;
    },
    resolveBranchIdFromSourceHandle: () => null,
    buildSourceHandleForOption: () => ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  };

export const WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION: ScenarioActionBranchTransitionDescriptor =
  {
    kind: "whatsapp_template_button",
    usesBranchHandles: nodeData =>
      resolveScenarioActionTypeFromNodeData(nodeData) === "whatsapp_template" &&
      hasWhatsAppTemplateQuickReplyButtons(
        nodeData.actionWhatsAppTemplateComponents
      ),
    extractOptions: (nodeData, actionNodeId) => {
      if (
        resolveScenarioActionTypeFromNodeData(nodeData) !== "whatsapp_template"
      ) {
        return [];
      }

      return extractWhatsAppTemplateQuickReplyBranchOptions({
        actionNodeId: actionNodeId || "",
        nodeData,
      }).map(option => ({
        id: option.payload,
        label: option.label,
        sourceHandleId: buildWhatsAppTemplateButtonSourceHandleId(
          option.buttonId
        ),
        ...(option.cardIndex === undefined
          ? {}
          : { cardIndex: option.cardIndex }),
      }));
    },
    getBranchId: nodeData => nodeData.whatsAppTemplateButtonPayload,
    makeBranchNodeData: option => ({
      whatsAppTemplateButtonPayload: option.id,
      whatsAppTemplateButtonLabel: option.label,
    }),
    outputHandleId: ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
    limitReachedKey: "whatsAppTemplateButtonBranchLimitReached",
    autoCreateMissingNodes: false,
    autoRemoveOrphanedNodes: "whenNoOptions",
    parseSourceHandleId: parseWhatsAppTemplateButtonSourceHandleId,
    matchesSourceHandle: templateButtonSourceHandleMatches,
    resolveBranchIdFromSourceHandle: (handleId, branchOptions) => {
      const requestedTemplateButtonBranch =
        parseWhatsAppTemplateButtonSourceHandleId(handleId);
      if (!requestedTemplateButtonBranch) return null;
      return (
        branchOptions.find(
          option =>
            option.sourceHandleId === handleId ||
            parseWhatsAppTemplateButtonPayload(option.id)?.buttonId ===
              requestedTemplateButtonBranch.buttonId
        )?.id ?? null
      );
    },
    buildSourceHandleForOption: option =>
      option?.sourceHandleId ??
      ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  };

export const SCENARIO_ACTION_BRANCH_TRANSITIONS = [
  FLOW_BRANCH_TRANSITION,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION,
  INSTAGRAM_BRANCH_TRANSITION,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION,
  TELEGRAM_BRANCH_TRANSITION,
] as const satisfies readonly ScenarioActionBranchTransitionDescriptor[];

export function getScenarioActionBranchTransitionBySourceHandle(
  sourceHandleId: string | null | undefined
): ScenarioActionBranchTransitionDescriptor | null {
  const normalized =
    typeof sourceHandleId === "string" ? sourceHandleId.trim() : "";
  if (!normalized) return null;
  return (
    SCENARIO_ACTION_BRANCH_TRANSITIONS.find(descriptor =>
      descriptor.matchesSourceHandle(normalized)
    ) ?? null
  );
}

export function getScenarioActionBranchTransitionsForNode(
  nodeData: ScenarioNodeData,
  actionNodeId?: string
): ScenarioActionBranchTransitionDescriptor[] {
  if (nodeData.kind !== "action") return [];
  return SCENARIO_ACTION_BRANCH_TRANSITIONS.filter(descriptor =>
    actionNodeId
      ? descriptor.extractOptions(nodeData, actionNodeId).length > 0
      : descriptor.usesBranchHandles(nodeData)
  );
}

/**
 * Whether a template step can have a "Form submitted" route: its one FLOW
 * button opens a form, and no route follows a Flow choice instead. The
 * builder and the runtime read this one rule.
 */
export function whatsappTemplateOffersFormSubmittedRoute(
  data: ScenarioNodeData
): boolean {
  return (
    whatsAppTemplateOffersFormSubmittedRoute(data) &&
    !FLOW_BRANCH_TRANSITION.usesBranchHandles(data)
  );
}

export function scenarioActionUsesWhatsAppTemplateButtonBranchHandles(
  nodeData: ScenarioNodeData
): boolean {
  return (
    resolveScenarioActionTypeFromNodeData(nodeData) === "whatsapp_template" &&
    hasWhatsAppTemplateQuickReplyButtons(
      nodeData.actionWhatsAppTemplateComponents
    )
  );
}

const POST_ACTION_CONDITION_EVENT_KINDS = {
  user_replied: [
    "inbound_message",
    "post_action_user_reply",
    "telegram_quick_reply",
    "instagram_quick_reply",
    "whatsapp_button_reply",
    "whatsapp_flow_reply",
  ],
  no_reply_timeout: ["no_human_reply_timeout"],
  payment_detected: ["payment_detected"],
} as const satisfies Record<
  ScenarioPostActionConditionType,
  readonly ScenarioTriggerEventKind[]
>;

const POST_ACTION_CONDITION_BRANCH_TYPES = [
  "user_replied",
  "payment_detected",
  "no_reply_timeout",
] as const satisfies readonly ScenarioPostActionConditionType[];

export const POST_ACTION_CONDITION_BRANCH_TRANSITIONS =
  POST_ACTION_CONDITION_BRANCH_TYPES.map(branchType => {
    const eventKinds = POST_ACTION_CONDITION_EVENT_KINDS[branchType];
    return {
      kind: "post_action_condition",
      branchType,
      eventKind: eventKinds[0],
      eventKinds,
      outputHandleId: getPostActionConditionHandleId(branchType),
      producesTimer: branchType === "no_reply_timeout",
    } satisfies PostActionConditionBranchTransitionDescriptor;
  });

export function getPostActionConditionBranchTransitionByHandle(
  handleId: string | null | undefined
): PostActionConditionBranchTransitionDescriptor | null {
  if (isPostActionReplyClaimHandleId(handleId)) {
    return (
      POST_ACTION_CONDITION_BRANCH_TRANSITIONS.find(
        descriptor => descriptor.branchType === "no_reply_timeout"
      ) ?? null
    );
  }

  const branchType = resolvePostActionConditionTypeFromHandle(handleId);
  if (!branchType) return null;
  return (
    POST_ACTION_CONDITION_BRANCH_TRANSITIONS.find(
      descriptor => descriptor.branchType === branchType
    ) ?? null
  );
}

// An answer rule belongs to the wait's No reply branch, so its handle keeps
// the timer descriptor; a location route shares it, never the Any reply
// descriptor, so typed text can't pass a location route. The wait claims a
// matched answer or a shared location and continues with that reply.
const POST_ACTION_ANSWER_MATCH_EVENT_KIND =
  "post_action_user_reply" satisfies ScenarioTriggerEventKind;

export function postActionConditionBranchHandleMatchesEvent(
  handleId: string | null | undefined,
  eventKind: string | null | undefined
): boolean {
  const descriptor = getPostActionConditionBranchTransitionByHandle(handleId);
  if (!descriptor || !eventKind) return false;
  if (descriptor.eventKinds.includes(eventKind as ScenarioTriggerEventKind)) {
    return true;
  }
  return (
    eventKind === POST_ACTION_ANSWER_MATCH_EVENT_KIND &&
    isPostActionReplyClaimHandleId(handleId)
  );
}

export function whatsAppTemplateButtonReplyMatchesSourceHandle(params: {
  sourceActionNodeId: string | null | undefined;
  sourceHandleId: string | null | undefined;
  quickReplyPayload: string | null | undefined;
}): boolean {
  const templateButtonBranch = parseWhatsAppTemplateButtonSourceHandleId(
    params.sourceHandleId
  );
  if (!templateButtonBranch) return false;

  const templateButtonReply = parseWhatsAppTemplateButtonPayload(
    params.quickReplyPayload
  );
  if (!templateButtonReply) return false;

  const sourceActionNodeId =
    typeof params.sourceActionNodeId === "string"
      ? params.sourceActionNodeId.trim()
      : "";

  return (
    Boolean(sourceActionNodeId) &&
    templateButtonReply.actionNodeId === sourceActionNodeId &&
    templateButtonReply.buttonId === templateButtonBranch.buttonId
  );
}
