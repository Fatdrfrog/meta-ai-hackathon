/**
 * The Airi chat turn: load context, start retrieval, language and grounding
 * in parallel, classify, dispatch to the intent handler, persist, emit.
 */

import { awaitWithCancellation, throwIfCancelled } from "@/lib/ai/cancellation";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { scheduleAiriChatAfterResponse } from "@/lib/airi-chats/after-response";
import { AiriChatThreadNotFoundError } from "@/lib/airi-chats/errors";
import {
  describeAiriChatFailure,
  formatAiriChatFailureDetail,
} from "@/lib/airi-chats/failure-diagnostics";
import {
  buildAiriChatAnalyticsSourceContext,
  recordAiriChatTurnAnalyticsEvents,
} from "@/lib/airi-chats/analytics";
import { logger } from "@/lib/logger";
import {
  buildSelectedAiriChatGroundingContext,
  type AiriChatSelectedGroundingContext,
} from "@/lib/airi-chats/sources";
import { normalizeActiveAiriBuilder } from "@/lib/airi-chats/builder-state";
import type { AiriChatAttachmentInput } from "@/lib/airi-chats/request-schemas";
import {
  isExplicitAiriChatMetaAdsRequest,
  normalizeAiriChatSelectedSources,
  type AiriChatSourceRef,
} from "@/lib/airi-chats/source-types";
import {
  classifyAiriChatIntent,
  type AiriChatIntentClassification,
  type AiriChatIntentKind,
} from "@/lib/airi-chats/intent-classifier";
import { resolveAiriMarketingToolAccess } from "@/lib/airi-chats/marketing-tool-access";
import { getMetaAdsMcpConversationId } from "@/lib/airi-chats/meta-ads-mcp-conversation";
import type { AiriMarketingToolAccess } from "@/lib/airi-chats/marketing-package";
import {
  createAiriChatRunEventAt,
  type AiriChatRunProgressEmitter,
} from "@/lib/airi-chats/run-events";
import { AiriChatMessage } from "@/models/airi-chat-message";
import {
  AiriChatThread,
  type AiriChatThreadSource,
} from "@/models/airi-chat-thread";
import { Types } from "mongoose";
import type {
  SupabaseClient,
  GeneratedAiriChatReply,
  SerializedAiriChatThread,
  SerializedAiriChatMessage,
  ThreadLike,
  MessageLike,
  AiriChatProgressRecorder,
  AiriChatTurnRouting,
  AiriTurnReplyParams,
} from "./types";
import {
  createProgressRecorder,
  stageEvent,
  buildModelRunEvent,
} from "./progress";
import {
  serializeThreadRunEvent,
  serializeUserRunMessage,
  serializeAssistantRunMessage,
  serializeAiriChatThread,
  serializeAiriChatMessage,
} from "./serialization";
import {
  assertAiriChatReplyCanBeSaved,
  clampAiriChatReplyForStorage,
  isDefaultAiriChatTitle,
  buildAiriChatTitle,
  createAiriChatThreadDocument,
  getAiriChatThreadForUser,
  listAiriChatTurnHistory,
  type AiriChatThreadDocument,
  touchAiriChatThreadForTurn,
} from "./persistence";
import { generateAiriChatTitle } from "./title";
import {
  startEarly,
  type AiriChatWorkspaceWork,
  startAiriChatWorkspaceWork,
} from "./retrieval";
import {
  buildRetrievedResources,
  buildThreadHistory,
  buildAiriChatConversationContext,
  buildAttachedSourceContextText,
  normalizeAiriChatAttachments,
  buildAttachedFileContextText,
  buildUserMessageMetadata,
  mergeAiriChatSearchResults,
  mergeAiriChatSourceContext,
  buildPendingWhatsAppActions,
} from "./context";
import {
  AIRI_TURN_LOCALIZED_FAILURE_CODES,
  getAiriChatReplyOutcome,
  buildAiriChatFailureReply,
  createAiriTurnStepRecovery,
  mapAiriTurnFailure,
} from "./failure";
import { createAiriTurnDeadline, type AiriTurnDeadline } from "./deadline";
import { dispatchAiriTurn } from "./handlers/index";

/** Every reply records the routing intent; a branch's own value wins. */
export function withAiriChatIntentMetadata(
  reply: GeneratedAiriChatReply,
  classification: AiriChatIntentClassification | undefined
): GeneratedAiriChatReply {
  if (!classification) return reply;
  return {
    ...reply,
    metadata: {
      intent: classification.intent,
      intentConfidence: classification.confidence,
      intentReason: classification.reason,
      ...reply.metadata,
    },
  };
}

export const AIRI_INTENTS_USING_TOOL_ACCESS: ReadonlySet<AiriChatIntentKind> =
  new Set(["product_capability", "opportunity_scan", "marketing_campaign"]);

export function generateAiriChatReply(
  params: Parameters<typeof generateAiriChatReplyInAction>[0]
): ReturnType<typeof generateAiriChatReplyInAction> {
  const routing = params.routing ?? {};
  return withWorkspaceTextAiAction(
    {
      workspaceId: params.workspaceId,
      actionId:
        "airi-chat:" + (params.userMessageId || String(new Types.ObjectId())),
    },
    async () => {
      throwIfCancelled(params.signal);
      const reply = withAiriChatIntentMetadata(
        await generateAiriChatReplyInAction({ ...params, routing }),
        routing.classification
      );
      assertAiriChatReplyCanBeSaved(reply, params.signal);
      return reply;
    }
  );
}

export async function generateAiriChatReplyInAction(
  params: AiriTurnReplyParams
): Promise<GeneratedAiriChatReply> {
  throwIfCancelled(params.signal);
  const startedAt = Date.now();
  // A direct reply call (no turn around it) gets its own deadline.
  const deadline = params.deadline ?? createAiriTurnDeadline();
  const normalizedSelectedSources = normalizeAiriChatSelectedSources(
    params.selectedSources
  );
  const attachedFiles = normalizeAiriChatAttachments(params.attachedFiles);
  const activeBuilder = normalizeActiveAiriBuilder(params.activeBuilder);
  const progress = params.progress ?? createProgressRecorder();

  // Language, selected grounding and workspace retrieval do not depend on
  // the intent, so they start now (or already started with the turn) and
  // overlap the history read and the classifier. Only the customer-message
  // excerpts wait for the intent.
  const workspaceWork =
    params.preparedWorkspaceWork ??
    startAiriChatWorkspaceWork({
      signal: params.signal,
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      query: params.userMessage,
      progress,
      deadline,
      skipRetrieval: isExplicitAiriChatMetaAdsRequest({
        selectedSources: normalizedSelectedSources,
        userMessage: params.userMessage,
      }),
    });
  const languagePromise = workspaceWork.language;
  const selectedContextPromise = startEarly(
    params.preparedSelectedContext !== undefined
      ? Promise.resolve(params.preparedSelectedContext)
      : normalizedSelectedSources.length > 0
        ? buildSelectedAiriChatGroundingContext({
            signal: params.signal,
            supabase: params.supabase,
            workspaceId: params.workspaceId,
            userId: null,
            query: params.userMessage,
            selectedSources: normalizedSelectedSources,
          })
        : Promise.resolve(null)
  );
  let toolAccessPromise: Promise<AiriMarketingToolAccess> | null = null;
  const getToolAccess = () =>
    (toolAccessPromise ??= startEarly(
      resolveAiriMarketingToolAccess({
        supabase: params.supabase,
        workspaceId: params.workspaceId,
      })
    ));

  await progress.emit(stageEvent("history", "Reading chat history", "running"));
  const historyStartedAt = Date.now();
  const history = await awaitWithCancellation(
    listAiriChatTurnHistory({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
    }),
    params.signal
  );
  await progress.emit(
    stageEvent(
      "history",
      "Reading chat history",
      "complete",
      `${history.length} messages`,
      Date.now() - historyStartedAt
    )
  );
  await progress.emit(stageEvent("intent", "Classifying request", "running"));
  const intentStartedAt = Date.now();
  const intentClassification = await awaitWithCancellation(
    classifyAiriChatIntent({
      signal: params.signal,
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userMessageId: params.userMessageId,
      userMessage: params.userMessage,
      selectedSources: normalizedSelectedSources,
      activeBuilder,
      recentMessages: history
        .filter(message => message.id !== params.userMessageId)
        .map(message => ({
          role: message.role,
          content: message.content,
          intent:
            message.role === "assistant" ? message.metadata?.intent : undefined,
        })),
      onLifecycle: async event => {
        await progress.emit(buildModelRunEvent(event));
      },
      timeoutBudgetMs: deadline.remainingMs(),
    }),
    params.signal
  );
  if (params.routing) params.routing.classification = intentClassification;
  await progress.emit(
    stageEvent(
      "intent",
      "Classifying request",
      "complete",
      intentClassification.intent,
      Date.now() - intentStartedAt
    )
  );
  const pendingActions = buildPendingWhatsAppActions({
    workspaceId: params.workspaceId,
    intent: intentClassification.intent,
  });
  // Intent-specific setup overlaps the retrieval that is still running.
  if (AIRI_INTENTS_USING_TOOL_ACCESS.has(intentClassification.intent)) {
    getToolAccess();
  }
  const metaConversationIdPromise =
    intentClassification.intent === "meta_ads_mcp"
      ? startEarly(
          getMetaAdsMcpConversationId({
            workspaceId: params.workspaceId,
            userId: params.userId,
            threadId: params.threadId,
            signal: params.signal,
          })
        )
      : null;
  // Meta Ads answers from its own tools, the thread and attached sources:
  // it never waits for the workspace KB/chat search (owner decision).
  const retrievalPromise =
    intentClassification.intent === "meta_ads_mcp"
      ? workspaceWork.skipRetrieval()
      : workspaceWork.retrieval;

  const [airiLanguage, selectedContext, workspaceRetrieval] =
    await awaitWithCancellation(
      Promise.all([languagePromise, selectedContextPromise, retrievalPromise]),
      params.signal
    );
  const workspaceSearchResult = workspaceRetrieval.result;
  if (normalizedSelectedSources.length > 0) {
    await progress.emit(
      stageEvent(
        "selected_sources",
        "Using attached sources",
        "complete",
        `${normalizedSelectedSources.length} selected`
      )
    );
  }
  const searchResult = mergeAiriChatSearchResults({
    workspaceResult: workspaceSearchResult,
    selectedContext,
  });
  const sourceContext = mergeAiriChatSourceContext({
    automatic: buildAiriChatAnalyticsSourceContext(workspaceSearchResult),
    selectedContext,
  });
  const automaticSearchMetadata = workspaceSearchResult.metadata;
  const selectedSourceLabels = selectedContext?.selectedSourceLabels ?? [];
  const resourceItems = buildRetrievedResources({
    selectedSources: normalizedSelectedSources,
    selectedSourceLabels,
    conversationCount: searchResult.conversations.length,
    kbCount: searchResult.kbArticles.length,
    retrievalPath: sourceContext.retrievalPath,
    retrievalEngine: automaticSearchMetadata?.retrievalPath,
    vectorIndex: automaticSearchMetadata?.vectorIndex,
    fallbackConversationCount:
      automaticSearchMetadata?.fallbackConversationCount,
  });
  await progress.emit({
    type: "resources",
    id: "retrieved_resources",
    label: "Resources used",
    status: "complete",
    resources: resourceItems,
    at: createAiriChatRunEventAt(),
  });
  const traceId = [
    "airi_chat",
    params.workspaceId,
    params.threadId,
    params.userMessageId || String(startedAt),
  ].join(":");

  const conversationContext = await awaitWithCancellation(
    buildAiriChatConversationContext({
      workspaceId: params.workspaceId,
      conversations: searchResult.conversations,
      includeMessageExcerpts:
        intentClassification.intent === "marketing_campaign" ||
        intentClassification.intent === "opportunity_scan" ||
        intentClassification.intent === "meta_ads_mcp",
    }),
    params.signal
  );

  const kbContext = searchResult.kbArticles
    .map(
      (article, index) =>
        `[KB Article ${index + 1}] "${article.title}" (Relevance: ${Math.round(article.relevance_score * 100)}%)\n${article.content.slice(0, 800)}`
    )
    .join("\n\n");
  const historyContext =
    buildThreadHistory(history) || "No previous messages in this Airi chat.";
  const attachedSourceContext = selectedContext
    ? buildAttachedSourceContextText(selectedContext)
    : "No explicit sources attached. Use automatic workspace context.";
  const attachedFileContext = buildAttachedFileContextText(attachedFiles);

  return dispatchAiriTurn({
    params,
    deadline,
    startedAt,
    progress,
    intentClassification,
    activeBuilder,
    attachedFiles,
    normalizedSelectedSources,
    airiLanguage,
    selectedContext,
    workspaceRetrieval,
    searchResult,
    sourceContext,
    selectedSourceLabels,
    resourceItems,
    pendingActions,
    traceId,
    history,
    historyContext,
    kbContext,
    conversationContext,
    attachedSourceContext,
    attachedFileContext,
    getToolAccess,
    metaConversationIdPromise,
    // Every generator step fails the same way: the shared busy reply on a
    // retryable provider error; anything else is rethrown to the turn's
    // failure reply.
    recoverFromGeneratorFailure: createAiriTurnStepRecovery({
      signal: params.signal,
      airiLanguage,
      selectedContext,
      selectedSourceLabels,
      resourceItems,
      sourceContext,
      searchResult,
      pendingActions,
      traceId,
      progress,
      startedAt,
    }),
  });
}

export function appendAiriChatTurn(
  params: Parameters<typeof appendAiriChatTurnInAction>[0]
): ReturnType<typeof appendAiriChatTurnInAction> {
  const userMessageId = params.userMessageId ?? new Types.ObjectId();
  return withWorkspaceTextAiAction(
    {
      workspaceId: params.workspaceId,
      actionId: "airi-chat:" + String(userMessageId),
    },
    () => appendAiriChatTurnInAction(params, userMessageId)
  );
}

export async function appendAiriChatTurnInAction(
  params: {
    supabase: SupabaseClient;
    workspaceId: string;
    userId: string;
    threadId: string;
    /** The route's ownership check already loaded it; skips a second read. */
    thread?: AiriChatThreadDocument | null;
    content: string;
    selectedSources?: AiriChatSourceRef[];
    attachedFiles?: AiriChatAttachmentInput[];
    activeBuilder?: unknown;
    preparedSelectedContext?: AiriChatSelectedGroundingContext | null;
    emitProgress?: AiriChatRunProgressEmitter;
    signal?: AbortSignal;
    /** The turn's one deadline; a turn without one starts it here. */
    deadline?: AiriTurnDeadline;
    /** Allocated by a durable run up front; the wrapper allocates one otherwise. */
    userMessageId?: Types.ObjectId;
  },
  userMessageId: Types.ObjectId,
  preparedGroundingError?: unknown,
  /** A new chat's progress and the workspace work it started first. */
  prepared?: {
    progress: AiriChatProgressRecorder;
    workspaceWork: AiriChatWorkspaceWork;
  }
): Promise<{
  userMessage: SerializedAiriChatMessage;
  assistantMessage: SerializedAiriChatMessage;
  thread: SerializedAiriChatThread;
}> {
  throwIfCancelled(params.signal);
  const deadline = params.deadline ?? createAiriTurnDeadline();
  const progress =
    prepared?.progress ?? createProgressRecorder(params.emitProgress);
  await progress.emit(stageEvent("thread", "Loading chat", "running"));
  const thread =
    params.thread ??
    (await awaitWithCancellation(
      getAiriChatThreadForUser({
        workspaceId: params.workspaceId,
        userId: params.userId,
        threadId: params.threadId,
      }),
      params.signal
    ));
  if (!thread) {
    await progress.emit(stageEvent("thread", "Loading chat", "error"));
    throw new AiriChatThreadNotFoundError();
  }
  await progress.emit(stageEvent("thread", "Loading chat", "complete"));
  await progress.emit({
    type: "thread",
    thread: serializeThreadRunEvent(thread as unknown as ThreadLike),
    at: createAiriChatRunEventAt(),
  });

  const normalizedSelectedSources = normalizeAiriChatSelectedSources(
    params.selectedSources
  );
  // Workspace retrieval and the language need neither the intent nor the
  // attached sources, so they start before grounding and the user-message
  // insert instead of after them. An explicit Meta Ads request skips it.
  const workspaceWork =
    prepared?.workspaceWork ??
    startAiriChatWorkspaceWork({
      signal: params.signal,
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      query: params.content,
      progress,
      deadline,
      skipRetrieval: isExplicitAiriChatMetaAdsRequest({
        selectedSources: normalizedSelectedSources,
        userMessage: params.content,
      }),
    });

  const attachedFiles = normalizeAiriChatAttachments(params.attachedFiles);
  if (normalizedSelectedSources.length > 0) {
    await progress.emit(
      stageEvent(
        "source_validation",
        "Validating attached sources",
        "running",
        `${normalizedSelectedSources.length} selected`
      )
    );
  }
  let groundingPolicyError: unknown = preparedGroundingError;
  let selectedContext: AiriChatSelectedGroundingContext | null = null;
  try {
    selectedContext =
      params.preparedSelectedContext !== undefined
        ? params.preparedSelectedContext
        : normalizedSelectedSources.length > 0
          ? await buildSelectedAiriChatGroundingContext({
              signal: params.signal,
              supabase: params.supabase,
              workspaceId: params.workspaceId,
              userId: params.userId,
              query: params.content,
              selectedSources: normalizedSelectedSources,
            })
          : null;
  } catch (error) {
    if (!isWorkspaceAiPolicyError(error)) workspaceWork.cancel();
    throwIfCancelled(params.signal, error);
    if (!isWorkspaceAiPolicyError(error)) throw error;
    groundingPolicyError = error;
  }
  if (normalizedSelectedSources.length > 0) {
    await progress.emit(
      stageEvent("source_validation", "Validating attached sources", "complete")
    );
  }

  await progress.emit(
    stageEvent("user_message", "Saving your message", "running")
  );
  throwIfCancelled(params.signal);
  const userMessage = await Promise.resolve(
    AiriChatMessage.create({
      _id: userMessageId,
      threadId: thread._id as Types.ObjectId,
      workspaceId: params.workspaceId,
      role: "user",
      content: params.content,
      metadata: buildUserMessageMetadata({
        selectedSources: normalizedSelectedSources,
        attachedFiles,
      }),
    })
  ).catch(error => {
    workspaceWork.cancel();
    throw error;
  });
  await progress.emit(
    stageEvent("user_message", "Saving your message", "complete")
  );
  await progress.emit({
    type: "user_message",
    message: serializeUserRunMessage(userMessage as unknown as MessageLike),
    at: createAiriChatRunEventAt(),
  });

  const generationStartedAt = Date.now();
  const routing: AiriChatTurnRouting = {};
  let reply: GeneratedAiriChatReply;
  try {
    if (groundingPolicyError) throw groundingPolicyError;
    reply = await generateAiriChatReply({
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      userId: params.userId,
      threadId: params.threadId,
      userMessageId: String(userMessage._id),
      userMessage: params.content,
      selectedSources: normalizedSelectedSources,
      attachedFiles,
      activeBuilder: params.activeBuilder,
      preparedSelectedContext: selectedContext,
      preparedWorkspaceWork: workspaceWork,
      signal: params.signal,
      progress,
      routing,
      deadline,
    });
  } catch (error) {
    workspaceWork.cancel();
    throwIfCancelled(params.signal, error);
    logger.error("airi_chat.reply_generation_failed", error, {
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userMessageId: String(userMessage._id),
    });
    // Only the localized failure codes need the (already started) language.
    const failureLanguage = AIRI_TURN_LOCALIZED_FAILURE_CODES.has(
      mapAiriTurnFailure(error, "turn").code
    )
      ? await workspaceWork.language.catch(() => null)
      : null;
    await progress.emit(
      stageEvent("generation_recovery", "Saving failure response", "running")
    );
    await progress.emit(
      stageEvent(
        "generation_recovery",
        "Saving failure response",
        "complete",
        formatAiriChatFailureDetail(describeAiriChatFailure(error))
      )
    );
    reply = withAiriChatIntentMetadata(
      buildAiriChatFailureReply({
        workspaceId: params.workspaceId,
        threadId: params.threadId,
        userMessageId: String(userMessage._id),
        startedAt: generationStartedAt,
        progress,
        error,
        language: failureLanguage,
      }),
      routing.classification
    );
  }
  // Settled by now when the reply used it; otherwise no longer needed.
  workspaceWork.cancel();

  await progress.emit(
    stageEvent("assistant_message", "Saving Airi response", "running")
  );
  assertAiriChatReplyCanBeSaved(reply, params.signal);
  reply = clampAiriChatReplyForStorage(reply);
  // The thread write (updatedAt, and the first-message title for a new chat)
  // lands with the answer, before 'done' releases the composer, so the next
  // turn never sees a stale default title. It runs beside the insert.
  const fallbackTitle =
    !params.signal?.aborted &&
    !reply.metadata.failed &&
    isDefaultAiriChatTitle(thread.title)
      ? buildAiriChatTitle(params.content)
      : null;
  const [assistantMessage, titledWithFallback] = await Promise.all([
    AiriChatMessage.create({
      threadId: thread._id as Types.ObjectId,
      workspaceId: params.workspaceId,
      role: "assistant",
      content: reply.content,
      metadata: reply.metadata,
    }),
    touchAiriChatThreadForTurn({
      threadId: thread._id,
      seenTitle: thread.title,
      fallbackTitle,
      at: new Date(),
    }).then(result => {
      thread.updatedAt = result.at;
      if (result.titled && fallbackTitle) thread.title = fallbackTitle;
      return result.titled;
    }),
  ]);
  await progress.emit(
    stageEvent("assistant_message", "Saving Airi response", "complete")
  );
  await progress.emit({
    type: "assistant_message",
    message: serializeAssistantRunMessage(
      assistantMessage as unknown as MessageLike
    ),
    at: createAiriChatRunEventAt(),
  });

  // The answer is saved: release the client now. Analytics and the generated
  // title run after the response and can no longer delay or fail this turn.
  // The stream is closed by then, so the generated title reaches the client
  // on its next thread-list or thread load, not through this run.
  await progress.emit({
    type: "done",
    thread: serializeThreadRunEvent(thread as unknown as ThreadLike),
    at: createAiriChatRunEventAt(),
  });

  const userMessageIdText = String(userMessage._id);
  const assistantMessageIdText = String(assistantMessage._id);
  scheduleAiriChatAfterResponse(
    "turn_bookkeeping",
    async () => {
      if (titledWithFallback && fallbackTitle) {
        const generatedTitle = await generateAiriChatTitle({
          workspaceId: params.workspaceId,
          threadId: params.threadId,
          userMessage: params.content,
          assistantMessage: reply.content,
        });
        // Only over the fallback written above: a rename (or any other
        // title) stored in the meantime wins.
        if (generatedTitle && generatedTitle !== fallbackTitle) {
          await AiriChatThread.updateOne(
            { _id: thread._id, title: fallbackTitle },
            { $set: { title: generatedTitle } },
            { timestamps: false }
          );
        }
      }
      await recordAiriChatTurnAnalyticsEvents({
        workspaceId: params.workspaceId,
        threadId: params.threadId,
        userMessageId: userMessageIdText,
        assistantMessageId: assistantMessageIdText,
        inputText: params.content,
        outputText: reply.content,
        outcome: getAiriChatReplyOutcome(reply.metadata),
        analytics: reply.analytics,
        metadata: {
          threadSource: thread.source,
          kbArticlesFound: reply.metadata.kbArticlesFound,
          conversationsFound: reply.metadata.conversationsFound,
          retrievalContextCount: reply.metadata.retrievalContextCount,
          selectedSources: reply.metadata.selectedSources,
          ...(typeof reply.metadata.errorCode === "string"
            ? { errorCode: reply.metadata.errorCode }
            : {}),
          ...(typeof reply.metadata.errorClass === "string"
            ? { errorClass: reply.metadata.errorClass }
            : {}),
        },
      });
    },
    {
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userMessageId: userMessageIdText,
    }
  );

  return {
    userMessage: serializeAiriChatMessage(
      userMessage as unknown as MessageLike
    ),
    assistantMessage: serializeAiriChatMessage(
      assistantMessage as unknown as MessageLike
    ),
    thread: serializeAiriChatThread(thread as unknown as ThreadLike),
  };
}

export function createAndAppendAiriChatTurn(
  params: Parameters<typeof createAndAppendAiriChatTurnInAction>[0]
): ReturnType<typeof createAndAppendAiriChatTurnInAction> {
  const userMessageId = params.userMessageId ?? new Types.ObjectId();
  return withWorkspaceTextAiAction(
    {
      workspaceId: params.workspaceId,
      actionId: "airi-chat:" + String(userMessageId),
    },
    () => createAndAppendAiriChatTurnInAction(params, userMessageId)
  );
}

export async function createAndAppendAiriChatTurnInAction(
  params: {
    supabase: SupabaseClient;
    workspaceId: string;
    userId: string;
    content: string;
    source?: AiriChatThreadSource | null;
    selectedSources?: AiriChatSourceRef[];
    attachedFiles?: AiriChatAttachmentInput[];
    activeBuilder?: unknown;
    emitProgress?: AiriChatRunProgressEmitter;
    signal?: AbortSignal;
    /** The turn's one deadline; a turn without one starts it here. */
    deadline?: AiriTurnDeadline;
    /** Allocated by a durable run up front; the wrapper allocates one otherwise. */
    userMessageId?: Types.ObjectId;
    /** A durable run records the new chat's id before the chat exists. */
    threadId?: Types.ObjectId;
  },
  userMessageId: Types.ObjectId
): Promise<{
  userMessage: SerializedAiriChatMessage;
  assistantMessage: SerializedAiriChatMessage;
  thread: SerializedAiriChatThread;
}> {
  throwIfCancelled(params.signal);
  const deadline = params.deadline ?? createAiriTurnDeadline();
  const progress = createProgressRecorder(params.emitProgress);
  const normalizedSelectedSources = normalizeAiriChatSelectedSources(
    params.selectedSources
  );
  // Retrieval and the language overlap grounding and the chat insert.
  const workspaceWork = startAiriChatWorkspaceWork({
    signal: params.signal,
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    query: params.content,
    progress,
    deadline,
    skipRetrieval: isExplicitAiriChatMetaAdsRequest({
      selectedSources: normalizedSelectedSources,
      userMessage: params.content,
    }),
  });
  if (normalizedSelectedSources.length > 0) {
    await progress.emit(
      stageEvent(
        "source_validation",
        "Validating attached sources",
        "running",
        `${normalizedSelectedSources.length} selected`
      )
    );
  }
  let groundingPolicyError: unknown;
  let selectedContext: AiriChatSelectedGroundingContext | null = null;
  try {
    selectedContext =
      normalizedSelectedSources.length > 0
        ? await buildSelectedAiriChatGroundingContext({
            signal: params.signal,
            supabase: params.supabase,
            workspaceId: params.workspaceId,
            userId: params.userId,
            query: params.content,
            selectedSources: normalizedSelectedSources,
          })
        : null;
  } catch (error) {
    if (!isWorkspaceAiPolicyError(error)) workspaceWork.cancel();
    throwIfCancelled(params.signal, error);
    if (!isWorkspaceAiPolicyError(error)) throw error;
    groundingPolicyError = error;
  }
  if (normalizedSelectedSources.length > 0) {
    await progress.emit(
      stageEvent("source_validation", "Validating attached sources", "complete")
    );
  }
  await progress.emit(stageEvent("thread", "Creating chat", "running"));
  throwIfCancelled(params.signal);
  const threadDocument = await Promise.resolve(
    createAiriChatThreadDocument({
      workspaceId: params.workspaceId,
      userId: params.userId,
      source: params.source,
      id: params.threadId,
    })
  ).catch(error => {
    workspaceWork.cancel();
    throw error;
  });
  const thread = serializeAiriChatThread(
    threadDocument as unknown as ThreadLike
  );
  await progress.emit(stageEvent("thread", "Creating chat", "complete"));
  await progress.emit({
    type: "thread",
    thread: {
      id: thread.id,
      title: thread.title,
      source: thread.source,
      pinnedAt: thread.pinnedAt,
      updatedAt: thread.updatedAt,
    },
    at: createAiriChatRunEventAt(),
  });

  return appendAiriChatTurnInAction(
    {
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      userId: params.userId,
      threadId: thread.id,
      thread: threadDocument,
      content: params.content,
      selectedSources: normalizedSelectedSources,
      attachedFiles: params.attachedFiles,
      activeBuilder: params.activeBuilder,
      preparedSelectedContext: selectedContext,
      signal: params.signal,
      emitProgress: params.emitProgress,
      deadline,
    },
    userMessageId,
    groundingPolicyError,
    { progress, workspaceWork }
  );
}
