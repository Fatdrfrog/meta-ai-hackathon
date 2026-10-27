import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import { evaluateFactualGroundingGuard } from "./factual-grounding-guard";

function kbArticle(partial: Partial<KBArticleResult>): KBArticleResult {
  return {
    id: "chunk-1",
    title: "Offer",
    fullContent: "",
    similarity: 0.76,
    locale: "ru",
    ...partial,
  };
}

describe("evaluateFactualGroundingGuard", () => {
  it("does not block pricing when useKB is false but retrieved candidates contain price evidence above floor", () => {
    const result = evaluateFactualGroundingGuard({
      query: "А сколько стоит менторство?",
      decision: {
        useSnippet: false,
        useKB: false,
        priority: "generic",
        reasoning: "No high-confidence matches",
      },
      kbArticles: [],
      retrievedKbCandidates: [
        kbArticle({
          id: "c1",
          fullContent: "Менторство — $1,500 за программу.",
          similarity: 0.759,
        }),
      ],
    });

    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("kb_contains_intent_evidence");
    expect(result.evidenceSource).toBe("kb");
  });

  it("still blocks pricing when retrieved candidates are below factual guard floor", () => {
    const result = evaluateFactualGroundingGuard({
      query: "How much does it cost?",
      decision: {
        useSnippet: false,
        useKB: false,
        priority: "generic",
        reasoning: "No high-confidence matches",
      },
      kbArticles: [],
      retrievedKbCandidates: [
        kbArticle({
          fullContent: "Price is $99",
          similarity: 0.65,
        }),
      ],
    });

    expect(result.shouldBlock).toBe(true);
  });

  it("does not block pricing when KB has amount+currency only (no price keywords)", () => {
    const result = evaluateFactualGroundingGuard({
      query: "сколько стоит гайд?",
      decision: {
        useSnippet: false,
        useKB: true,
        priority: "kb",
        reasoning: "kb",
      },
      kbArticles: [
        kbArticle({
          id: "c-kzt",
          fullContent: "Гайд и вебинар — 7 000 ₸, оплата онлайн.",
          similarity: 0.9,
        }),
      ],
    });

    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("kb_contains_intent_evidence");
  });

  it("does not treat policy intent from retrieval expansion alone when literal follow-up is benign", () => {
    const result = evaluateFactualGroundingGuard({
      query: "Грантовый спринт Зульфии Уруновой условия и наличие",
      literalCustomerMessage: "а спринт есть?",
      decision: {
        useSnippet: false,
        useKB: false,
        priority: "generic",
        reasoning: "No high-confidence matches",
      },
      kbArticles: [],
      retrievedKbCandidates: [],
    });

    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("query_not_in_fact_sensitive_scope");
  });

  it("still classifies pricing from literal when retrieval query is benign", () => {
    const result = evaluateFactualGroundingGuard({
      query: "follow up on earlier topic",
      literalCustomerMessage: "сколько стоит гайд?",
      decision: {
        useSnippet: false,
        useKB: false,
        priority: "generic",
        reasoning: "No high-confidence matches",
      },
      kbArticles: [],
      retrievedKbCandidates: [
        kbArticle({
          id: "c1",
          fullContent: "Гайд и вебинар — 7 000 ₸.",
          similarity: 0.759,
        }),
      ],
    });

    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("kb_contains_intent_evidence");
  });
});
