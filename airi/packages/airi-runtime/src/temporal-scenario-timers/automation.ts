import { isAiriAutoReplyEnabled } from "../auto-reply-switch";
import type { AiriScenarioTimerDependencies } from "./dependencies";
import type { TimerConversationRecord } from "./types";

export type TimerTurnSkipReason = "auto_reply_disabled" | "scenarios_disabled";

/**
 * A timer turn acts only through the scenario runtime, which skips it without
 * touching its wait when auto-reply is off or the conversation's scenarios are
 * disabled. The wait would still be due, so such a timer is never armed or fired.
 */
export async function resolveTimerTurnSkipReason(
  conversation: TimerConversationRecord,
  dependencies: Pick<AiriScenarioTimerDependencies, "resolveScenariosEnabled">,
): Promise<TimerTurnSkipReason | null> {
  if (!isAiriAutoReplyEnabled()) return "auto_reply_disabled";
  if (!(await dependencies.resolveScenariosEnabled(conversation))) {
    return "scenarios_disabled";
  }
  return null;
}
