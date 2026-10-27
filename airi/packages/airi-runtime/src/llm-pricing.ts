export const LLM_PRICING_VERSION = "2026-10-meta-muse-spark";

export type LlmModelPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  /** Prompt-cache write rate; base input rate when unset (e.g. Gemini). */
  cacheWriteInputUsdPerMillion?: number;
};

export type LlmCostEstimate = {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  pricingVersion: string;
  pricingMatched: boolean;
  matchedModel: string;
};

const DEFAULT_PRICING: LlmModelPricing = {
  inputUsdPerMillion: 1.5,
  outputUsdPerMillion: 9,
};

// Global standard online inference estimates, verified 2026-10-02. Excludes
// regional premiums, batch rates and customer contracts.
// https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
const MODEL_PRICING_USD_PER_MILLION: Record<string, LlmModelPricing> = {
  // Gemini Embedding online input pricing, verified 2026-10-10.
  "gemini-embedding-001": { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0 },
  "gemini-3.5-flash": {
    inputUsdPerMillion: 1.5,
    outputUsdPerMillion: 9,
    cachedInputUsdPerMillion: 0.15,
  },
  "gemini-3.5-flash-lite": {
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.03,
  },
  "gemini-3.8-flash": {
    inputUsdPerMillion: 1.5,
    outputUsdPerMillion: 7.5,
    cachedInputUsdPerMillion: 0.15,
  },
  "gemini-3-flash-preview": {
    inputUsdPerMillion: 0.5,
    outputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.05,
  },
  "gemini-2.5-flash": {
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.03,
  },
  "gemini-2.5-flash-lite": {
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.4,
    cachedInputUsdPerMillion: 0.01,
  },
  "gemini-2.0-flash": { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  // Claude API list prices, verified 2026-10-07. Prompt tokens include cache
  // reads and writes; writes use the 5-minute TTL rate (1.25x base input).
  "claude-haiku-4-5": {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteInputUsdPerMillion: 1.25,
  },
  "claude-sonnet-5-5": {
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 0.2,
    cacheWriteInputUsdPerMillion: 2.5,
  },
  "claude-opus-5-5": {
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
    cachedInputUsdPerMillion: 0.2,
    cacheWriteInputUsdPerMillion: 5,
  },
  // Models that serve a server-side refusal fallback (`fallbacks: "default"`)
  // for Sonnet 5.5 and Opus 5.5; the event records the serving model. The
  // longest-key-first match keeps the 5.5 ids on their own rows.
  "claude-sonnet-5": {
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 0.2,
    cacheWriteInputUsdPerMillion: 2.5,
  },
  "claude-opus-5": {
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 25,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteInputUsdPerMillion: 6.25,
  },
  "claude-opus-4-8": {
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 25,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteInputUsdPerMillion: 6.25,
  },
  "gpt-4o-mini": { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  // Meta Model API list price, verified 2026-10-27 (dev.meta.ai).
  "muse-spark-1.3": {
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 4.25,
    cachedInputUsdPerMillion: 0.15,
  },
};

// Conservative estimate boundary: August 13 is documented for Provisioned
// Throughput promotional credits. The on-demand table specifies only the end
// date; its start date and this account's credit eligibility remain unverified.
// These effective estimates are distinct from invoiced spend and issued credits.
const FLASH_38_INTRO_START = "2026-08-13T00:00:00Z";
const FLASH_38_INTRO_END = "2027-01-01T00:00:00Z";
const FLASH_38_INTRO_PRICING: LlmModelPricing = {
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  cachedInputUsdPerMillion: 0.075,
};

function isFlash38IntroEvent(eventTs?: string | Date | null): boolean {
  if (!eventTs) return false;
  const timestamp = new Date(eventTs).getTime();
  return (
    timestamp >= Date.parse(FLASH_38_INTRO_START) &&
    timestamp < Date.parse(FLASH_38_INTRO_END)
  );
}

export function listLlmModelPricingEntries(): Array<
  LlmModelPricing & { model: string }
> {
  // Lite/version-qualified IDs must match before the parent Flash identifier.
  return Object.entries(MODEL_PRICING_USD_PER_MILLION)
    .sort(([left], [right]) => right.length - left.length)
    .map(([model, pricing]) => ({ model, ...pricing }));
}

export function resolveLlmModelPricing(
  model: string,
  eventTs?: string | Date | null,
): {
  pricing: LlmModelPricing;
  matchedModel: string;
  pricingMatched: boolean;
} {
  const normalized = String(model || "")
    .trim()
    .toLowerCase();
  const match = listLlmModelPricingEntries().find((entry) =>
    normalized.includes(entry.model),
  );
  if (!match)
    return {
      pricing: DEFAULT_PRICING,
      matchedModel: "default",
      pricingMatched: false,
    };
  const { model: matchedModel, ...standardPricing } = match;
  return {
    pricing:
      matchedModel === "gemini-3.8-flash" && isFlash38IntroEvent(eventTs)
        ? FLASH_38_INTRO_PRICING
        : standardPricing,
    matchedModel,
    pricingMatched: true,
  };
}

function toNonNegativeInt(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function estimateLlmCostUsd(params: {
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  thinkingTokens?: number | null;
  cachedPromptTokens?: number | null;
  /** Prompt tokens written to the prompt cache (already in promptTokens). */
  cacheWritePromptTokens?: number | null;
  eventTs?: string | Date | null;
}): LlmCostEstimate {
  const promptTokens = toNonNegativeInt(params.promptTokens);
  const cachedTokens = Math.min(
    promptTokens,
    toNonNegativeInt(params.cachedPromptTokens),
  );
  const cacheWriteTokens = Math.min(
    promptTokens - cachedTokens,
    toNonNegativeInt(params.cacheWritePromptTokens),
  );
  const outputTokens =
    toNonNegativeInt(params.completionTokens) +
    toNonNegativeInt(params.thinkingTokens);
  const { pricing, matchedModel, pricingMatched } = resolveLlmModelPricing(
    params.model,
    params.eventTs,
  );
  const inputCostUsd =
    ((promptTokens - cachedTokens - cacheWriteTokens) *
      pricing.inputUsdPerMillion +
      cachedTokens *
        (pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion) +
      cacheWriteTokens *
        (pricing.cacheWriteInputUsdPerMillion ?? pricing.inputUsdPerMillion)) /
    1_000_000;
  const outputCostUsd =
    (outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    pricingVersion:
      matchedModel === "gemini-3.8-flash" && isFlash38IntroEvent(params.eventTs)
        ? `${LLM_PRICING_VERSION}:flash-3.8-intro-2026`
        : LLM_PRICING_VERSION,
    pricingMatched,
    matchedModel,
  };
}

type BigQueryPricingParams = {
  modelColumn: string;
  eventTsColumn?: string;
  storedCostColumn?: string | null;
};
type BigQueryInputParams = BigQueryPricingParams & {
  promptTokensColumn: string;
  cachedPromptTokensColumn?: string;
};
type BigQueryOutputParams = BigQueryPricingParams & {
  completionTokensColumn: string;
  thinkingTokensColumn?: string;
};

function tokenColumn(column?: string): string {
  return column ? `GREATEST(IFNULL(${column}, 0), 0)` : "0";
}

function sqlRate(
  model: string,
  pricing: LlmModelPricing,
  key: keyof LlmModelPricing,
  eventTsColumn?: string,
): string {
  const standardRate = pricing[key] ?? pricing.inputUsdPerMillion;
  if (model !== "gemini-3.8-flash" || !eventTsColumn)
    return String(standardRate);
  // Introductory effective rate assumes Google's documented 50% promo credit.
  // Missing dates use standard pricing; persisted event costs are never repriced.
  return `IF(${eventTsColumn} >= TIMESTAMP('${FLASH_38_INTRO_START}') AND ${eventTsColumn} < TIMESTAMP('${FLASH_38_INTRO_END}'), ${FLASH_38_INTRO_PRICING[key]}, ${standardRate})`;
}

function buildPricingCase(
  params: BigQueryPricingParams,
  expression: (model: string, pricing: LlmModelPricing) => string,
): string {
  const branches = listLlmModelPricingEntries()
    .map(
      ({ model, ...pricing }) =>
        `WHEN LOWER(${params.modelColumn}) = '${model}' OR STRPOS(LOWER(${params.modelColumn}), '${model}') > 0 THEN ${expression(model, pricing)}`,
    )
    .join("\n        ");
  const repriced = `CASE
        ${branches}
        ELSE ${expression("default", DEFAULT_PRICING)}
      END`;
  return params.storedCostColumn
    ? `COALESCE(${params.storedCostColumn}, ${repriced})`
    : repriced;
}

function inputCostExpression(
  params: BigQueryInputParams,
  model: string,
  pricing: LlmModelPricing,
): string {
  const prompt = tokenColumn(params.promptTokensColumn);
  const cached = `LEAST(${prompt}, ${tokenColumn(params.cachedPromptTokensColumn)})`;
  return `((${prompt} - ${cached}) * ${sqlRate(model, pricing, "inputUsdPerMillion", params.eventTsColumn)} + ${cached} * ${sqlRate(model, pricing, "cachedInputUsdPerMillion", params.eventTsColumn)}) / 1000000`;
}

function outputCostExpression(
  params: BigQueryOutputParams,
  model: string,
  pricing: LlmModelPricing,
): string {
  return `((${tokenColumn(params.completionTokensColumn)} + ${tokenColumn(params.thinkingTokensColumn)}) * ${sqlRate(model, pricing, "outputUsdPerMillion", params.eventTsColumn)}) / 1000000`;
}

export function buildBigQueryCostExpression(
  params: BigQueryInputParams & BigQueryOutputParams,
): string {
  return buildPricingCase(
    params,
    (model, pricing) =>
      `(${inputCostExpression(params, model, pricing)} + ${outputCostExpression(params, model, pricing)})`,
  );
}

export function buildBigQueryInputCostExpression(
  params: BigQueryInputParams,
): string {
  return buildPricingCase(params, (model, pricing) =>
    inputCostExpression(params, model, pricing),
  );
}

export function buildBigQueryOutputCostExpression(
  params: BigQueryOutputParams,
): string {
  return buildPricingCase(params, (model, pricing) =>
    outputCostExpression(params, model, pricing),
  );
}
