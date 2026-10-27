import type {
  AiriConversationTimerDescriptor,
  AiriConversationTurnSignal,
} from "@icecore/temporal";
import { normalizeOptionalString } from "../../internal/value-normalization";
import { buildScenarioLocationRescueMessageId } from "../../scenario-location-turn";
import type { AiriScenarioTimerDependencies } from "../dependencies";
import { readPostActionLocationRescueMessageId } from "../descriptors/post-action";
import type { TimerConversationRecord } from "../types";

function buildSyntheticTimerMessageId(
  timer: AiriConversationTimerDescriptor,
): string {
  const anchor =
    timer.waitStartedAt ||
    timer.lastInboundAt ||
    timer.dueAt ||
    timer.conditionNodeId ||
    "timer";
  const messageId = `scenario-timeout:${timer.kind}:${timer.scenarioId}:${anchor}`;
  const rescuedShareId = readPostActionLocationRescueMessageId(timer);
  return rescuedShareId
    ? buildScenarioLocationRescueMessageId(messageId, rescuedShareId)
    : messageId;
}

export function buildTimerTurn(
  params: {
    timer: AiriConversationTimerDescriptor;
    conversation: TimerConversationRecord;
    followUpInstruction?: string | null;
  },
  dependencies: Pick<AiriScenarioTimerDependencies, "buildTimerTurnSignal">,
): Promise<AiriConversationTurnSignal | null> {
  const channel =
    normalizeOptionalString(params.timer.channel) ||
    normalizeOptionalString(params.conversation.channel);
  if (!channel) return Promise.resolve(null);
  return dependencies.buildTimerTurnSignal({
    ...params,
    channel,
    messageId: buildSyntheticTimerMessageId(params.timer),
  });
}
