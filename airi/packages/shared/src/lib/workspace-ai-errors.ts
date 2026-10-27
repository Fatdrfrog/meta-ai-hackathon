function findWorkspaceAiPolicyError(error: unknown): {
  code:
    | "own_ai_source_required"
    | "workspace_ai_policy_unavailable"
    | "workspace_ai_spend_limit"
    | "workspace_ai_operation_replayed";
  resetAt?: unknown;
} | null {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const value = current as {
      code?: unknown;
      resetAt?: unknown;
      cause?: unknown;
    };
    if (
      value.code === "own_ai_source_required" ||
      value.code === "workspace_ai_policy_unavailable" ||
      value.code === "workspace_ai_spend_limit" ||
      value.code === "workspace_ai_operation_replayed"
    ) {
      return { code: value.code, resetAt: value.resetAt };
    }
    current = value.cause;
  }
  return null;
}

export function isWorkspaceAiPolicyError(error: unknown): boolean {
  return findWorkspaceAiPolicyError(error) !== null;
}

/** Safe, serializable allowance denial across job/provider error wrappers. */
export function getWorkspaceAiRequiredDetails(error: unknown): {
  code: "own_ai_source_required";
  error: string;
  resetAt: string | null;
} | null {
  const value = findWorkspaceAiPolicyError(error);
  if (value?.code === "own_ai_source_required") {
    return {
      code: "own_ai_source_required",
      error:
        "Connect a compatible AI source in Settings > Integrations to continue AI generation.",
      resetAt: null,
    };
  }
  return null;
}
