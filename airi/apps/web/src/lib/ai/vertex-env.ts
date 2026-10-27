/**
 * Environment flags and location helpers for Vertex / Gemini.
 * Env names are project conventions; see Google’s Vertex AI setup guides for ADC and project ID.
 *
 * @see https://cloud.google.com/vertex-ai/docs/start/cloud-environment
 * @see https://cloud.google.com/docs/authentication/application-default-credentials
 */

import { parseEnabledFlag } from "./vertex-shared";

export const VERTEX_AI_ENABLED = parseEnabledFlag(
  process.env.VERTEX_AI_ENABLED,
  true
);

export function getVertexProjectIdFromEnv(): string | null {
  return (
    (
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      ""
    ).trim() || null
  );
}

/**
 * Gemini used to hit the express-mode style endpoint without an explicit
 * project/region in the URL. Keep the SDK path aligned with that behavior by
 * defaulting Gemini traffic to the global endpoint unless explicitly
 * overridden.
 */
export function getVertexGeminiLocation(): string {
  return (process.env.VERTEX_GEMINI_LOCATION || "global").trim();
}

/**
 * Embeddings stay on the existing regional Vertex path unless explicitly
 * overridden.
 */
export function getVertexEmbeddingLocationFromEnv(): string {
  return (
    process.env.VERTEX_EMBEDDING_LOCATION ||
    process.env.VERTEX_AI_LOCATION ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    "us-central1"
  ).trim();
}

export function getVertexApiVersion(): string {
  return (process.env.VERTEX_AI_API_VERSION || "v1").trim();
}
