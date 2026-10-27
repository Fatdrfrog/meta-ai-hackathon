/**
 * The scenario a Scenarios page opens first: the requested one when the
 * workspace still has it, otherwise the first in sidebar order. The server
 * reads its detail ahead of hydration with this rule, so it must match the
 * canvas exactly.
 */
export function pickActiveScenarioId(
  scenarios: ReadonlyArray<{ _id: string }>,
  requestedScenarioId?: string | null
): string | null {
  if (
    requestedScenarioId &&
    scenarios.some(scenario => scenario._id === requestedScenarioId)
  ) {
    return requestedScenarioId;
  }
  return scenarios[0]?._id ?? null;
}
