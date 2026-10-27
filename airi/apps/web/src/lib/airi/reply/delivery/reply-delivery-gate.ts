import type { RAGResponseResult } from "@/lib/airi/rag/response/rag-response-service";

export type DeliveryBlockReason =
  | "bot_disabled"
  | "shadow_mode"
  | "rollout_filtered"
  | "confidence_below_threshold";

export type DeliveryGateDecision = {
  allowSend: boolean;
  reason: DeliveryBlockReason | null;
  rolloutBucket: number;
  rolloutPercentage: number;
  minConfidence: number;
  responseConfidence: number | null;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * Deterministic rollout bucket in [0, 99].
 * Same seed always maps to the same bucket.
 */
export function getDeterministicRolloutBucket(seed: string): number {
  const input = seed || "";
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0) % 100;
}

export function estimateRagResponseConfidence(
  result: Pick<
    RAGResponseResult,
    "type" | "snippet" | "retrievalSummary" | "decision" | "fallbackAction"
  >
): number {
  const snippetScore = toNumberOrNull(result.snippet?.score);
  const topKbSimilarity = toNumberOrNull(
    result.retrievalSummary?.topKBSimilarity
  );
  const groundedConfidence = toNumberOrNull(
    result.retrievalSummary?.groundedConfidence
  );

  if (
    result.fallbackAction === "intent_fallback" ||
    result.fallbackAction === "generic_clarification"
  ) {
    return 0.35;
  }

  if (result.type === "verified_snippet") {
    return clamp(snippetScore ?? 0.9, 0, 1);
  }

  if (result.type === "suggestion_with_ai") {
    if (groundedConfidence !== null) {
      return clamp(groundedConfidence, 0, 1);
    }
    const candidate = Math.max(
      snippetScore !== null ? snippetScore * 0.92 : 0,
      topKbSimilarity !== null ? topKbSimilarity * 0.88 : 0.45
    );
    return clamp(candidate, 0, 1);
  }

  if (result.type === "ai_reply") {
    if (groundedConfidence !== null) {
      return clamp(groundedConfidence, 0, 1);
    }
    const candidate = Math.max(
      topKbSimilarity !== null ? topKbSimilarity * 0.9 : 0,
      result.decision?.priority === "kb" ? 0.65 : 0.55
    );
    return clamp(candidate, 0, 1);
  }

  if (result.type === "fallback") {
    return 0.35;
  }

  if (
    result.type === "evidence_retrieve" ||
    result.type === "evidence_context"
  ) {
    return 0;
  }

  return 0.5;
}

export function evaluateReplyDeliveryGate(params: {
  botEnabled: boolean;
  shadowModeEnabled: boolean;
  rolloutPercentage: number;
  minConfidence: number;
  seed: string;
  responseConfidence?: number | null;
}): DeliveryGateDecision {
  const rolloutPercentage = clamp(params.rolloutPercentage, 0, 100);
  const minConfidence = clamp(params.minConfidence, 0, 1);
  const responseConfidence =
    typeof params.responseConfidence === "number"
      ? clamp(params.responseConfidence, 0, 1)
      : null;
  const rolloutBucket = getDeterministicRolloutBucket(params.seed);

  if (!params.botEnabled) {
    if (params.shadowModeEnabled) {
      return {
        allowSend: false,
        reason: "shadow_mode",
        rolloutBucket,
        rolloutPercentage,
        minConfidence,
        responseConfidence,
      };
    }

    return {
      allowSend: false,
      reason: "bot_disabled",
      rolloutBucket,
      rolloutPercentage,
      minConfidence,
      responseConfidence,
    };
  }

  if (rolloutBucket >= rolloutPercentage) {
    return {
      allowSend: false,
      reason: "rollout_filtered",
      rolloutBucket,
      rolloutPercentage,
      minConfidence,
      responseConfidence,
    };
  }

  if (responseConfidence !== null && responseConfidence < minConfidence) {
    return {
      allowSend: false,
      reason: "confidence_below_threshold",
      rolloutBucket,
      rolloutPercentage,
      minConfidence,
      responseConfidence,
    };
  }

  return {
    allowSend: true,
    reason: null,
    rolloutBucket,
    rolloutPercentage,
    minConfidence,
    responseConfidence,
  };
}
