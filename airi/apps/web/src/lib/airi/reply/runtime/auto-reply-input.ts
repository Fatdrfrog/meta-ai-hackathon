import {
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioTriggerEventKind,
} from "@icecore/scenario-contracts";
export { isWhatsAppUnavailableInboundSourcePayload } from "@/lib/provider-message-display";

/** An unreadable message cannot advance, restart or resume an existing journey. */
export function canStartUnavailableMessageScenario(params: {
  scenarioState?: unknown;
  handoffActive?: unknown;
  pendingGenerativeExecution?: unknown;
}): boolean {
  if (params.handoffActive || params.pendingGenerativeExecution) return false;
  if (params.scenarioState === undefined || params.scenarioState === null)
    return true;
  if (
    typeof params.scenarioState !== "object" ||
    Array.isArray(params.scenarioState)
  )
    return false;
  return !Object.values(params.scenarioState).some(value =>
    Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined && value !== ""
  );
}

export function shouldAllowEmptyAutoReplyInput(
  triggerEventKind?: ScenarioTriggerEventKind
): boolean {
  return triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout;
}
