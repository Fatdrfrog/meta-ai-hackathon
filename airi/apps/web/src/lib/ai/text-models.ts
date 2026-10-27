/**
 * Provider-neutral text model tiers. Platform text generation runs on Claude
 * when ANTHROPIC_API_KEY is configured; Vertex Gemini stays the outage fallback
 * and the customer-billed (BYO Google key) path.
 *
 * Tiers:
 * - light: classification, JSON extraction, short translations, HyDE, query cleanup.
 * - heavy: customer-facing replies, rerank, verifier, coach, summaries, drafts,
 *   KB article translation, Meta Ads planning, prompt optimization.
 * - reasoning: scenario generator planning and graph creation.
 */

import { canUseAnthropicAI } from "./anthropic-config";
import {
  getVertexGeminiHeavyModel,
  getVertexGeminiLightModel,
  getVertexGeminiStructuredJsonGenerationConfig,
} from "./vertex-gemini-rest";

export type TextModelProvider = "anthropic" | "vertex" | "google";

const DEFAULT_ANTHROPIC_LIGHT_MODEL = "claude-haiku-4-5";
const DEFAULT_ANTHROPIC_HEAVY_MODEL = "claude-sonnet-5-5";
const DEFAULT_ANTHROPIC_REASONING_MODEL = "claude-opus-5-5";

/** Env: ANTHROPIC_LIGHT_MODEL (default claude-haiku-4-5). */
export function getAnthropicLightModel(): string {
  return (
    process.env.ANTHROPIC_LIGHT_MODEL?.trim() || DEFAULT_ANTHROPIC_LIGHT_MODEL
  );
}

/** Env: ANTHROPIC_HEAVY_MODEL (default claude-sonnet-5-5). */
export function getAnthropicHeavyModel(): string {
  return (
    process.env.ANTHROPIC_HEAVY_MODEL?.trim() || DEFAULT_ANTHROPIC_HEAVY_MODEL
  );
}

/** Env: ANTHROPIC_REASONING_MODEL (default claude-opus-5-5). */
export function getAnthropicReasoningModel(): string {
  return (
    process.env.ANTHROPIC_REASONING_MODEL?.trim() ||
    DEFAULT_ANTHROPIC_REASONING_MODEL
  );
}

export function isClaudeModel(model: string): boolean {
  return /^claude-/i.test(String(model || "").trim());
}

export function getLightTextModel(): string {
  return canUseAnthropicAI()
    ? getAnthropicLightModel()
    : getVertexGeminiLightModel();
}

export function getHeavyTextModel(): string {
  return canUseAnthropicAI()
    ? getAnthropicHeavyModel()
    : getVertexGeminiHeavyModel();
}

export function getReasoningTextModel(): string {
  return canUseAnthropicAI()
    ? getAnthropicReasoningModel()
    : getVertexGeminiHeavyModel();
}

/**
 * Merge into generation config for structured JSON calls. Claude ids get a
 * low thinking level, which the Anthropic adapter maps to `effort: "low"`.
 */
export function getStructuredJsonGenerationConfig(
  model: string
): Record<string, unknown> {
  if (isClaudeModel(model)) {
    return { thinkingConfig: { thinkingLevel: "LOW" } };
  }
  return getVertexGeminiStructuredJsonGenerationConfig(model);
}

export function getLightStructuredJsonGenerationConfig(): Record<
  string,
  unknown
> {
  return getStructuredJsonGenerationConfig(getLightTextModel());
}

function isLightGeminiModel(model: string): boolean {
  if (/-lite(?:$|[-@])/i.test(model)) return true;
  const light = getVertexGeminiLightModel();
  // When light and heavy share one id (the default), the tier is ambiguous;
  // keep quality by treating it as heavy.
  return model === light && light !== getVertexGeminiHeavyModel();
}

function isLightClaudeModel(model: string): boolean {
  return model === getAnthropicLightModel() || /^claude-haiku-/i.test(model);
}

/**
 * Maps a model chosen at module load onto the provider that actually runs, so
 * a Claude id still works on the Gemini fallback and vice versa.
 */
export function resolveTextModelForProvider(
  model: string,
  provider: TextModelProvider
): string {
  const normalized = String(model || "").trim();
  if (provider === "anthropic") {
    if (!normalized) return getAnthropicHeavyModel();
    if (isClaudeModel(normalized)) return normalized;
    return isLightGeminiModel(normalized)
      ? getAnthropicLightModel()
      : getAnthropicHeavyModel();
  }

  if (!normalized) return getVertexGeminiHeavyModel();
  if (!isClaudeModel(normalized)) return normalized;
  return isLightClaudeModel(normalized)
    ? getVertexGeminiLightModel()
    : getVertexGeminiHeavyModel();
}
