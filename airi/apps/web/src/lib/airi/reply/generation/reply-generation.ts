import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import {
  chatCompletionWithFallback,
  getDefaultAIChatProviderOrder,
  getHeavyTextModel,
  getStructuredJsonGenerationConfig,
  type AIChatProvider,
} from "@/lib/ai";
import { createInferenceDeadline } from "@/lib/ai/inference-deadline";
import { canUseTextAI } from "@/lib/ai/text-provider-config";
import type { WorkspaceAgentPersona } from "@/lib/airi/agent-context";
import { redactPII, unredact } from "@/lib/airi/coach/coach-utils";
import { hasGreetedToday } from "@/lib/airi/conversation";
import { resolveEffectiveCitationDiscipline } from "@/lib/airi/grounding/citation-discipline";
import { getLanguageName } from "@/lib/airi/language-detector";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type {
  CitationStrength,
  RetrievalPlan,
} from "@/lib/airi/rag/evidence/evidence-types";
import {
  formatCompanyContext,
  formatKBBlockForAssistantReply,
} from "@/lib/airi/rag/kb/formatting";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import { createFallbackRetrievalPlan } from "@/lib/airi/rag/pipeline/retrieval-planner";
import type { RetrievedAnswer } from "@/lib/airi/rag/types";
import {
  buildAnswerCoveragePlan,
  evaluateAnswerCoverage,
  renderAnswerCoverageBlock,
  type AnswerCoverageResult,
} from "@/lib/airi/reply/generation/answer-coverage";
import {
  generateFallbackRecoveryReplyResult,
  type FallbackRecoveryReplyType,
} from "@/lib/airi/reply/generation/fallback-recovery-reply";
import {
  buildReplyPromptEnvelope,
  type ReplyOutputProfile,
  type ReplyPromptEnvelope,
} from "@/lib/airi/reply/generation/prompt-envelope";
import {
  isInterruptedFinishReason,
  isLikelyIncompleteAssistantReply,
  shouldPreferRetriedAssistantReply,
} from "@/lib/airi/reply/generation/reply-completeness";
import {
  latestConversationTurns,
  resolveReplyFallbackDecision,
  type FallbackRecoveryContext,
  type ReplyFallbackAction,
  type ReplyFallbackReason,
} from "@/lib/airi/reply/generation/reply-fallback-policy";
import { normalizeReplyText } from "@/lib/airi/reply/generation/reply-text-sanitize";
import { evaluateActiveSelectionReplyConsistency } from "@/lib/airi/reply/generation/selection-reply-consistency";
import { stripDuplicateGreetingLead } from "@/lib/airi/reply/generation/strip-duplicate-greeting-lead";
import { buildActiveSelectionPromptBlock } from "@/lib/airi/reply/prompting/active-selection-prompt";
import { AGENT_CONTEXT_SECTIONS_STRIPPED_FOR_ANSWER_PLAN } from "@/lib/airi/reply/prompting/agent-context-sections";
import { getDefaultChannelEnvelopeLine } from "@/lib/airi/reply/prompting/channel-prompt";
import {
  airiReplyLogger,
  compactLogList,
} from "@/lib/airi/reply/runtime/reply-logging";
import type { AiriActiveSelection } from "@/lib/airi/reply/selection";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";
import { MAX_REPLY_CHAR_LIMIT } from "@/lib/airi/shared/token-budget";
import type {
  ChannelInstructions,
  GreetingBehavior,
  ResponseStyle,
} from "@/lib/airi/workspace-bot-contract";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";

export type AssistantReplyContext = {
  workspaceId: string;
  conversationId: string;
  conversationWindow?: string;
  intentAnchor?: string;
  threadMemorySummary?: string;
  recentConversationTail?: string;
  activeGoals?: string[];
  openAsks?: string[];
  followUpAnchor?: string;
  crossConversationContext?: string;
  calendarAvailabilityBlock?: string;
  /** Customer answers the scenario instruction names, as quoted lines. */
  customerAnswersBlock?: string;
  activeSelection?: AiriActiveSelection;
  companyContext?: {
    businessContext?: string;
    dynamicTags?: string[];
  };
  preferredLanguage?: string;
  channel?: string;
  snippetContext?: RetrievedAnswer | null;
  kbContext?: KBArticleResult[];
  conversationSummaries?: Array<{
    conversationId: string;
    summaryText: string;
    similarity: number;
  }>;
  quickReplies?: Array<{ text: string; category?: string; channel?: string }>;
  scenarioInstruction?: string;
  retrievalMetadata?: {
    hasSnippet: boolean;
    hasKB: boolean;
    hasSummaries?: boolean;
    priority: "snippet" | "kb" | "conversation_summary" | "generic";
  };
  agentContextBlock?: string;
  widgetContextBlock?: string;
  engine?: "vertex";
  /** Legacy settings may carry this value; text generation always uses the metered facade. */
  elevenlabsAgentId?: string;
  workspacePersona?: WorkspaceAgentPersona;
  alreadyGreeted?: boolean;
  agentName?: string;
  customInstructions?: string;
  greetingBehavior?: GreetingBehavior;
  responseStyle?: ResponseStyle;
  channelInstructions?: ChannelInstructions;
  /** When true, KB block lists public article page URLs (chunk body links are always listed separately). */
  attachKbArticlePageLinks?: boolean;
  /** When set, drives citation-first system/task prompts with {@link resolveEffectiveCitationDiscipline}. */
  retrievalPlan?: RetrievalPlan;
  /**
   * Optional callback that receives incremental text chunks from the model
   * during first-pass generation. Enables live channel streaming such as
   * Telegram `sendMessageDraft`. Not invoked during the repair pass.
   */
  onReplyDelta?: (event: {
    delta: string;
    accumulated: string;
  }) => void | Promise<void>;
};

export type AssistantReplyPromptDiagnostics = Omit<
  ReplyPromptEnvelope,
  "systemPrompt" | "userPrompt" | "outputMaxTokens"
> & {
  usedOutputMaxTokens: number;
};

export type AssistantReplyResult = {
  reply: string;
  isIncomplete?: boolean;
  finishReason?: string | null;
  fallbackAction?: ReplyFallbackAction;
  fallbackReason?: ReplyFallbackReason;
  promptDiagnostics?: AssistantReplyPromptDiagnostics;
  inference?: {
    provider?: string;
    model: string;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    finishReason?: string | null;
  };
  coverage?: AnswerCoverageResult;
  recoveryContext?: FallbackRecoveryContext;
};

const FINAL_GENERATION_TIMEOUT_MS = 25_000;
const FINAL_WRITER_CALL_TIMEOUT_MS = 20_000;
const COVERAGE_JUDGE_TIMEOUT_MS = 5_000;
const REPAIR_GENERATION_TIMEOUT_MS = 8_000;
const FALLBACK_RECOVERY_TIMEOUT_MS = 8_000;

function logReplyGenerationOutcome(params: {
  ctx: AssistantReplyContext;
  outcome: string;
  finalReply?: string | null;
  isIncomplete?: boolean;
  promptDiagnostics?: AssistantReplyPromptDiagnostics;
  inference?: AssistantReplyResult["inference"];
  fallbackAction?: ReplyFallbackAction;
  fallbackReason?: ReplyFallbackReason;
  coverage?: {
    asksDetected?: string[];
    asksAnswered?: string[];
    missingAsks?: string[];
  } | null;
  metadata?: {
    repairAttempted: boolean;
    repairApplied: boolean;
  };
  timings?: {
    wallDurationMs: number;
    firstGenerationWallMs: number | null;
    coveragePhaseWallMs: number | null;
    repairGenerationWallMs: number | null;
  };
}): void {
  const hasSnippet = Boolean(params.ctx.retrievalMetadata?.hasSnippet);
  const hasKB = Boolean(params.ctx.retrievalMetadata?.hasKB);
  const groundingSourceKind =
    hasSnippet && hasKB
      ? "mixed"
      : hasKB
        ? "kb"
        : hasSnippet
          ? "snippet"
          : "none";

  airiReplyLogger.info("airi.reply.generation", {
    workspaceId: params.ctx.workspaceId,
    conversationId: params.ctx.conversationId,
    channel: params.ctx.channel || null,
    outcome: params.outcome,
    durationMs: params.inference?.latencyMs || null,
    wallDurationMs: params.timings?.wallDurationMs ?? null,
    firstGenerationWallMs: params.timings?.firstGenerationWallMs ?? null,
    coveragePhaseWallMs: params.timings?.coveragePhaseWallMs ?? null,
    repairGenerationWallMs: params.timings?.repairGenerationWallMs ?? null,
    provider: params.inference?.provider || null,
    model: params.inference?.model || null,
    finishReason: params.inference?.finishReason || null,
    replyLength: params.finalReply?.length || 0,
    isIncomplete: Boolean(params.isIncomplete),
    fallbackAction: params.fallbackAction || null,
    fallbackReason: params.fallbackReason || null,
    retrievalPriority: params.ctx.retrievalMetadata?.priority || null,
    groundingSourceKind,
    outputProfile: params.promptDiagnostics?.outputProfile || null,
    inputTokenLimit: params.promptDiagnostics?.inputTokenLimit || null,
    estimatedInputTokens:
      params.promptDiagnostics?.estimatedInputTokens || null,
    actualPromptTokens: params.inference?.promptTokens || null,
    promptTokenEstimateDelta:
      typeof params.promptDiagnostics?.estimatedInputTokens === "number" &&
      typeof params.inference?.promptTokens === "number"
        ? params.inference.promptTokens -
          params.promptDiagnostics.estimatedInputTokens
        : null,
    usedOutputMaxTokens: params.promptDiagnostics?.usedOutputMaxTokens || null,
    sectionsIncludedCount:
      params.promptDiagnostics?.sectionsIncluded.length || 0,
    trimmedSections: compactLogList(params.promptDiagnostics?.trimmedSections, {
      maxItems: 3,
    }),
    droppedSections: compactLogList(params.promptDiagnostics?.droppedSections, {
      maxItems: 3,
    }),
    coverageDetectedCount: params.coverage?.asksDetected?.length || 0,
    coverageAnsweredCount: params.coverage?.asksAnswered?.length || 0,
    coverageMissingCount: params.coverage?.missingAsks?.length || 0,
    repairAttempted: Boolean(params.metadata?.repairAttempted),
    repairApplied: Boolean(params.metadata?.repairApplied),
  });
}

function normalizeThreadMemorySummary(text?: string): string {
  return String(text || "")
    .replace(/^THREAD MEMORY SUMMARY:\s*/u, "")
    .trim();
}

function buildGroundedContextBlock(
  language: string,
  snippet?: RetrievedAnswer | null,
  kbContext?: KBArticleResult[],
  outputProfile: ReplyOutputProfile = "grounded_answer",
  citationDiscipline: CitationStrength = "none",
  attachKbArticlePageLinks?: boolean
): string | undefined {
  const parts: string[] = [];

  if (snippet?.answer) {
    const snippetHead =
      citationDiscipline === "strict"
        ? "AUTHORITATIVE Q/A SNIPPET (use for matching facts; do not contradict):"
        : "Q/A SNIPPET:";
    parts.push(
      [
        snippetHead,
        snippet.question ? `Question: ${snippet.question}` : "",
        `Answer: ${snippet.answer}`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const kbBlock =
    kbContext && kbContext.length > 0
      ? formatKBBlockForAssistantReply(
          kbContext,
          language,
          5,
          outputProfile === "grounded_overview" ? "overview" : "default",
          citationDiscipline,
          attachKbArticlePageLinks
        )
      : undefined;
  if (kbBlock) {
    parts.push(kbBlock);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
}

function buildQuickRepliesBlock(
  quickReplies?: AssistantReplyContext["quickReplies"]
): string | undefined {
  if (!quickReplies || quickReplies.length === 0) return undefined;
  return quickReplies
    .slice(0, 12)
    .map(reply => {
      const meta = [reply.category, reply.channel].filter(Boolean).join(", ");
      return `- ${reply.text}${meta ? ` (${meta})` : ""}`;
    })
    .join("\n");
}

function dedupeComparableValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = String(value || "").trim();
    const normalized = normalizeComparableText(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }

  return result;
}

function stripAnswerPlanOverlapFromAgentContext(params: {
  agentContextBlock?: string;
  hasAnswerCoverageBlock: boolean;
}): string | undefined {
  const agentContextBlock = String(params.agentContextBlock || "").trim();
  if (!agentContextBlock) return undefined;
  if (!params.hasAnswerCoverageBlock) return agentContextBlock;

  const filteredSections = agentContextBlock
    .split(/\n{2,}/)
    .map(section => section.trim())
    .filter(Boolean)
    .filter(section => {
      const normalizedSection = section.toUpperCase();
      return !AGENT_CONTEXT_SECTIONS_STRIPPED_FOR_ANSWER_PLAN.some(prefix =>
        normalizedSection.startsWith(prefix)
      );
    });

  return filteredSections.length > 0
    ? filteredSections.join("\n\n")
    : undefined;
}

function buildRelatedConversationContextBlock(params: {
  crossConversationContext?: string;
  conversationSummaries?: AssistantReplyContext["conversationSummaries"];
}): string | undefined {
  const crossConversationContext = String(
    params.crossConversationContext || ""
  ).trim();
  const normalizedCrossConversationContext = normalizeComparableText(
    crossConversationContext
  );
  const summaryItems = dedupeComparableValues(
    (params.conversationSummaries || []).map(summary => summary.summaryText)
  ).filter(summary => {
    const normalizedSummary = normalizeComparableText(summary);
    if (!normalizedSummary) return false;
    if (!normalizedCrossConversationContext) return true;
    return !(
      normalizedCrossConversationContext.includes(normalizedSummary) ||
      normalizedSummary.includes(normalizedCrossConversationContext)
    );
  });

  if (!crossConversationContext && summaryItems.length === 0) {
    return undefined;
  }

  if (crossConversationContext && summaryItems.length === 0) {
    return crossConversationContext;
  }

  const summariesBlock = [
    "Relevant past conversation summaries:",
    ...summaryItems.map(summary => `- ${summary}`),
  ].join("\n");

  return [crossConversationContext, summariesBlock]
    .filter(Boolean)
    .join("\n\n");
}

function resolveFinalWriterProviderOrder(): AIChatProvider[] {
  return getDefaultAIChatProviderOrder();
}

function hasGroundedReplyContext(ctx: AssistantReplyContext): boolean {
  return (
    Boolean(ctx.retrievalMetadata?.hasSnippet) ||
    Boolean(ctx.snippetContext?.answer?.trim()) ||
    Boolean(ctx.retrievalMetadata?.hasKB) ||
    Boolean(ctx.kbContext?.length)
  );
}

function resolveReplyOutputProfile(
  ctx: AssistantReplyContext
): ReplyOutputProfile {
  if (!hasGroundedReplyContext(ctx)) {
    return "clarification";
  }

  if ((ctx.kbContext?.length || 0) > 2) {
    return "grounded_overview";
  }

  return "grounded_answer";
}

type ProviderGenerationResult = {
  content: string;
  provider: AIChatProvider;
  model: string;
  latencyMs: number;
  finishReason?: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

async function generateAssistantReplyImpl(
  latestCustomerMessage: string,
  ctx: AssistantReplyContext
): Promise<AssistantReplyResult> {
  const wallStart = Date.now();
  const generationDeadline = createInferenceDeadline(
    FINAL_GENERATION_TIMEOUT_MS
  );
  const language = ctx.preferredLanguage || "en";
  let repairAttempted = false;
  let repairApplied = false;

  const buildFallbackResult = (options?: {
    generatedReply?: string | null;
    finishReason?: string | null;
    markedIncomplete?: boolean;
    isIncomplete?: boolean;
    promptDiagnostics?: AssistantReplyPromptDiagnostics;
    inference?: AssistantReplyResult["inference"];
    coverage?: AnswerCoverageResult;
    coverageRequired?: boolean;
    missingAsks?: string[] | null;
  }): AssistantReplyResult => {
    const fallbackDecision = resolveReplyFallbackDecision({
      language,
      latestCustomerMessage,
      intentAnchor: ctx.intentAnchor,
      turnContext: {
        stepInstruction: ctx.scenarioInstruction?.trim() || undefined,
        recentConversation: latestConversationTurns(
          ctx.recentConversationTail || ctx.conversationWindow
        ),
      },
      snippetContext: ctx.snippetContext,
      kbContext: ctx.kbContext,
      generatedReply: options?.generatedReply,
      finishReason: options?.finishReason,
      markedIncomplete: options?.markedIncomplete,
      coverageRequired: options?.coverageRequired,
      missingAsks: options?.missingAsks,
    });

    return {
      reply: fallbackDecision.reply || "",
      isIncomplete: options?.isIncomplete ?? false,
      finishReason: options?.finishReason ?? null,
      fallbackAction: fallbackDecision.action,
      fallbackReason: fallbackDecision.reason,
      promptDiagnostics: options?.promptDiagnostics,
      inference: options?.inference,
      coverage: options?.coverage,
      recoveryContext: fallbackDecision.recoveryContext,
    };
  };

  const logAndReturn = (params: {
    outcome: string;
    generatedReply?: string | null;
    finishReason?: string | null;
    markedIncomplete?: boolean;
    isIncomplete?: boolean;
    promptDiagnostics?: AssistantReplyPromptDiagnostics;
    inference?: AssistantReplyResult["inference"];
    coverage?: AnswerCoverageResult;
    coverageRequired?: boolean;
    missingAsks?: string[] | null;
    timings?: {
      wallDurationMs: number;
      firstGenerationWallMs: number | null;
      coveragePhaseWallMs: number | null;
      repairGenerationWallMs: number | null;
    };
  }): AssistantReplyResult => {
    const result = buildFallbackResult({
      generatedReply: params.generatedReply,
      finishReason: params.finishReason,
      markedIncomplete: params.markedIncomplete,
      isIncomplete: params.isIncomplete,
      promptDiagnostics: params.promptDiagnostics,
      inference: params.inference,
      coverage: params.coverage,
      coverageRequired: params.coverageRequired,
      missingAsks: params.missingAsks,
    });

    logReplyGenerationOutcome({
      ctx,
      outcome: params.outcome,
      finalReply: params.generatedReply || result.reply,
      isIncomplete: params.isIncomplete,
      promptDiagnostics: params.promptDiagnostics,
      inference: params.inference,
      fallbackAction: result.fallbackAction,
      fallbackReason: result.fallbackReason,
      coverage: params.coverage,
      metadata: {
        repairAttempted,
        repairApplied,
      },
      timings: params.timings,
    });

    return result;
  };

  const emptyTimings = () => ({
    wallDurationMs: Date.now() - wallStart,
    firstGenerationWallMs: null as number | null,
    coveragePhaseWallMs: null as number | null,
    repairGenerationWallMs: null as number | null,
  });

  if (!latestCustomerMessage.trim()) {
    return logAndReturn({ outcome: "empty_input", timings: emptyTimings() });
  }

  const hasFinalWriterProvider = canUseTextAI();

  if (!hasFinalWriterProvider) {
    return logAndReturn({ outcome: "no_provider", timings: emptyTimings() });
  }

  const { redacted, map } = redactPII(latestCustomerMessage || "");
  const started = Date.now();
  let firstGenerationWallMs: number | null = null;
  let coveragePhaseWallMs: number | null = null;
  let repairGenerationWallMs: number | null = null;

  try {
    const alreadyGreeted =
      ctx.alreadyGreeted ??
      (await hasGreetedToday(ctx.conversationId).catch(() => false));

    const outputProfile = resolveReplyOutputProfile(ctx);
    const hasGroundedContext = hasGroundedReplyContext(ctx);
    const languageName = getLanguageName(language);
    const companyBlock = formatCompanyContext(ctx.companyContext);
    const retrievalPlanForDiscipline =
      ctx.retrievalPlan ?? createFallbackRetrievalPlan(redacted);
    const citationDiscipline = resolveEffectiveCitationDiscipline({
      plan: retrievalPlanForDiscipline,
      groundedStrictEnforcement: RAG_CONFIG.features.groundedStrictCitation,
      hasRetrievedSources: hasGroundedContext,
    });
    const groundedContext = buildGroundedContextBlock(
      language,
      ctx.snippetContext,
      ctx.kbContext,
      outputProfile,
      citationDiscipline,
      ctx.attachKbArticlePageLinks
    );
    const quickRepliesBlock = buildQuickRepliesBlock(ctx.quickReplies);
    const answerCoveragePlan = buildAnswerCoveragePlan({
      openAsks: ctx.openAsks,
      followUpAnchor: ctx.followUpAnchor,
    });
    const activeSelectionBlock = buildActiveSelectionPromptBlock(
      ctx.activeSelection
    );
    const sanitizedAgentContextBlock = stripAnswerPlanOverlapFromAgentContext({
      agentContextBlock: [ctx.agentContextBlock, activeSelectionBlock]
        .filter(Boolean)
        .join("\n\n"),
      hasAnswerCoverageBlock: answerCoveragePlan.requiresCoverageCheck,
    });
    const relatedConversationContextBlock =
      buildRelatedConversationContextBlock({
        crossConversationContext: ctx.crossConversationContext,
        conversationSummaries: ctx.conversationSummaries,
      });
    const threadMemorySummary = normalizeThreadMemorySummary(
      ctx.threadMemorySummary ||
        (ctx.conversationWindow &&
        ctx.conversationWindow.startsWith("THREAD MEMORY SUMMARY")
          ? ctx.conversationWindow
          : "")
    );
    const recentConversationTail =
      ctx.recentConversationTail ||
      (!threadMemorySummary ? ctx.conversationWindow || "" : "");
    const channelInstruction = getDefaultChannelEnvelopeLine(ctx.channel);
    // The prompt budget follows the provider that writes first.
    const firstWriterProviderOrder = resolveFinalWriterProviderOrder();
    const providerBudget =
      firstWriterProviderOrder[0] === "anthropic" ? "anthropic" : "vertex";

    const buildEnvelope = (options?: {
      compactMode?: boolean;
      previousIncompleteDraft?: string;
      missingAsks?: string[];
      selectionRepairInstruction?: string;
    }) =>
      buildReplyPromptEnvelope({
        providerBudget,
        outputProfile,
        language,
        languageName,
        alreadyGreeted,
        channelInstruction,
        hasGroundedContext,
        latestCustomerMessage: redacted,
        scenarioInstruction: [
          ctx.scenarioInstruction,
          options?.selectionRepairInstruction,
        ]
          .filter(Boolean)
          .join("\n\n"),
        customerAnswersBlock: ctx.customerAnswersBlock,
        answerCoverageBlock: renderAnswerCoverageBlock(answerCoveragePlan, {
          missingAsks: options?.missingAsks,
        }),
        groundedContext,
        agentContextBlock: sanitizedAgentContextBlock,
        threadMemorySummary,
        recentConversationTail,
        crossConversationContext: relatedConversationContextBlock,
        calendarAvailabilityBlock: ctx.calendarAvailabilityBlock,
        quickRepliesBlock,
        companyContextBlock: companyBlock,
        widgetContextBlock: ctx.widgetContextBlock,
        previousIncompleteDraft: options?.previousIncompleteDraft,
        compactMode: options?.compactMode,
        agentName: ctx.agentName,
        greetingBehavior: ctx.greetingBehavior,
        customInstructions: ctx.customInstructions,
        responseStyle: ctx.responseStyle,
        citationDiscipline,
      });

    const initialEnvelope = buildEnvelope();
    const callProviderChain = async (
      envelope: ReplyPromptEnvelope,
      options?: {
        temperature?: number;
        stream?: boolean;
        maxTimeoutMs?: number;
        maxOutputTokens?: number;
        providerOrder?: AIChatProvider[];
      }
    ): Promise<ProviderGenerationResult> => {
      const timeoutMs = generationDeadline.nextTimeoutMs(
        options?.maxTimeoutMs ?? FINAL_WRITER_CALL_TIMEOUT_MS
      );
      if (!timeoutMs) {
        throw new Error("Final-generation inference deadline exhausted");
      }
      // Heavy tier, resolved per call so the model matches the provider that
      // is configured right now (Claude, or Gemini when Claude is off).
      const finalWriterModel = getHeavyTextModel();
      const response = await chatCompletionWithFallback({
        model: finalWriterModel,
        providerOrder:
          options?.providerOrder ?? resolveFinalWriterProviderOrder(),
        messages: [
          { role: "system", content: envelope.systemPrompt },
          { role: "user", content: envelope.userPrompt },
        ],
        temperature: options?.temperature ?? 0.4,
        generationConfig: {
          ...getStructuredJsonGenerationConfig(finalWriterModel),
          maxOutputTokens: options?.maxOutputTokens ?? envelope.outputMaxTokens,
        },
        resilience: {
          maxRetries: 0,
          timeoutMs,
        },
        analytics: {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          operation: "airi.reply.final_generation",
          inputText: `${envelope.systemPrompt}\n\n${envelope.userPrompt}`,
          sourceService: "web.airi.reply",
          metadata: {
            channel: ctx.channel || null,
            stream: Boolean(options?.stream),
            hasSnippet: Boolean(ctx.retrievalMetadata?.hasSnippet),
            hasKB: Boolean(ctx.retrievalMetadata?.hasKB),
            retrievalPriority: ctx.retrievalMetadata?.priority || null,
          },
        },
        // Only stream on the first generation pass. Repair passes retry with
        // the full text already known, so streaming drafts would be confusing.
        ...(options?.stream && ctx.onReplyDelta
          ? { onDelta: ctx.onReplyDelta }
          : {}),
      });
      return {
        content: (response.content || "").trim(),
        provider: response.provider,
        model: response.model || finalWriterModel,
        usage: response.usage,
        latencyMs: response.latencyMs || Date.now() - started,
        finishReason: response.finishReason,
      };
    };

    let activeEnvelope = initialEnvelope;
    let usedOutputMaxTokens = initialEnvelope.outputMaxTokens;

    const firstGenStarted = Date.now();
    const generation = await callProviderChain(initialEnvelope, {
      stream: true,
      // The order the initial envelope was budgeted for.
      providerOrder: firstWriterProviderOrder,
    });
    firstGenerationWallMs = Date.now() - firstGenStarted;

    let finalReply = normalizeReplyText(
      unredact(generation.content, map).trim(),
      MAX_REPLY_CHAR_LIMIT
    );
    let finalFinishReason = generation.finishReason || null;
    let totalLatencyMs = generation.latencyMs;
    let finalModel = generation.model;
    let finalProvider = generation.provider;
    let finalUsage = generation.usage;
    const resolveCoverageResult = (replyText: string) =>
      evaluateAnswerCoverage({
        reply: replyText,
        plan: answerCoveragePlan,
        latestCustomerMessage: redacted,
        conversationContext: [
          threadMemorySummary
            ? `Thread memory summary:\n${threadMemorySummary}`
            : "",
          recentConversationTail
            ? `Recent conversation:\n${recentConversationTail}`
            : "",
          relatedConversationContextBlock
            ? `Related conversation context:\n${relatedConversationContextBlock}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        groundedContext,
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        timeoutMs:
          generationDeadline.nextTimeoutMs(COVERAGE_JUDGE_TIMEOUT_MS) ?? 0,
      });

    const coveragePhaseStarted = Date.now();
    let coverageResult = await resolveCoverageResult(finalReply);
    let selectionConsistency = evaluateActiveSelectionReplyConsistency({
      reply: finalReply,
      selection: ctx.activeSelection,
    });

    const initialIncomplete =
      isInterruptedFinishReason(generation.finishReason) ||
      isLikelyIncompleteAssistantReply(finalReply, generation.finishReason) ||
      !selectionConsistency.isConsistent ||
      (answerCoveragePlan.requiresCoverageCheck &&
        !coverageResult.fullyCovered);

    if (hasFinalWriterProvider && initialIncomplete) {
      repairAttempted = true;

      const repairStarted = Date.now();
      try {
        const repairEnvelope = buildEnvelope({
          compactMode: true,
          previousIncompleteDraft: finalReply.slice(0, MAX_REPLY_CHAR_LIMIT),
          missingAsks: coverageResult.missingAsks,
          selectionRepairInstruction: selectionConsistency.repairInstruction,
        });
        activeEnvelope = repairEnvelope;
        usedOutputMaxTokens = Math.min(
          repairEnvelope.outputMaxTokens + 200,
          1600
        );
        const repaired = await callProviderChain(repairEnvelope, {
          temperature: 0.2,
          maxTimeoutMs: REPAIR_GENERATION_TIMEOUT_MS,
          maxOutputTokens: usedOutputMaxTokens,
        });
        const repairedReply = normalizeReplyText(
          unredact(repaired.content, map).trim() || finalReply,
          MAX_REPLY_CHAR_LIMIT
        );

        const previouslyJudgedReply = finalReply;
        if (
          shouldPreferRetriedAssistantReply(finalReply, repairedReply, {
            original: finalFinishReason,
            candidate: repaired.finishReason,
          })
        ) {
          repairApplied = true;
          finalReply = repairedReply;
          finalFinishReason = repaired.finishReason || null;
          finalModel = repaired.model;
          finalProvider = repaired.provider;
          finalUsage = repaired.usage;
          totalLatencyMs += repaired.latencyMs;
        } else {
          totalLatencyMs += repaired.latencyMs;
        }
        // The existing judgment still applies when repair preserves the reply.
        if (finalReply !== previouslyJudgedReply) {
          coverageResult = await resolveCoverageResult(finalReply);
        }
        selectionConsistency = evaluateActiveSelectionReplyConsistency({
          reply: finalReply,
          selection: ctx.activeSelection,
        });
      } catch (repairError) {
        if (isWorkspaceAiPolicyError(repairError)) throw repairError;
      }
      repairGenerationWallMs = Date.now() - repairStarted;
    }

    coveragePhaseWallMs = Date.now() - coveragePhaseStarted;

    if (alreadyGreeted) {
      const stripped = stripDuplicateGreetingLead(finalReply, true);
      if (stripped !== finalReply) {
        airiReplyLogger.info("airi.reply.generation", {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          channel: ctx.channel || null,
          outcome: "duplicate_greeting_lead_stripped",
          strippedChars: finalReply.length - stripped.length,
        });
      }
      finalReply = stripped;
    }

    const isIncomplete =
      isInterruptedFinishReason(finalFinishReason) ||
      isLikelyIncompleteAssistantReply(finalReply, finalFinishReason) ||
      !selectionConsistency.isConsistent ||
      (answerCoveragePlan.requiresCoverageCheck &&
        !coverageResult.fullyCovered);

    const promptDiagnostics: AssistantReplyPromptDiagnostics = {
      providerBudget: activeEnvelope.providerBudget,
      inputCharLimit: activeEnvelope.inputCharLimit,
      inputTokenLimit: activeEnvelope.inputTokenLimit,
      outputProfile: activeEnvelope.outputProfile,
      usedOutputMaxTokens,
      estimatedInputChars: activeEnvelope.estimatedInputChars,
      estimatedInputTokens: activeEnvelope.estimatedInputTokens,
      sectionsIncluded: activeEnvelope.sectionsIncluded,
      trimmedSections: activeEnvelope.trimmedSections,
      droppedSections: activeEnvelope.droppedSections,
      sectionBudgets: activeEnvelope.sectionBudgets,
      wasOverBudget: activeEnvelope.wasOverBudget,
    };

    const inferenceResult = {
      provider: finalProvider,
      model: finalModel,
      latencyMs: totalLatencyMs,
      promptTokens: finalUsage?.prompt_tokens,
      completionTokens: finalUsage?.completion_tokens,
      totalTokens: finalUsage?.total_tokens,
      finishReason: finalFinishReason,
    };

    const replyTimings = {
      wallDurationMs: Date.now() - wallStart,
      firstGenerationWallMs,
      coveragePhaseWallMs,
      repairGenerationWallMs,
    };

    if (isIncomplete) {
      return logAndReturn({
        outcome: "fallback_after_incomplete",
        generatedReply: finalReply,
        finishReason: finalFinishReason,
        markedIncomplete: true,
        isIncomplete: true,
        promptDiagnostics,
        inference: inferenceResult,
        coverage: coverageResult,
        coverageRequired: answerCoveragePlan.requiresCoverageCheck,
        missingAsks: coverageResult.missingAsks,
        timings: replyTimings,
      });
    }

    return logAndReturn({
      outcome: "success",
      generatedReply: finalReply,
      finishReason: finalFinishReason,
      promptDiagnostics,
      inference: inferenceResult,
      coverage: coverageResult,
      coverageRequired: answerCoveragePlan.requiresCoverageCheck,
      missingAsks: coverageResult.missingAsks,
      timings: replyTimings,
    });
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    let fallbackResult = buildFallbackResult();
    let catchReply = fallbackResult.reply;

    if (!catchReply) {
      try {
        const catchAlreadyGreeted =
          ctx.alreadyGreeted ??
          (await hasGreetedToday(ctx.conversationId).catch(() => false));
        const actionTypeMap: Record<string, FallbackRecoveryReplyType> = {
          grounded_recovery: "grounded_recovery",
          intent_fallback: "missing_knowledge",
          generic_clarification: "generic_clarification",
        };
        const fallbackRecovery = await generateFallbackRecoveryReplyResult({
          type:
            actionTypeMap[fallbackResult.fallbackAction || ""] ||
            "generic_clarification",
          language,
          channel: ctx.channel,
          persona: ctx.workspacePersona,
          channelInstructions: ctx.channelInstructions,
          recoveryContext: fallbackResult.recoveryContext,
          alreadyGreetedToday: catchAlreadyGreeted,
          timeoutMs: FALLBACK_RECOVERY_TIMEOUT_MS,
        });
        catchReply = fallbackRecovery.reply;
        // Route the answer recovery actually produced, not the failed draft.
        // A complete recovery must not request another recovery from RAG.
        fallbackResult = buildFallbackResult({
          generatedReply: catchReply,
          finishReason: fallbackRecovery.finishReason,
          markedIncomplete: fallbackRecovery.isIncomplete,
          isIncomplete: fallbackRecovery.isIncomplete,
          inference: fallbackRecovery.model
            ? {
                provider: fallbackRecovery.provider || undefined,
                model: fallbackRecovery.model,
                latencyMs: fallbackRecovery.latencyMs ?? 0,
                finishReason: fallbackRecovery.finishReason,
              }
            : undefined,
        });
      } catch (fallbackError) {
        if (isWorkspaceAiPolicyError(fallbackError)) throw fallbackError;
        /* LLM also failed; empty reply is acceptable */
      }
    }

    airiReplyLogger.error("airi.reply.generation", error, {
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      channel: ctx.channel || null,
      outcome: "failed",
      durationMs: Date.now() - wallStart,
      fallbackAction: fallbackResult.fallbackAction || null,
      fallbackReason: fallbackResult.fallbackReason || null,
      retrievalPriority: ctx.retrievalMetadata?.priority || null,
      repairAttempted,
      repairApplied,
    });
    return { ...fallbackResult, reply: catchReply || "" };
  }
}

export const generateAssistantReply = traceableChain(
  generateAssistantReplyImpl,
  {
    name: "airi.reply.final_generation",
    tags: ["airi", "reply", "generation"],
    getMetadata: (_latestCustomerMessage, ctx) => ({
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      channel: ctx.channel || null,
      preferred_language: ctx.preferredLanguage || null,
    }),
    processInputs: inputs => {
      const payload = "args" in inputs ? inputs.args : [inputs];
      const [latestCustomerMessage, ctx] = payload as [
        string,
        AssistantReplyContext,
      ];
      return {
        workspace_id: ctx.workspaceId,
        conversation_id: ctx.conversationId,
        language: ctx.preferredLanguage || null,
        latest_message_preview: previewText(latestCustomerMessage, 240),
        channel: ctx.channel || null,
        active_goals: previewStringArray(ctx.activeGoals || [], 4, 120),
        open_asks: previewStringArray(ctx.openAsks || [], 4, 120),
        follow_up_anchor: previewText(ctx.followUpAnchor, 160),
        has_snippet: Boolean(ctx.retrievalMetadata?.hasSnippet),
        has_kb: Boolean(ctx.retrievalMetadata?.hasKB),
        kb_count: ctx.kbContext?.length || 0,
        active_selection: ctx.activeSelection
          ? {
              kind: ctx.activeSelection.kind,
              label: ctx.activeSelection.label,
              quoted_price: ctx.activeSelection.quotedPriceText,
              source_kind: ctx.activeSelection.sourceKind,
            }
          : null,
        has_calendar_availability: Boolean(ctx.calendarAvailabilityBlock),
        has_customer_answers: Boolean(ctx.customerAnswersBlock),
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as AssistantReplyResult;
      return {
        reply_preview: previewText(result.reply, 260),
        is_incomplete: Boolean(result.isIncomplete),
        finish_reason: result.finishReason || null,
        fallback_action: result.fallbackAction || null,
        fallback_reason: result.fallbackReason || null,
        coverage_missing: previewStringArray(
          result.coverage?.missingAsks || [],
          4,
          120
        ),
        model: result.inference?.model || null,
        provider: result.inference?.provider || null,
        latency_ms: result.inference?.latencyMs || null,
      };
    },
  }
);
