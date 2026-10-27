import "server-only";

import { recordRagTurnAnalyticsEvents } from "@/lib/llm-analytics/events";
import type {
  AskDataConversationResult,
  GatewayKnowledgeSource,
} from "@icecore/airi-runtime/ai-gateway";

export type AiriChatSearchContextForAnalytics = {
  conversations: Array<AskDataConversationResult & { id?: string | null }>;
  kbArticles: GatewayKnowledgeSource[];
};

export type AiriChatReplyAnalytics = {
  traceId: string;
  durationMs: number;
  generationLatencyMs: number | null;
  generationModel: string | null;
  sourceIds: string[];
  conversationSourceIds: string[];
  kbSourceIds: string[];
  retrievalPath: "snippet" | "kb" | "blended" | "none";
};

function compactId(value: unknown): string | null {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function uniqueIds(values: Array<string | null>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

export function buildAiriChatAnalyticsSourceContext(
  context: AiriChatSearchContextForAnalytics
): Pick<
  AiriChatReplyAnalytics,
  "sourceIds" | "conversationSourceIds" | "kbSourceIds" | "retrievalPath"
> {
  const conversationSourceIds = uniqueIds(
    context.conversations.map(conversation => {
      const id = compactId(conversation.id);
      return id ? `conversation:${id}` : null;
    })
  );
  const kbSourceIds = uniqueIds(
    context.kbArticles.map(article => {
      const id = compactId(article.id);
      if (!id) return null;
      return article.source_type === "external_url" ? `url:${id}` : `kb:${id}`;
    })
  );
  const sourceIds = uniqueIds([...conversationSourceIds, ...kbSourceIds]);
  const retrievalPath =
    conversationSourceIds.length > 0 && kbSourceIds.length > 0
      ? "blended"
      : kbSourceIds.length > 0
        ? "kb"
        : conversationSourceIds.length > 0
          ? "snippet"
          : "none";

  return {
    sourceIds,
    conversationSourceIds,
    kbSourceIds,
    retrievalPath,
  };
}

/** "failed" covers the failure reply and the busy (retryable) reply. */
export type AiriChatTurnOutcome = "ok" | "failed";

export async function recordAiriChatTurnAnalyticsEvents(params: {
  workspaceId: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  inputText: string;
  outputText: string;
  outcome: AiriChatTurnOutcome;
  analytics: AiriChatReplyAnalytics;
  metadata?: Record<string, unknown> | null;
}) {
  await recordRagTurnAnalyticsEvents(
    {
      eventTs: new Date(),
      answerMessageId: params.assistantMessageId,
      inputText: params.inputText,
      outputText: params.outputText,
      sourceService: "web.airi_chat",
      metadata: {
        userMessageId: params.userMessageId,
        ...(params.metadata || {}),
      },
      wideEvent: {
        event: "airi_chat.reply.complete",
        workspaceId: params.workspaceId,
        conversationId: params.threadId,
        traceId: params.analytics.traceId,
        channel: "panel",
        resultType: "ai_reply",
        outcome: params.outcome,
        durationMs: params.analytics.durationMs,
        productMode: "workspace_assistant",
        pipelinePath: "airi_chat_context_reply",
        retrievalPath: params.analytics.retrievalPath,
        generationModel: params.analytics.generationModel,
        generationInferenceMs: params.analytics.generationLatencyMs,
        retrieval: {
          selectedSourceIds: params.analytics.sourceIds,
          sourceIds: params.analytics.sourceIds,
          conversationSourceIds: params.analytics.conversationSourceIds,
          kbSourceIds: params.analytics.kbSourceIds,
        },
      },
    },
    { persistReviewItems: false }
  );
}
