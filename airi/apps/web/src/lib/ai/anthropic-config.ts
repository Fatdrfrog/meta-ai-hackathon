/**
 * Anthropic (Claude) runtime configuration for platform-funded text generation.
 * Env: ANTHROPIC_API_KEY (required), ANTHROPIC_WORKSPACE_ID (optional; sent as
 * the `anthropic-workspace-id` header for keys not scoped to one workspace),
 * ANTHROPIC_AI_ENABLED (default true).
 *
 * @see https://platform.claude.com/docs/en/api/errors
 */

import { AuthenticationError, PermissionDeniedError } from "@anthropic-ai/sdk";
import { parseEnabledFlag } from "./vertex-shared";

let anthropicRuntimeDisabled = false;
// Models already reported as access-denied (403), so each one warns once.
const accessDeniedModelsWarned = new Set<string>();

export function getAnthropicApiKey(): string {
  return (process.env.ANTHROPIC_API_KEY || "").trim();
}

/** Env: ANTHROPIC_WORKSPACE_ID (optional, non-secret). Empty when unset. */
export function getAnthropicWorkspaceId(): string {
  return (process.env.ANTHROPIC_WORKSPACE_ID || "").trim();
}

export function isAnthropicAIEnabled(): boolean {
  return parseEnabledFlag(process.env.ANTHROPIC_AI_ENABLED, true);
}

export function canUseAnthropicAI(): boolean {
  return (
    isAnthropicAIEnabled() &&
    !anthropicRuntimeDisabled &&
    Boolean(getAnthropicApiKey())
  );
}

/** A 401: the API rejected ANTHROPIC_API_KEY itself. */
export function isAnthropicAuthError(error: unknown): boolean {
  return error instanceof AuthenticationError;
}

/**
 * A 403. It can apply to one model only (region restriction, identity
 * verification, or a missing model access grant), so it never disables Claude
 * for the whole runtime; the failing call already falls back on its own.
 */
export function isAnthropicPermissionError(error: unknown): boolean {
  return error instanceof PermissionDeniedError;
}

// Only the workspace wording the API uses for a key/workspace mismatch, e.g.
// "This API key is not scoped to a workspace, so this request must include
// the anthropic-workspace-id header", or a rejected workspace id.
const WORKSPACE_CONFIG_ERROR_PATTERN =
  /anthropic-workspace-id|not scoped to a workspace|\binvalid workspace\b|\bworkspace(?:[ _-]?id)?\b[^"{}]{0,60}?\b(?:is invalid|not found|does not exist)\b/i;

function readErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) ? status : null;
}

/**
 * A 400/404 that rejects the workspace configuration (missing or invalid
 * `anthropic-workspace-id`). Retrying or failing over per call cannot fix it.
 */
export function isAnthropicWorkspaceConfigError(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (status !== 400 && status !== 404) return false;
  const message = error instanceof Error ? error.message : "";
  return WORKSPACE_CONFIG_ERROR_PATTERN.test(message);
}

/**
 * Disables Claude for this runtime after a configuration failure: a rejected
 * credential (401) or a rejected workspace configuration (400/404). Logs one
 * warning naming the env vars to fix, never their values. A 403 keeps Claude
 * on and logs one warning per model, naming the model and its access block.
 */
export function markAnthropicUnavailableForRuntime(
  error: unknown,
  context: string,
  model?: string
): void {
  if (anthropicRuntimeDisabled) return;

  if (isAnthropicAuthError(error)) {
    anthropicRuntimeDisabled = true;
    console.warn(
      `[${context}] Anthropic disabled for this runtime: the API rejected ANTHROPIC_API_KEY (HTTP ${readErrorStatus(
        error
      )}). Check the key.`
    );
    return;
  }

  if (isAnthropicPermissionError(error)) {
    const modelLabel = String(model || "").trim() || "an unnamed model";
    if (accessDeniedModelsWarned.has(modelLabel)) return;
    accessDeniedModelsWarned.add(modelLabel);
    console.warn(
      `[${context}] Anthropic denied access to ${modelLabel} (HTTP ${readErrorStatus(
        error
      )}): the model has an access requirement this request does not meet, such as a region restriction, identity verification, or a model access grant. Calls to this model fall back per call; other Claude models stay enabled.`
    );
    return;
  }

  if (isAnthropicWorkspaceConfigError(error)) {
    anthropicRuntimeDisabled = true;
    const workspaceState = getAnthropicWorkspaceId()
      ? "ANTHROPIC_WORKSPACE_ID is set but was rejected"
      : "ANTHROPIC_WORKSPACE_ID is not set";
    console.warn(
      `[${context}] Anthropic disabled for this runtime: the API rejected the workspace configuration (HTTP ${readErrorStatus(
        error
      )}; ${workspaceState}). Set ANTHROPIC_WORKSPACE_ID to the workspace id that ANTHROPIC_API_KEY belongs to, or use a workspace-scoped ANTHROPIC_API_KEY.`
    );
  }
}

/** Test-only reset of the runtime auth latch. */
export function resetAnthropicRuntimeAvailabilityForTesting(): void {
  anthropicRuntimeDisabled = false;
  accessDeniedModelsWarned.clear();
}
