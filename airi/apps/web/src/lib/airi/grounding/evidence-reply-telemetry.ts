import "server-only";

import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { decideResponsePolicy } from "@/lib/airi/rag/evidence/evidence-response-policy";
import type {
  CitationStrength,
  EvidenceChunk,
  GroundedAnswer,
  ResponsePolicy,
  RetrievalPlan,
} from "@/lib/airi/rag/evidence/evidence-types";
import { resolveEffectiveCitationDiscipline } from "./citation-discipline";
import {
  buildGroundingReflectionSources,
  generateGroundedAnswer,
  rankProductEvidenceChunks,
} from "./generate-grounded-answer";
import { runLlmGroundingReflection } from "./llm-grounding-reflection";
import { createFallbackRetrievalPlan } from "@/lib/airi/rag/pipeline/retrieval-planner";
import { ragLogger } from "@/lib/airi/shared/logger";
import type { ContextDecision, HybridContext } from "@/lib/airi/rag/types";

function hasVerifiedSnippetInContext(
  hybridContext: HybridContext,
  decision: ContextDecision
): boolean {
  return Boolean(
    hybridContext.snippet &&
      decision.useSnippet &&
      decision.priority === "snippet"
  );
}

/**
 * Typed synchronous evidence evaluation used on the hot reply path.
 */
export type AssistantReplyEvidenceEvaluation = {
  summary: Record<string, unknown>;
  groundedAnswer: GroundedAnswer;
  evidenceResponsePolicy: ResponsePolicy;
  plan: RetrievalPlan;
  citationDiscipline: CitationStrength;
  /** Ranked product chunks (same ordering as grounding); reused for deferred LLM reflection. */
  rankedProductChunks: EvidenceChunk[];
  reflectionSources: Array<{ chunkId: string; excerpt: string }>;
  reflectionDeferred: boolean;
};

function resolveAssistantReplyEvidenceInputs(params: {
  hybridContext: HybridContext;
  customerText: string;
}) {
  const plan =
    params.hybridContext.retrievalPlan ??
    createFallbackRetrievalPlan(params.customerText);
  const rankedProduct = rankProductEvidenceChunks(params.hybridContext);
  const hasRetrievedSources = rankedProduct.length > 0;
  const citationDiscipline = resolveEffectiveCitationDiscipline({
    plan,
    groundedStrictEnforcement: RAG_CONFIG.features.groundedStrictCitation,
    hasRetrievedSources,
  });

  return {
    plan,
    citationDiscipline,
    rankedProduct,
  };
}

export function buildAssistantReplyEvidenceEvaluation(params: {
  baseSummary: Record<string, unknown>;
  hybridContext: HybridContext;
  customerText: string;
  decision: ContextDecision;
  replyText: string;
}): AssistantReplyEvidenceEvaluation {
  const { plan, citationDiscipline, rankedProduct } =
    resolveAssistantReplyEvidenceInputs({
      hybridContext: params.hybridContext,
      customerText: params.customerText,
    });
  const reflectionSources = buildGroundingReflectionSources(
    params.hybridContext,
    rankedProduct
  );
  const reflectionDeferred =
    reflectionSources.length > 0 &&
    params.replyText.trim().length > 0 &&
    RAG_CONFIG.features.enableLlmGroundingReflection;

  const groundedAnswer = generateGroundedAnswer({
    answer: params.replyText || "",
    hybridContext: params.hybridContext,
    rankedProductOverride: rankedProduct,
  });
  const evidenceResponsePolicy = decideResponsePolicy({
    decision: params.decision,
    plan,
    citationDiscipline,
    hasVerifiedSnippet: hasVerifiedSnippetInContext(
      params.hybridContext,
      params.decision
    ),
    unsupportedClaimCount: groundedAnswer.unsupportedClaims.length,
    hasProductEvidence: groundedAnswer.citations.length > 0,
  });

  return {
    groundedAnswer,
    evidenceResponsePolicy,
    plan,
    citationDiscipline,
    rankedProductChunks: rankedProduct,
    reflectionSources,
    reflectionDeferred,
    summary: {
      ...params.baseSummary,
      groundedAnswer,
      groundedConfidence: groundedAnswer.confidence,
      unsupportedClaimCount: groundedAnswer.unsupportedClaims.length,
      citedChunkIds: groundedAnswer.citations.map(c => c.chunkId),
      llmGroundingReflection: false,
      llmGroundingReflectionDeferred: reflectionDeferred,
      effectiveCitationDiscipline: citationDiscipline,
      evidenceResponsePolicy,
    },
  };
}

/**
 * Optional post-reply reflection for observability. This must never block the user-facing reply path.
 */
export function startAssistantReplyGroundingReflectionTelemetry(params: {
  evaluation: AssistantReplyEvidenceEvaluation;
  hybridContext: HybridContext;
  decision: ContextDecision;
  replyText: string;
  replyLanguage: string;
  workspaceId?: string;
  conversationId?: string;
}): void {
  if (!params.evaluation.reflectionDeferred) {
    return;
  }

  void (async () => {
    const llmReflection = await runLlmGroundingReflection({
      reply: params.replyText,
      language: params.replyLanguage || "en",
      sources: params.evaluation.reflectionSources,
    });
    if (!llmReflection) {
      return;
    }

    const reflectedGroundedAnswer = generateGroundedAnswer({
      answer: params.replyText || "",
      hybridContext: params.hybridContext,
      llmReflection,
      rankedProductOverride: params.evaluation.rankedProductChunks,
    });
    const reflectedPolicy = decideResponsePolicy({
      decision: params.decision,
      plan: params.evaluation.plan,
      citationDiscipline: params.evaluation.citationDiscipline,
      hasVerifiedSnippet: hasVerifiedSnippetInContext(
        params.hybridContext,
        params.decision
      ),
      unsupportedClaimCount: reflectedGroundedAnswer.unsupportedClaims.length,
      hasProductEvidence: reflectedGroundedAnswer.citations.length > 0,
    });

    ragLogger.general.info("Deferred grounding reflection completed", {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      replyLanguage: params.replyLanguage || "en",
      unsupportedClaimCountBefore:
        params.evaluation.groundedAnswer.unsupportedClaims.length,
      unsupportedClaimCountAfter:
        reflectedGroundedAnswer.unsupportedClaims.length,
      confidenceBefore: params.evaluation.groundedAnswer.confidence,
      confidenceAfter: reflectedGroundedAnswer.confidence,
      evidencePolicyBefore: params.evaluation.evidenceResponsePolicy,
      evidencePolicyAfter: reflectedPolicy,
      policyChanged:
        reflectedPolicy !== params.evaluation.evidenceResponsePolicy,
      llmCitedChunkIds:
        reflectedGroundedAnswer.llmCitedChunkIds?.slice(0, 6) ?? [],
    });
  })().catch(error => {
    ragLogger.general.warn("Deferred grounding reflection failed", {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
