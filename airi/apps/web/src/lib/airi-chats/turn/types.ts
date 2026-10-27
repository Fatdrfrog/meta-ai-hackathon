/** Shared types of one Airi chat turn: inputs, replies and progress. */

import type { AiriLanguage } from "@/lib/airi/shared/language-policy";
import type { AiriChatReplyAnalytics } from "@/lib/airi-chats/analytics";
import type { AiriChatSelectedGroundingContext } from "@/lib/airi-chats/sources";
import type { ActiveAiriBuilderInput } from "@/lib/airi-chats/builder-state";
import type { AiriChatAttachmentInput } from "@/lib/airi-chats/request-schemas";
import type { AiriChatSourceRef } from "@/lib/airi-chats/source-types";
import type { AiriChatIntentClassification } from "@/lib/airi-chats/intent-classifier";
import type { AiriMarketingToolAccess } from "@/lib/airi-chats/marketing-package";
import type { AiriChatPendingAction } from "@/lib/airi-chats/pending-actions";
import type {
  AiriChatRunProgressEmitter,
  AiriChatRunResource,
  AiriChatThinkingTrace,
} from "@/lib/airi-chats/run-events";
import type { createClient } from "@/lib/supabase/server";
import type { AskDataContextGatewayResponse } from "@icecore/airi-runtime/ai-gateway";
import type {
  AiriChatWorkspaceRetrieval,
  AiriChatWorkspaceWork,
} from "./retrieval";
import type { AiriTurnDeadline } from "./deadline";

export type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type GeneratedAiriChatReply = {
  content: string;
  metadata: Record<string, unknown>;
  analytics: AiriChatReplyAnalytics;
};

/** What every turn handler returns: the reply to save. */
export type AiriTurnResult = GeneratedAiriChatReply;

export type SerializedAiriChatThread = {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  source: string;
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SerializedAiriChatMessage = {
  id: string;
  threadId: string;
  workspaceId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ThreadLike = {
  _id: unknown;
  workspaceId: string;
  title: string;
  status: string;
  source: string;
  pinnedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type MessageLike = {
  _id: unknown;
  threadId: unknown;
  workspaceId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
};

export type AiriChatProgressRecorder = {
  emit: AiriChatRunProgressEmitter;
  stages: AiriChatThinkingTrace["stages"];
  resources: AiriChatRunResource[];
  /** True when a live client receives the events (the SSE routes). */
  live: boolean;
};

export type AiriChatGeneratorStage = { id: string; label: string };

/** Routing outcome of a turn, kept so every saved reply can record it. */
export type AiriChatTurnRouting = {
  classification?: AiriChatIntentClassification;
};

/** Input of one turn's reply generation (the user message is saved). */
export type AiriTurnReplyParams = {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  threadId: string;
  userMessageId?: string | null;
  userMessage: string;
  selectedSources?: AiriChatSourceRef[];
  attachedFiles?: AiriChatAttachmentInput[];
  activeBuilder?: unknown;
  preparedSelectedContext?: AiriChatSelectedGroundingContext | null;
  /** Language and retrieval the turn started before grounding its sources. */
  preparedWorkspaceWork?: AiriChatWorkspaceWork;
  progress?: AiriChatProgressRecorder;
  routing?: AiriChatTurnRouting;
  signal?: AbortSignal;
  /** The turn's one deadline; a direct reply call starts its own. */
  deadline?: AiriTurnDeadline;
};

/** The source ids and retrieval path every reply records. */
export type AiriChatSourceContext = Pick<
  AiriChatReplyAnalytics,
  "sourceIds" | "conversationSourceIds" | "kbSourceIds" | "retrievalPath"
>;

/**
 * Everything the turn gathered before dispatch. Handlers read it and return
 * the reply to save; none of them repeats retrieval or classification.
 */
export type AiriTurnContext = {
  params: AiriTurnReplyParams;
  deadline: AiriTurnDeadline;
  startedAt: number;
  progress: AiriChatProgressRecorder;
  intentClassification: AiriChatIntentClassification;
  activeBuilder: ActiveAiriBuilderInput | null;
  attachedFiles: AiriChatAttachmentInput[];
  normalizedSelectedSources: AiriChatSourceRef[];
  airiLanguage: AiriLanguage;
  selectedContext: AiriChatSelectedGroundingContext | null;
  workspaceRetrieval: AiriChatWorkspaceRetrieval;
  searchResult: AskDataContextGatewayResponse;
  sourceContext: AiriChatSourceContext;
  selectedSourceLabels: string[];
  resourceItems: AiriChatRunResource[];
  pendingActions: AiriChatPendingAction[];
  traceId: string;
  history: SerializedAiriChatMessage[];
  historyContext: string;
  kbContext: string;
  conversationContext: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  /** Marketing tool access, started at most once per turn. */
  getToolAccess: () => Promise<AiriMarketingToolAccess>;
  /** The Meta Ads conversation id, started with the intent. */
  metaConversationIdPromise: Promise<string> | null;
  /**
   * The one catch for a generator step: the busy reply on a retryable
   * provider failure; anything else is rethrown to the turn's failure reply.
   */
  recoverFromGeneratorFailure: (
    error: unknown,
    stage: AiriChatGeneratorStage,
    requestedModel?: string
  ) => Promise<GeneratedAiriChatReply>;
};

/** One intent's step of the turn. */
export type AiriTurnHandler = (
  context: AiriTurnContext
) => Promise<AiriTurnResult>;
