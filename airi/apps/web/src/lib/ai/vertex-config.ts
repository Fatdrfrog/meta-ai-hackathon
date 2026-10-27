/**
 * Shared Vertex AI runtime configuration.
 * Gemini runs on `@google/genai` in Vertex mode with Google Cloud auth.
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/sdks/overview
 */

import { VERTEX_AI_ENABLED } from "./vertex-env";
import { extractErrorMessage, getErrorHttpStatus } from "./vertex-shared";

export { VERTEX_AI_ENABLED };

let vertexRuntimeDisabled = false;

function isVertexAuthError(error: unknown): boolean {
  const status = getErrorHttpStatus(error);
  if (status === 401 || status === 403) return true;

  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("vertex ai auth failed") ||
    message.includes("vertex gemini http 401") ||
    message.includes("vertex gemini http 403") ||
    message.includes("vertex embedding http 401") ||
    message.includes("vertex embedding http 403") ||
    message.includes("googleautherror") ||
    message.includes("unable to authenticate your request") ||
    message.includes("could not load the default credentials") ||
    message.includes("default credentials") ||
    message.includes("application default credentials") ||
    message.includes("service account") ||
    message.includes("invalid_grant") ||
    message.includes("invalid jwt") ||
    message.includes("permission denied") ||
    message.includes("access token") ||
    message.includes("oauth") ||
    message.includes("api key not valid") ||
    message.includes("invalid api key") ||
    message.includes("google_cloud_project") ||
    message.includes("resolvable project")
  );
}

export function canUseVertexAI(): boolean {
  return VERTEX_AI_ENABLED && !vertexRuntimeDisabled;
}

export function markVertexUnavailableForRuntime(
  error: unknown,
  context: string
): void {
  if (vertexRuntimeDisabled || !isVertexAuthError(error)) {
    return;
  }

  vertexRuntimeDisabled = true;
  console.warn(
    `[${context}] Vertex AI disabled for this runtime due to authentication or project configuration failure.`
  );
}
