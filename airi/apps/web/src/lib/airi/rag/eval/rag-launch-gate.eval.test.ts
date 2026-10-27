/**
 * Launch-gate eval (Phase 4 rag-production-hardening).
 *
 * Stricter release-gate that runs against a larger, multilingual fixture
 * drafted from real-workspace turn shapes. Intended to block production
 * cutovers (e.g. flipping `RAG_USE_CANONICAL_SNIPPETS` or merging to `main`
 * with RAG-relevant diffs).
 *
 * Like `rag-ragas.eval.test.ts` this is deterministic and offline — no LLM,
 * no network — so it is safe to run in CI. The separation from the
 * PR-level RAGAS eval is about two things:
 *   1. Thresholds here are materially higher (post-launch quality bar).
 *   2. The fixture mirrors real in-app phrasings across locales and
 *      covers abstention contracts (empty retrieved context, empty answer).
 */

import { aggregate, scoreCase, type RagasCaseInput } from "./ragas-metrics";
import {
  expectScoresAtLeast,
  isAbstentionCase,
  type RagasFixtureFile,
} from "./ragas-eval-test-utils";
import fixtures from "./launch-gate-golden.json";

const LAUNCH_GATE_VERSION = 1;

const fx = fixtures as RagasFixtureFile;

describe("RAG launch-gate eval (offline)", () => {
  it("fixture schema version matches runner", () => {
    expect(fx.version).toBe(LAUNCH_GATE_VERSION);
    expect(Array.isArray(fx.cases)).toBe(true);
    expect(fx.cases.length).toBeGreaterThanOrEqual(10);
  });

  describe.each(fx.cases)("case: $id", (caseInput: RagasCaseInput) => {
    it("meets launch-gate per-case floors", () => {
      if (isAbstentionCase(caseInput)) {
        // Abstention contract: no gold => generated answer MUST be empty.
        // This is the production-critical guardrail against hallucination
        // when retrieval returns nothing relevant.
        expect(caseInput.generatedAnswer).toBe("");
        return;
      }
      const scores = scoreCase(caseInput);
      expectScoresAtLeast(scores, fx.perCaseThresholds);
    });
  });

  it("aggregate scores clear launch-gate suite-wide floors", () => {
    const scored = fx.cases.filter(c => !isAbstentionCase(c)).map(scoreCase);
    const agg = aggregate(scored);

    expectScoresAtLeast(agg, fx.aggregateThresholds);
  });

  it("covers multiple locales", () => {
    // Guard: a real launch gate must exercise more than one language to
    // protect the multilingual KB paths (query cleaner, HyDE prompt,
    // reranker).
    const ids = fx.cases.map(c => c.id);
    const hasEn = ids.some(id => id.includes("-en-"));
    const hasRu = ids.some(id => id.includes("-ru-"));
    expect(hasEn).toBe(true);
    expect(hasRu).toBe(true);
  });

  it("includes at least one abstention case", () => {
    const abstention = fx.cases.filter(isAbstentionCase);
    expect(abstention.length).toBeGreaterThan(0);
  });
});
