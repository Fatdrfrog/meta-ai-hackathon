/** meta_ads_mcp: runs the Meta Ads MCP turn and records its cards. */

import { awaitWithCancellation } from "@/lib/ai/cancellation";
import { getMetaAdsMcpConversationId } from "@/lib/airi-chats/meta-ads-mcp-conversation";
import { runMetaAdsMcpTurn } from "@/lib/meta-ads/mcp/agent-loop";
import { loadMetaAdsMcpBusinessEvidence } from "@/lib/meta-ads/mcp/business-evidence";
import type { AiriChatPendingAction } from "@/lib/airi-chats/pending-actions";
import type { GeneratedAiriChatReply, AiriTurnContext } from "../types";
import { buildModelRunEvent, createAssistantDeltaStream } from "../progress";
import { uniqueStrings } from "../context";
import type { AiriTurnErrorCode } from "../failure";

/**
 * The code the Meta Ads turn returns when Claude cannot run it (Meta Ads is
 * Claude-only): the reply is saved as a failed turn with this typed code.
 */
const META_ADS_REQUIRES_CLAUDE: AiriTurnErrorCode = "meta_ads_requires_claude";

/**
 * The meta_ads_mcp step of the turn. The Meta Ads loop keeps its own 180 s
 * clock, which fits inside the turn budget after classification. Its final
 * answer streams as assistant_delta; the saved reply replaces the preview.
 */
export async function handleMetaAdsTurn(
  context: AiriTurnContext
): Promise<GeneratedAiriChatReply> {
  const {
    params,
    startedAt,
    progress,
    intentClassification,
    airiLanguage,
    attachedFiles,
    normalizedSelectedSources,
    sourceContext,
    traceId,
    history,
    historyContext,
    kbContext,
    conversationContext,
    attachedSourceContext,
    attachedFileContext,
    metaConversationIdPromise,
  } = context;

  const clientConversationId = await awaitWithCancellation(
    metaConversationIdPromise ??
      getMetaAdsMcpConversationId({
        workspaceId: params.workspaceId,
        userId: params.userId,
        threadId: params.threadId,
        signal: params.signal,
      }),
    params.signal
  );
  const answerStream = createAssistantDeltaStream({
    threadId: params.threadId,
    progress,
  });
  const onAnswerDelta = answerStream.onDelta;
  const mcpResult = await runMetaAdsMcpTurn({
    clientConversationId,
    language: airiLanguage,
    // The loop reports the full text so far (a new model step restarts it).
    ...(onAnswerDelta
      ? {
          onTextDelta: (text: string) =>
            onAnswerDelta({ delta: "", accumulated: text }),
        }
      : {}),
    threadId: params.threadId,
    analytics: {
      conversationId: params.threadId,
      messageId: params.userMessageId || null,
    },
    loadBusinessEvidence: ({ selectedAdAccount, sourceId, signal }) =>
      loadMetaAdsMcpBusinessEvidence({
        supabase: params.supabase,
        workspaceId: params.workspaceId,
        userMessage: params.userMessage,
        previousUserMessages: history
          .filter(
            message =>
              message.role === "user" && message.id !== params.userMessageId
          )
          .map(message => message.content),
        selectedAdAccount,
        sourceId,
        signal,
      }),
    signal: params.signal,
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    userMessage: params.userMessage,
    creativeAssetIds: uniqueStrings(
      attachedFiles.flatMap(attachment =>
        attachment.creativeAssetId ? [attachment.creativeAssetId] : []
      )
    ),
    groundingContext: {
      threadHistory: historyContext,
      attachedSources: attachedSourceContext,
      attachedFiles: attachedFileContext,
      workspaceKnowledge: kbContext,
      customerContext: conversationContext,
    },
    emitProgress: async event => {
      await progress.emit(event);
    },
    onLifecycle: async event => {
      await progress.emit(buildModelRunEvent(event));
    },
  }).finally(answerStream.stop);
  const requiresClaude = mcpResult.failureCode === META_ADS_REQUIRES_CLAUDE;
  const mcpPendingActions: AiriChatPendingAction[] =
    mcpResult.pendingMutations.map(mutation => ({
      confirmationVersion: 2,
      id: mutation.id,
      kind: "meta_ads_mcp_mutation" as const,
      label: "Review changes" as const,
      description: mutation.summary,
      href: `#meta-mcp-confirm:${mutation.id}`,
      mutationId: mutation.id,
      transactionDigest: mutation.transactionDigest,
    }));
  const durationMs = Date.now() - startedAt;
  return {
    content: mcpResult.content,
    metadata: {
      intent: intentClassification.intent,
      intentConfidence: intentClassification.confidence,
      intentReason: intentClassification.reason,
      selectedSources: normalizedSelectedSources,
      pendingActions: mcpPendingActions,
      airiMetaAdsMcpPending: mcpResult.pendingMutations,
      airiMetaAdsMcpToolTrace: mcpResult.toolTrace,
      ...(mcpResult.coverage
        ? { airiMetaAdsMcpCoverage: mcpResult.coverage }
        : {}),
      // Claude-only fail-closed: a failed turn with the typed code. The
      // localized text, any evidence read and prepared cards are kept.
      ...(requiresClaude
        ? { failed: true, errorCode: META_ADS_REQUIRES_CLAUDE }
        : {}),
      thinkingTrace: {
        stages: progress.stages,
        resources: progress.resources,
      },
    },
    analytics: {
      traceId,
      durationMs,
      generationLatencyMs: durationMs,
      generationModel: intentClassification.model,
      sourceIds: sourceContext.sourceIds,
      conversationSourceIds: sourceContext.conversationSourceIds,
      kbSourceIds: sourceContext.kbSourceIds,
      retrievalPath: sourceContext.retrievalPath,
    },
  };
}
