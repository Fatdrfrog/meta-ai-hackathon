/** Heuristic query typing for adaptive KB/snippet similarity thresholds (no LLM). */

import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type {
  RetrievalIntentClassification,
  RetrievalIntentConfidence,
} from "@/lib/airi/rag/query/retrieval-intent-classifier";

export type QueryType = "factual" | "exploratory" | "procedural" | "unknown";

export interface QueryTypeResult {
  type: QueryType;
  threshold: number;
  confidence: number;
  reason: string;
}

export const THRESHOLDS_BY_TYPE: Record<QueryType, number> = {
  factual: RAG_CONFIG.queryTypes.factual,
  exploratory: RAG_CONFIG.queryTypes.exploratory,
  procedural: RAG_CONFIG.queryTypes.procedural,
  unknown: RAG_CONFIG.queryTypes.unknown,
};

const FACTUAL_PATTERNS = [
  /(?:how much|what(?:'s| is) the (?:price|cost))/i,
  /(?:сколько стоит|какая цена)/i,
  /(?:қанша тұрады|бағасы қанша)/i,
  /(?:is there|do you have|in stock)/i,
  /(?:есть ли|есть в наличии)/i,
  /(?:бар ма|барма)/i,
  /(?:what(?:'s| is) (?:the|your))/i,
  /(?:when (?:do|does|is|are|will))/i,
  /(?:where (?:is|are|can))/i,
  /(?:who (?:is|can|should))/i,
  /(?:что такое|каков|какой)/i,
  /(?:когда|где|кто)/i,
];

const EXPLORATORY_PATTERNS = [
  /(?:tell me about|can you explain|what do you think)/i,
  /(?:information about|more about|details)/i,
  /(?:расскажи|расскажите|объясни)/i,
  /(?:any (?:tips|advice|recommendations))/i,
  /(?:could you|would you|might you)/i,
  /(?:можешь ли|могли бы|посоветуй)/i,
  /(?:difference between|compare|which is better)/i,
  /(?:разница между|сравни|что лучше)/i,
];

const PROCEDURAL_PATTERNS = [
  /(?:how (?:do|can|to|should) I)/i,
  /(?:steps to|process for|way to)/i,
  /(?:как мне|как (?:можно|сделать))/i,
  /(?:қалай|қалайша)/i,
  /(?:need to|want to|trying to)/i,
  /(?:хочу|нужно|пытаюсь)/i,
  /(?:help me|guide me|show me)/i,
  /(?:помоги|покажи)/i,
];

function confidenceScore(confidence: RetrievalIntentConfidence): number {
  switch (confidence) {
    case "high":
      return 0.9;
    case "medium":
      return 0.65;
    case "low":
      return 0.35;
  }
}

export function classifyQueryType(
  query: string,
  options?: {
    retrievalIntent?: RetrievalIntentClassification;
  }
): QueryTypeResult {
  const trimmed = query.trim().toLowerCase();

  if (options?.retrievalIntent?.shouldUseBroadRetrieval) {
    return {
      type: "exploratory",
      threshold: THRESHOLDS_BY_TYPE.exploratory,
      confidence: confidenceScore(options.retrievalIntent.confidence),
      reason: options.retrievalIntent.reason,
    };
  }

  for (const pattern of FACTUAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        type: "factual",
        threshold: THRESHOLDS_BY_TYPE.factual,
        confidence: 0.8,
        reason: "Matched factual question pattern",
      };
    }
  }

  for (const pattern of PROCEDURAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        type: "procedural",
        threshold: THRESHOLDS_BY_TYPE.procedural,
        confidence: 0.8,
        reason: "Matched procedural question pattern",
      };
    }
  }

  for (const pattern of EXPLORATORY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        type: "exploratory",
        threshold: THRESHOLDS_BY_TYPE.exploratory,
        confidence: 0.8,
        reason: "Matched exploratory question pattern",
      };
    }
  }

  if (trimmed.endsWith("?")) {
    return {
      type: "factual",
      threshold: THRESHOLDS_BY_TYPE.factual,
      confidence: 0.5,
      reason: "Question mark detected, defaulting to factual",
    };
  }

  if (trimmed.length < 30) {
    return {
      type: "factual",
      threshold: THRESHOLDS_BY_TYPE.factual,
      confidence: 0.4,
      reason: "Short query, defaulting to factual",
    };
  }

  if (trimmed.length > 100) {
    return {
      type: "exploratory",
      threshold: THRESHOLDS_BY_TYPE.exploratory,
      confidence: 0.4,
      reason: "Long query, defaulting to exploratory",
    };
  }

  return {
    type: "unknown",
    threshold: THRESHOLDS_BY_TYPE.unknown,
    confidence: 0.3,
    reason: "No pattern matched, using default threshold",
  };
}
