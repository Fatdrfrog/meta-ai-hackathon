import { deriveRetrievalPath, selectBestContext } from "./decision-engine";
import type { ContextDecision, HybridContext } from "@/lib/airi/rag/types";

function d(partial: Partial<ContextDecision>): ContextDecision {
  return {
    useSnippet: false,
    useKB: false,
    priority: "generic",
    reasoning: "",
    ...partial,
  };
}

describe("deriveRetrievalPath", () => {
  it("returns none for generic priority", () => {
    expect(
      deriveRetrievalPath(
        d({ priority: "generic", useSnippet: false, useKB: false })
      )
    ).toBe("none");
  });

  it("returns blended when both snippet and KB are used", () => {
    expect(
      deriveRetrievalPath(
        d({
          priority: "kb",
          useSnippet: true,
          useKB: true,
        })
      )
    ).toBe("blended");
  });

  it("returns snippet when only snippet is used", () => {
    expect(
      deriveRetrievalPath(
        d({ priority: "snippet", useSnippet: true, useKB: false })
      )
    ).toBe("snippet");
  });

  it("returns kb when only KB is used", () => {
    expect(
      deriveRetrievalPath(d({ priority: "kb", useSnippet: false, useKB: true }))
    ).toBe("kb");
  });

  it("maps conversation_summary to kb", () => {
    expect(
      deriveRetrievalPath(
        d({
          priority: "conversation_summary",
          useSnippet: false,
          useKB: false,
        })
      )
    ).toBe("kb");
  });
});

describe("selectBestContext — KB near-threshold soft path", () => {
  const basePlan = {
    standaloneQuery: "Сколько стоит менторство?",
    subqueries: [] as string[],
    factualIntent: "factual" as const,
    pinnedSourceIds: [] as string[],
    requiredCitationStrength: "strict" as const,
    plannerMode: "heuristic" as const,
    hydeRecommended: true,
    ragQueryPreparation: {
      cleanedQuery: "",
      subQueries: [] as string[],
      originalQuery: "",
      wasCleaned: false,
      source: "fallback" as const,
    },
  };

  it("uses KB when top similarity is just below admission for a pricing query", () => {
    const hybrid = {
      kbArticles: [
        {
          id: "x",
          title: "Mentorship",
          fullContent: "mentorship",
          similarity: 0.759,
          locale: "ru",
        },
      ],
      retrievalStats: {
        kbArticlesCount: 1,
        topKBSimilarity: 0.759,
        totalRetrievalTimeMs: 0,
        queryClassification: {
          type: "factual" as const,
          retrievalKbThreshold: 0.85,
          kbAdmissionThreshold: 0.764,
        },
      },
      retrievalPlan: {
        ...basePlan,
        normalizedQuery: "Сколько стоит менторство?",
      },
    };

    const decision = selectBestContext(hybrid as HybridContext);
    expect(decision.useKB).toBe(true);
    expect(decision.priority).toBe("kb");
    expect(decision.reasoning).toContain("near admission");
  });

  it("does not use near-threshold KB when the query is not fact-sensitive", () => {
    const hybrid = {
      kbArticles: [
        {
          id: "x",
          title: "Science",
          fullContent: "text",
          similarity: 0.759,
          locale: "en",
        },
      ],
      retrievalStats: {
        kbArticlesCount: 1,
        topKBSimilarity: 0.759,
        totalRetrievalTimeMs: 0,
        queryClassification: {
          type: "factual" as const,
          retrievalKbThreshold: 0.85,
          kbAdmissionThreshold: 0.764,
        },
      },
      retrievalPlan: {
        ...basePlan,
        normalizedQuery: "Explain quantum entanglement briefly.",
      },
    };

    const decision = selectBestContext(hybrid as HybridContext);
    expect(decision.useKB).toBe(false);
    expect(decision.priority).toBe("generic");
  });
});
