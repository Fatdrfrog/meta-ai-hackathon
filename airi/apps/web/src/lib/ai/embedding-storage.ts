import { EMBEDDING_DIMENSIONS } from "./embedding-config";

export function parseStoredEmbedding(value: unknown): number[] | null {
  let embedding = value;
  if (typeof embedding === "string") {
    try {
      embedding = JSON.parse(embedding);
    } catch {
      return null;
    }
  }
  return Array.isArray(embedding) &&
    embedding.length === EMBEDDING_DIMENSIONS &&
    embedding.every(n => typeof n === "number" && Number.isFinite(n))
    ? embedding
    : null;
}
