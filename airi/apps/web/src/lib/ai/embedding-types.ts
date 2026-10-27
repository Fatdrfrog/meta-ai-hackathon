export type EmbeddingTaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

export type EmbeddingProvider = "vertex" | "openai";

export type GeneratedEmbedding = {
  embedding: number[];
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  taskType: EmbeddingTaskType;
};

export type EmbeddingMetadataFields = {
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  embeddingTaskType: EmbeddingTaskType;
  embeddingDimensions: number;
};

export type EmbeddingMetadataLike =
  | Partial<EmbeddingMetadataFields>
  | null
  | undefined;
