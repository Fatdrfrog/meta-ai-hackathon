import type {
  AiriConversationExternalEvent,
  AiriConversationExternalEventResult,
  AiriConversationTimerDescriptor,
} from "@icecore/temporal";
import {
  normalizeOptionalString,
  parseDate,
} from "../../internal/value-normalization";
import { resolveTimerTurnSkipReason } from "../automation";
import { loadTimerContext } from "../context";
import type { AiriScenarioTimerDependencies } from "../dependencies";
import { buildPostActionTimerDescriptor } from "../descriptors/post-action";
import type { TimerContext } from "../types";
import { handleGenerativeAIResultEvent } from "./generative-ai-result";

/** Replans agree with the planner: a timer whose turn would be skipped is not armed. */
async function buildArmableTimer(
  context: TimerContext,
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationTimerDescriptor | null> {
  const timer = await buildPostActionTimerDescriptor(context, dependencies);
  return timer &&
    !(await resolveTimerTurnSkipReason(context.conversation, dependencies))
    ? timer
    : null;
}

async function handleHumanOutboundEvent(
  event: AiriConversationExternalEvent,
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationExternalEventResult> {
  const context = await loadTimerContext(event.conversationId, dependencies);
  const scenarioState = context?.conversation.airi_scenario_state || null;
  const hasPendingPostActionTimer = Boolean(
    normalizeOptionalString(scenarioState?.lockedScenarioId) &&
      normalizeOptionalString(scenarioState?.pendingConditionNodeId) &&
      normalizeOptionalString(scenarioState?.pendingSourceActionNodeId) &&
      parseDate(scenarioState?.pendingStartedAt),
  );
  const hasLockedScenarioState = Boolean(
    normalizeOptionalString(scenarioState?.lockedScenarioId) ||
      normalizeOptionalString(scenarioState?.currentActionNodeId),
  );

  if (context && hasPendingPostActionTimer) {
    return {
      handled: true,
      projection: context.projection,
      clearTimer: false,
      timer: await buildArmableTimer(context, dependencies),
    };
  }

  if (context && hasLockedScenarioState) {
    return {
      handled: true,
      projection: context.projection,
      clearTimer: false,
    };
  }

  return {
    handled: true,
    projection: context?.projection || null,
    clearTimer: true,
  };
}

async function handleTimerReplanEvent(
  event: AiriConversationExternalEvent,
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationExternalEventResult> {
  const context = await loadTimerContext(event.conversationId, dependencies);
  const timer = context ? await buildArmableTimer(context, dependencies) : null;

  return {
    handled: true,
    projection: context?.projection || null,
    clearTimer: !timer,
    timer,
  };
}

export async function handleAiriConversationExternalEvent(
  event: AiriConversationExternalEvent,
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationExternalEventResult> {
  await dependencies.connectDB();

  if (event.kind === "payment_confirmed") {
    if (!dependencies.handleConfirmedPaymentEvent) {
      throw new Error("Confirmed payment event requires its authoritative host");
    }
    return dependencies.handleConfirmedPaymentEvent(event);
  }

  if (event.kind === "human_outbound") {
    return handleHumanOutboundEvent(event, dependencies);
  }
  if (event.kind === "timer_replan") {
    return handleTimerReplanEvent(event, dependencies);
  }
  if (event.kind === "generative_ai_result") {
    return handleGenerativeAIResultEvent(
      event,
      dependencies.generativeAIResult,
    );
  }

  return {
    handled: false,
    clearTimer: false,
  };
}
