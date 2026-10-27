import type { WorkspaceTaxonomy } from "@/lib/classifier/taxonomy";
import {
  resolveEffectiveConversationCategory,
  selectCategoryWithSchema,
} from "@/lib/classifier/taxonomy-evaluation";

const mockChat = jest.fn();
jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) => mockChat(...args),
  getLightTextModel: () => "claude-haiku-4-5",
}));

const taxonomy: WorkspaceTaxonomy = {
  id: "taxonomy-1",
  workspaceId: "workspace-1",
  labels: ["Sales", "Support", "Other"],
  confidenceThreshold: 0.7,
  version: "v1",
};

describe("resolveEffectiveConversationCategory", () => {
  it.each(["own_ai_source_required", "workspace_ai_policy_unavailable"])(
    "does not publish an Other category when %s denies inference",
    async code => {
      const error = Object.assign(new Error("Inference denied"), { code });
      await expect(
        resolveEffectiveConversationCategory({
          taxonomy,
          storedCategory: "Old Category",
          evaluateCategory: async () => {
            throw error;
          },
        })
      ).rejects.toBe(error);
    }
  );
  it("uses the stored category when it matches the latest taxonomy", async () => {
    const evaluateCategory = jest.fn();

    const result = await resolveEffectiveConversationCategory({
      taxonomy,
      storedCategory: "Sales",
      storedConfidence: 0.84,
      evaluateCategory,
    });

    expect(result).toEqual({
      effectiveCategory: "Sales",
      categorySource: "stored",
      categoryConfidence: 0.84,
      categoryEvidence: "Stored classification matched the latest taxonomy.",
      warnings: [],
    });
    expect(evaluateCategory).not.toHaveBeenCalled();
  });

  it("reclassifies a legacy category against the latest taxonomy without falling back", async () => {
    const evaluateCategory = jest.fn().mockResolvedValue({
      category: "Support",
      confidence: 0.91,
      rationale: "Recent messages are about fixing an account issue.",
      evidence: ["Customer asked for help accessing the account."],
    });

    const result = await resolveEffectiveConversationCategory({
      taxonomy,
      storedCategory: "Legacy Product Bucket",
      storedConfidence: 0.95,
      evaluateCategory,
    });

    expect(result).toEqual({
      effectiveCategory: "Support",
      categorySource: "reclassified",
      categoryConfidence: 0.91,
      categoryEvidence:
        "Customer asked for help accessing the account. | Recent messages are about fixing an account issue.",
      warnings: [],
    });
    expect(evaluateCategory).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates when stored label matches taxonomy but confidence is below threshold", async () => {
    const evaluateCategory = jest.fn().mockResolvedValue({
      category: "Support",
      confidence: 0.92,
      rationale: "Latest intent is support.",
      evidence: ["Password reset request"],
    });

    const result = await resolveEffectiveConversationCategory({
      taxonomy,
      storedCategory: "Sales",
      storedConfidence: 0.35,
      evaluateCategory,
    });

    expect(evaluateCategory).toHaveBeenCalledTimes(1);
    expect(result.categorySource).toBe("reclassified");
    expect(result.effectiveCategory).toBe("Support");
  });

  it("keeps stored label with warning when confidence is low and LLM is unavailable", async () => {
    const result = await resolveEffectiveConversationCategory({
      taxonomy,
      storedCategory: "Sales",
      storedConfidence: 0.35,
    });
    expect(result.effectiveCategory).toBe("Sales");
    expect(result.categorySource).toBe("stored");
    expect(result.warnings).toEqual(["low_confidence_category"]);
  });

  it("falls back to Other when reclassification is low confidence", async () => {
    const result = await resolveEffectiveConversationCategory({
      taxonomy,
      storedCategory: "Old Category",
      evaluateCategory: async () => ({
        category: "Sales",
        confidence: 0.42,
        rationale: "Signals were mixed.",
        evidence: ["Conversation covered pricing and support questions."],
      }),
    });

    expect(result.effectiveCategory).toBe("Other");
    expect(result.categorySource).toBe("fallback_other");
    expect(result.categoryConfidence).toBe(0.42);
    expect(result.warnings).toEqual(["low_confidence_category"]);
    expect(result.categoryEvidence).toContain(
      "Fell back to Other because the category was missing or below the confidence threshold."
    );
  });
});

describe("selectCategoryWithSchema", () => {
  beforeEach(() => mockChat.mockReset());

  it("asks the light text tier for JSON and accepts a fenced reply", async () => {
    mockChat.mockResolvedValue({
      content: [
        "```json",
        '{"category":"Support","confidence":0.88,"rationale":"Login issue.","evidence":["Cannot sign in"]}',
        "```",
      ].join("\n"),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 12,
    });

    const result = await selectCategoryWithSchema({
      businessContext: "SaaS support",
      textForAnalysis: "Customer: I cannot sign in",
      taxonomy,
    });

    expect(result).toEqual({
      category: "Support",
      confidence: 0.88,
      rationale: "Login issue.",
      evidence: ["Cannot sign in"],
    });
    expect(mockChat).toHaveBeenCalledTimes(1);
    const request = mockChat.mock.calls[0][0];
    expect(request).toMatchObject({
      model: "claude-haiku-4-5",
      responseFormat: { type: "json_object" },
      temperature: 0,
    });
    // The chat path applies the per-provider structured-JSON config itself.
    expect(request).not.toHaveProperty("generationConfig");
  });
});
