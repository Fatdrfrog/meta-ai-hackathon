import { ScenarioTriggerLog } from "../scenario-trigger-log";

const declares = (keys: Record<string, number>) =>
  ScenarioTriggerLog.schema
    .indexes()
    .some(([actual]) => JSON.stringify(actual) === JSON.stringify(keys));

describe("ScenarioTriggerLog indexes", () => {
  // Every trigger-log read filters workspaceId and evaluatedAt.
  it.each([
    { evaluationId: 1 },
    { workspaceId: 1, evaluationId: 1 },
    { scenarioId: 1 },
    { winnerScenarioId: 1 },
    { shadowedByScenarioId: 1 },
    { triggerType: 1 },
    { eventKind: 1 },
    { matched: 1 },
  ])("does not declare the retired index %j", keys => {
    expect(declares(keys)).toBe(false);
  });

  it.each([
    { workspaceId: 1, scenarioId: 1, evaluatedAt: -1 },
    { workspaceId: 1, evaluatedAt: -1 },
    { workspaceId: 1, conversationId: 1, evaluatedAt: -1 },
    { evaluatedAt: 1 },
  ])("keeps the read-path index %j", keys => {
    expect(declares(keys)).toBe(true);
  });
});
