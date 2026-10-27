import { randomUUID } from "node:crypto";
import { awaitWithCancellation, throwIfCancelled } from "./cancellation";
import connectDB from "@/lib/mongoose";
import type { AskDataContextGatewayResponse } from "@icecore/airi-runtime/ai-gateway";
import { searchConversationContext } from "./conversation-context-search";
import {
  getQueryEmbeddingWithCache,
  type WorkspaceAiAction,
} from "./embeddings";
import {
  getWorkspaceTextAiAction,
  withWorkspaceTextAiAction,
} from "./workspace-ai-policy";
import { retrieveWorkspaceKbArticleSources } from "@/lib/airi/rag/workspace-knowledge";

type SearchAskDataContextParams = {
  signal?: AbortSignal;
  workspaceId: string;
  query: string;
  conversationLimit?: number;
  kbLimit?: number;
  sourceIds?: string[];
  includeConversations?: boolean;
  includeKnowledge?: boolean;
  action?: WorkspaceAiAction;
};

export async function searchAskDataContextLocal(
  params: SearchAskDataContextParams
): Promise<AskDataContextGatewayResponse> {
  throwIfCancelled(params.signal);
  const ambientAction = getWorkspaceTextAiAction();
  if (
    (params.action && params.action.workspaceId !== params.workspaceId) ||
    (ambientAction && ambientAction.workspaceId !== params.workspaceId)
  ) {
    throw new Error("An AI action cannot change workspace.");
  }
  const action = ambientAction ??
    params.action ?? {
      workspaceId: params.workspaceId,
      actionId: `ask-data:${randomUUID()}`,
    };
  return withWorkspaceTextAiAction(action, () =>
    searchAskDataContextInAction(params, action)
  );
}

async function searchAskDataContextInAction(
  params: SearchAskDataContextParams,
  action: WorkspaceAiAction
): Promise<AskDataContextGatewayResponse> {
  const conversationLimit = Math.max(1, params.conversationLimit || 5);
  const kbLimit = Math.max(1, params.kbLimit || 3);
  const includeConversations = params.includeConversations !== false;
  const includeKnowledge = params.includeKnowledge !== false;

  if (includeConversations) {
    await awaitWithCancellation(connectDB(), params.signal);
  }

  const queryEmbeddingPromise = includeConversations
    ? getQueryEmbeddingWithCache(params.query, action)
    : Promise.resolve(null);
  const kbArticlesPromise = includeKnowledge
    ? retrieveWorkspaceKbArticleSources({
        workspaceId: params.workspaceId,
        query: params.query,
        limit: kbLimit,
      }).catch(error => {
        throwIfCancelled(params.signal, error);
        return [];
      })
    : Promise.resolve([]);

  const [queryEmbedding, kbArticles] = await awaitWithCancellation(
    Promise.all([queryEmbeddingPromise, kbArticlesPromise]),
    params.signal
  );

  if (!includeConversations) {
    return {
      conversations: [],
      kbArticles,
      metadata: {
        retrievalPath: "knowledge_only",
        vectorIndex: null,
        vectorConversationCount: 0,
        fallbackConversationCount: 0,
      },
    };
  }

  const conversationResult = await awaitWithCancellation(
    searchConversationContext({
      workspaceId: params.workspaceId,
      query: params.query,
      limit: conversationLimit,
      sourceIds: params.sourceIds,
      queryEmbedding,
    }),
    params.signal
  );

  return {
    conversations: conversationResult.conversations,
    kbArticles,
    metadata: conversationResult.metadata,
  };
}
