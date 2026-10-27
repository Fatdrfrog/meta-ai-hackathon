import {
  getWorkspaceAiRequiredDetails,
  isWorkspaceAiPolicyError,
} from "./workspace-ai-errors";

describe("workspace AI allowance errors", () => {
  it.each([
    "own_ai_source_required",
    "workspace_ai_policy_unavailable",
    "workspace_ai_spend_limit",
    "workspace_ai_operation_replayed",
  ])(
    "recognizes %s through wrappers without treating it as a provider fallback",
    code => {
      expect(
        isWorkspaceAiPolicyError(
          new Error("wrapper", {
            cause: Object.assign(new Error("safe"), { code }),
          })
        )
      ).toBe(true);
      expect(isWorkspaceAiPolicyError(new Error("ordinary failure"))).toBe(
        false
      );
    }
  );
  it("keeps the connection requirement through bounded runtime error wrappers", () => {
    const requirement = Object.assign(new Error("private provider text"), {
      code: "own_ai_source_required",
      workspaceId: "workspace-1",
      resetAt: "2026-10-01T00:00:00.000Z",
    });
    expect(
      getWorkspaceAiRequiredDetails(
        new Error("wrapper", { cause: requirement })
      )
    ).toEqual({
      code: "own_ai_source_required",
      error:
        "Connect a compatible AI source in Settings > Integrations to continue AI generation.",
      resetAt: null,
    });
  });

  it("ignores unrelated errors and cyclic causes", () => {
    const error = new Error("unrelated");
    error.cause = error;
    expect(getWorkspaceAiRequiredDetails(error)).toBeNull();
    expect(
      getWorkspaceAiRequiredDetails({ message: "own_ai_source_required" })
    ).toBeNull();
  });

  it("never exposes a malformed reset value or raw error message", () => {
    const details = getWorkspaceAiRequiredDetails({
      code: "own_ai_source_required",
      resetAt: "secret",
      message: "secret",
    });
    expect(details?.resetAt).toBeNull();
    expect(JSON.stringify(details)).not.toContain("secret");
    expect(details?.error).not.toContain("allowance is used");
  });
});
