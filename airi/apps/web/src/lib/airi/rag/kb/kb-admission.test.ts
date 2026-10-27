import { RAG_CONFIG } from "@/lib/airi/rag/config";
import {
  computeKbAdmissionThreshold,
  resolveKbDecisionThreshold,
} from "./kb-admission";
import type { HybridContext } from "@/lib/airi/rag/types";

describe("computeKbAdmissionThreshold", () => {
  it("matches staged retrieval factor (exploratory 0.75 → ~0.674)", () => {
    const t = computeKbAdmissionThreshold(0.75);
    expect(t).toBeCloseTo(
      0.75 * RAG_CONFIG.thresholds.kbRetrievalStageRatio - RAG_CONFIG.epsilon,
      5
    );
  });

  it("stays stricter for factual queries", () => {
    const exploratory = computeKbAdmissionThreshold(0.75);
    const factual = computeKbAdmissionThreshold(0.85);
    expect(factual).toBeGreaterThan(exploratory);
  });
});

describe("resolveKbDecisionThreshold", () => {
  it("uses queryClassification.kbAdmissionThreshold when present", () => {
    const ctx = {
      kbArticles: [],
      retrievalStats: {
        kbArticlesCount: 0,
        totalRetrievalTimeMs: 0,
        queryClassification: {
          type: "exploratory" as const,
          retrievalKbThreshold: 0.75,
          kbAdmissionThreshold: 0.66,
        },
      },
    } satisfies Pick<HybridContext, "kbArticles" | "retrievalStats">;
    expect(resolveKbDecisionThreshold(ctx as HybridContext)).toBe(0.66);
  });

  it("falls back to RAG_CONFIG.thresholds.kb when classification missing", () => {
    const ctx = {
      kbArticles: [],
      retrievalStats: {
        kbArticlesCount: 0,
        totalRetrievalTimeMs: 0,
      },
    } satisfies Pick<HybridContext, "kbArticles" | "retrievalStats">;
    expect(resolveKbDecisionThreshold(ctx as HybridContext)).toBe(
      RAG_CONFIG.thresholds.kb
    );
  });
});
