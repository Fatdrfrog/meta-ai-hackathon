import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  isScenarioEntryPolicy,
  normalizeScenarioLoopSetting,
  type ScenarioEntryPolicy,
} from "@icecore/scenario-contracts";
import type { ConversationScenarioState } from "@icecore/airi-runtime/scenario-state";

type RawScenarioEntryPolicyInput = {
  entryPolicy?: unknown;
  loopScenario?: unknown;
};

type ScenarioEntryPolicyState = Pick<
  ConversationScenarioState,
  "lockedScenarioId" | "startedScenarios" | "completedScenarios"
>;

export type ScenarioEntryPolicyBlockReason = "blocked_by_once_per_conversation";

export type ScenarioEntryPolicyEvaluation = {
  eligible: boolean;
  reason?: ScenarioEntryPolicyBlockReason;
};

export function resolveScenarioEntryPolicy(
  raw: RawScenarioEntryPolicyInput
): ScenarioEntryPolicy {
  if (isScenarioEntryPolicy(raw.entryPolicy)) {
    return raw.entryPolicy;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "entryPolicy")) {
    return DEFAULT_SCENARIO_ENTRY_POLICY;
  }

  return normalizeScenarioLoopSetting(raw.loopScenario)
    ? "repeatable"
    : DEFAULT_SCENARIO_ENTRY_POLICY;
}

export function evaluateScenarioEntryPolicy(params: {
  scenarioId: string;
  entryPolicy: ScenarioEntryPolicy;
  state?: ScenarioEntryPolicyState | null;
  allowCurrentLockedScenario?: boolean;
}): ScenarioEntryPolicyEvaluation {
  if (
    params.allowCurrentLockedScenario &&
    params.state?.lockedScenarioId === params.scenarioId
  ) {
    return { eligible: true };
  }

  if (params.entryPolicy === "repeatable") {
    return { eligible: true };
  }

  const hasStarted =
    params.state?.startedScenarios?.some(
      entry => entry.scenarioId === params.scenarioId
    ) ?? false;
  const hasCompleted =
    params.state?.completedScenarios?.some(
      entry => entry.scenarioId === params.scenarioId
    ) ?? false;

  return hasStarted || hasCompleted
    ? {
        eligible: false,
        reason: "blocked_by_once_per_conversation",
      }
    : { eligible: true };
}
