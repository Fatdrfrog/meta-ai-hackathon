import { aggregate } from "./ragas-metrics";
import {
  evaluateReliabilityCase,
  type RagReliabilityCaseInput,
} from "./rag-reliability-contracts";
import fixtures from "./reliability-stress-cases.json";

const RELIABILITY_FIXTURE_VERSION = 1;

type FixtureFile = {
  version: number;
  description?: string;
  cases: RagReliabilityCaseInput[];
};

const fx = fixtures as FixtureFile;

describe("RAG reliability stress contracts", () => {
  it("fixture schema version matches runner", () => {
    expect(fx.version).toBe(RELIABILITY_FIXTURE_VERSION);
    expect(Array.isArray(fx.cases)).toBe(true);
    expect(fx.cases.length).toBeGreaterThanOrEqual(8);
  });

  describe.each(fx.cases)("case: $id", caseInput => {
    it("satisfies the product reliability contract", () => {
      const report = evaluateReliabilityCase(caseInput);
      expect(report.failures).toEqual([]);
    });
  });

  it("keeps aggregate quality above the stress-suite floor", () => {
    const answerReports = fx.cases
      .filter(c => c.expected.outcome === "answer")
      .map(evaluateReliabilityCase);
    const agg = aggregate(answerReports.map(report => report.scores));

    expect(agg.contextPrecisionAtK).toBeGreaterThanOrEqual(0.64);
    expect(agg.contextRecallAtK).toBeGreaterThanOrEqual(1);
    expect(agg.answerRelevancy).toBeGreaterThanOrEqual(0.6);
    expect(agg.faithfulness).toBeGreaterThanOrEqual(0.68);
  });

  it("covers the failure modes that matter for launch gates", () => {
    const tags = new Set(fx.cases.flatMap(c => c.tags || []));
    expect(tags.has("abstention")).toBe(true);
    expect(tags.has("conflicting_context")).toBe(true);
    expect(tags.has("multi_hop")).toBe(true);
    expect(tags.has("multilingual")).toBe(true);
    expect(tags.has("workspace_isolation")).toBe(true);
  });

  it("negative control catches unsupported answers and bad citations", () => {
    const base = fx.cases.find(c => c.id === "stress-en-noisy-refund-ranking");
    expect(base).toBeDefined();

    const report = evaluateReliabilityCase({
      ...base!,
      id: "negative-control-unsupported-refund",
      citations: ["kb-shipping-zones"],
      generatedAnswer: "You only get store credit after 7 days.",
    });

    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing required citation source"),
        expect.stringContaining("generatedAnswer contains forbidden term"),
      ])
    );
  });
});
