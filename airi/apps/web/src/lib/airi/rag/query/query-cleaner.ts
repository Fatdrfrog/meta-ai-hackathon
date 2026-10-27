import "server-only";

import {
  chatCompletionWithFallback,
  getLightStructuredJsonGenerationConfig,
  getLightTextModel,
} from "@/lib/ai";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";
import { shouldApplyHyDE } from "@/lib/airi/rag/pipeline/hyde";
import { ragLogger } from "@/lib/airi/shared/logger";
import { buildCacheKey, cache } from "@/lib/cache";
import crypto from "crypto";
import { normalizeWhitespace } from "@icecore/shared/lib/value-utils";

// Bump when prompt / schema shape changes so old cached entries don't satisfy
// the unified flag (they lack `hypotheticalAnswer`).
const RAG_PREP_CACHE_PREFIX = "ai:rag-query-prep:v2";
const CACHE_TTL_SEC = 300;

export type RagQueryPreparation = {
  cleanedQuery: string;
  /** Distinct sub-questions when the user asked multiple things; empty if single intent */
  subQueries: string[];
  /**
   * Optional HyDE hypothetical answer produced inline by the unified prep call
   * (Phase 3.3). Non-empty string → retrieval can skip the standalone HyDE LLM.
   * Undefined when `unifiedQueryPrep` is off or the query was not HyDE-eligible.
   */
  hypotheticalAnswer?: string;
  originalQuery: string;
  wasCleaned: boolean;
  source: "llm" | "fallback";
};

export type RagQueryPreparationFields = {
  cleanedQuery?: string;
  subQueries?: string[];
  hypotheticalAnswer?: string;
};

/** LLM prep explicitly marked the turn as non-searchable (greeting-only, etc.); do not fall back to raw text for RAG. */
export function isRagPrepExplicitlyNonSearchable(
  prep: RagQueryPreparation
): boolean {
  return (
    prep.source === "llm" &&
    prep.cleanedQuery.trim().length === 0 &&
    prep.subQueries.length === 0
  );
}

const RAG_PREP_SYSTEM = `You normalize a customer message into retrieval-friendly text for embedding / search (RAG).

Rules:
- Output JSON only with keys: cleanedQuery (string), subQueries (string array).
- Preserve the customer's language. Do not translate.
- cleanedQuery = main search text: drop salutations and filler that do not carry factual intent; keep question words and named entities.
- subQueries: if there are clearly separate questions/clauses (e.g. two different asks), list each as its own string (max 4). Otherwise use [].
- If the message is only a greeting or empty of searchable content, set cleanedQuery to "" and subQueries to [].
- Never invent facts or answer the question; only strip noise and split.`;

// Unified cleaner + HyDE prompt (Phase 3.3). One LLM round-trip returns both
// retrieval-normalized text and a short hypothetical answer used to enrich the
// query embedding. Kept under this module so both paths share caching + tracing.
const RAG_UNIFIED_PREP_SYSTEM = `You prepare a customer message for retrieval-augmented search (RAG).

Output JSON only with these keys:
- cleanedQuery (string): main search text; drop salutations and filler; keep question words and named entities.
- subQueries (string array, max 4): distinct sub-questions when the user asked multiple things; otherwise [].
- hypotheticalAnswer (string): a 2-3 sentence hypothetical answer that sounds like it comes from a product knowledge base. Write it in the SAME LANGUAGE as the customer's message. Be direct and factual — do not hedge with phrases like "I think" or "it seems". Leave as "" only if the message is a pure greeting or has no searchable intent.

Rules:
- Preserve the customer's language. Do not translate.
- Never invent brand-specific facts. The hypothetical answer may use generic plausible phrasing ("The platform typically allows…", "Users can usually…") — its job is to enrich the embedding, not to be shown to a user.
- If cleanedQuery is "", hypotheticalAnswer must also be "".`;

/** Shared whitespace normalization for RAG query text (planner, LLM prep fallback). */
export const normalizeRagQueryWhitespace = normalizeWhitespace;

function buildPrepCacheKey(
  prefix: string,
  query: string,
  language: string
): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${language}\0${query.trim()}`)
    .digest("hex")
    .slice(0, 32);
  return buildCacheKey(prefix, [hash]);
}

type ParsedRagPrepFields = {
  /** Present only when the model returned a string `cleanedQuery` (including ""). Omit when key missing / wrong type → finalize uses whitespace fallback. */
  cleanedQuery?: string;
  subQueries: string[];
  /** Phase 3.3 unified prep: hypothetical answer for HyDE short-circuit. */
  hypotheticalAnswer?: string;
};

function parseRagPrepJson(raw: string): ParsedRagPrepFields | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  let parsed: {
    cleanedQuery?: unknown;
    subQueries?: unknown;
    hypotheticalAnswer?: unknown;
  };
  try {
    parsed = JSON.parse(trimmed) as {
      cleanedQuery?: unknown;
      subQueries?: unknown;
      hypotheticalAnswer?: unknown;
    };
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]) as {
        cleanedQuery?: unknown;
        subQueries?: unknown;
        hypotheticalAnswer?: unknown;
      };
    } catch {
      return null;
    }
  }
  const subRaw = parsed.subQueries;
  const subQueries = Array.isArray(subRaw)
    ? subRaw
        .map(s => String(s || "").trim())
        .filter(s => s.length >= 2)
        .slice(0, 4)
    : [];
  const out: ParsedRagPrepFields = { subQueries };
  if (typeof parsed.cleanedQuery === "string") {
    out.cleanedQuery = parsed.cleanedQuery.trim();
  }
  if (typeof parsed.hypotheticalAnswer === "string") {
    const hypo = parsed.hypotheticalAnswer.trim();
    if (hypo.length > 0) out.hypotheticalAnswer = hypo;
  }
  return out;
}

/**
 * Fast, non-LLM normalization for secondary KB variants and other paths that must
 * not call {@link prepareQueryForRagWithLlm}.
 */
export function buildHeuristicRagQueryPreparation(
  query: string
): RagQueryPreparation {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      cleanedQuery: "",
      subQueries: [],
      originalQuery: query,
      wasCleaned: false,
      source: "fallback",
    };
  }
  return finalizeRagPreparation(trimmed, null, "fallback");
}

function finalizeRagPreparation(
  original: string,
  parsed: ParsedRagPrepFields | null,
  source: "llm" | "fallback"
): RagQueryPreparation {
  const trimmedOriginal = original.trim();
  const fb = normalizeRagQueryWhitespace(original);
  if (!parsed) {
    return {
      cleanedQuery: fb,
      subQueries: [],
      originalQuery: original,
      wasCleaned: fb !== trimmedOriginal,
      source: "fallback",
    };
  }
  const cleanedQuery =
    parsed.cleanedQuery !== undefined ? parsed.cleanedQuery : fb;
  const subQueries = parsed.subQueries.filter(
    q => q.length >= 2 && q.toLowerCase() !== cleanedQuery.toLowerCase()
  );
  const hypotheticalAnswer =
    parsed.hypotheticalAnswer && parsed.hypotheticalAnswer.length > 0
      ? parsed.hypotheticalAnswer
      : undefined;
  return {
    cleanedQuery,
    subQueries,
    hypotheticalAnswer,
    originalQuery: original,
    wasCleaned: cleanedQuery !== trimmedOriginal || subQueries.length > 0,
    source,
  };
}

/** Shared finalization for any caller that already has parsed prep fields. */
export function buildRagQueryPreparationFromFields(
  query: string,
  fields: RagQueryPreparationFields | null | undefined,
  source: "llm" | "fallback"
): RagQueryPreparation {
  if (!fields) {
    return finalizeRagPreparation(query, null, "fallback");
  }

  const parsed: ParsedRagPrepFields = {
    subQueries: Array.isArray(fields.subQueries)
      ? fields.subQueries
          .map(item => String(item || "").trim())
          .filter(item => item.length >= 2)
          .slice(0, 4)
      : [],
  };

  if (typeof fields.cleanedQuery === "string") {
    parsed.cleanedQuery = fields.cleanedQuery.trim();
  }

  if (typeof fields.hypotheticalAnswer === "string") {
    const hypo = fields.hypotheticalAnswer.trim();
    if (hypo.length > 0) parsed.hypotheticalAnswer = hypo;
  }

  return finalizeRagPreparation(query, parsed, source);
}

export type PrepareQueryForRagWithLlmOptions = {
  language?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  /** Skip cache read; still only persists successful LLM prep (not fallbacks). */
  bypassCache?: boolean;
};

/**
 * LLM pass to strip salutations/filler and optionally split compound asks before RAG.
 * Cached per (query, language) for successful model output only. Transient failures and
 * unparseable responses are not cached so the next call can retry the LLM.
 */
async function prepareQueryForRagWithLlmImpl(
  query: string,
  options?: PrepareQueryForRagWithLlmOptions
): Promise<RagQueryPreparation> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      cleanedQuery: "",
      subQueries: [],
      originalQuery: query,
      wasCleaned: false,
      source: "fallback",
    };
  }

  const language = (options?.language || "en").trim().toLowerCase();
  const cacheKey = buildPrepCacheKey(RAG_PREP_CACHE_PREFIX, trimmed, language);
  if (!options?.bypassCache) {
    const cached = await cache.get<RagQueryPreparation>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Phase 3.3: unified prompt emits cleanedQuery + subQueries + hypotheticalAnswer
  // in one round-trip, but only when HyDE would be eligible anyway. For very
  // long queries or greetings, drop back to the cleaner-only prompt so we don't
  // waste tokens on a hypothetical answer that would be discarded downstream.
  const useUnified = shouldApplyHyDE(trimmed);
  const systemPrompt = useUnified ? RAG_UNIFIED_PREP_SYSTEM : RAG_PREP_SYSTEM;

  try {
    const response = await chatCompletionWithFallback({
      model: getLightTextModel(),
      analytics: options?.workspaceId
        ? {
            workspaceId: options.workspaceId,
            conversationId: options.conversationId || null,
            operation: "airi.rag.query_cleaner",
            sourceService: "web.airi.rag",
          }
        : undefined,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Language hint (BCP-47 style): ${language}\n\nMessage:\n${trimmed}`,
        },
      ],
      responseFormat: { type: "json_object" },
      // Slight temperature lift when generating the hypothetical keeps answers
      // non-degenerate; keep it at 0 for the cleaner-only path to preserve
      // deterministic sub-query splitting.
      temperature: useUnified ? 0.3 : 0,
      generationConfig: getLightStructuredJsonGenerationConfig(),
      resilience: {
        maxRetries: 0,
        timeoutMs: 8_000,
      },
    });
    const parsed = parseRagPrepJson(response.content || "");
    const result = finalizeRagPreparation(query, parsed, "llm");
    if (result.source === "llm") {
      void Promise.resolve(cache.set(cacheKey, result, CACHE_TTL_SEC)).catch(
        cacheError => {
          ragLogger.retrieval.warn("RAG query prep cache write failed", {
            preview: trimmed.slice(0, 80),
            error:
              cacheError instanceof Error
                ? cacheError.message
                : String(cacheError),
          });
        }
      );
    }
    return result;
  } catch (error) {
    ragLogger.retrieval.warn("RAG query prep LLM failed, using fallback", {
      preview: trimmed.slice(0, 80),
      error: error instanceof Error ? error.message : String(error),
    });
    return finalizeRagPreparation(query, null, "fallback");
  }
}

export const prepareQueryForRagWithLlm = traceableChain(
  prepareQueryForRagWithLlmImpl,
  {
    name: "airi.rag.prepare_query",
    tags: ["airi", "rag", "query-prep"],
    processInputs: inputs => {
      const payload = "args" in inputs ? inputs.args : [inputs];
      const [query, options] = payload as [
        string,
        PrepareQueryForRagWithLlmOptions | undefined,
      ];
      return {
        query_preview: previewText(query),
        query_length: String(query || "").length,
        language: options?.language || "en",
        bypass_cache: Boolean(options?.bypassCache),
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as RagQueryPreparation;
      return {
        cleaned_query_preview: previewText(result.cleanedQuery),
        sub_queries: previewStringArray(result.subQueries),
        sub_query_count: result.subQueries.length,
        was_cleaned: result.wasCleaned,
        source: result.source,
        unified_hypothetical_included: Boolean(result.hypotheticalAnswer),
      };
    },
  }
);
