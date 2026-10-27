import type { RagasCaseInput } from "./ragas-metrics";

// Shared shape and assertions for the offline RAGAS-lite and launch-gate
// evals, which differ only in fixture and floors.

export type RagasMetricFloors = {
  contextPrecisionAtK: number;
  contextRecallAtK: number;
  answerRelevancy: number;
  faithfulness: number;
};

export type RagasFixtureFile = {
  version: number;
  description?: string;
  aggregateThresholds: RagasMetricFloors;
  perCaseThresholds: RagasMetricFloors;
  cases: RagasCaseInput[];
};

/** No gold sources and no gold answer: the answer must abstain. */
export function isAbstentionCase(caseInput: RagasCaseInput): boolean {
  return (
    caseInput.goldSourceIds.length === 0 && caseInput.goldAnswer.length === 0
  );
}

/** Expects each of the four metrics to be at or above its floor. */
export function expectScoresAtLeast(
  scores: RagasMetricFloors,
  floors: RagasMetricFloors
) {
  expect(scores.contextPrecisionAtK).toBeGreaterThanOrEqual(
    floors.contextPrecisionAtK
  );
  expect(scores.contextRecallAtK).toBeGreaterThanOrEqual(
    floors.contextRecallAtK
  );
  expect(scores.answerRelevancy).toBeGreaterThanOrEqual(floors.answerRelevancy);
  expect(scores.faithfulness).toBeGreaterThanOrEqual(floors.faithfulness);
}
