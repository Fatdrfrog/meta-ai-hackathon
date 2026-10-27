/**
 * Conversation handoff pauses generic auto-reply. An in-flight scenario
 * follow-up wait still runs unless a stop phrase/event cancels it; the wait
 * clock refreshes from the latest inbound or outbound message.
 */
export function isScenarioAutomationPausedByHandoff(
  handoffActive: boolean | null | undefined
): boolean {
  return Boolean(handoffActive);
}
