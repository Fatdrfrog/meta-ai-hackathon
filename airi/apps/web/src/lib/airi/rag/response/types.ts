import type { KnowledgeSearchPrincipal } from "@/lib/airi/rag/knowledge/knowledge-search-permissions";
import type {
  KBArticleResult,
  KnowledgeCanonicalSourceKind,
} from "@/lib/airi/rag/kb/kb-types";
import type { GroundedReplyOption } from "@icecore/shared/types/message-preview";
import type { RagQueryPreparation } from "@/lib/airi/rag/query/query-cleaner";
import type {
  EvidenceChunk,
  EvidencePools,
} from "@/lib/airi/rag/evidence/evidence-types";
import type { ContextDecision, RetrievedAnswer } from "@/lib/airi/rag/types";
import type { AssistantReplyPromptDiagnostics } from "@/lib/airi/reply/generation/reply-generation";
import type {
  ReplyFallbackAction,
  ReplyFallbackReason,
} from "@/lib/airi/reply/generation/reply-fallback-policy";
import type { AiriActiveSelection } from "@/lib/airi/reply/selection";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import type { TurnFollowUpMode } from "@/lib/airi/reply/turn/understand-customer-turn";
import type { WorkspaceAgentPersona } from "@/lib/airi/agent-context";
import type { Channel } from "@/types/models";
import type {
  ChannelInstructions,
  CustomAvailableAction,
  EscalationBehavior,
  GreetingBehavior,
  ResponseStyle,
} from "@/lib/airi/workspace-bot-contract";
import type { MissingKnowledgeSignal } from "@/lib/airi/grounding/factual-grounding-guard";
import type { RetrievalIntentClassification } from "@/lib/airi/rag/query/retrieval-intent-classifier";

export type RagProductMode = "answer" | "retrieve" | "context";

/**
 * One shared retrieval-summary shape across the whole pipeline.
 *
 * The summary is intentionally a `Record<string, unknown>` today: fields are
 * written from many layers (orchestrator base via `getRetrievalSummary`,
 * rag-response-service for selection/scenario metadata, and
 * rag-response-routing for factual-grounding guard). This
 * named alias pins it down as a single identity so downstream consumers
 * don't invent their own local `Record<string, unknown>` shapes and layer
 * further re-copies on top of each other — see Phase 1.6 in the production
 * hardening plan. Future phases will gradually tighten this to a typed
 * interface once the writer set stabilizes.
 */
export type RetrievalSummary = Record<string, unknown>;

export interface RAGResponseResult {
  type:
    | "verified_snippet"
    | "suggestion_with_ai"
    | "ai_reply"
    | "fallback"
    | "evidence_retrieve"
    | "evidence_context";
  content?: string;
  generationIncomplete?: boolean;
  generationFinishReason?: string | null;
  generationPromptDiagnostics?: AssistantReplyPromptDiagnostics;
  snippet?: RetrievedAnswer;
  kbArticles?: KBArticleResult[];
  decision?: ContextDecision;
  retrievalSummary?: RetrievalSummary;
  shouldAutoSend?: boolean;
  /** Public article page URLs for footer append when channel/workspace policy allows. */
  attachedArticleLinks?: Array<{ url: string; title: string }>;
  missingKnowledgeSignal?: MissingKnowledgeSignal;
  fallbackAction?: ReplyFallbackAction;
  fallbackReason?: ReplyFallbackReason;
  generationInference?: {
    provider?: string;
    model: string;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    finishReason?: string | null;
  };
  coverage?: {
    asksDetected: string[];
    asksAnswered: string[];
    missingAsks: string[];
  };
  productMode?: RagProductMode;
  rankedEvidence?: EvidenceChunk[];
  evidencePools?: EvidencePools;
  groundedReplyOptions?: GroundedReplyOption[];
}

export interface RAGGenerateResponseParams {
  workspaceId: string;
  conversationId: string;
  channel?: Channel;
  /** The retrieval query: the turn plan may rewrite it from history. */
  text: string;
  /** What the customer actually sent, for the writer and every fallback. */
  customerMessage?: string;
  language: string;
  conversationWindow: string;
  intentAnchor?: string;
  conversationContext?: string;
  lastMessageQuery?: string;
  currentGoal?: string;
  activeGoals?: string[];
  openAsks?: string[];
  queryVariants?: string[];
  followUpAnchor?: string;
  coverageHints?: string[];
  unresolvedNeeds?: string[];
  resolvedNeeds?: string[];
  hasUnresolvedNeed?: boolean;
  dominantLanguage?: string;
  lastGrounding?: {
    sourceKind: "snippet" | "kb" | "mixed" | "none";
    sourceIds: string[];
    intentAnchor: string | null;
    answeredAsks: string[];
    updatedAt?: Date | string | null;
  } | null;
  activeSelection?: AiriActiveSelection;
  followUpMode?: TurnFollowUpMode;
  seedRagQueryPreparation?: RagQueryPreparation;
  retrievalIntent?: RetrievalIntentClassification;
  companyContext: {
    businessContext?: string;
    dynamicTags?: string[];
  };
  threadMemorySummary?: string;
  recentConversationTail?: string;
  crossConversationContext?: string;
  calendarAvailabilityBlock?: string;
  calendarAvailabilitySignature?: string;
  /** Customer answers the scenario instruction names, as quoted lines. */
  customerAnswersBlock?: string;
  widgetContextBlock?: string;
  channelContextBlock?: string;
  engine?: "vertex";
  fastMode?: boolean;
  scenarioRuntime?: AiriScenarioRuntimeConfig;
  scenarioInstructionOverride?: string;
  workspacePersona?: WorkspaceAgentPersona;
  elevenlabsAgentId?: string;
  alreadyGreeted?: boolean;
  customInstructions?: string;
  greetingBehavior?: GreetingBehavior;
  escalationBehavior?: EscalationBehavior;
  responseStyle?: ResponseStyle;
  customAvailableActions?: CustomAvailableAction[];
  channelInstructions?: ChannelInstructions;
  productMode?: RagProductMode;
  knowledgeSearchPrincipal?: KnowledgeSearchPrincipal;
  matchAllowedVisibilities?: string[] | null;
  matchSourceKinds?: KnowledgeCanonicalSourceKind[] | null;
  /** When true with non-widget channels, article page URLs participate in prompts, allowlist, and footer. */
  sendKbArticleLinksToUserChannels?: boolean;
  /**
   * Streaming hook forwarded to {@link generateAssistantReply}. Invoked for
   * each incremental text chunk from the final writer model. Used by the
   * Telegram auto-reply path to emit `sendMessageDraft` animations.
   */
  onReplyDelta?: (event: {
    delta: string;
    accumulated: string;
  }) => void | Promise<void>;
}
