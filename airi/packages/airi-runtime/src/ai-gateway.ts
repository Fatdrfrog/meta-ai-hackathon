export const AI_GATEWAY_PATHS = {
  health: "/healthz",
  queryEmbedding: "/v1/embeddings/query",
  documentEmbedding: "/v1/embeddings/document",
  documentEmbeddingBatch: "/v1/embeddings/document-batch",
  askDataContextSearch: "/v1/search/ask-data-context",
  llmEvents: "/v1/llm-events",
  llmAnalyticsQuery: "/v1/llm-analytics/query",
} as const;

export type AIGatewayEmbeddingTaskType =
  | "RETRIEVAL_QUERY"
  | "RETRIEVAL_DOCUMENT";

export type AIGatewayGeneratedEmbedding = {
  embedding: number[];
  provider: string;
  model: string;
  dimensions: number;
  taskType: AIGatewayEmbeddingTaskType;
};

export type AiGatewayAction = { workspaceId: string; actionId: string };

export type QueryEmbeddingGatewayRequest = {
  action?: AiGatewayAction;
  text: string;
};

export type QueryEmbeddingGatewayResponse = {
  result: AIGatewayGeneratedEmbedding | null;
};

export type DocumentEmbeddingGatewayRequest = {
  action?: AiGatewayAction;
  text: string;
  title?: string;
};

export type DocumentEmbeddingGatewayResponse = {
  result: AIGatewayGeneratedEmbedding | null;
};

export type DocumentEmbeddingBatchGatewayItem =
  | string
  | {
      text: string;
      title?: string;
    };

export type DocumentEmbeddingBatchGatewayRequest = {
  action?: AiGatewayAction;
  items: DocumentEmbeddingBatchGatewayItem[];
};

export type DocumentEmbeddingBatchGatewayResponse = {
  results: Array<AIGatewayGeneratedEmbedding | null>;
};

export type GatewayKnowledgeSource = {
  id: string;
  title: string;
  content: string;
  relevance_score: number;
  source_type?: "article" | "external_url";
  url?: string;
};

export type AskDataConversationResult = {
  id?: string;
  summary?: string;
  category?: string;
  priority?: string;
  createdAt?: string | null;
};

export type AskDataContextGatewayRequest = {
  action?: AiGatewayAction;
  workspaceId: string;
  query: string;
  conversationLimit?: number;
  kbLimit?: number;
  sourceIds?: string[];
  includeConversations?: boolean;
  includeKnowledge?: boolean;
};

export type AskDataContextGatewayResponse = {
  conversations: AskDataConversationResult[];
  kbArticles: GatewayKnowledgeSource[];
  metadata?: {
    retrievalPath?:
      | "vector_filter"
      | "fallback_keyword_recent"
      | "embedding_unavailable"
      | "knowledge_only"
      | "none";
    vectorIndex?: string | null;
    vectorConversationCount?: number;
    fallbackConversationCount?: number;
  };
};

export const LLM_ANALYTICS_QUERY_NAMES = [
  "quality_overview",
  "model_breakdown",
  "rag_failures",
  "score_trends",
  "generation_quality",
  "system_performance",
  "operational_efficiency",
  "spend_overview",
  "spend_daily",
  "spend_by_operation",
  "airi_chat_overview",
  "airi_chat_daily",
  "airi_chat_issues",
  "airi_chat_quality_score",
] as const;

export type LlmAnalyticsQueryName = (typeof LLM_ANALYTICS_QUERY_NAMES)[number];

export type LlmAnalyticsGatewayEventResponse = {
  accepted: number;
  published: number;
  skipped: boolean;
  topics: string[];
};

export type LlmAnalyticsQueryGatewayRequest = {
  workspaceId: string;
  /** When set, filters traces across multiple workspaces (company rollup). */
  workspaceIds?: string[];
  query: LlmAnalyticsQueryName;
  days?: number;
  limit?: number;
};

export type LlmAnalyticsQueryGatewayResponse = {
  query: LlmAnalyticsQueryName;
  workspaceId: string;
  rows: Array<Record<string, unknown>>;
  limited: boolean;
  source: "bigquery" | "disabled";
  generatedAt: string;
};
