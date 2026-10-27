/**
 * Application Default Credentials and OAuth access tokens for Vertex AI and related
 * Google Cloud APIs (embeddings predict, Discovery Engine `:rank`, etc.).
 *
 * Serverless (Vercel, etc.): you cannot rely on `gcloud auth` or a key *file* path.
 * Put the service account JSON key in a secret env var and use:
 *   `GOOGLE_APPLICATION_CREDENTIALS_JSON` — full JSON body (type: service_account)
 * plus `GOOGLE_CLOUD_PROJECT` (or `project_id` inside that JSON).
 *
 * Local dev: `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` still works.
 *
 * @see https://cloud.google.com/docs/authentication/application-default-credentials
 * @see https://cloud.google.com/vertex-ai/docs/authentication
 */

import { GoogleAuth } from "google-auth-library";
import {
  getGoogleCloudAuthOptions,
  getGoogleCloudPlatformAccessToken,
} from "@/lib/google/gcp-auth";
import {
  canUseVertexAI,
  markVertexUnavailableForRuntime,
} from "./vertex-config";
import {
  getVertexEmbeddingLocationFromEnv,
  getVertexProjectIdFromEnv,
  VERTEX_AI_ENABLED,
} from "./vertex-env";
import { parseEnabledFlag, extractErrorMessage } from "./vertex-shared";

export const VERTEX_EMBEDDINGS_ENABLED = parseEnabledFlag(
  process.env.VERTEX_EMBEDDINGS_ENABLED,
  VERTEX_AI_ENABLED
);

export function getVertexEmbeddingProjectId(): string | null {
  return getVertexProjectIdFromEnv();
}

export function getVertexEmbeddingLocation(): string {
  return getVertexEmbeddingLocationFromEnv();
}

let platformAccessTokenPromise: Promise<string> | null = null;
let resolvedProjectIdPromise: Promise<string | null> | null = null;
let adcAuth: GoogleAuth | null = null;

export function getVertexGoogleAuthOptions(): ConstructorParameters<
  typeof GoogleAuth
>[0] {
  return getGoogleCloudAuthOptions(getVertexEmbeddingProjectId());
}

function getAdcGoogleAuth(): GoogleAuth {
  adcAuth ||= new GoogleAuth(getVertexGoogleAuthOptions());
  return adcAuth;
}

export async function resolveVertexEmbeddingProjectId(): Promise<
  string | null
> {
  const projectId = getVertexEmbeddingProjectId();
  if (projectId) {
    return projectId;
  }

  if (!resolvedProjectIdPromise) {
    resolvedProjectIdPromise = getAdcGoogleAuth()
      .getProjectId()
      .then(value => value?.trim() || null)
      .catch(() => null);
  }

  return resolvedProjectIdPromise;
}

export function markVertexEmbeddingsUnavailableForRuntime(
  error: unknown,
  context: string
): void {
  markVertexUnavailableForRuntime(error, context);
}

export function canUseVertexEmbeddings(): boolean {
  return VERTEX_EMBEDDINGS_ENABLED && canUseVertexAI();
}

async function requestVertexAccessToken(): Promise<string> {
  try {
    return await getGoogleCloudPlatformAccessToken(
      getVertexEmbeddingProjectId()
    );
  } catch (error) {
    throw new Error(
      "Vertex AI auth failed. Configure Google Cloud credentials for this runtime. " +
        `Details: ${extractErrorMessage(error)}`
    );
  }
}

/**
 * OAuth access token for Google Cloud REST APIs (e.g. Discovery Engine Ranking API)
 * independent of the embedding flags.
 */
export async function getVertexPlatformAccessToken(): Promise<string> {
  if (!canUseVertexAI()) {
    throw new Error("Vertex AI is disabled");
  }
  if (platformAccessTokenPromise) {
    return platformAccessTokenPromise;
  }
  platformAccessTokenPromise = requestVertexAccessToken().finally(() => {
    platformAccessTokenPromise = null;
  });
  return platformAccessTokenPromise;
}
