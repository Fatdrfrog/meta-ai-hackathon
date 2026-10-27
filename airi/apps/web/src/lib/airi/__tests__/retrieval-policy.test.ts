import {
  buildRetrievalExecutionPlan,
  resolveRetrievalHintVariants,
  resolveThreadBlendDecision,
} from "@/lib/airi/rag/pipeline/retrieval-policy";
import type { RetrievalIntentClassification } from "@/lib/airi/rag/query/retrieval-intent-classifier";

function retrievalIntent(
  overrides: Partial<RetrievalIntentClassification>
): RetrievalIntentClassification {
  return {
    query: "What services do you offer?",
    language: "en",
    label: "unclear",
    confidence: "low",
    shouldUseBroadRetrieval: false,
    shouldUseOverviewVariants: false,
    queryVariants: [],
    reason: "test",
    source: "llm_classifier",
    ...overrides,
  };
}

describe("retrieval policy", () => {
  it("does not emit a redundant stage-2 variant for a mere cleaned form", async () => {
    const plan = await buildRetrievalExecutionPlan({
      query: "Hello, pricing?",
      ragQueryPreparation: {
        cleanedQuery: "pricing?",
        subQueries: [],
        originalQuery: "Hello, pricing?",
        wasCleaned: true,
        source: "llm",
      },
    });

    // Stage-1 retrieval internally uses `cleanedQuery`, so a separate stage-2
    // "cleanup" variant would just re-run the same RPC. We now emit only the
    // primary variant unless decomposition/pinned/overview extras apply.
    expect(plan.queryVariants).toEqual(["Hello, pricing?"]);
    expect(plan.forceBlendedRetrieval).toBe(false);
    expect(plan.forceBlendedReason).toBeUndefined();
    expect(plan.variantPlans).toEqual([
      {
        query: "Hello, pricing?",
        purpose: "primary",
        stage: 1,
      },
    ]);
    expect(plan.retrievalBudget).toEqual({
      maxKbVectorQueries: 1,
      maxExtraQueryVariants: 0,
      maxPinnedKbPasses: 0,
    });
  });

  it("forces blended retrieval for truly compound sentence queries", async () => {
    const plan = await buildRetrievalExecutionPlan({
      query: "How do I apply? What is the price?",
      ragQueryPreparation: {
        cleanedQuery: "How do I apply? What is the price?",
        subQueries: ["How do I apply?", "What is the price?"],
        originalQuery: "How do I apply? What is the price?",
        wasCleaned: false,
        source: "llm",
      },
    });

    expect(plan.queryVariants).toEqual([
      "How do I apply? What is the price?",
      "How do I apply?",
      "What is the price?",
    ]);
    expect(plan.forceBlendedRetrieval).toBe(true);
    expect(plan.forceBlendedReason).toBe("compound_query");
    expect(plan.retrievalBudget).toEqual({
      maxKbVectorQueries: 3,
      maxExtraQueryVariants: 2,
      maxPinnedKbPasses: 0,
    });
  });

  it("preserves explicit thread-plan forcing over internal expansion", async () => {
    const plan = await buildRetrievalExecutionPlan({
      query: "Tell me about grants and pricing",
      ragQueryPreparation: {
        cleanedQuery: "Tell me about grants and pricing",
        subQueries: [],
        originalQuery: "Tell me about grants and pricing",
        wasCleaned: false,
        source: "llm",
      },
      plannedQueryVariants: ["grants", "pricing"],
      forceBlendedRetrieval: true,
      forceBlendedReason: "thread_plan",
    });

    expect(plan.queryVariants).toEqual([
      "Tell me about grants and pricing",
      "grants",
      "pricing",
    ]);
    expect(plan.forceBlendedRetrieval).toBe(true);
    expect(plan.forceBlendedReason).toBe("thread_plan");
    expect(plan.retrievalBudget).toEqual({
      maxKbVectorQueries: 3,
      maxExtraQueryVariants: 2,
      maxPinnedKbPasses: 0,
    });
  });

  it("forces pinned grounding even for single-ask queries", async () => {
    const plan = await buildRetrievalExecutionPlan({
      query: "Pricing",
      ragQueryPreparation: {
        cleanedQuery: "Pricing",
        subQueries: [],
        originalQuery: "Pricing",
        wasCleaned: false,
        source: "llm",
      },
      pinnedGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-pricing"],
      },
    });

    expect(plan.forceBlendedRetrieval).toBe(true);
    expect(plan.forceBlendedReason).toBe("pinned_grounding");
    expect(plan.retrievalBudget).toEqual({
      maxKbVectorQueries: 1,
      maxExtraQueryVariants: 0,
      maxPinnedKbPasses: 1,
    });
  });

  it("keeps retrieval hints on the same priority chain as the service", () => {
    expect(
      resolveRetrievalHintVariants({
        queryVariants: ["pricing", "pricing"],
        coverageHints: ["grants"],
        activeGoals: ["services"],
      })
    ).toEqual(["pricing"]);

    expect(
      resolveRetrievalHintVariants({
        coverageHints: ["grants", "pricing"],
        activeGoals: ["services"],
      })
    ).toEqual(["grants", "pricing"]);

    expect(
      resolveRetrievalHintVariants({
        activeGoals: ["services", "services", "pricing"],
      })
    ).toEqual(["services", "pricing"]);
  });

  it("forces thread-plan blending only for multi-ask or shifted follow-ups", () => {
    expect(
      resolveThreadBlendDecision({
        openAsks: ["grants", "pricing"],
        followUpAnchor: null,
        lastMessageQuery: null,
      })
    ).toEqual({
      forceBlendedRetrieval: true,
      forceBlendedReason: "thread_plan",
    });

    expect(
      resolveThreadBlendDecision({
        openAsks: ["pricing"],
        followUpAnchor: "pod kluch",
        lastMessageQuery: "pricing",
      })
    ).toEqual({
      forceBlendedRetrieval: true,
      forceBlendedReason: "thread_plan",
    });

    expect(
      resolveThreadBlendDecision({
        openAsks: ["pricing"],
        followUpAnchor: "pricing",
        lastMessageQuery: "pricing",
      })
    ).toEqual({
      forceBlendedRetrieval: false,
    });
  });

  it("forces blended retrieval for high-confidence broad service-overview intent", async () => {
    const plan = await buildRetrievalExecutionPlan({
      query: "Какие есть услуги?",
      ragQueryPreparation: {
        cleanedQuery: "Какие есть услуги?",
        subQueries: [],
        originalQuery: "Какие есть услуги?",
        wasCleaned: false,
        source: "llm",
      },
      retrievalIntent: retrievalIntent({
        label: "service_overview",
        confidence: "high",
        shouldUseBroadRetrieval: true,
        shouldUseOverviewVariants: true,
        queryVariants: ["available services", "formats of work"],
      }),
    });

    expect(plan.forceBlendedRetrieval).toBe(true);
    expect(plan.forceBlendedReason).toBe("service_overview");
    expect(plan.variantPlans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: "service_overview",
          stage: 2,
        }),
      ])
    );
  });

  it("uses medium-confidence overview variants without forcing a broad route", async () => {
    const plan = await buildRetrievalExecutionPlan({
      query: "tell me more",
      ragQueryPreparation: {
        cleanedQuery: "tell me more",
        subQueries: [],
        originalQuery: "tell me more",
        wasCleaned: false,
        source: "llm",
      },
      retrievalIntent: retrievalIntent({
        label: "service_overview",
        confidence: "medium",
        shouldUseOverviewVariants: true,
        queryVariants: ["available services"],
      }),
    });

    expect(plan.forceBlendedRetrieval).toBe(false);
    expect(plan.forceBlendedReason).toBeUndefined();
    expect(plan.variantPlans).toEqual([
      {
        query: "tell me more",
        purpose: "primary",
        stage: 1,
      },
      {
        query: "available services",
        purpose: "service_overview",
        stage: 2,
      },
    ]);
    expect(plan.retrievalBudget).toEqual({
      maxKbVectorQueries: 2,
      maxExtraQueryVariants: 1,
      maxPinnedKbPasses: 0,
    });
  });
});
