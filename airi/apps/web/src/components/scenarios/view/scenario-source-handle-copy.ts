import {
  buildFlowBranchOptionKey,
  DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  getNoReplyAnswerMatchRules,
  getPostActionConditionHandleId,
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  listScenarioWhatsAppServiceOptions,
  normalizeScenarioActionOutcomes,
  parsePostActionAnswerMatchHandleId,
  parseRecipientColumnSplitPathHandleId,
  parseScenarioActionOutcomeHandleId,
  PROMPT_INPUTS_UNMET_HANDLE,
  readScenarioActionPromptInputAsk,
  type ScenarioActionLocationRoutes,
  type ScenarioActionOutcomeHandle,
  type ScenarioAnswerMatchMode,
} from "@icecore/scenario-contracts";
import {
  getRecipientColumnSplitConfig,
  isRecipientColumnSplitNodeData,
} from "@/lib/scenarios/recipient-column-split";
import {
  getScenarioActionBranchTransitionBySourceHandle,
  getScenarioActionBranchTransitionsForNode,
  scenarioActionUsesWhatsAppTemplateButtonBranchHandles,
  type ScenarioBranchOption,
  type ScenarioBranchTransitionKind,
} from "@/lib/scenarios/transition-registry";
import { extractFlowBranchOptions } from "@/lib/scenarios/whatsapp-flow-branches";
import {
  resolveScenarioWhatsAppInteractiveFlowConfig,
  resolveScenarioWhatsAppServiceMessage,
} from "@/lib/scenarios/whatsapp-service-message";
import { prefixCardLabel } from "../nodes/action-node/action-node-utils";
import type { ScenarioFlowNode, ScenarioNodeData, TranslateFn } from "../types";

export type ScenarioSourceHandleCopy = {
  label: string;
  tooltip: string;
};

/** A tapped button or a picked list row or form option. */
export type ScenarioBranchOptionKind = "button" | "option";

function sourceHandleCopy(label: string): ScenarioSourceHandleCopy {
  return { label, tooltip: label };
}

export function getAnyUserReplySourceHandleCopy(
  t: TranslateFn
): ScenarioSourceHandleCopy {
  return sourceHandleCopy(t("sourceHandleAnyUserReply"));
}

export function getTemplateQuickReplySourceHandleCopy(
  t: TranslateFn,
  label: string
): ScenarioSourceHandleCopy {
  return sourceHandleCopy(t("sourceHandleTemplateQuickReply", { label }));
}

/** A template's "Form submitted" route. */
export function getWhatsAppTemplateFormSubmittedSourceHandleCopy(
  t: TranslateFn
): ScenarioSourceHandleCopy {
  return sourceHandleCopy(t("serviceRouteFlowSubmitted"));
}

/** A WhatsApp reply button or carousel button: "Taps “{label}”". */
export function getWhatsAppButtonSourceHandleCopy(
  t: TranslateFn,
  label: string
): ScenarioSourceHandleCopy {
  return sourceHandleCopy(t("sourceHandleWhatsAppButton", { label }));
}

/** A WhatsApp list row: "Picks “{label}”". */
export function getWhatsAppChoiceSourceHandleCopy(
  t: TranslateFn,
  label: string
): ScenarioSourceHandleCopy {
  return sourceHandleCopy(t("sourceHandleWhatsAppChoice", { label }));
}

export function getTelegramButtonSourceHandleCopy(
  t: TranslateFn,
  label: string
): ScenarioSourceHandleCopy {
  return sourceHandleCopy(t("sourceHandleTelegramButton", { label }));
}

/** A form option: "Picks “{label}”". */
export function getFlowOptionSourceHandleCopy(
  t: TranslateFn,
  label: string
): ScenarioSourceHandleCopy {
  return sourceHandleCopy(t("sourceHandleFlowOption", { label }));
}

/** An answer rule route: "Has “{label}”" for words, "Means “{label}”" for meaning. */
export function getAnswerRuleSourceHandleCopy(
  t: TranslateFn,
  rule: { text?: string; mode?: ScenarioAnswerMatchMode }
): ScenarioSourceHandleCopy {
  const label = rule.text?.trim() || t("sourceHandleConditionAnswerMatchAny");
  return sourceHandleCopy(
    t(
      rule.mode === "intent"
        ? "sourceHandleConditionAnswerMeaning"
        : "sourceHandleConditionAnswerMatch",
      { label }
    )
  );
}

/** The route name of a branch option, e.g. "Taps “Yes”" or "Picks “Pickup”". */
export function getBranchOptionSourceHandleCopy(
  t: TranslateFn,
  kind: ScenarioBranchTransitionKind,
  optionKind: ScenarioBranchOptionKind,
  label: string
): ScenarioSourceHandleCopy {
  switch (kind) {
    case "whatsapp_template_button":
      return getTemplateQuickReplySourceHandleCopy(t, label);
    case "telegram_quick_reply":
      return getTelegramButtonSourceHandleCopy(t, label);
    case "instagram_reply":
      return sourceHandleCopy(t("sourceHandleInstagramButton", { label }));
    case "whatsapp_flow":
      return getFlowOptionSourceHandleCopy(t, label);
    case "whatsapp_service_message":
      return optionKind === "option"
        ? getWhatsAppChoiceSourceHandleCopy(t, label)
        : getWhatsAppButtonSourceHandleCopy(t, label);
  }
}

/** Whether customers tap a button or pick an option on this kind of route. */
export function resolveBranchOptionKind(
  kind: ScenarioBranchTransitionKind,
  nodeData: ScenarioNodeData
): ScenarioBranchOptionKind {
  if (kind === "whatsapp_flow") return "option";
  if (kind !== "whatsapp_service_message") return "button";
  const serviceMessage = resolveScenarioWhatsAppServiceMessage(nodeData);
  return serviceMessage.status === "canonical" &&
    serviceMessage.value.message.kind === "list"
    ? "option"
    : "button";
}

export function resolveUntitledBranchOptionLabel(
  optionKind: ScenarioBranchOptionKind,
  t: TranslateFn
): string {
  return t(optionKind === "option" ? "untitledOption" : "untitledButton");
}

/**
 * Names the options of an action's branch routes as their rows show them. A
 * carousel choice names its card ("Card 2 · Buy"), and a form option names
 * its question when the form asks more than one ("Size · Large"). Unnamed
 * options read "Untitled button" or "Untitled option", never an id.
 */
export function createScenarioBranchOptionLabeler(
  nodeData: ScenarioNodeData,
  t: TranslateFn
): (
  kind: ScenarioBranchTransitionKind,
  option: ScenarioBranchOption
) => { label: string; optionKind: ScenarioBranchOptionKind } {
  const serviceMessage = resolveScenarioWhatsAppServiceMessage(nodeData);
  const serviceOptionsById = new Map(
    serviceMessage.status === "canonical"
      ? listScenarioWhatsAppServiceOptions(serviceMessage.value).map(
          option => [option.id, option] as const
        )
      : []
  );
  const flowOptions = extractFlowBranchOptions(
    resolveScenarioWhatsAppInteractiveFlowConfig(nodeData)
  );
  const flowFieldLabelsByOptionKey = new Map(
    flowOptions.map(
      option =>
        [
          buildFlowBranchOptionKey(option.fieldId, option.optionId),
          option.fieldLabel.trim(),
        ] as const
    )
  );
  const namesFlowFields =
    new Set(flowOptions.map(option => option.fieldId)).size > 1;

  return (kind, option) => {
    const optionKind = resolveBranchOptionKind(kind, nodeData);
    const untitled = resolveUntitledBranchOptionLabel(optionKind, t);
    if (kind === "whatsapp_service_message") {
      const serviceOption = serviceOptionsById.get(option.id);
      return {
        optionKind,
        label: prefixCardLabel(
          serviceOption?.cardIndex,
          serviceOption?.label.trim() || untitled,
          t
        ),
      };
    }
    const label = option.label.trim() || untitled;
    if (kind === "whatsapp_template_button") {
      return {
        optionKind,
        label: prefixCardLabel(option.cardIndex, label, t),
      };
    }
    const fieldLabel =
      kind === "whatsapp_flow" && namesFlowFields
        ? flowFieldLabelsByOptionKey.get(option.id)
        : undefined;
    return {
      optionKind,
      label: fieldLabel ? `${fieldLabel} · ${label}` : label,
    };
  };
}

/**
 * The reply outcome catches every reply the step doesn't route elsewhere.
 * Next to buttons, choices, answer rules or location routes it is "Other
 * reply".
 */
export function resolveAnyReplyLabel(
  nodeData: ScenarioNodeData,
  t: TranslateFn
): string {
  const outcomes = normalizeScenarioActionOutcomes(nodeData.actionOutcomes);
  const routesReplies =
    outcomes.status === "supported" &&
    ((outcomes.value.answerMatches?.length ?? 0) > 0 ||
      outcomes.value.locationRoutes !== undefined);
  return t(
    routesReplies ||
      getScenarioActionBranchTransitionsForNode(nodeData).length > 0
      ? "actionOutcomeOtherReply"
      : "actionOutcomeAnyReply"
  );
}

/**
 * A location route's name: "Nearest office: Kazakhstan", "Any other office"
 * ("Office found" when no group splits the offices) or "No office within
 * 100 km".
 */
export function getLocationRouteSourceHandleCopy(
  t: TranslateFn,
  locationRoutes: ScenarioActionLocationRoutes | undefined,
  outcome: Extract<
    ScenarioActionOutcomeHandle,
    { type: "location_route" | "location_any_office" | "location_outside" }
  >
): ScenarioSourceHandleCopy {
  switch (outcome.type) {
    case "location_route": {
      const route = locationRoutes?.routes.find(
        item => item.id === outcome.routeId
      );
      const label =
        route?.label ||
        route?.match.values
          .map(value =>
            route.match.by === "city"
              ? value.slice(value.indexOf(":") + 1)
              : value
          )
          .join(", ");
      return sourceHandleCopy(
        label
          ? t("actionOutcomeLocationRoute", { label })
          : t("actionOutcomeLocationRouteEmpty")
      );
    }
    case "location_any_office":
      return sourceHandleCopy(
        t(
          (locationRoutes?.routes.length ?? 0) > 0
            ? "actionOutcomeLocationAnyOffice"
            : "actionOutcomeLocationOfficeFound"
        )
      );
    case "location_outside":
      return sourceHandleCopy(
        t("actionOutcomeLocationOutside", {
          km:
            locationRoutes?.outside?.maxDistanceKm ??
            DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM,
        })
      );
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export type ScenarioContinueRouteKind =
  | "then"
  | "reply"
  | "other_reply"
  | "form_submitted"
  | "details_collected";

/** What an action's default output waits for. */
export function resolveContinueRouteKind({
  nodeData,
  usesTemplateButtons = scenarioActionUsesWhatsAppTemplateButtonBranchHandles(
    nodeData
  ),
}: {
  nodeData: ScenarioNodeData;
  usesTemplateButtons?: boolean;
}): ScenarioContinueRouteKind {
  if (readScenarioActionPromptInputAsk(nodeData) === "text") {
    return "details_collected";
  }
  if (usesTemplateButtons) return "other_reply";
  const serviceMessage = resolveScenarioWhatsAppServiceMessage(nodeData);
  if (serviceMessage.status === "canonical") {
    return serviceMessage.value.message.kind === "flow"
      ? "form_submitted"
      : "reply";
  }
  return "then";
}

/** A default output that also means "the customer replied". */
export function continueRouteOverlapsAnyReply(
  kind: ScenarioContinueRouteKind
): boolean {
  return kind === "reply" || kind === "other_reply";
}

/**
 * Any reply already routes the next customer message, so an unlinked default
 * output that waits for it keeps only its anchor and gets no row or dot.
 */
export function anyReplyReplacesContinueRoute({
  nodeData,
  usesTemplateButtons,
  hasAnyReply,
  continueConnected,
}: {
  nodeData: ScenarioNodeData;
  usesTemplateButtons?: boolean;
  hasAnyReply: boolean;
  continueConnected: boolean;
}): boolean {
  return (
    hasAnyReply &&
    !continueConnected &&
    continueRouteOverlapsAnyReply(
      resolveContinueRouteKind({ nodeData, usesTemplateButtons })
    )
  );
}

/**
 * The name of an action's default output: "Then", "Reply", "Other reply",
 * "Form submitted" or "Details collected". Beside an Any reply or Other
 * reply route, a reply-like default output reads "Then", so no two routes
 * share a name.
 */
export function resolveContinueLabel({
  nodeData,
  t,
  usesTemplateButtons,
  besideAnyReply = false,
}: {
  nodeData: ScenarioNodeData;
  t: TranslateFn;
  usesTemplateButtons?: boolean;
  besideAnyReply?: boolean;
}): string {
  const kind = resolveContinueRouteKind({ nodeData, usesTemplateButtons });
  if (besideAnyReply && continueRouteOverlapsAnyReply(kind)) {
    return t("actionPortNextStep");
  }
  switch (kind) {
    case "details_collected":
      return t("whatsappServicePromptInputsMet");
    case "other_reply":
      return getAnyUserReplySourceHandleCopy(t).label;
    case "form_submitted":
      return t("serviceRouteFlowSubmitted");
    case "reply":
      return t("serviceRouteNextMessage");
    case "then":
      return t("actionPortNextStep");
  }
}

function getPostActionConditionSourceHandleCopy(
  t: TranslateFn,
  sourceData: ScenarioNodeData,
  sourceHandleId: string
): ScenarioSourceHandleCopy | null {
  if (sourceHandleId === getPostActionConditionHandleId("user_replied")) {
    return sourceHandleCopy(t("sourceHandleConditionUserReplied"));
  }

  if (sourceHandleId === getPostActionConditionHandleId("no_reply_timeout")) {
    return sourceHandleCopy(t("sourceHandleConditionNoReply"));
  }

  const answerRuleId = parsePostActionAnswerMatchHandleId(sourceHandleId);
  if (answerRuleId) {
    const rule = getNoReplyAnswerMatchRules(sourceData).find(
      item => item.id === answerRuleId
    );
    return getAnswerRuleSourceHandleCopy(t, rule ?? {});
  }

  return null;
}

function resolveActionBranchOptionCopy(
  sourceNode: ScenarioFlowNode,
  sourceData: ScenarioNodeData,
  sourceHandleId: string,
  t: TranslateFn
): ScenarioSourceHandleCopy | null {
  const descriptor =
    getScenarioActionBranchTransitionBySourceHandle(sourceHandleId);
  if (!descriptor) return null;

  const options = descriptor.extractOptions(sourceData, sourceNode.id);
  if (!descriptor.matchesSourceHandle(sourceHandleId, options)) return null;

  const optionId = descriptor.resolveBranchIdFromSourceHandle(
    sourceHandleId,
    options
  );
  const option = options.find(item => item.id === optionId);
  if (!option) return null;
  const { label, optionKind } = createScenarioBranchOptionLabeler(
    sourceData,
    t
  )(descriptor.kind, option);
  return getBranchOptionSourceHandleCopy(t, descriptor.kind, optionKind, label);
}

function resolveActionOutcomeCopy(
  sourceData: ScenarioNodeData,
  outcome: NonNullable<ReturnType<typeof parseScenarioActionOutcomeHandleId>>,
  t: TranslateFn
): ScenarioSourceHandleCopy {
  switch (outcome.type) {
    case "any_reply":
      return sourceHandleCopy(resolveAnyReplyLabel(sourceData, t));
    case "no_reply":
      return sourceHandleCopy(t("actionOutcomeNoReply"));
    case "payment_detected":
      return sourceHandleCopy(t("actionOutcomePayment"));
    case "answer": {
      const outcomes = normalizeScenarioActionOutcomes(
        sourceData.actionOutcomes
      );
      const rule =
        outcomes.status === "supported"
          ? outcomes.value.answerMatches?.find(
              item => item.id === outcome.ruleId
            )
          : undefined;
      return getAnswerRuleSourceHandleCopy(t, rule ?? {});
    }
    case "location_route":
    case "location_any_office":
    case "location_outside": {
      const outcomes = normalizeScenarioActionOutcomes(
        sourceData.actionOutcomes
      );
      return getLocationRouteSourceHandleCopy(
        t,
        outcomes.status === "supported"
          ? outcomes.value.locationRoutes
          : undefined,
        outcome
      );
    }
  }
}

export function resolveScenarioSourceHandleCopy(params: {
  sourceNode: ScenarioFlowNode | null;
  sourceHandleId: string | null | undefined;
  t: TranslateFn;
}): ScenarioSourceHandleCopy | null {
  const { sourceNode, t } = params;
  const sourceHandleId =
    typeof params.sourceHandleId === "string"
      ? params.sourceHandleId.trim()
      : "";
  if (!sourceNode || !sourceHandleId) return null;

  const sourceData = sourceNode.data as ScenarioNodeData;

  if (sourceData.kind === "logic") {
    const postActionCopy = getPostActionConditionSourceHandleCopy(
      t,
      sourceData,
      sourceHandleId
    );
    if (postActionCopy) return postActionCopy;

    if (isRecipientColumnSplitNodeData(sourceData)) {
      const parsed = parseRecipientColumnSplitPathHandleId(sourceHandleId);
      if (parsed?.isElse) {
        return {
          label: t("sourceHandleColumnSplitElse"),
          tooltip: t("sourceHandleColumnSplitElseTooltip"),
        };
      }
      if (parsed && !parsed.isElse) {
        const config = getRecipientColumnSplitConfig(sourceData);
        const path = config.paths.find(item => item.id === parsed.pathId);
        const label =
          path?.label?.trim() ||
          t("sourceHandleColumnSplitPath", { pathId: parsed.pathId });
        return {
          label,
          tooltip: t("sourceHandleColumnSplitPathTooltip", {
            pathId: parsed.pathId,
          }),
        };
      }
    }
  }

  if (sourceData.kind !== "action") return null;

  if (sourceHandleId === PROMPT_INPUTS_UNMET_HANDLE) {
    return readScenarioActionPromptInputAsk(sourceData)
      ? sourceHandleCopy(t("whatsappServicePromptInputsUnmet"))
      : null;
  }
  if (sourceHandleId === GENERATIVE_AI_SUCCESS_HANDLE) {
    return sourceHandleCopy(t("generativeAISuccess"));
  }
  if (sourceHandleId === GENERATIVE_AI_FAILURE_HANDLE) {
    return sourceHandleCopy(t("generativeAIFailure"));
  }

  const actionOutcome = parseScenarioActionOutcomeHandleId(sourceHandleId);
  if (actionOutcome) {
    return resolveActionOutcomeCopy(sourceData, actionOutcome, t);
  }

  if (isWhatsAppTemplateFormSubmittedSourceHandleId(sourceHandleId)) {
    return getWhatsAppTemplateFormSubmittedSourceHandleCopy(t);
  }

  if (sourceHandleId === "right-source") {
    const outcomes = normalizeScenarioActionOutcomes(sourceData.actionOutcomes);
    return sourceHandleCopy(
      resolveContinueLabel({
        nodeData: sourceData,
        t,
        besideAnyReply:
          outcomes.status === "supported" &&
          outcomes.value.anyReply?.enabled === true,
      })
    );
  }

  return resolveActionBranchOptionCopy(
    sourceNode,
    sourceData,
    sourceHandleId,
    t
  );
}
