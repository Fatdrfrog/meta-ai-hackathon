import {
  citationDisciplineSystemRules,
  citationDisciplineTaskSuffix,
  kbBlockCitationFooter,
  resolveEffectiveCitationDiscipline,
} from "@/lib/airi/grounding/citation-discipline";
import type { RetrievalPlan } from "@/lib/airi/rag/evidence/evidence-types";

function plan(
  strength: RetrievalPlan["requiredCitationStrength"],
  factual: RetrievalPlan["factualIntent"]
): RetrievalPlan {
  return {
    normalizedQuery: "q",
    standaloneQuery: "q",
    subqueries: [],
    factualIntent: factual,
    pinnedSourceIds: [],
    requiredCitationStrength: strength,
    plannerMode: "heuristic",
    hydeRecommended: true,
    ragQueryPreparation: {
      cleanedQuery: "q",
      subQueries: [],
      originalQuery: "q",
      wasCleaned: false,
      source: "fallback",
    },
  };
}

describe("resolveEffectiveCitationDiscipline", () => {
  it("leaves planner strength when strict enforcement is off", () => {
    expect(
      resolveEffectiveCitationDiscipline({
        plan: plan("none", "factual"),
        groundedStrictEnforcement: false,
        hasRetrievedSources: true,
      })
    ).toBe("none");
  });

  it("bumps one step when strict enforcement is on with sources and factual intent", () => {
    expect(
      resolveEffectiveCitationDiscipline({
        plan: plan("none", "factual"),
        groundedStrictEnforcement: true,
        hasRetrievedSources: true,
      })
    ).toBe("preferred");

    expect(
      resolveEffectiveCitationDiscipline({
        plan: plan("preferred", "factual"),
        groundedStrictEnforcement: true,
        hasRetrievedSources: true,
      })
    ).toBe("strict");
  });

  it("does not bump when intent is none", () => {
    expect(
      resolveEffectiveCitationDiscipline({
        plan: plan("none", "none"),
        groundedStrictEnforcement: true,
        hasRetrievedSources: true,
      })
    ).toBe("none");
  });
});

describe("citationDisciplineSystemRules", () => {
  it("returns strict block when grounded", () => {
    const t = citationDisciplineSystemRules("strict", true);
    expect(t).toContain("CITATION-FIRST (strict)");
    expect(t).toContain("numbered sources");
    expect(t).toContain("Do not include bracket citations");
  });
});

describe("citationDisciplineTaskSuffix", () => {
  it("appends only for strict grounded profiles", () => {
    expect(citationDisciplineTaskSuffix("strict", "clarification")).toBe("");
    expect(citationDisciplineTaskSuffix("strict", "grounded_answer")).toContain(
      "numbered retrieved"
    );
  });
});

describe("kbBlockCitationFooter", () => {
  it("is empty unless strict", () => {
    expect(kbBlockCitationFooter("preferred")).toBe("");
    expect(kbBlockCitationFooter("strict")).toContain("STRICT SOURCE MODE");
  });
});
