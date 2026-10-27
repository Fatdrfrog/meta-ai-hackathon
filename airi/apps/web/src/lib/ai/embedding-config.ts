export const PRIMARY_EMBEDDING_MODEL_FALLBACK = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_CACHE_VERSION = "v5-vertex-only";
export const QUERY_EMBEDDING_CACHE_TTL_SECONDS = 60 * 60;
export const BATCH_EMBEDDING_CONCURRENCY = Math.max(
  1,
  Number(process.env.EMBEDDING_BATCH_CONCURRENCY || 4)
);
