import { Conversation } from "@/models/conversation";
import type { AskDataConversationResult } from "@icecore/airi-runtime/ai-gateway";
import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import { readDate } from "@icecore/shared/lib/value-utils";

const MAX_CONVERSATION_CONTEXT_RESULTS = 50;
const VECTOR_OVERSAMPLE_FACTOR = 8;
const MAX_VECTOR_POST_FILTER_CANDIDATES = 400;
const MAX_RECENT_FALLBACK_CANDIDATES = 500;

export const FILTERED_CONVERSATION_VECTOR_INDEX =
  "vector_search_conversations_v2";

export type ConversationContextRetrievalPath =
  | "vector_filter"
  | "fallback_keyword_recent"
  | "embedding_unavailable"
  | "none";

export type ConversationContextSearchMetadata = {
  retrievalPath: ConversationContextRetrievalPath;
  vectorIndex: string | null;
  vectorConversationCount: number;
  fallbackConversationCount: number;
};

export type ConversationContextSearchResult = {
  conversations: AskDataConversationResult[];
  metadata: ConversationContextSearchMetadata;
};

type LeanConversationSearchResult = {
  _id?: unknown;
  summary?: string | null;
  history_summary?: string | null;
  classification?: {
    summary?: string | null;
    category?: string | null;
    priority?: string | null;
  } | null;
  category?: string | null;
  priority?: string | null;
  subject?: string | null;
  rename?: string | null;
  internal_labels?: unknown[] | null;
  createdAt?: Date | string | null;
  lastMessageAt?: Date | string | null;
};

function compactText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDate(value: Date | string | null | undefined): string | null {
  return readDate(value)?.toISOString() ?? null;
}

function toConversationResult(
  conversation: LeanConversationSearchResult
): AskDataConversationResult {
  const createdAt = conversation.lastMessageAt || conversation.createdAt;
  return {
    id: conversation._id ? String(conversation._id) : undefined,
    summary:
      compactText(conversation.summary) ||
      compactText(conversation.classification?.summary) ||
      compactText(conversation.history_summary) ||
      undefined,
    category:
      compactText(conversation.category) ||
      compactText(conversation.classification?.category) ||
      undefined,
    priority:
      compactText(conversation.priority) ||
      compactText(conversation.classification?.priority) ||
      undefined,
    createdAt: toIsoDate(createdAt),
  };
}

function normalizeConversationContextLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(
    MAX_CONVERSATION_CONTEXT_RESULTS,
    Math.max(1, Math.trunc(limit))
  );
}

function normalizeConversationQueryTerms(query: string): string[] {
  return compactText(query)
    .split(/\s+/)
    .map(term => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(term => term.length >= 3)
    .map(term => term.toLowerCase())
    .slice(0, 8);
}

function conversationMatchesAnyTerm(
  conversation: LeanConversationSearchResult,
  terms: string[]
): boolean {
  if (terms.length === 0) return false;
  const searchableText = [
    conversation.classification?.summary,
    conversation.history_summary,
    conversation.classification?.category,
    conversation.subject,
    conversation.rename,
    ...(conversation.internal_labels || []),
  ]
    .map(compactText)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.some(term => searchableText.includes(term));
}

function buildConversationProjection() {
  return {
    _id: 1,
    summary: "$classification.summary",
    history_summary: 1,
    category: "$classification.category",
    priority: "$classification.priority",
    createdAt: 1,
    lastMessageAt: 1,
  };
}

function toConversationResults(
  conversations: LeanConversationSearchResult[]
): AskDataConversationResult[] {
  return (conversations || [])
    .map((conversation: LeanConversationSearchResult) =>
      toConversationResult(conversation)
    )
    .filter(conversation => conversation.summary);
}

function buildConversationWorkspaceFilter(params: {
  workspaceId: string;
  sourceIds: string[];
}) {
  const filter: Record<string, unknown> = {
    workspaceId: params.workspaceId,
  };
  if (params.sourceIds.length > 0) {
    filter.sourceId = { $in: params.sourceIds };
  }
  return filter;
}

async function searchFilteredVectorConversations(params: {
  workspaceId: string;
  sourceIds: string[];
  queryEmbedding: number[];
  limit: number;
}): Promise<AskDataConversationResult[]> {
  const vectorLimit = Math.min(
    MAX_VECTOR_POST_FILTER_CANDIDATES,
    Math.max(params.limit, params.limit * VECTOR_OVERSAMPLE_FACTOR)
  );
  const numCandidates = Math.min(8000, Math.max(100, vectorLimit * 20));
  const rows = (await Conversation.aggregate([
    {
      $vectorSearch: {
        index: FILTERED_CONVERSATION_VECTOR_INDEX,
        path: "embedding",
        queryVector: params.queryEmbedding,
        numCandidates,
        limit: vectorLimit,
        filter: buildConversationWorkspaceFilter({
          workspaceId: params.workspaceId,
          sourceIds: params.sourceIds,
        }),
      },
    },
    {
      $match: buildCurrentConversationClassificationFilter(),
    },
    {
      $limit: params.limit,
    },
    {
      $project: buildConversationProjection(),
    },
  ])) as LeanConversationSearchResult[];

  return toConversationResults(rows);
}

async function findFallbackConversations(params: {
  workspaceId: string;
  query: string;
  limit: number;
  sourceIds: string[];
}): Promise<AskDataConversationResult[]> {
  const baseFilter: Record<string, unknown> = {
    ...buildConversationWorkspaceFilter({
      workspaceId: params.workspaceId,
      sourceIds: params.sourceIds,
    }),
    ...buildCurrentConversationClassificationFilter(),
  };

  const seen = new Set<string>();
  const append = (
    output: AskDataConversationResult[],
    conversation: LeanConversationSearchResult
  ) => {
    const result = toConversationResult(conversation);
    if (!result.id || seen.has(result.id) || !result.summary) return;
    seen.add(result.id);
    output.push(result);
  };

  const select =
    "_id classification.summary classification.category classification.priority history_summary subject rename internal_labels createdAt lastMessageAt";
  const output: AskDataConversationResult[] = [];
  const candidateLimit = Math.min(
    MAX_RECENT_FALLBACK_CANDIDATES,
    Math.max(100, params.limit * 20)
  );
  const recent = (await Conversation.find(baseFilter)
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(candidateLimit)
    .select(select)
    .lean()) as LeanConversationSearchResult[];
  const terms = normalizeConversationQueryTerms(params.query);
  const keywordMatches: LeanConversationSearchResult[] = [];
  const otherRecent: LeanConversationSearchResult[] = [];
  for (const conversation of recent || []) {
    (conversationMatchesAnyTerm(conversation, terms)
      ? keywordMatches
      : otherRecent
    ).push(conversation);
  }
  for (const conversation of [...keywordMatches, ...otherRecent]) {
    append(output, conversation);
    if (output.length >= params.limit) break;
  }

  return output.slice(0, params.limit);
}

export function normalizeConversationSourceIds(
  sourceIds: string[] | undefined
): string[] {
  return Array.from(
    new Set(
      (sourceIds || [])
        .map(sourceId => String(sourceId || "").trim())
        .filter(Boolean)
    )
  );
}

export async function searchConversationContext(params: {
  workspaceId: string;
  query: string;
  limit: number;
  sourceIds?: string[];
  queryEmbedding: number[] | null;
}): Promise<ConversationContextSearchResult> {
  const sourceIds = normalizeConversationSourceIds(params.sourceIds);
  const limit = normalizeConversationContextLimit(params.limit);

  if (!params.queryEmbedding) {
    const conversations = await findFallbackConversations({
      workspaceId: params.workspaceId,
      query: params.query,
      limit,
      sourceIds,
    });
    return {
      conversations,
      metadata: {
        retrievalPath: "embedding_unavailable",
        vectorIndex: null,
        vectorConversationCount: 0,
        fallbackConversationCount: conversations.length,
      },
    };
  }

  const vectorConversations = await searchFilteredVectorConversations({
    workspaceId: params.workspaceId,
    queryEmbedding: params.queryEmbedding,
    limit,
    sourceIds,
  }).catch(() => []);

  if (vectorConversations.length > 0) {
    return {
      conversations: vectorConversations,
      metadata: {
        retrievalPath: "vector_filter",
        vectorIndex: FILTERED_CONVERSATION_VECTOR_INDEX,
        vectorConversationCount: vectorConversations.length,
        fallbackConversationCount: 0,
      },
    };
  }

  const fallbackConversations = await findFallbackConversations({
    workspaceId: params.workspaceId,
    query: params.query,
    limit,
    sourceIds,
  });

  return {
    conversations: fallbackConversations,
    metadata: {
      retrievalPath:
        fallbackConversations.length > 0 ? "fallback_keyword_recent" : "none",
      vectorIndex: FILTERED_CONVERSATION_VECTOR_INDEX,
      vectorConversationCount: 0,
      fallbackConversationCount: fallbackConversations.length,
    },
  };
}
