import "server-only";

import {
  chatCompletionWithFallback,
  getDefaultAIChatProviderOrder,
  getLightStructuredJsonGenerationConfig,
  getLightTextModel,
} from "@/lib/ai";

export type RetrievalIntentLabel =
  | "service_overview"
  | "specific_factual"
  | "procedural"
  | "pricing"
  | "comparison"
  | "other"
  | "unclear";

export type RetrievalIntentConfidence = "low" | "medium" | "high";

const RETRIEVAL_INTENT_LABELS = [
  "service_overview",
  "specific_factual",
  "procedural",
  "pricing",
  "comparison",
  "other",
  "unclear",
] as const satisfies readonly RetrievalIntentLabel[];
const RETRIEVAL_INTENT_CONFIDENCES = [
  "low",
  "medium",
  "high",
] as const satisfies readonly RetrievalIntentConfidence[];
const RETRIEVAL_INTENT_LABEL_SET = new Set<string>(RETRIEVAL_INTENT_LABELS);
const RETRIEVAL_INTENT_CONFIDENCE_SET = new Set<string>(
  RETRIEVAL_INTENT_CONFIDENCES
);

export type RetrievalIntentSource =
  | "turn_understanding"
  | "llm_classifier"
  | "classifier_unavailable";

export type RetrievalIntentClassification = {
  query: string;
  language: string;
  label: RetrievalIntentLabel;
  confidence: RetrievalIntentConfidence;
  shouldUseBroadRetrieval: boolean;
  shouldUseOverviewVariants: boolean;
  queryVariants: string[];
  reason: string;
  source: RetrievalIntentSource;
};

const RETRIEVAL_INTENT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["label", "confidence", "language", "queryVariants", "reason"],
  properties: {
    label: {
      type: "STRING",
      format: "enum",
      enum: [...RETRIEVAL_INTENT_LABELS],
    },
    confidence: {
      type: "STRING",
      format: "enum",
      enum: [...RETRIEVAL_INTENT_CONFIDENCES],
    },
    language: { type: "STRING" },
    queryVariants: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
    reason: { type: "STRING" },
  },
  propertyOrdering: [
    "label",
    "confidence",
    "language",
    "queryVariants",
    "reason",
  ],
};

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/u);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function normalizeLabel(value: unknown): RetrievalIntentLabel {
  return typeof value === "string" && RETRIEVAL_INTENT_LABEL_SET.has(value)
    ? (value as RetrievalIntentLabel)
    : "unclear";
}

function normalizeConfidence(value: unknown): RetrievalIntentConfidence {
  return typeof value === "string" && RETRIEVAL_INTENT_CONFIDENCE_SET.has(value)
    ? (value as RetrievalIntentConfidence)
    : "low";
}

function normalizeLanguage(value: unknown, fallback?: string | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw.slice(0, 16);
  const hinted = typeof fallback === "string" ? fallback.trim() : "";
  return hinted ? hinted.slice(0, 16) : "unknown";
}

function normalizeReason(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return (raw || fallback).slice(0, 500);
}

function normalizeComparableQueryText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeQueryVariants(
  value: unknown,
  originalQuery: string
): string[] {
  if (!Array.isArray(value)) return [];

  const originalComparable = normalizeComparableQueryText(originalQuery);
  const seen = new Set<string>();
  const variants: string[] = [];

  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const variant = raw.trim();
    const comparable = normalizeComparableQueryText(variant);
    if (!variant || !comparable) continue;
    if (comparable === originalComparable || seen.has(comparable)) continue;
    seen.add(comparable);
    variants.push(variant.slice(0, 180));
    if (variants.length >= 4) break;
  }

  return variants;
}

function buildRetrievalIntent(params: {
  query: string;
  language?: string | null;
  label: RetrievalIntentLabel;
  confidence: RetrievalIntentConfidence;
  queryVariants?: string[];
  reason: string;
  source: RetrievalIntentSource;
}): RetrievalIntentClassification {
  const isHighServiceOverview =
    params.label === "service_overview" && params.confidence === "high";
  const isMediumOrHighServiceOverview =
    params.label === "service_overview" && params.confidence !== "low";

  return {
    query: params.query,
    language: normalizeLanguage(params.language, null),
    label: params.label,
    confidence: params.confidence,
    shouldUseBroadRetrieval: isHighServiceOverview,
    shouldUseOverviewVariants: isMediumOrHighServiceOverview,
    queryVariants: isMediumOrHighServiceOverview
      ? normalizeQueryVariants(params.queryVariants || [], params.query)
      : [],
    reason: params.reason,
    source: params.source,
  };
}

export function createModelRetrievalIntent(params: {
  query: string;
  language?: unknown;
  label?: unknown;
  confidence?: unknown;
  queryVariants?: unknown;
  reason?: unknown;
  source: Extract<
    RetrievalIntentSource,
    "turn_understanding" | "llm_classifier"
  >;
}): RetrievalIntentClassification | null {
  const rawLabel = String(params.label || "") as RetrievalIntentLabel;
  const rawConfidence = String(
    params.confidence || ""
  ) as RetrievalIntentConfidence;
  if (
    !RETRIEVAL_INTENT_LABEL_SET.has(rawLabel) ||
    !RETRIEVAL_INTENT_CONFIDENCE_SET.has(rawConfidence)
  ) {
    return null;
  }

  return buildRetrievalIntent({
    query: String(params.query || "").trim(),
    language: normalizeLanguage(params.language, null),
    label: rawLabel,
    confidence: rawConfidence,
    queryVariants: normalizeQueryVariants(
      params.queryVariants,
      String(params.query || "")
    ),
    reason: normalizeReason(
      params.reason,
      "Model retrieval intent classification."
    ),
    source: params.source,
  });
}

export function createNeutralRetrievalIntent(params: {
  query: string;
  language?: string | null;
  source?: RetrievalIntentSource;
  reason?: string;
}): RetrievalIntentClassification {
  return buildRetrievalIntent({
    query: String(params.query || "").trim(),
    language: params.language,
    label: "unclear",
    confidence: "low",
    queryVariants: [],
    reason: params.reason || "No reliable retrieval intent signal.",
    source: params.source || "classifier_unavailable",
  });
}

export async function classifyRetrievalIntent(params: {
  query: string;
  language?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
}): Promise<RetrievalIntentClassification> {
  const query = String(params.query || "").trim();
  if (!query) {
    return createNeutralRetrievalIntent({
      query,
      language: params.language,
      source: "classifier_unavailable",
      reason: "Empty query.",
    });
  }

  const systemPrompt = [
    "You classify a customer message for retrieval routing in a support RAG system.",
    "Use semantic intent, not keyword matching. Handle typos, slang, transliteration, and mixed language.",
    "Choose service_overview only when the customer is broadly asking what services, products, programs, plans, or help are available.",
    "Do not choose service_overview for one specific price, location, document, eligibility, or how-to question.",
    "If the message is underspecified or could be a continuation, mark confidence low or medium instead of guessing.",
    "For service_overview, provide short query variants that would retrieve broad KB context. Otherwise return an empty queryVariants array.",
    "Return JSON only.",
  ].join("\n");

  const userPrompt = [
    `Language hint: ${params.language || "unknown"}`,
    `Customer message:\n${query}`,
    [
      "Return fields:",
      "- label: service_overview, specific_factual, procedural, pricing, comparison, other, or unclear.",
      "- confidence: high only when the routing decision is unambiguous.",
      "- language: detected language code or unknown.",
      "- queryVariants: 0-4 broad retrieval variants for service_overview only.",
      "- reason: concise routing reason.",
    ].join("\n"),
  ].join("\n\n");

  try {
    const response = await chatCompletionWithFallback({
      model: getLightTextModel(),
      providerOrder: getDefaultAIChatProviderOrder(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      responseFormat: { type: "json_object" },
      generationConfig: {
        ...getLightStructuredJsonGenerationConfig(),
        responseSchema: RETRIEVAL_INTENT_RESPONSE_SCHEMA,
      },
      temperature: 0,
      resilience: {
        maxRetries: 0,
        timeoutMs: 8_000,
      },
      analytics: {
        workspaceId: params.workspaceId || null,
        conversationId: params.conversationId || null,
        operation: "airi.rag.retrieval_intent_classifier",
        inputText: `${systemPrompt}\n\n${userPrompt}`,
        sourceService: "web.airi.rag",
        metadata: {
          queryLength: query.length,
          languageHint: params.language || null,
        },
      },
    });

    const parsed = parseJsonObject(response.content || "");
    if (!parsed) {
      throw new Error("Retrieval intent classifier returned invalid JSON");
    }

    const intent = createModelRetrievalIntent({
      query,
      language: normalizeLanguage(parsed.language, params.language),
      label: normalizeLabel(parsed.label),
      confidence: normalizeConfidence(parsed.confidence),
      queryVariants: normalizeQueryVariants(parsed.queryVariants, query),
      reason: normalizeReason(
        parsed.reason,
        "LLM retrieval intent classification."
      ),
      source: "llm_classifier",
    });
    if (!intent) {
      throw new Error("Retrieval intent classifier returned invalid labels");
    }
    return intent;
  } catch {
    return createNeutralRetrievalIntent({
      query,
      language: params.language,
      source: "classifier_unavailable",
      reason: "Retrieval intent classifier unavailable.",
    });
  }
}
