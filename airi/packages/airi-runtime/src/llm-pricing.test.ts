import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateLlmCostUsd,
  LLM_PRICING_VERSION,
  resolveLlmModelPricing,
} from "./llm-pricing.js";

function close(actual: number, expected: number) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${expected}, received ${actual}`,
  );
}

for (const [model, input, output, cached, cacheWrite] of [
  ["claude-haiku-4-5", 1, 5, 0.1, 1.25],
  ["claude-sonnet-5-5", 2, 10, 0.2, 2.5],
  ["claude-opus-5-5", 4, 20, 0.2, 5],
  // Server-side refusal fallbacks for Sonnet 5.5 and Opus 5.5.
  ["claude-sonnet-5", 2, 10, 0.2, 2.5],
  ["claude-opus-5", 5, 25, 0.5, 6.25],
  ["claude-opus-4-8", 5, 25, 0.5, 6.25],
] as const) {
  test(`prices ${model} at Claude API list rates`, () => {
    assert.deepEqual(resolveLlmModelPricing(model), {
      pricing: {
        inputUsdPerMillion: input,
        outputUsdPerMillion: output,
        cachedInputUsdPerMillion: cached,
        cacheWriteInputUsdPerMillion: cacheWrite,
      },
      matchedModel: model,
      pricingMatched: true,
    });
  });
}

test("prices Claude usage whose prompt tokens include cache reads", () => {
  // Normalized Claude usage: prompt = input + cache reads + cache writes.
  const cost = estimateLlmCostUsd({
    model: "claude-sonnet-5-5",
    promptTokens: 1_000,
    cachedPromptTokens: 800,
    completionTokens: 100,
  });
  close(cost.inputCostUsd, (200 * 2 + 800 * 0.2) / 1_000_000);
  close(cost.outputCostUsd, (100 * 10) / 1_000_000);
  assert.equal(cost.pricingVersion, LLM_PRICING_VERSION);
  assert.equal(cost.matchedModel, "claude-sonnet-5-5");
});

test("keeps 5.5 ids on their own rows next to the shorter fallback ids", () => {
  assert.equal(
    resolveLlmModelPricing("claude-opus-5-5").matchedModel,
    "claude-opus-5-5",
  );
  assert.equal(
    resolveLlmModelPricing("claude-sonnet-5-5").matchedModel,
    "claude-sonnet-5-5",
  );
  for (const model of ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5"]) {
    assert.equal(resolveLlmModelPricing(model).pricingMatched, true, model);
  }
});

test("prices cache writes at 1.25x base input for Claude", () => {
  // 300 uncached + 3000 written + 0 read prompt tokens, 200 output tokens.
  const cost = estimateLlmCostUsd({
    model: "claude-sonnet-5-5",
    promptTokens: 3_300,
    cacheWritePromptTokens: 3_000,
    completionTokens: 200,
  });
  close(cost.inputCostUsd, (300 * 2 + 3_000 * 2.5) / 1_000_000);
  close(cost.totalCostUsd, 0.0101);
});

test("bounds cache writes by the uncached prompt tokens", () => {
  const cost = estimateLlmCostUsd({
    model: "claude-haiku-4-5",
    promptTokens: 1_000,
    cachedPromptTokens: 900,
    cacheWritePromptTokens: 5_000,
  });
  close(cost.inputCostUsd, (900 * 0.1 + 100 * 1.25) / 1_000_000);
});

test("prices Gemini cache writes at the base input rate", () => {
  const cost = estimateLlmCostUsd({
    model: "gemini-3.5-flash",
    promptTokens: 1_000,
    cacheWritePromptTokens: 1_000,
  });
  close(cost.inputCostUsd, (1_000 * 1.5) / 1_000_000);
});

test("keeps Gemini pricing rows for the Vertex fallback", () => {
  assert.equal(
    resolveLlmModelPricing("gemini-3.5-flash").matchedModel,
    "gemini-3.5-flash",
  );
  assert.equal(LLM_PRICING_VERSION, "2026-10-meta-muse-spark");
});
