import {
  buildBigQueryCostExpression,
  estimateLlmCostUsd,
  LLM_PRICING_VERSION,
  resolveLlmModelPricing,
} from "@icecore/airi-runtime/llm-pricing";

describe("llm pricing", () => {
  it("prices thinking as output and cached input at the cached rate", () => {
    const cost = estimateLlmCostUsd({
      model: "gemini-3.5-flash",
      promptTokens: 1000,
      completionTokens: 100,
      thinkingTokens: 200,
      cachedPromptTokens: 800,
    });
    expect(cost.inputCostUsd).toBeCloseTo(0.00042, 8);
    expect(cost.outputCostUsd).toBeCloseTo(0.0027, 8);
    expect(cost.totalCostUsd).toBeCloseTo(0.00312, 8);
    expect(
      estimateLlmCostUsd({
        model: "gemini-3.5-flash",
        promptTokens: 1000,
        completionTokens: 100,
        thinkingTokens: -20,
        cachedPromptTokens: 9000,
      }).totalCostUsd
    ).toBeCloseTo(0.00105, 8);
  });

  it.each([
    [
      "publishers/google/models/gemini-3.5-flash-lite-001",
      "gemini-3.5-flash-lite",
      0.3,
      2.5,
    ],
    ["gemini-2.5-flash-lite-001", "gemini-2.5-flash-lite", 0.1, 0.4],
  ])(
    "matches the longest model id for %s",
    (model, matchedModel, input, output) => {
      expect(resolveLlmModelPricing(model)).toMatchObject({
        matchedModel,
        pricing: { inputUsdPerMillion: input, outputUsdPerMillion: output },
      });
    }
  );

  it("applies 3.8 introductory pricing only to explicitly dated eligible events", () => {
    const base = {
      model: "gemini-3.8-flash",
      promptTokens: 1000,
      completionTokens: 100,
    };
    expect(
      estimateLlmCostUsd({ ...base, eventTs: "2026-10-02T00:00:00Z" })
        .totalCostUsd
    ).toBeCloseTo(0.001125, 8);
    expect(
      estimateLlmCostUsd({ ...base, eventTs: "2027-01-01T00:00:00Z" })
        .totalCostUsd
    ).toBeCloseTo(0.00225, 8);
    expect(estimateLlmCostUsd(base).totalCostUsd).toBeCloseTo(0.00225, 8);
    expect(
      estimateLlmCostUsd({ ...base, eventTs: "invalid-date" }).totalCostUsd
    ).toBeCloseTo(0.00225, 8);
    expect(
      estimateLlmCostUsd({ ...base, eventTs: "2026-08-12T23:59:59Z" })
        .totalCostUsd
    ).toBeCloseTo(0.00225, 8);
  });

  it("preserves stored cost and accounts for optional billable fields in SQL", () => {
    const sql = buildBigQueryCostExpression({
      modelColumn: "model",
      promptTokensColumn: "prompt_tokens",
      completionTokensColumn: "completion_tokens",
      storedCostColumn: "estimated_cost_usd",
      thinkingTokensColumn: "thinking_tokens",
      cachedPromptTokensColumn: "cached_prompt_tokens",
      eventTsColumn: "event_ts",
    });
    expect(sql).toMatch(/^COALESCE\(estimated_cost_usd,/);
    expect(sql).toContain("thinking_tokens");
    expect(sql).toContain("cached_prompt_tokens");
    expect(sql).toContain("2027-01-01");
    expect(sql.indexOf("'gemini-3.5-flash-lite'")).toBeLessThan(
      sql.indexOf("'gemini-3.5-flash'")
    );
  });
  it("estimates gemini-3.5-flash coach averages near $0.0068", () => {
    const estimate = estimateLlmCostUsd({
      model: "gemini-3.5-flash",
      promptTokens: 1543,
      completionTokens: 496,
    });

    expect(estimate.pricingMatched).toBe(true);
    expect(estimate.pricingVersion).toBe(LLM_PRICING_VERSION);
    expect(estimate.totalCostUsd).toBeCloseTo(0.0068, 3);
  });

  it("falls back to default pricing for unknown models", () => {
    const estimate = estimateLlmCostUsd({
      model: "unknown-model",
      promptTokens: 1000,
      completionTokens: 100,
    });

    expect(estimate.pricingMatched).toBe(false);
    expect(estimate.matchedModel).toBe("default");
    expect(estimate.totalCostUsd).toBeCloseTo(0.0024, 4);
  });

  it("builds BigQuery cost expression with stored-cost fallback", () => {
    const sql = buildBigQueryCostExpression({
      modelColumn: "model",
      promptTokensColumn: "prompt_tokens",
      completionTokensColumn: "completion_tokens",
      storedCostColumn: "estimated_cost_usd",
    });

    expect(sql).toContain("COALESCE(estimated_cost_usd");
    expect(sql).toContain("WHEN LOWER(model) = 'gemini-3.5-flash'");
  });
});
