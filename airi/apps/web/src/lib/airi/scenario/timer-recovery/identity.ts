export function buildTimerReplanMessageId(params: {
  scenarioId: string;
  actionNodeId: string;
  anchorId: string;
}): string {
  return `timer-replan:${params.scenarioId}:${params.actionNodeId}:${params.anchorId}`;
}
