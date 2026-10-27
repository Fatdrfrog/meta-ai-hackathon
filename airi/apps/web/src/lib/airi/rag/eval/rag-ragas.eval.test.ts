/**
 * RAGAS-lite eval (Phase 3.5 rag-production-hardening).
 *
 * Runs the deterministic metric proxies from `ragas-metrics.ts` against the
 * fixtures in `ragas-golden.json`. Asserts both per-case floors (catches a
 * single-case regression) and aggregate floors (catches a broad quality drift
 * across the suite).
 *
 * This eval is offline — no LLM calls, no network — so it is safe to run on
 * every PR touching `apps/web/src/lib/airi/**`. Real LLM-judge RAGAS runs in
 * the launch-gate eval on real workspaces (Phase 4).
 */

import { aggregate, scoreCase, type RagasCaseInput } from "./ragas-metrics";
import {
  expectScoresAtLeast,
  isAbstentionCase,
  type RagasFixtureFile,
} from "./ragas-eval-test-utils";
import fixtures from "./ragas-golden.json";

const RAGAS_VERSION = 1;

const fx = fixtures as RagasFixtureFile;

describe("RAG RAGAS-lite eval (offline)", () => {
  it("fixture schema version matches runner", () => {
    expect(fx.version).toBe(RAGAS_VERSION);
    expect(Array.isArray(fx.cases)).toBe(true);
    expect(fx.cases.length).toBeGreaterThan(0);
  });

  describe.each(fx.cases)("case: $id", (caseInput: RagasCaseInput) => {
    it("meets per-case floors for all four metrics", () => {
      const scores = scoreCase(caseInput);
      // Abstention cases (empty gold sources, empty gold answer) are a
      // distinct contract: retrieval should return no evidence and the answer
      // should be empty. Enforce that directly rather than running the
      // F1/rank-decay metrics (which collapse to 0/0 at the boundary).
      if (isAbstentionCase(caseInput)) {
        expect(caseInput.generatedAnswer).toBe("");
        return;
      }
      expectScoresAtLeast(scores, fx.perCaseThresholds);
    });
  });

  it("aggregate scores clear the suite-wide floors", () => {
    const scored = fx.cases
      // Only aggregate over cases that have a gold answer. Abstention cases
      // distort means (faithfulness=1 by definition, relevancy undefined).
      .filter(c => !isAbstentionCase(c))
      .map(scoreCase);
    const agg = aggregate(scored);

    expectScoresAtLeast(agg, fx.aggregateThresholds);
  });
});
