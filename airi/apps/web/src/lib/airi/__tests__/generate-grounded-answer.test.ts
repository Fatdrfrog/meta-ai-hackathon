import {
  computeHeuristicGroundedAnswer,
  generateGroundedAnswer,
  rankProductEvidenceChunks,
} from "@/lib/airi/grounding/generate-grounded-answer";
import type { HybridContext } from "@/lib/airi/rag/types";

function minimalHybrid(productText: string): HybridContext {
  return {
    kbArticles: [
      {
        id: "chunk-1",
        title: "Source",
        fullContent: productText,
        similarity: 0.9,
        locale: "en",
        retrievalMethod: "knowledge_chunk",
        sourceType: "kb_article",
        sourceRecordId: "art-1",
      },
    ],
    conversationSummaries: [],
    retrievalStats: {
      kbArticlesCount: 1,
      totalRetrievalTimeMs: 0,
    },
  };
}

describe("generateGroundedAnswer", () => {
  it("returns GroundedAnswer with citations aligned to postCheckClaims corpus", () => {
    const hybrid = minimalHybrid(
      "The annual fee is 99 dollars for the Pro plan in 2024."
    );
    const grounded = generateGroundedAnswer({
      answer: "The Pro plan costs $99 per year.",
      hybridContext: hybrid,
    });

    expect(grounded.answer).toBe("The Pro plan costs $99 per year.");
    expect(grounded.citations.length).toBeGreaterThanOrEqual(1);
    expect(grounded.citations[0]?.chunkId).toBeDefined();
    expect(grounded.confidence).toBeGreaterThanOrEqual(0);
    expect(grounded.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(grounded.unsupportedClaims)).toBe(true);
  });

  it("returns empty citations when there is no product evidence", () => {
    const hybrid: HybridContext = {
      kbArticles: [],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 0,
        totalRetrievalTimeMs: 0,
      },
    };
    const grounded = generateGroundedAnswer({
      answer: "Hello there.",
      hybridContext: hybrid,
    });
    expect(grounded.citations).toEqual([]);
  });

  it("merges LLM reflection conservatively (confidence min, union unsupported, cited ids)", () => {
    const hybrid = minimalHybrid(
      "The annual fee is 99 dollars for the Pro plan in 2024."
    );
    const ranked = rankProductEvidenceChunks(hybrid);
    const base = computeHeuristicGroundedAnswer({
      answer: "The Pro plan costs $99 per year.",
      rankedProduct: ranked,
    });
    const chunkId = base.citations[0]?.chunkId;
    expect(chunkId).toBeDefined();

    const merged = generateGroundedAnswer({
      answer: "The Pro plan costs $99 per year.",
      hybridContext: hybrid,
      llmReflection: {
        citedChunkIds: chunkId ? [chunkId] : [],
        unsupportedClaims: [
          "We also guarantee same-day shipping worldwide on all tiers.",
        ],
        confidence: 0.95,
      },
    });

    expect(merged.confidence).toBeLessThanOrEqual(base.confidence);
    expect(merged.unsupportedClaims.length).toBeGreaterThanOrEqual(
      base.unsupportedClaims.length
    );
    expect(merged.llmCitedChunkIds).toEqual(chunkId ? [chunkId] : []);
  });
});
