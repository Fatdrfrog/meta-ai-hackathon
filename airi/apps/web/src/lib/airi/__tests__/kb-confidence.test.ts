import { isHighConfidenceKB } from "@/lib/airi/rag/kb/kb-confidence";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";

describe("kb confidence", () => {
  it("does not treat lexical fallback overlap as high-confidence on its own", () => {
    expect(
      isHighConfidenceKB({
        id: "kb-1",
        title: "Disability program",
        fullContent: "Program details",
        similarity: 0.9,
        locale: "ru",
        retrievalMethod: "search_vector",
      })
    ).toBe(false);
  });

  it("accepts lexical fallback results once reranker strongly confirms them", () => {
    expect(
      isHighConfidenceKB({
        id: "kb-1",
        title: "Disability program",
        fullContent: "Program details",
        similarity: 0.6,
        locale: "ru",
        retrievalMethod: "search_vector",
        rerankerScore: 0.91,
      })
    ).toBe(true);
  });

  it("allows strong reranker rescue for broad vector candidates", () => {
    expect(
      isHighConfidenceKB({
        id: "kb-1",
        title: "Disability program",
        fullContent: "Program details",
        similarity: 0.6,
        locale: "ru",
        retrievalMethod: "vector",
        rerankerScore: 0.91,
      })
    ).toBe(true);
  });

  it("does not grant retired canonical summary rows a lower confidence threshold", () => {
    const retiredRuntimeRow = {
      id: "legacy-summary-chunk",
      title: "Legacy mirror",
      fullContent: "Old duplicated conversation memory",
      similarity: 0.5,
      locale: "en",
      sourceType: "conversation_summary",
      retrievalMethod: "knowledge_chunk",
    } as unknown as KBArticleResult;

    expect(isHighConfidenceKB(retiredRuntimeRow)).toBe(false);
  });
});
