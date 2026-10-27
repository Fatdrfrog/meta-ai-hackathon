let scenarioGraphIdSequence = 0;

export function createScenarioGraphId(prefix: "node" | "edge"): string {
  scenarioGraphIdSequence =
    scenarioGraphIdSequence >= Number.MAX_SAFE_INTEGER
      ? 1
      : scenarioGraphIdSequence + 1;

  return `${prefix}-${Date.now()}-${scenarioGraphIdSequence}-${Math.floor(
    Math.random() * 1000
  )}`;
}
