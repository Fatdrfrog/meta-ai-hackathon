import {
  planRetrievalQuery,
  turnSeedCoversRetrievalQuery,
} from "@/lib/airi/rag/pipeline/retrieval-planner";

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

describe("planRetrievalQuery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses heuristics for short factual questions without calling LLM prep", async () => {
    const plan = await planRetrievalQuery({
      query: "What is your refund policy?",
      language: "en",
    });

    expect(plan.plannerMode).toBe("heuristic");
    expect(prepareQueryForRagWithLlm).not.toHaveBeenCalled();
    expect(plan.standaloneQuery.length).toBeGreaterThan(4);
    expect(plan.factualIntent).toBe("factual");
    expect(plan.hydeRecommended).toBe(true);
  });

  it("calls LLM prep for long compound questions", async () => {
    const long =
      "I need help with billing and also want to know how to export data and what your SLA is?";
    const plan = await planRetrievalQuery({
      query: long,
      language: "en",
    });

    expect(plan.plannerMode).toBe("llm");
    expect(prepareQueryForRagWithLlm).toHaveBeenCalled();
    expect(plan.subqueries.length).toBeGreaterThan(0);
    expect(plan.hydeRecommended).toBe(false);
  });

  it("skips LLM prep when skipLlmRetrievalPlanner is set (fast channel mode)", async () => {
    const long =
      "I need help with billing and also want to know how to export data and what your SLA is?";
    const plan = await planRetrievalQuery({
      query: long,
      language: "en",
      skipLlmRetrievalPlanner: true,
    });

    expect(plan.plannerMode).toBe("heuristic");
    expect(prepareQueryForRagWithLlm).not.toHaveBeenCalled();
  });

  it("reuses seedRagQueryPreparation when originalQuery matches (no second prep LLM)", async () => {
    const long =
      "I need help with billing and also want to know how to export data and what your SLA is?";
    const seed = {
      cleanedQuery: "billing export SLA",
      subQueries: ["billing", "export", "sla"],
      originalQuery: long,
      wasCleaned: true,
      source: "llm" as const,
    };
    const plan = await planRetrievalQuery({
      query: long,
      language: "en",
      seedRagQueryPreparation: seed,
    });

    expect(plan.plannerMode).toBe("llm");
    expect(prepareQueryForRagWithLlm).not.toHaveBeenCalled();
    expect(plan.ragQueryPreparation).toEqual(seed);
  });

  it("reuses seed when query equals cleanedQuery (retrievalQuery from goal planner)", async () => {
    const seed = {
      cleanedQuery: "What is the price for mentorship?",
      subQueries: [] as string[],
      originalQuery:
        "Hello! What is the price for mentorship and do you have grants?",
      wasCleaned: true,
      source: "llm" as const,
    };
    const plan = await planRetrievalQuery({
      query: "What is the price for mentorship?",
      language: "en",
      seedRagQueryPreparation: seed,
    });

    expect(prepareQueryForRagWithLlm).not.toHaveBeenCalled();
    expect(plan.ragQueryPreparation).toEqual(seed);
  });

  it("reuses turn seed when needsLlm and retrieval query matches a subQuery (no second prep LLM)", async () => {
    const longOriginal =
      "I need help with billing and also want to know how to export data and what your SLA is?";
    const seed = {
      cleanedQuery: "billing export SLA help",
      subQueries: ["billing help", "how to export data", "what is your SLA"],
      originalQuery: longOriginal,
      wasCleaned: true,
      source: "llm" as const,
    };
    const plan = await planRetrievalQuery({
      query: "how to export data",
      language: "en",
      forceBlendedRetrieval: true,
      seedRagQueryPreparation: seed,
    });

    expect(plan.plannerMode).toBe("llm");
    expect(prepareQueryForRagWithLlm).not.toHaveBeenCalled();
    expect(plan.ragQueryPreparation).toEqual(seed);
  });

  it("reuses seed when cleanedQuery matches with extra whitespace", async () => {
    const seed = {
      cleanedQuery: "What  is  the  price?",
      subQueries: [] as string[],
      originalQuery: "Hello what is the price",
      wasCleaned: true,
      source: "llm" as const,
    };
    const plan = await planRetrievalQuery({
      query: "What is the price?",
      language: "en",
      seedRagQueryPreparation: seed,
    });

    expect(prepareQueryForRagWithLlm).not.toHaveBeenCalled();
    expect(plan.ragQueryPreparation).toEqual(seed);
  });

  it("plans a blended thread query from the turn's own LLM prep (no second prep LLM)", async () => {
    // The incident: the thread query differed from the message, so every
    // blended turn paid for another query-prep call (setup 2 s).
    const seed = {
      cleanedQuery: "стоимость доставки в Астану",
      subQueries: ["доставка Астана", "оплата при получении"],
      originalQuery: "А сколько стоит доставка в Астану? И можно картой?",
      wasCleaned: true,
      source: "llm" as const,
    };
    const threadQuery = "Футболка размер M: доставка в Астану и оплата картой";
    const plan = await planRetrievalQuery({
      query: threadQuery,
      language: "ru",
      forceBlendedRetrieval: true,
      forceBlendedReason: "thread_plan",
      seedRagQueryPreparation: seed,
    });

    expect(prepareQueryForRagWithLlm).not.toHaveBeenCalled();
    expect(plan.plannerMode).toBe("llm");
    expect(plan.ragQueryPreparation).toEqual({
      ...seed,
      originalQuery: threadQuery,
    });
    expect(plan.subqueries).toEqual(seed.subQueries);
  });

  it("still calls LLM prep for a blended query when the seed is only heuristic", async () => {
    await planRetrievalQuery({
      query: "Футболка размер M: доставка в Астану и оплата картой",
      language: "ru",
      forceBlendedRetrieval: true,
      seedRagQueryPreparation: {
        cleanedQuery: "доставка",
        subQueries: [],
        originalQuery: "доставка?",
        wasCleaned: true,
        source: "fallback",
      },
    });
    expect(prepareQueryForRagWithLlm).toHaveBeenCalledTimes(1);
  });

  it("turnSeedCoversRetrievalQuery is false for empty searchable prep", () => {
    const seed = {
      cleanedQuery: "",
      subQueries: [] as string[],
      originalQuery: "hi",
      wasCleaned: true,
      source: "llm" as const,
    };
    expect(turnSeedCoversRetrievalQuery(seed, "hi")).toBe(false);
  });
});
