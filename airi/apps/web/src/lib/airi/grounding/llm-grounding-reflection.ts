import "server-only";

import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { canUseTextAI } from "@/lib/ai/text-provider-config";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";
import { GROUNDING_REFLECTION_EXCERPT_CAP } from "./constants";

function parseJsonObjectLoose(content: string): unknown | null {
  const normalized = String(content || "").trim();
  if (!normalized) return null;

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    const embedded = normalized.match(/\{[\s\S]*\}/);
    if (embedded?.[0]) {
      try {
        return JSON.parse(embedded[0]) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export type LlmGroundingReflection = {
  citedChunkIds: string[];
  unsupportedClaims: string[];
  confidence: number;
};

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function parseReflectionPayload(
  content: string,
  allowedChunkIds: Set<string>
): LlmGroundingReflection | null {
  const raw = parseJsonObjectLoose(content);
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const citedRaw = o.citedChunkIds;
  const citedChunkIds = Array.isArray(citedRaw)
    ? citedRaw
        .map(id => String(id || "").trim())
        .filter(id => allowedChunkIds.has(id))
    : [];

  const unsupRaw = o.unsupportedClaims;
  const unsupportedClaims = Array.isArray(unsupRaw)
    ? unsupRaw.map(s => String(s || "").trim()).filter(s => s.length > 12)
    : [];

  const confRaw = o.confidence;
  const confidence =
    typeof confRaw === "number" ? clamp01(confRaw) : clamp01(Number(confRaw));

  return { citedChunkIds, unsupportedClaims, confidence };
}

/**
 * Light-model JSON reflection: which retrieved chunks support the reply and which factual
 * statements look unsupported. Complements heuristic {@link postCheckClaims} (merged upstream).
 */
async function runLlmGroundingReflectionImpl(params: {
  reply: string;
  language: string;
  sources: Array<{ chunkId: string; excerpt: string }>;
}): Promise<LlmGroundingReflection | null> {
  if (!RAG_CONFIG.features.enableLlmGroundingReflection) {
    return null;
  }
  if (!canUseTextAI()) return null;
  if (!params.reply.trim() || params.sources.length === 0) return null;

  const idList = params.sources.map(s => s.chunkId).join(", ");
  const blocks = params.sources.map(
    (s, i) =>
      `[${i + 1}] id=${s.chunkId}\n${s.excerpt.slice(0, GROUNDING_REFLECTION_EXCERPT_CAP)}`
  );

  const response = await chatCompletionWithFallback({
    model: getLightTextModel(),
    messages: [
      {
        role: "system",
        content: [
          "You audit grounding of a support assistant reply against retrieved source excerpts.",
          "Return JSON only.",
          'Schema: {"citedChunkIds":["..."],"unsupportedClaims":["..."],"confidence":0.0-1.0}',
          "citedChunkIds: only ids from the allowed list that substantively support factual claims in the reply.",
          "unsupportedClaims: short quotes or paraphrases of reply sentences that state specific facts, numbers, prices, dates, or policies NOT clearly supported by the excerpts.",
          "confidence: your estimate that the reply stays within what the excerpts support (1 = fully supported, 0 = largely hallucinated).",
          "If the reply is purely greeting/small talk with no factual claims, use citedChunkIds: [], unsupportedClaims: [], confidence: 1.",
          `Allowed chunk ids only: ${idList}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Reply language hint: ${params.language}`,
          "",
          "Assistant reply:",
          params.reply,
          "",
          "Source excerpts:",
          ...blocks,
        ].join("\n"),
      },
    ],
    responseFormat: { type: "json_object" },
    temperature: 0,
    generationConfig: { maxOutputTokens: 512 },
  });

  const allowed = new Set(params.sources.map(s => s.chunkId));
  return parseReflectionPayload(response.content || "", allowed);
}

export const runLlmGroundingReflection = traceableChain(
  runLlmGroundingReflectionImpl,
  {
    name: "airi.rag.grounding_reflection",
    tags: ["airi", "rag", "grounding-reflection"],
    processInputs: inputs => {
      const payload = ("input" in inputs ? inputs.input : inputs) as {
        reply: string;
        language: string;
        sources: Array<{ chunkId: string; excerpt: string }>;
      };
      return {
        language: payload.language,
        reply_preview: previewText(payload.reply, 320),
        source_ids: previewStringArray(
          payload.sources.map(source => source.chunkId),
          8,
          60
        ),
        source_count: payload.sources.length,
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as LlmGroundingReflection | null;
      return {
        cited_chunk_ids: result?.citedChunkIds || [],
        unsupported_claims_preview: previewStringArray(
          result?.unsupportedClaims || [],
          4,
          120
        ),
        confidence: result?.confidence ?? null,
      };
    },
  }
);
