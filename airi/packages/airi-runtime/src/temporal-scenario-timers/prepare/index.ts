import type {
  AiriConversationPreparedTimerTurnResult,
  AiriConversationTimerDescriptor,
} from "@icecore/temporal";
import { normalizeOptionalString } from "../../internal/value-normalization";
import { resolveTimerTurnSkipReason } from "../automation";
import { loadTimerContext } from "../context";
import type { AiriScenarioTimerDependencies } from "../dependencies";
import { preparePostActionTimerTurn } from "./post-action";

export async function buildAiriConversationTimerTurn(
  timer: AiriConversationTimerDescriptor,
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationPreparedTimerTurnResult> {
  if ((timer as { kind?: unknown }).kind !== "post_action_no_reply_timeout") {
    return {
      turn: null,
      projection: null,
      reason: "retired_timer_kind",
    };
  }

  await dependencies.connectDB();

  const context = await loadTimerContext(timer.conversationId, dependencies);
  if (!context) {
    return {
      turn: null,
      projection: null,
      reason: "conversation_not_found",
    };
  }

  const { conversation, projection } = context;
  if (normalizeOptionalString(conversation.workspaceId) !== timer.workspaceId) {
    return {
      turn: null,
      projection,
      reason: "workspace_mismatch",
    };
  }

  // A timer armed before automation was switched off: drop it before any effect.
  const skipReason = await resolveTimerTurnSkipReason(
    conversation,
    dependencies,
  );
  if (skipReason) {
    return { turn: null, projection, reason: skipReason };
  }

  return preparePostActionTimerTurn(
    {
      timer,
      conversation,
      projection,
    },
    dependencies,
  );
}
