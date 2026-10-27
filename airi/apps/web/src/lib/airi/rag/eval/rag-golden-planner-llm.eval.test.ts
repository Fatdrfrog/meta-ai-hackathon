/**
 * Planner rows that call `prepareQueryForRagWithLlm` (blend / long / service-overview / compound).
 * Isolated from `rag-golden.eval.test.ts` so the main golden file keeps a real query-cleaner.
 */

jest.mock("@/lib/airi/rag/query/query-cleaner", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/airi/rag/query/query-cleaner")
  >("@/lib/airi/rag/query/query-cleaner");
  return {
    ...actual,
    prepareQueryForRagWithLlm: jest.fn(async (query: string) => ({
      cleanedQuery: query.trim(),
      subQueries: ["sub-a", "sub-b"],
      originalQuery: query,
      wasCleaned: true,
      source: "llm" as const,
    })),
  };
});

import { prepareQueryForRagWithLlm } from "@/lib/airi/rag/query/query-cleaner";
import { planRetrievalQuery } from "@/lib/airi/rag/pipeline/retrieval-planner";

describe("RAG golden planner (mocked LLM prep)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("forceBlendedRetrieval skips HyDE", async () => {
    const plan = await planRetrievalQuery({
      query: "Quick question about shipping.",
      language: "en",
      forceBlendedRetrieval: true,
    });
    expect(plan.hydeRecommended).toBe(false);
    expect(plan.plannerMode).toBe("llm");
    expect(prepareQueryForRagWithLlm).toHaveBeenCalled();
  });

  it("long compound query uses LLM prep and disables HyDE (multi subquery)", async () => {
    const long =
      "I need help with billing and also want to know how to export data and what your SLA is?";
    const plan = await planRetrievalQuery({
      query: long,
      language: "en",
    });
    expect(plan.plannerMode).toBe("llm");
    expect(plan.subqueries.length).toBeGreaterThan(0);
    expect(plan.hydeRecommended).toBe(false);
    expect(prepareQueryForRagWithLlm).toHaveBeenCalled();
  });
});
