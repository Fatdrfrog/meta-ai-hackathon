import type {
  AiriConversationTimerPlanResult,
  AiriConversationTurnSignal,
} from "@icecore/temporal";
import { isScenarioAutomationPausedByHandoff } from "../../scenario-handoff-policy";
import { resolveTimerTurnSkipReason } from "../automation";
import { loadTimerContext } from "../context";
import type { AiriScenarioTimerDependencies } from "../dependencies";
import { buildPostActionTimerDescriptor } from "../descriptors/index";

export async function planAiriConversationTimer(
  params: {
    turn: AiriConversationTurnSignal | null | undefined;
  },
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationTimerPlanResult> {
  if (!params.turn?.conversationId || !params.turn?.messageId) {
    return {
      timer: null,
      projection: null,
      reason: "invalid_turn",
    };
  }

  await dependencies.connectDB();

  const context = await loadTimerContext(
    params.turn.conversationId,
    dependencies,
  );
  if (!context) {
    return {
      timer: null,
      projection: null,
      reason: "conversation_not_found",
    };
  }

  const { conversation, projection } = context;
  const postActionTimer = await buildPostActionTimerDescriptor(
    {
      conversation,
      projection,
    },
    dependencies,
  );
  if (postActionTimer) {
    const skipReason = await resolveTimerTurnSkipReason(
      conversation,
      dependencies,
    );
    if (skipReason) {
      return { timer: null, projection, reason: skipReason };
    }
    return {
      timer: postActionTimer,
      projection,
      reason: "pending_post_action_condition",
    };
  }

  return {
    timer: null,
    projection,
    reason: isScenarioAutomationPausedByHandoff(projection.handoffActive)
      ? "handoff_active"
      : "no_timer",
  };
}
