import {
  buildScenarioPickedOption,
  findScenarioWhatsAppServiceOption,
  listRunnableScenarioPromptInputs,
  listScenarioPromptInputTypedChoices,
  mergeCollectedPromptInputsIntoScenarioState,
  readCollectedPromptInputs,
  readScenarioPromptInputBehavior,
  recordScenarioPickedOption,
  resolveServiceMessagePromptInputChoice,
  resolveServiceMessagePromptInputDispatch,
  SCENARIO_TRIGGER_EVENT_KIND,
  serviceMessagePromptInputNeedsExtraction,
  type ScenarioPromptInputExtraction,
  type ScenarioPromptInputField,
  type ScenarioPromptInputUntapped,
  type ScenarioWhatsAppServiceOption,
} from "@icecore/scenario-contracts";
import {
  normalizeConversationPreferredLanguage,
  type ConversationPreferredLanguage,
} from "@icecore/shared/types/conversation";
import { parseDate } from "./internal/value-normalization";
import type { KeptScenarioPendingWait } from "./scenario-runtime-dependencies";
import type {
  AiriScenarioRuntimeConfig,
  ScenarioDispatchTransition,
} from "./scenario-runtime-types";
import {
  normalizeConversationScenarioState,
  type ScenarioPendingLegacyRouting,
} from "./scenario-state";

export type ServiceMessagePromptInputTurnPlan =
  | { type: "none" }
  | {
      type: "wait";
      runtime: AiriScenarioRuntimeConfig;
      scenarioState: Record<string, unknown>;
    }
  | {
      type: "resume";
      scenarioState: Record<string, unknown>;
      /** True when this reply supplied every detail; false on the unmet route. */
      answered: boolean;
      /** A choice ask resumes by replaying the tap that picked its branch. */
      replayChoiceOptionId?: string;
    }
  | {
      type: "hold";
      runtime: AiriScenarioRuntimeConfig;
      scenarioState: Record<string, unknown>;
      untapped?: ScenarioPromptInputUntapped;
    }
  | {
      type: "stored";
      /** Released from a text ask's own wait when it holds the dispatch. */
      runtime: AiriScenarioRuntimeConfig;
      scenarioState: Record<string, unknown>;
    };

export type ScenarioPromptInputExtractor = (params: {
  fields: ScenarioPromptInputField[];
  sourceText: string;
  /** Options the customer may name instead of tapping; empty when none. */
  choices: ScenarioWhatsAppServiceOption[];
}) => Promise<ScenarioPromptInputExtraction | null>;

export function shouldConsumePromptInputAnswer(
  triggerEventKind: string | null | undefined,
): boolean {
  return (
    !triggerEventKind ||
    triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.inboundMessage ||
    triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply
  );
}

export async function planServiceMessagePromptInputTurn(params: {
  runtime: AiriScenarioRuntimeConfig;
  scenarioState: unknown;
  sourceText: string;
  triggerEventKind?: string | null;
  allowExtract?: boolean;
  extract?: ScenarioPromptInputExtractor;
  now?: Date;
}): Promise<ServiceMessagePromptInputTurnPlan> {
  const sourceActionNodeId = params.runtime.selectedActionNodeId?.trim() || "";
  const config = params.runtime.actionWhatsAppServiceMessage;
  if (!sourceActionNodeId || !config) {
    return { type: "none" };
  }

  const now = params.now ?? new Date();
  const consumeInbound =
    params.allowExtract !== false &&
    shouldConsumePromptInputAnswer(params.triggerEventKind);
  const metTransition = params.runtime.actionPromptInputsMetTransition;
  const collection = readCollectedPromptInputs(params.scenarioState);
  const fields = listRunnableScenarioPromptInputs(config);
  const needsExtraction =
    Boolean(fields) &&
    serviceMessagePromptInputNeedsExtraction({
      config,
      collection,
      scenarioId: params.runtime.scenarioId,
      sourceActionNodeId,
      consumeInbound,
    });
  let extraction: ScenarioPromptInputExtraction | null = null;
  if (needsExtraction && params.sourceText.trim() && params.extract && fields) {
    try {
      extraction = await params.extract({
        fields,
        sourceText: params.sourceText,
        choices: listScenarioPromptInputTypedChoices({
          config,
          collection,
          scenarioId: params.runtime.scenarioId,
          sourceActionNodeId,
        }),
      });
    } catch {
      // Unavailable: the ask holds instead of taking the unmet edge.
    }
  }

  const dispatch = resolveServiceMessagePromptInputDispatch({
    config,
    collection,
    scenarioId: params.runtime.scenarioId,
    sourceActionNodeId,
    resumeActionNodeId: metTransition
      ? metTransition.nextActionNodeId
      : (params.runtime.nextActionNodeId ?? null),
    sourcePathNodeIds: params.runtime.selectedPathNodeIds ?? [],
    consumeInbound,
    extractedValues: extraction?.values ?? null,
    typedChoiceOptionId: extraction?.choiceOptionId ?? null,
    now,
  });
  // An option named in words is recorded as the pick its tap would record.
  const typedOption =
    dispatch.type !== "none" &&
    extraction?.choiceOptionId &&
    !collection?.choiceOptionId &&
    dispatch.collection.choiceOptionId === extraction.choiceOptionId
      ? findScenarioWhatsAppServiceOption(config, extraction.choiceOptionId)
      : null;
  const typedPick = typedOption
    ? buildScenarioPickedOption({
        sourceActionNodeId,
        option: typedOption,
        pickedAt: now,
      })
    : null;
  const scenarioState = typedPick
    ? recordScenarioPickedOption(params.scenarioState, {
        scenarioId: params.runtime.scenarioId,
        pick: typedPick,
      })
    : params.scenarioState;

  switch (dispatch.type) {
    case "none":
      return { type: "none" };
    case "wait":
      return {
        type: "wait",
        runtime: holdServiceMessagePromptInputNode(params.runtime),
        scenarioState: mergeCollectedPromptInputsIntoScenarioState(
          scenarioState,
          { collection: dispatch.collection },
        ),
      };
    case "hold":
      return {
        type: "hold",
        runtime: holdServiceMessagePromptInputNode(params.runtime),
        scenarioState: mergeCollectedPromptInputsIntoScenarioState(
          scenarioState,
          { collection: dispatch.collection },
        ),
        ...(dispatch.untapped ? { untapped: dispatch.untapped } : {}),
      };
    case "met": {
      // The tap is replayed from its message, as if it happened now.
      const replayChoiceOptionId = dispatch.collection.followsChoice
        ? dispatch.collection.choiceOptionId
        : null;
      return {
        type: "resume",
        answered: true,
        ...(replayChoiceOptionId ? { replayChoiceOptionId } : {}),
        scenarioState: mergeCollectedPromptInputsIntoScenarioState(
          scenarioState,
          replayChoiceOptionId
            ? {
                collection: dispatch.collection,
                currentActionNodeId: sourceActionNodeId,
                currentPathNodeIds: params.runtime.selectedPathNodeIds ?? [],
              }
            : {
                collection: dispatch.collection,
                currentActionNodeId: dispatch.resumeActionNodeId,
                currentPathNodeIds: dispatch.sourcePathNodeIds,
              },
        ),
      };
    }
    case "stored":
      return {
        type: "stored",
        runtime: metTransition
          ? releasePromptInputWait(params.runtime, metTransition)
          : params.runtime,
        scenarioState: mergeCollectedPromptInputsIntoScenarioState(
          scenarioState,
          { collection: dispatch.collection },
        ),
      };
    case "unmet": {
      const routeActionNodeId =
        params.runtime.actionPromptInputsUnmetTransition?.nextActionNodeId?.trim() ||
        "";
      const route =
        routeActionNodeId && routeActionNodeId !== sourceActionNodeId
          ? routeActionNodeId
          : null;
      const collection = {
        ...dispatch.collection,
        awaitingReply: !route,
      };
      if (!route) {
        return {
          type: "hold",
          runtime: holdServiceMessagePromptInputNode(params.runtime),
          scenarioState: mergeCollectedPromptInputsIntoScenarioState(
            scenarioState,
            { collection },
          ),
        };
      }
      return {
        type: "resume",
        answered: false,
        scenarioState: mergeCollectedPromptInputsIntoScenarioState(
          scenarioState,
          {
            collection,
            currentActionNodeId: route,
            currentPathNodeIds: dispatch.collection.sourcePathNodeIds,
          },
        ),
      };
    }
    default: {
      const exhaustive: never = dispatch;
      return exhaustive;
    }
  }
}

/**
 * A met text ask with no route on: its own wait ends, so no reminder follows a
 * complete answer, and the scenario ends if its collected route does.
 */
function releasePromptInputWait(
  runtime: AiriScenarioRuntimeConfig,
  metTransition: ScenarioDispatchTransition,
): AiriScenarioRuntimeConfig {
  return {
    ...runtime,
    nextActionNodeId: metTransition.nextActionNodeId,
    completesScenario: metTransition.completesScenario,
    pendingConditionNodeId: null,
    pendingSourceActionNodeId: null,
    pendingLinkedConditionId: null,
    pendingLegacyRouting: null,
  };
}

/** The wait the conversation still holds for an action, if any. */
function readArmedActionWait(
  scenarioState: unknown,
  actionNodeId: string | null | undefined,
): {
  conditionNodeId: string;
  linkedConditionId: string | null;
  legacyRouting: ScenarioPendingLegacyRouting | null;
  startedAt: Date | null;
  lastOutboundMessageId: string | null;
} | null {
  const state = normalizeConversationScenarioState(scenarioState);
  const sourceActionNodeId = actionNodeId?.trim();
  if (
    !state?.pendingConditionNodeId ||
    !sourceActionNodeId ||
    state.pendingSourceActionNodeId !== sourceActionNodeId
  ) {
    return null;
  }
  return {
    conditionNodeId: state.pendingConditionNodeId,
    linkedConditionId: state.pendingLinkedConditionId ?? null,
    legacyRouting: state.pendingLegacyRouting ?? null,
    startedAt: parseDate(state.pendingStartedAt),
    lastOutboundMessageId: state.pendingLastOutboundMessageId ?? null,
  };
}

/**
 * A prompt-input turn that sends nothing keeps its message's armed wait as it
 * was: the quiet period still counts from that message, which stays the
 * anchor the No reply timer checks.
 */
export function readKeptPromptInputWait(
  scenarioState: unknown,
  runtime: AiriScenarioRuntimeConfig,
): KeptScenarioPendingWait | null {
  const conditionNodeId = runtime.pendingConditionNodeId?.trim();
  const armed = readArmedActionWait(
    scenarioState,
    runtime.pendingSourceActionNodeId,
  );
  if (
    !conditionNodeId ||
    armed?.conditionNodeId !== conditionNodeId ||
    !armed.startedAt ||
    !armed.lastOutboundMessageId
  ) {
    return null;
  }
  return {
    startedAt: armed.startedAt,
    lastOutboundMessageId: armed.lastOutboundMessageId,
  };
}

/**
 * A No reply reminder whose route ends with its own message only nudges: the
 * conversation returns to the ask it reminded about, which keeps its tap and
 * answers and takes the customer's words until its wait period passes. Null
 * when the reminder's route goes on, waits again or does not just send.
 */
export function returnToPromptInputAskAfterReminder(
  runtime: AiriScenarioRuntimeConfig | null,
  askNodeId: string,
): AiriScenarioRuntimeConfig | null {
  if (
    !runtime?.completesScenario ||
    runtime.pendingConditionNodeId ||
    (runtime.actionType !== "reply" &&
      runtime.actionType !== "whatsapp_template") ||
    (runtime.actionWhatsAppServiceMessage &&
      listRunnableScenarioPromptInputs(runtime.actionWhatsAppServiceMessage))
  ) {
    return null;
  }
  return { ...runtime, nextActionNodeId: askNodeId, completesScenario: false };
}

/**
 * When a No reply reminder's route goes on past it, an ask still waiting on
 * that message stops taking the customer's words, so the route hears them.
 * Its answers stay; sending the message again asks again.
 */
export function closePromptInputAskForNoReply(
  scenarioState: unknown,
  sourceActionNodeId: string,
): unknown {
  const collection = readCollectedPromptInputs(scenarioState);
  if (
    !collection?.awaitingReply ||
    collection.sourceActionNodeId !== sourceActionNodeId
  ) {
    return scenarioState;
  }
  return mergeCollectedPromptInputsIntoScenarioState(scenarioState, {
    collection: { ...collection, awaitingReply: false, choiceOptionId: null },
  });
}

/**
 * A choice ask whose replayed tap no longer routes, because the option left
 * the message after the tap: the message is sent again with the answers
 * kept and the tap forgotten, so the customer picks again.
 */
export function planServiceMessagePromptInputResend(params: {
  runtime: AiriScenarioRuntimeConfig;
  scenarioState: unknown;
  now?: Date;
}): {
  runtime: AiriScenarioRuntimeConfig;
  scenarioState: Record<string, unknown>;
} | null {
  const collection = readCollectedPromptInputs(params.scenarioState);
  const dispatch = resolveServiceMessagePromptInputDispatch({
    config: params.runtime.actionWhatsAppServiceMessage,
    collection: collection ? { ...collection, awaitingReply: false } : null,
    scenarioId: params.runtime.scenarioId,
    sourceActionNodeId: params.runtime.selectedActionNodeId?.trim() || "",
    resumeActionNodeId: params.runtime.nextActionNodeId ?? null,
    sourcePathNodeIds: params.runtime.selectedPathNodeIds ?? [],
    consumeInbound: false,
    now: params.now,
  });
  if (dispatch.type !== "wait" || !dispatch.collection.followsChoice) {
    return null;
  }
  return {
    runtime: holdServiceMessagePromptInputNode(params.runtime),
    scenarioState: mergeCollectedPromptInputsIntoScenarioState(
      params.scenarioState,
      { collection: dispatch.collection },
    ),
  };
}

const CHOICE_NUDGE_COPY: Record<ConversationPreferredLanguage, string> = {
  en: "Please choose one of the options above to continue.",
  ru: "Чтобы продолжить, выберите один из вариантов выше.",
  kz: "Жалғастыру үшін жоғарыдағы нұсқалардың бірін таңдаңыз.",
  uz: "Davom etish uchun yuqoridagi variantlardan birini tanlang.",
};

/** The one nudge words sent before the tap may get, in the customer's language. */
export function resolvePromptInputChoiceNudge(language: string): string {
  return CHOICE_NUDGE_COPY[
    normalizeConversationPreferredLanguage(language) ?? "en"
  ];
}

/**
 * Scenario state that records the ask's one nudge to tap, or null when the
 * ask does not nudge, already did, or no longer waits for a tap.
 */
export function claimPromptInputChoiceNudge(params: {
  runtime: AiriScenarioRuntimeConfig;
  scenarioState: unknown;
}): Record<string, unknown> | null {
  const config = params.runtime.actionWhatsAppServiceMessage;
  const collection = readCollectedPromptInputs(params.scenarioState);
  if (
    !config ||
    !collection?.awaitingReply ||
    !collection.followsChoice ||
    collection.choiceOptionId ||
    collection.nudged ||
    collection.sourceActionNodeId !== params.runtime.selectedActionNodeId ||
    !readScenarioPromptInputBehavior(config).nudgeOnce
  ) {
    return null;
  }
  return mergeCollectedPromptInputsIntoScenarioState(params.scenarioState, {
    collection: { ...collection, nudged: true },
  });
}

export type ServiceMessagePromptInputChoicePlan =
  | { type: "none" }
  | { type: "continue"; scenarioState: Record<string, unknown> }
  | {
      type: "hold";
      runtime: AiriScenarioRuntimeConfig;
      scenarioState: Record<string, unknown>;
    };

/**
 * A tap on a message that also asks for details. It records the tapped
 * branch; unless every detail is already known, the turn stops on that
 * message and waits for the customer's words.
 */
export function planServiceMessagePromptInputChoice(params: {
  runtime: AiriScenarioRuntimeConfig;
  scenarioState: unknown;
  now?: Date;
}): ServiceMessagePromptInputChoicePlan {
  const source = params.runtime.choicePromptInputSource;
  if (!source) return { type: "none" };
  const decision = resolveServiceMessagePromptInputChoice({
    config: source.config,
    collection: readCollectedPromptInputs(params.scenarioState),
    scenarioId: params.runtime.scenarioId,
    sourceActionNodeId: source.actionNodeId,
    optionId: source.optionId,
    resumeActionNodeId: params.runtime.selectedActionNodeId ?? null,
    sourcePathNodeIds: params.runtime.selectedPathNodeIds ?? [],
    now: params.now,
  });
  if (decision.type === "none") return decision;
  const scenarioState = mergeCollectedPromptInputsIntoScenarioState(
    params.scenarioState,
    { collection: decision.collection },
  );
  if (decision.type === "continue") return { type: "continue", scenarioState };
  const path = params.runtime.selectedPathNodeIds ?? [];
  const sourceIndex = path.lastIndexOf(source.actionNodeId);
  // The message's No reply wait stays armed, so its reminder also covers a
  // tap whose details never arrive.
  const wait = readArmedActionWait(params.scenarioState, source.actionNodeId);
  return {
    type: "hold",
    scenarioState,
    // Anchored on the message that asked, not on the tapped branch.
    runtime: {
      ...params.runtime,
      actionType: "reply",
      selectedActionNodeId: source.actionNodeId,
      selectedPathNodeIds:
        sourceIndex >= 0
          ? path.slice(0, sourceIndex + 1)
          : [source.actionNodeId],
      nextActionNodeId: source.actionNodeId,
      completesScenario: false,
      pendingConditionNodeId: wait?.conditionNodeId ?? null,
      pendingSourceActionNodeId: wait ? source.actionNodeId : null,
      pendingLinkedConditionId: wait?.linkedConditionId ?? null,
      pendingLegacyRouting: wait?.legacyRouting ?? null,
      actionWhatsAppServiceMessage: source.config,
      actionGenerativeAI: undefined,
      scenarioRevisionFingerprint: undefined,
      flowPromptInputCapture: undefined,
      choicePromptInputSource: undefined,
    },
  };
}

export function holdServiceMessagePromptInputNode(
  runtime: AiriScenarioRuntimeConfig,
): AiriScenarioRuntimeConfig {
  const sourceActionNodeId = runtime.selectedActionNodeId?.trim() || null;
  return {
    ...runtime,
    nextActionNodeId: sourceActionNodeId,
    completesScenario: false,
  };
}
