import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import { canonicalKbHitToEvidenceChunk } from "@/lib/airi/rag/evidence/evidence-kb-mapping";
import { splitEvidencePools } from "@/lib/airi/rag/evidence/evidence-from-hybrid";
import type { HybridContext } from "@/lib/airi/rag/types";

function minimalHybrid(partial: Partial<HybridContext>): HybridContext {
  return {
    kbArticles: [],
    retrievalStats: {
      kbArticlesCount: 0,
      totalRetrievalTimeMs: 0,
    },
    ...partial,
  } as HybridContext;
}

describe("canonicalKbHitToEvidenceChunk", () => {
  it("prefers mirrored chunkAuthorityScore over logical-kind defaults", () => {
    const kb: KBArticleResult = {
      id: "chunk-1",
      sourceRecordId: "art-1",
      documentId: "doc-1",
      chunkIndex: 0,
      title: "Policy",
      fullContent: "Details here.",
      similarity: 0.88,
      chunkAuthorityScore: 0.22,
      locale: "en",
      sourceType: "kb_article",
      retrievalMethod: "knowledge_chunk",
      contextFormat: "preview",
    };

    const chunk = canonicalKbHitToEvidenceChunk(kb);
    expect(chunk.authorityScore).toBe(0.22);
  });
});

describe("splitEvidencePools", () => {
  it("uses chunk body only for knowledge_chunk KB hits (no title+body merge)", () => {
    const kb: KBArticleResult = {
      id: "chunk-uuid-1",
      sourceRecordId: "art-1",
      documentId: "doc-1",
      chunkIndex: 0,
      title: "Refund policy",
      fullContent: "You can request a refund within 14 days.",
      similarity: 0.9,
      locale: "en",
      sourceType: "kb_article",
      retrievalMethod: "knowledge_chunk",
      contextFormat: "preview",
    };

    const { productChunks } = splitEvidencePools(
      minimalHybrid({ kbArticles: [kb] })
    );

    expect(productChunks).toHaveLength(1);
    expect(productChunks[0]).toMatchObject({
      id: "knowledge_chunk:chunk-uuid-1",
      sourceKind: "knowledge_chunk",
      text: "You can request a refund within 14 days.",
    });
    expect(productChunks[0]?.text.includes("Refund policy")).toBe(false);
  });

  it("keeps legacy article-level title+body merge for non-canonical KB hits", () => {
    const kb: KBArticleResult = {
      id: "article-1",
      title: "Shipping",
      fullContent: "We ship in 2 days.",
      similarity: 0.88,
      locale: "en",
      sourceType: "kb_article",
      retrievalMethod: "vector",
      contextFormat: "preview",
    };

    const { productChunks } = splitEvidencePools(
      minimalHybrid({ kbArticles: [kb] })
    );

    expect(productChunks[0]?.sourceKind).toBe("kb_article");
    expect(productChunks[0]?.id).toBe("kb_article:article-1");
    expect(productChunks[0]?.text).toContain("Shipping");
    expect(productChunks[0]?.text).toContain("We ship in 2 days.");
  });

  it("omits Mongo snippet when a canonical curated_snippet covers the same sourceRecordId", () => {
    const kb: KBArticleResult = {
      id: "chunk-s1",
      sourceRecordId: "mongo-snippet-id",
      title: "Question?",
      fullContent: "Answer from mirrored chunk.",
      similarity: 0.85,
      locale: "en",
      sourceType: "curated_snippet",
      retrievalMethod: "knowledge_chunk",
      contextFormat: "preview",
    };

    const { productChunks } = splitEvidencePools(
      minimalHybrid({
        snippet: {
          id: "mongo-snippet-id",
          question: "Question?",
          answer: "Answer from Mongo.",
          score: 0.92,
        },
        kbArticles: [kb],
      })
    );

    expect(productChunks).toHaveLength(1);
    expect(productChunks[0]?.sourceKind).toBe("knowledge_chunk");
  });

  it("keeps direct conversation summaries in the memory evidence pool", () => {
    const { memoryChunks } = splitEvidencePools(
      minimalHybrid({
        conversationSummaries: [
          {
            conversationId: "mongo-conv-1",
            summaryText: "Direct RPC row.",
            chunkIndex: null,
            similarity: 0.9,
          },
        ],
      })
    );

    expect(memoryChunks).toHaveLength(1);
    expect(memoryChunks[0]).toMatchObject({
      id: "conversation_summary:mongo-conv-1:0",
      sourceKind: "conversation_summary",
      text: "Direct RPC row.",
    });
  });
});
