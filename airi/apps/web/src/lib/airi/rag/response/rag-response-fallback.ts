import type { WorkspaceAgentPersona } from "@/lib/airi/agent-context";
import {
  toMissingKnowledgeSignal,
  type FactualGroundingGuardResult,
  type MissingKnowledgeSignal,
} from "@/lib/airi/grounding/factual-grounding-guard";
import { getLanguageName } from "@/lib/airi/language-detector";
import type { ResponsePolicy } from "@/lib/airi/rag/evidence/evidence-types";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import type { ContextDecision } from "@/lib/airi/rag/types";
import {
  generateFallbackRecoveryReplyResult,
  type FallbackRecoveryReplyType,
} from "@/lib/airi/reply/generation/fallback-recovery-reply";
import {
  latestConversationTurns,
  resolveReplyFallbackDecision,
  type FallbackRecoveryContext,
  type RecoveryTurnContext,
  type ReplyFallbackAction,
  type ReplyFallbackReason,
} from "@/lib/airi/reply/generation/reply-fallback-policy";
import type { ChannelInstructions } from "@/lib/airi/workspace-bot-contract";
import type { Channel } from "@/types/models";
import type {
  RAGGenerateResponseParams,
  RAGResponseResult,
  RetrievalSummary,
} from "./types";

/** The scenario step's own instruction, as both the writer and recovery read it. */
export function resolveScenarioReplyInstruction(
  params: Pick<
    RAGGenerateResponseParams,
    "scenarioInstructionOverride" | "scenarioRuntime"
  >
): string {
  return [
    typeof params.scenarioInstructionOverride === "string"
      ? params.scenarioInstructionOverride.trim()
      : "",
    params.scenarioRuntime?.actionReplyInstruction || "",
    params.scenarioRuntime?.actionInstruction || "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What a recovery needs to answer this turn instead of a retrieved topic. */
export function buildRecoveryTurnContext(
  params: Pick<
    RAGGenerateResponseParams,
    | "scenarioInstructionOverride"
    | "scenarioRuntime"
    | "recentConversationTail"
    | "conversationWindow"
  >
): RecoveryTurnContext {
  return {
    stepInstruction: resolveScenarioReplyInstruction(params) || undefined,
    recentConversation: latestConversationTurns(
      params.recentConversationTail || params.conversationWindow
    ),
  };
}

/** Unified shape from {@link generateFallbackRecoveryResolution} and evidence/generic fallbacks. */
export type GenericFallbackResolution = {
  fallbackAction: ReplyFallbackAction;
  fallbackReason: ReplyFallbackReason;
  reply?: string;
  missingKnowledgeSignal?: MissingKnowledgeSignal;
  finishReason?: string | null;
  generationIncomplete?: boolean;
  inference?: {
    provider?: string;
    model: string;
    latencyMs: number;
    finishReason?: string | null;
  };
};

export function hasBusinessContext(companyContext?: {
  businessContext?: string;
  dynamicTags?: string[];
}): boolean {
  return !!(
    companyContext?.businessContext ||
    (companyContext?.dynamicTags && companyContext.dynamicTags.length > 0)
  );
}

export function buildGuardClarificationInstruction(language: string): string {
  const langName = getLanguageName(language);
  return `IMPORTANT: No specific documentation was found for this customer's query, but their question may be relevant to the business.
Instead of saying "I don't know" or "I don't have information", try to:
1. Acknowledge the customer's topic naturally
2. Ask 1-2 specific clarifying questions to better understand their exact need
3. Show willingness to help find the right information
4. Do NOT make up facts, prices, schedules, or specific details
5. Keep the response concise and conversational
6. You MUST reply in ${langName} (language code: ${language}) - match the language the customer is using`;
}

function normalizeFallbackRecoveryReplyResult(
  result:
    | Awaited<ReturnType<typeof generateFallbackRecoveryReplyResult>>
    | string
): Awaited<ReturnType<typeof generateFallbackRecoveryReplyResult>> {
  if (typeof result === "string") {
    return {
      reply: result,
      finishReason: null,
      provider: null,
      model: null,
      latencyMs: null,
      isIncomplete: false,
    };
  }

  return result;
}

function fallbackReplyTypeForAction(
  action: Exclude<
    ReplyFallbackAction,
    "use_generated_reply" | "clarifying_generation"
  >
): FallbackRecoveryReplyType {
  switch (action) {
    case "grounded_recovery":
      return "grounded_recovery";
    case "intent_fallback":
      return "missing_knowledge";
    default:
      return "generic_clarification";
  }
}

function missingKnowledgeSignalFromSummary(
  summary: RetrievalSummary
): MissingKnowledgeSignal | undefined {
  const factualGroundingGuard = summary?.factualGroundingGuard as
    | FactualGroundingGuardResult
    | undefined;
  return factualGroundingGuard
    ? toMissingKnowledgeSignal(factualGroundingGuard) || undefined
    : undefined;
}

export async function generateFallbackRecoveryResolution(params: {
  action: Exclude<
    ReplyFallbackAction,
    "use_generated_reply" | "clarifying_generation"
  >;
  reason: ReplyFallbackReason;
  language: string;
  recoveryContext?: FallbackRecoveryContext;
  workspacePersona?: WorkspaceAgentPersona;
  channel?: Channel;
  channelInstructions?: ChannelInstructions;
  alreadyGreeted?: boolean;
  missingKnowledgeSignal?: MissingKnowledgeSignal;
  emptyFallback?: {
    action: ReplyFallbackAction;
    reason: ReplyFallbackReason;
  };
}): Promise<GenericFallbackResolution> {
  const fallbackReply = normalizeFallbackRecoveryReplyResult(
    await generateFallbackRecoveryReplyResult({
      type: fallbackReplyTypeForAction(params.action),
      language: params.language,
      channel: params.channel,
      persona: params.workspacePersona,
      channelInstructions: params.channelInstructions,
      recoveryContext: params.recoveryContext,
      alreadyGreetedToday: params.alreadyGreeted,
    })
  );

  if (!fallbackReply.reply?.trim()) {
    return {
      fallbackAction: params.emptyFallback?.action ?? params.action,
      fallbackReason: params.emptyFallback?.reason ?? params.reason,
      reply: undefined,
      missingKnowledgeSignal: params.missingKnowledgeSignal,
      finishReason: fallbackReply.finishReason,
      generationIncomplete: true,
    };
  }

  return {
    fallbackAction: params.action,
    fallbackReason: params.reason,
    reply: fallbackReply.reply,
    missingKnowledgeSignal: params.missingKnowledgeSignal,
    finishReason: fallbackReply.finishReason,
    generationIncomplete: fallbackReply.isIncomplete,
    inference: fallbackReply.model
      ? {
          provider: fallbackReply.provider || undefined,
          model: fallbackReply.model,
          latencyMs: fallbackReply.latencyMs || 0,
          finishReason: fallbackReply.finishReason,
        }
      : undefined,
  };
}

export async function resolveEvidencePolicyFallback(params: {
  policy: ResponsePolicy;
  latestCustomerMessage: string;
  turnContext?: RecoveryTurnContext;
  language: string;
  summary: RetrievalSummary;
  intentAnchor?: string;
  kbContext?: KBArticleResult[];
  workspacePersona?: WorkspaceAgentPersona;
  channel?: Channel;
  channelInstructions?: ChannelInstructions;
  alreadyGreeted?: boolean;
}): Promise<GenericFallbackResolution | null> {
  if (params.policy !== "clarify" && params.policy !== "handoff") {
    return null;
  }

  const missingKnowledgeSignal = missingKnowledgeSignalFromSummary(
    params.summary
  );
  const groundedRecoveryContext = resolveReplyFallbackDecision({
    language: params.language,
    latestCustomerMessage: params.latestCustomerMessage,
    intentAnchor: params.intentAnchor,
    turnContext: params.turnContext,
    kbContext: params.kbContext,
    missingKnowledgeSignal,
    allowClarifyingGeneration: false,
  }).recoveryContext;

  if (params.policy === "handoff") {
    return generateFallbackRecoveryResolution({
      action: "intent_fallback",
      reason: "evidence_policy_handoff",
      language: params.language,
      workspacePersona: params.workspacePersona,
      channel: params.channel,
      channelInstructions: params.channelInstructions,
      alreadyGreeted: params.alreadyGreeted,
      missingKnowledgeSignal,
      recoveryContext: {
        ...(groundedRecoveryContext || {}),
        missingKnowledgeIntent:
          missingKnowledgeSignal?.intent ||
          params.intentAnchor ||
          "this request",
        latestCustomerMessage: params.latestCustomerMessage,
        intentAnchor: params.intentAnchor,
      },
    });
  }

  return generateFallbackRecoveryResolution({
    action: "generic_clarification",
    reason: "evidence_policy_clarify",
    language: params.language,
    workspacePersona: params.workspacePersona,
    channel: params.channel,
    channelInstructions: params.channelInstructions,
    alreadyGreeted: params.alreadyGreeted,
    missingKnowledgeSignal,
    recoveryContext: {
      ...(groundedRecoveryContext || {}),
      latestCustomerMessage: params.latestCustomerMessage,
      intentAnchor: params.intentAnchor,
    },
  });
}

export async function resolveGenericFallback(params: {
  latestCustomerMessage: string;
  turnContext?: RecoveryTurnContext;
  language: string;
  summary: RetrievalSummary;
  allowClarifyingGeneration?: boolean;
  intentAnchor?: string;
  kbContext?: KBArticleResult[];
  workspacePersona?: WorkspaceAgentPersona;
  channel?: Channel;
  channelInstructions?: ChannelInstructions;
  alreadyGreeted?: boolean;
}): Promise<GenericFallbackResolution> {
  const factualGroundingGuard = params.summary?.factualGroundingGuard as
    | FactualGroundingGuardResult
    | undefined;
  const missingKnowledgeSignal = factualGroundingGuard
    ? toMissingKnowledgeSignal(factualGroundingGuard)
    : null;
  const fallbackDecision = resolveReplyFallbackDecision({
    language: params.language,
    latestCustomerMessage: params.latestCustomerMessage,
    intentAnchor: params.intentAnchor,
    turnContext: params.turnContext,
    kbContext: params.kbContext,
    missingKnowledgeSignal,
    allowClarifyingGeneration: params.allowClarifyingGeneration,
  });

  const reply = fallbackDecision.reply;
  if (
    !reply &&
    fallbackDecision.action !== "clarifying_generation" &&
    fallbackDecision.action !== "use_generated_reply"
  ) {
    return generateFallbackRecoveryResolution({
      action: fallbackDecision.action,
      reason: fallbackDecision.reason,
      language: params.language,
      workspacePersona: params.workspacePersona,
      channel: params.channel,
      channelInstructions: params.channelInstructions,
      alreadyGreeted: params.alreadyGreeted,
      recoveryContext: fallbackDecision.recoveryContext,
      missingKnowledgeSignal: missingKnowledgeSignal || undefined,
      emptyFallback:
        fallbackDecision.action === "grounded_recovery"
          ? {
              action: "generic_clarification",
              reason: "incomplete_generated_reply",
            }
          : undefined,
    });
  }

  return {
    fallbackAction: fallbackDecision.action,
    fallbackReason: fallbackDecision.reason,
    reply,
    missingKnowledgeSignal: missingKnowledgeSignal || undefined,
    finishReason: null,
    generationIncomplete: false,
    inference: undefined,
  };
}

export function toFallbackResult(
  decision: ContextDecision,
  summary: RetrievalSummary,
  fallback: GenericFallbackResolution
): RAGResponseResult {
  return {
    type: "fallback",
    content: fallback.reply,
    generationIncomplete: fallback.generationIncomplete,
    generationFinishReason: fallback.finishReason,
    decision,
    retrievalSummary: summary,
    missingKnowledgeSignal: fallback.missingKnowledgeSignal,
    fallbackAction: fallback.fallbackAction,
    fallbackReason: fallback.fallbackReason,
    generationInference: fallback.inference,
  };
}

export async function buildGenericFallbackResult(params: {
  latestCustomerMessage: string;
  turnContext?: RecoveryTurnContext;
  language: string;
  decision: ContextDecision;
  summary: RetrievalSummary;
  intentAnchor?: string;
  kbContext?: KBArticleResult[];
  workspacePersona?: WorkspaceAgentPersona;
  channel?: Channel;
  channelInstructions?: ChannelInstructions;
  alreadyGreeted?: boolean;
}): Promise<RAGResponseResult> {
  const fallback = await resolveGenericFallback({
    latestCustomerMessage: params.latestCustomerMessage,
    turnContext: params.turnContext,
    language: params.language,
    summary: params.summary,
    intentAnchor: params.intentAnchor,
    kbContext: params.kbContext,
    workspacePersona: params.workspacePersona,
    channel: params.channel,
    channelInstructions: params.channelInstructions,
    alreadyGreeted: params.alreadyGreeted,
  });

  return toFallbackResult(params.decision, params.summary, fallback);
}
