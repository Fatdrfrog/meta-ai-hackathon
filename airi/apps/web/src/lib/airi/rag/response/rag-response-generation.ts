import { buildAgentContext } from "@/lib/airi/agent-context";
import {
  buildAssistantReplyEvidenceEvaluation,
  startAssistantReplyGroundingReflectionTelemetry,
} from "@/lib/airi/grounding/evidence-reply-telemetry";
import type { MissingKnowledgeSignal } from "@/lib/airi/grounding/factual-grounding-guard";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import {
  findHyDELeakageMatch,
  type HyDEArtifact,
} from "@/lib/airi/rag/pipeline/hyde-safety";
import {
  translateAnswerForReply,
  type CompanyLanguage,
} from "@/lib/airi/rag/query/query-translator";
import type {
  ContextDecision,
  HybridContext,
  RetrievedAnswer,
} from "@/lib/airi/rag/types";
import type {
  ReplyFallbackAction,
  ReplyFallbackReason,
} from "@/lib/airi/reply/generation/reply-fallback-policy";
import { resolveReplyFallbackDecision } from "@/lib/airi/reply/generation/reply-fallback-policy";
import { generateAssistantReply } from "@/lib/airi/reply/generation/reply-generation";
import { ragLogger } from "@/lib/airi/shared/logger";
import {
  buildRecoveryTurnContext,
  generateFallbackRecoveryResolution,
  resolveEvidencePolicyFallback,
  resolveScenarioReplyInstruction,
  type GenericFallbackResolution,
} from "./rag-response-fallback";
import {
  allowedUrlsForLinks,
  collectCitedSourceLinks,
  collectKbArticlePageLinks,
  mergeReplyUrlAllowlist,
} from "@/lib/airi/rag/evidence/source-url-allowlist";
import { resolveAttachKbArticlePageLinks } from "@/lib/airi/reply/runtime/dispatch";
import {
  meetsSnippetCriteria,
  selectMatchedKBArticles,
} from "./rag-response-kb-selection";
import {
  sanitizeGeneratedReply,
  structureReplyForReadability,
} from "./rag-response-text";
import type {
  RAGGenerateResponseParams,
  RAGResponseResult,
  RetrievalSummary,
} from "./types";

function isFallbackRecoveryAction(
  action: ReplyFallbackAction | undefined
): action is "grounded_recovery" | "intent_fallback" | "generic_clarification" {
  return (
    action === "grounded_recovery" ||
    action === "intent_fallback" ||
    action === "generic_clarification"
  );
}

/** Core generation fields from a generic fallback (caller should set `resolvedGenerationPromptDiagnostics = undefined`). */
function patchGenerationStateFromFallback(fb: GenericFallbackResolution): {
  content: string;
  incomplete: boolean;
  finishReason: string | null | undefined;
  inference: RAGResponseResult["generationInference"];
} {
  return {
    content: fb.reply || "",
    incomplete: Boolean(fb.generationIncomplete),
    finishReason: fb.finishReason,
    inference: fb.inference,
  };
}

function resolveMatchedKbArticlesForGeneration(
  useKB: boolean,
  selected: KBArticleResult[] | undefined,
  hybridContext: HybridContext
): KBArticleResult[] {
  if (!useKB) return [];
  if (selected?.length) return selected;
  return selectMatchedKBArticles(hybridContext);
}

function collectHyDEArtifactsForGeneration(
  hybridContext: HybridContext,
  matchedKBArticles: KBArticleResult[]
): HyDEArtifact[] {
  const deduped = new Map<string, HyDEArtifact>();

  const pushArtifact = (artifact: HyDEArtifact | null | undefined) => {
    const query = artifact?.query?.trim();
    const hypotheticalAnswer = artifact?.hypotheticalAnswer?.trim();
    if (!artifact || !query || !hypotheticalAnswer) return;

    const dedupeKey = `${artifact.source}:${query.toLowerCase()}:${hypotheticalAnswer.toLowerCase()}`;
    if (deduped.has(dedupeKey)) return;

    deduped.set(dedupeKey, {
      source: artifact.source,
      query,
      hypotheticalAnswer,
    });
  };

  for (const artifact of hybridContext.retrievalStats.hydeArtifacts || []) {
    pushArtifact(artifact);
  }

  if (
    hybridContext.snippet?.wasHydeApplied &&
    hybridContext.snippet.hydeHypotheticalAnswer?.trim()
  ) {
    pushArtifact({
      source: "snippet",
      query: hybridContext.snippet.question || "",
      hypotheticalAnswer: hybridContext.snippet.hydeHypotheticalAnswer,
    });
  }

  for (const article of matchedKBArticles) {
    if (!article.wasHydeApplied || !article.hydeHypotheticalAnswer?.trim()) {
      continue;
    }

    pushArtifact({
      source: "kb",
      query: article.title || "",
      hypotheticalAnswer: article.hydeHypotheticalAnswer,
    });
  }

  return Array.from(deduped.values());
}

/** Verified-snippet path may auto-send outbound when env gates pass (see `AIRI_AUTOSEND_*`). */
function shouldAutoSendVerifiedSnippet(snippet: RetrievedAnswer): boolean {
  const flag = (process.env.AIRI_AUTOSEND_ENABLED || "").toLowerCase();
  if (flag !== "true" && flag !== "1" && flag !== "yes") return false;

  const minRaw = Number(process.env.AIRI_AUTOSEND_MIN_SCORE || "0.84");
  const minScore = Number.isFinite(minRaw) ? minRaw : 0.84;
  if (snippet.score < minScore) return false;

  const allowed = (process.env.AIRI_AUTOSEND_CATEGORIES || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (!snippet.category) return true;
  return allowed.includes(String(snippet.category).toLowerCase());
}

export async function generateVerifiedSnippetResponse(
  snippet: RetrievedAnswer,
  targetLang: string,
  decision: ContextDecision,
  summary: RetrievalSummary
): Promise<RAGResponseResult> {
  let content = snippet.answer;
  const snippetLang = snippet.language || targetLang;

  if (snippetLang !== targetLang) {
    try {
      const trans = await translateAnswerForReply(
        content,
        snippetLang as CompanyLanguage,
        targetLang as CompanyLanguage
      );
      content = trans.translatedText;
    } catch (err) {
      ragLogger.translation.error("Snippet reply translation failed", err, {
        targetLang,
        snippetLang,
      });
    }
  }
  return {
    type: "verified_snippet",
    content,
    snippet,
    decision,
    retrievalSummary: summary,
    shouldAutoSend: shouldAutoSendVerifiedSnippet(snippet),
  };
}

export async function generateGroundedAIResponse(
  params: RAGGenerateResponseParams,
  hybridContext: HybridContext,
  decision: ContextDecision,
  summary: RetrievalSummary,
  selectedKBArticles?: KBArticleResult[]
): Promise<RAGResponseResult> {
  const {
    text,
    workspaceId,
    conversationId,
    conversationWindow,
    intentAnchor,
    language,
    companyContext,
    threadMemorySummary,
    recentConversationTail,
    crossConversationContext,
    widgetContextBlock,
    engine,
  } = params;
  // `text` is the retrieval query; the writer answers what the customer sent.
  const customerMessage = params.customerMessage?.trim() || text;
  const scenarioInstruction = resolveScenarioReplyInstruction(params);
  // Every recovery answers this turn: the step instruction and the latest turns.
  const recoveryTurnContext = buildRecoveryTurnContext(params);
  const matchedKBArticles = resolveMatchedKbArticlesForGeneration(
    decision.useKB,
    selectedKBArticles,
    hybridContext
  );

  const attachKbArticlePageLinks = resolveAttachKbArticlePageLinks({
    channel: params.channel,
    sendKbArticleLinksToUserChannels: params.sendKbArticleLinksToUserChannels,
  });

  const agentCtx = buildAgentContext({
    currentGoal: params.currentGoal,
    activeGoals: params.activeGoals,
    openAsks: params.openAsks,
    followUpAnchor: params.followUpAnchor,
    unresolvedNeeds: params.unresolvedNeeds,
    resolvedNeeds: params.resolvedNeeds,
    hasUnresolvedNeed: params.hasUnresolvedNeed,
    dominantLanguage: params.dominantLanguage,
    latestMessage: customerMessage,
    channel: params.channel,
    hasActiveScenario: !!params.scenarioRuntime,
    hasRetrievedContext: decision.useKB || decision.useSnippet,
    workspacePersona: params.workspacePersona,
    customAvailableActions: params.customAvailableActions,
    escalationBehavior: params.escalationBehavior,
    channelInstructions: params.channelInstructions,
  });

  const gen = await generateAssistantReply(customerMessage, {
    workspaceId,
    conversationId,
    conversationWindow,
    intentAnchor,
    threadMemorySummary,
    recentConversationTail,
    activeGoals: params.activeGoals,
    openAsks: params.openAsks,
    followUpAnchor: params.followUpAnchor,
    crossConversationContext,
    calendarAvailabilityBlock: params.calendarAvailabilityBlock,
    customerAnswersBlock: params.customerAnswersBlock,
    companyContext,
    preferredLanguage: language,
    channel: params.channel,
    snippetContext: decision.useSnippet ? hybridContext.snippet : undefined,
    kbContext: matchedKBArticles.length > 0 ? matchedKBArticles : undefined,
    conversationSummaries: hybridContext.conversationSummaries,
    quickReplies: params.scenarioRuntime?.quickReplies,
    scenarioInstruction: scenarioInstruction || undefined,
    retrievalMetadata: {
      hasSnippet: !!hybridContext.snippet,
      hasKB: matchedKBArticles.length > 0,
      hasSummaries: (hybridContext.conversationSummaries?.length || 0) > 0,
      priority: decision.priority,
    },
    retrievalPlan: hybridContext.retrievalPlan,
    agentContextBlock: [agentCtx.toPromptBlock(), params.channelContextBlock]
      .filter(Boolean)
      .join("\n\n"),
    widgetContextBlock,
    engine,
    activeSelection: params.activeSelection,
    elevenlabsAgentId: params.elevenlabsAgentId,
    workspacePersona: params.workspacePersona,
    alreadyGreeted: params.alreadyGreeted,
    agentName: params.workspacePersona?.displayName,
    customInstructions: params.customInstructions,
    greetingBehavior: params.greetingBehavior,
    responseStyle: params.responseStyle,
    channelInstructions: params.channelInstructions,
    attachKbArticlePageLinks,
    onReplyDelta: params.onReplyDelta,
  });

  const initialStructuredReply = structureReplyForReadability(gen.reply);
  const usedClarifyingGeneration =
    Boolean(summary.guardClarification) &&
    gen.fallbackAction === "use_generated_reply";

  let resolvedContent = initialStructuredReply;
  let resolvedGenerationIncomplete = gen.isIncomplete;
  let resolvedGenerationFinishReason = gen.finishReason;
  let resolvedGenerationPromptDiagnostics = gen.promptDiagnostics;
  let resolvedGenerationInference = gen.inference;
  let resolvedMissingKnowledgeSignal: MissingKnowledgeSignal | undefined;
  const hydeArtifacts = collectHyDEArtifactsForGeneration(
    hybridContext,
    matchedKBArticles
  );
  const fallbackRecoveryAction = isFallbackRecoveryAction(gen.fallbackAction)
    ? gen.fallbackAction
    : null;

  if (!usedClarifyingGeneration && fallbackRecoveryAction) {
    const llmFallback = await generateFallbackRecoveryResolution({
      action: fallbackRecoveryAction,
      reason: gen.fallbackReason || "incomplete_generated_reply",
      language,
      workspacePersona: params.workspacePersona,
      channel: params.channel,
      channelInstructions: params.channelInstructions,
      alreadyGreeted: params.alreadyGreeted,
      recoveryContext: gen.recoveryContext,
    });

    // The recovery starts from the draft; it replaces it only when it reads
    // as finished, otherwise the writer's own draft is kept.
    if (
      llmFallback.reply?.trim() &&
      (!initialStructuredReply.trim() || !llmFallback.generationIncomplete)
    ) {
      const p = patchGenerationStateFromFallback(llmFallback);
      resolvedContent = p.content;
      resolvedGenerationIncomplete = p.incomplete;
      resolvedGenerationFinishReason = p.finishReason;
      resolvedGenerationPromptDiagnostics = undefined;
      resolvedGenerationInference = p.inference;
    } else if (initialStructuredReply.trim()) {
      resolvedContent = initialStructuredReply;
      resolvedGenerationIncomplete = true;
    }
  }

  let resolvedFallbackAction: ReplyFallbackAction | undefined =
    usedClarifyingGeneration ? "clarifying_generation" : gen.fallbackAction;
  let resolvedFallbackReason: ReplyFallbackReason | undefined =
    usedClarifyingGeneration
      ? "clarifying_generation_allowed"
      : gen.fallbackReason;
  let hydeLeakageGuardSummary: RetrievalSummary | undefined;

  const hydeLeakageMatch = findHyDELeakageMatch(resolvedContent, hydeArtifacts);
  if (hydeLeakageMatch) {
    ragLogger.general.warn("HyDE leakage guard intercepted generated reply", {
      workspaceId,
      conversationId,
      source: hydeLeakageMatch.source,
      reason: hydeLeakageMatch.reason,
      tokenOverlap: Number(hydeLeakageMatch.tokenOverlap.toFixed(3)),
      bigramOverlap: Number(hydeLeakageMatch.bigramOverlap.toFixed(3)),
    });

    hydeLeakageGuardSummary = {
      hydeLeakageGuardTriggered: true,
      hydeLeakageGuardSource: hydeLeakageMatch.source,
      hydeLeakageGuardReason: hydeLeakageMatch.reason,
    };

    const hydeFallbackDecision = resolveReplyFallbackDecision({
      language,
      latestCustomerMessage: customerMessage,
      intentAnchor,
      turnContext: recoveryTurnContext,
      snippetContext: decision.useSnippet ? hybridContext.snippet : undefined,
      kbContext: matchedKBArticles.length > 0 ? matchedKBArticles : undefined,
      allowClarifyingGeneration: false,
    });

    if (isFallbackRecoveryAction(hydeFallbackDecision.action)) {
      const hydeFallback = await generateFallbackRecoveryResolution({
        action: hydeFallbackDecision.action,
        reason: "hyde_leakage_guard",
        language,
        workspacePersona: params.workspacePersona,
        channel: params.channel,
        channelInstructions: params.channelInstructions,
        alreadyGreeted: params.alreadyGreeted,
        recoveryContext: hydeFallbackDecision.recoveryContext,
      });
      const patched = patchGenerationStateFromFallback(hydeFallback);
      // Re-validate fallback text against the same HyDE artifacts — the
      // fallback LLM (esp. grounded_recovery prompts) can parrot the
      // hypothetical wording that tripped the original guard, bypassing it.
      const fallbackLeakageMatch = findHyDELeakageMatch(
        patched.content,
        hydeArtifacts
      );
      if (fallbackLeakageMatch) {
        ragLogger.general.warn(
          "HyDE leakage guard intercepted fallback reply; blanking",
          {
            workspaceId,
            conversationId,
            source: fallbackLeakageMatch.source,
            reason: fallbackLeakageMatch.reason,
            tokenOverlap: Number(fallbackLeakageMatch.tokenOverlap.toFixed(3)),
            bigramOverlap: Number(
              fallbackLeakageMatch.bigramOverlap.toFixed(3)
            ),
          }
        );
        resolvedContent = "";
        resolvedGenerationIncomplete = true;
        resolvedGenerationFinishReason = null;
        resolvedGenerationPromptDiagnostics = undefined;
        resolvedGenerationInference = undefined;
        resolvedFallbackAction = "generic_clarification";
        resolvedFallbackReason = "hyde_leakage_guard";
      } else {
        resolvedContent = patched.content;
        resolvedGenerationIncomplete = patched.incomplete;
        resolvedGenerationFinishReason = patched.finishReason;
        resolvedGenerationPromptDiagnostics = undefined;
        resolvedGenerationInference = patched.inference;
        resolvedFallbackAction = hydeFallback.fallbackAction;
        resolvedFallbackReason = hydeFallback.fallbackReason;
        resolvedMissingKnowledgeSignal = hydeFallback.missingKnowledgeSignal;
      }
    } else {
      resolvedContent = "";
      resolvedGenerationIncomplete = true;
      resolvedGenerationFinishReason = null;
      resolvedGenerationPromptDiagnostics = undefined;
      resolvedGenerationInference = undefined;
      resolvedFallbackAction = "generic_clarification";
      resolvedFallbackReason = "hyde_leakage_guard";
    }
  }

  const evidenceEvaluation = buildAssistantReplyEvidenceEvaluation({
    baseSummary: hydeLeakageGuardSummary
      ? { ...summary, ...hydeLeakageGuardSummary }
      : summary,
    hybridContext,
    customerText: text,
    decision,
    replyText: resolvedContent || "",
  });
  const enrichedSummary = evidenceEvaluation.summary;
  const evidencePolicy = evidenceEvaluation.evidenceResponsePolicy;
  const groundedAnswer = evidenceEvaluation.groundedAnswer;

  let citationLinksForAllowlist: Array<{ url: string; title: string }> =
    usedClarifyingGeneration ||
    resolvedFallbackAction === "clarifying_generation" ||
    (evidencePolicy !== "clarify" && evidencePolicy !== "handoff")
      ? collectCitedSourceLinks(groundedAnswer?.citations || [], 100)
      : [];

  startAssistantReplyGroundingReflectionTelemetry({
    evaluation: evidenceEvaluation,
    hybridContext,
    decision,
    replyText: resolvedContent || "",
    replyLanguage: language,
    workspaceId,
    conversationId,
  });

  if (
    !usedClarifyingGeneration &&
    resolvedFallbackAction !== "clarifying_generation" &&
    (evidencePolicy === "clarify" || evidencePolicy === "handoff")
  ) {
    const evidenceFallback = await resolveEvidencePolicyFallback({
      policy: evidencePolicy,
      latestCustomerMessage: customerMessage,
      turnContext: recoveryTurnContext,
      language,
      summary: enrichedSummary,
      intentAnchor,
      kbContext: matchedKBArticles.length > 0 ? matchedKBArticles : undefined,
      workspacePersona: params.workspacePersona,
      channel: params.channel,
      channelInstructions: params.channelInstructions,
      alreadyGreeted: params.alreadyGreeted,
    });

    if (evidenceFallback) {
      const p = patchGenerationStateFromFallback(evidenceFallback);
      resolvedContent = p.content;
      resolvedGenerationIncomplete = p.incomplete;
      resolvedGenerationFinishReason = p.finishReason;
      resolvedGenerationPromptDiagnostics = undefined;
      resolvedGenerationInference = p.inference;
      resolvedFallbackAction = evidenceFallback.fallbackAction;
      resolvedFallbackReason = evidenceFallback.fallbackReason;
      resolvedMissingKnowledgeSignal = evidenceFallback.missingKnowledgeSignal;
    }
  }

  if (!resolvedContent?.trim() && !usedClarifyingGeneration) {
    const lastResort = await generateFallbackRecoveryResolution({
      action: "generic_clarification",
      reason: "incomplete_generated_reply",
      language,
      channel: params.channel,
      workspacePersona: params.workspacePersona,
      channelInstructions: params.channelInstructions,
      recoveryContext: {
        ...recoveryTurnContext,
        latestCustomerMessage: customerMessage,
        intentAnchor: intentAnchor || undefined,
      },
      alreadyGreeted: params.alreadyGreeted,
    });
    if (lastResort.reply?.trim()) {
      const p = patchGenerationStateFromFallback(lastResort);
      resolvedContent = p.content;
      resolvedGenerationIncomplete = p.incomplete;
      resolvedGenerationFinishReason = p.finishReason;
      resolvedGenerationPromptDiagnostics = undefined;
      resolvedGenerationInference = p.inference;
      resolvedFallbackAction = lastResort.fallbackAction;
      resolvedFallbackReason = lastResort.fallbackReason;
      citationLinksForAllowlist = [];
    }
  }

  const articlePageLinksForFooter = attachKbArticlePageLinks
    ? collectKbArticlePageLinks(matchedKBArticles)
    : [];

  const sanitizationAllowlist = mergeReplyUrlAllowlist({
    citationLinks: citationLinksForAllowlist,
    kbArticles: matchedKBArticles,
    includeArticlePageUrls: attachKbArticlePageLinks,
    articlePageLinks: attachKbArticlePageLinks
      ? articlePageLinksForFooter
      : undefined,
  });

  resolvedContent = sanitizeGeneratedReply(
    structureReplyForReadability(resolvedContent || ""),
    allowedUrlsForLinks(sanitizationAllowlist)
  );

  const isSuggestion =
    !meetsSnippetCriteria(decision, hybridContext.snippet) &&
    decision.useSnippet;

  ragLogger.general.info("Assistant reply generation finished", {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    resultType: isSuggestion ? "suggestion_with_ai" : "ai_reply",
    contentLength: (resolvedContent || "").length,
    generationFinishReason: resolvedGenerationFinishReason ?? null,
    generationIncomplete: resolvedGenerationIncomplete,
    fallbackAction: resolvedFallbackAction,
    fallbackReason: resolvedFallbackReason,
  });

  return {
    type: isSuggestion ? "suggestion_with_ai" : "ai_reply",
    content: resolvedContent,
    generationIncomplete: resolvedGenerationIncomplete,
    generationFinishReason: resolvedGenerationFinishReason,
    generationPromptDiagnostics: resolvedGenerationPromptDiagnostics,
    snippet: isSuggestion ? hybridContext.snippet : undefined,
    kbArticles: matchedKBArticles.length > 0 ? matchedKBArticles : undefined,
    decision,
    retrievalSummary: enrichedSummary,
    attachedArticleLinks:
      articlePageLinksForFooter.length > 0
        ? articlePageLinksForFooter
        : undefined,
    missingKnowledgeSignal: resolvedMissingKnowledgeSignal,
    generationInference: resolvedGenerationInference,
    coverage: gen.coverage
      ? {
          asksDetected: gen.coverage.asksDetected,
          asksAnswered: gen.coverage.asksAnswered,
          missingAsks: gen.coverage.missingAsks,
        }
      : undefined,
    fallbackAction: resolvedFallbackAction,
    fallbackReason: resolvedFallbackReason,
  };
}
