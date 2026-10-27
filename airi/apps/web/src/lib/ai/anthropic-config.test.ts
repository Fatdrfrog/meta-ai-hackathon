import {
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import {
  canUseAnthropicAI,
  getAnthropicWorkspaceId,
  isAnthropicWorkspaceConfigError,
  markAnthropicUnavailableForRuntime,
  resetAnthropicRuntimeAvailabilityForTesting,
} from "./anthropic-config";
import {
  getHeavyTextModel,
  getLightTextModel,
  getReasoningTextModel,
} from "./text-models";

const UNSCOPED_KEY_BODY = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header",
  },
};

function badRequest(body: object) {
  return new BadRequestError(400, body, undefined, new Headers());
}

describe("anthropic-config", () => {
  const previous = {
    key: process.env.ANTHROPIC_API_KEY,
    enabled: process.env.ANTHROPIC_AI_ENABLED,
    workspace: process.env.ANTHROPIC_WORKSPACE_ID,
  };

  beforeEach(() => {
    resetAnthropicRuntimeAvailabilityForTesting();
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.ANTHROPIC_AI_ENABLED;
    delete process.env.ANTHROPIC_WORKSPACE_ID;
  });

  afterAll(() => {
    resetAnthropicRuntimeAvailabilityForTesting();
    for (const [name, value] of [
      ["ANTHROPIC_API_KEY", previous.key],
      ["ANTHROPIC_AI_ENABLED", previous.enabled],
      ["ANTHROPIC_WORKSPACE_ID", previous.workspace],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("requires a non-blank key and honours ANTHROPIC_AI_ENABLED", () => {
    expect(canUseAnthropicAI()).toBe(true);
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(canUseAnthropicAI()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_AI_ENABLED = "false";
    expect(canUseAnthropicAI()).toBe(false);
  });

  it("reads an optional trimmed ANTHROPIC_WORKSPACE_ID", () => {
    expect(getAnthropicWorkspaceId()).toBe("");
    process.env.ANTHROPIC_WORKSPACE_ID = "  wrkspc_01ABC  ";
    expect(getAnthropicWorkspaceId()).toBe("wrkspc_01ABC");
    process.env.ANTHROPIC_WORKSPACE_ID = "   ";
    expect(getAnthropicWorkspaceId()).toBe("");
  });

  it("disables the runtime only on rejected credentials, with one key-safe warning", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      markAnthropicUnavailableForRuntime(
        new RateLimitError(429, undefined, "rate limited", new Headers()),
        "AI"
      );
      markAnthropicUnavailableForRuntime(new Error("500"), "AI");
      expect(canUseAnthropicAI()).toBe(true);

      markAnthropicUnavailableForRuntime(
        new AuthenticationError(
          401,
          undefined,
          "invalid x-api-key",
          new Headers()
        ),
        "AI",
        "claude-haiku-4-5"
      );
      markAnthropicUnavailableForRuntime(
        new AuthenticationError(
          401,
          undefined,
          "invalid x-api-key",
          new Headers()
        ),
        "AI",
        "claude-haiku-4-5"
      );
      expect(canUseAnthropicAI()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("ANTHROPIC_API_KEY");
      expect(warn.mock.calls[0]?.[0]).toContain("HTTP 401");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("test-key");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps Claude on after a model-specific 403 and names the model, not the key", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const accessGrant = () =>
      new PermissionDeniedError(
        403,
        {
          type: "error",
          error: {
            type: "permission_error",
            message:
              "Access to this model requires an access grant your request does not have.",
          },
        },
        undefined,
        new Headers()
      );
    try {
      markAnthropicUnavailableForRuntime(
        accessGrant(),
        "AI",
        "claude-opus-5-5"
      );
      markAnthropicUnavailableForRuntime(
        accessGrant(),
        "AI",
        "claude-opus-5-5"
      );
      expect(canUseAnthropicAI()).toBe(true);
      expect(getLightTextModel()).toMatch(/^claude-/);
      expect(getHeavyTextModel()).toMatch(/^claude-/);
      expect(getReasoningTextModel()).toMatch(/^claude-/);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("claude-opus-5-5");
      expect(message).toContain("HTTP 403");
      expect(message).toContain("access");
      expect(message).not.toContain("ANTHROPIC_API_KEY");

      // A different model gets its own single warning.
      markAnthropicUnavailableForRuntime(
        accessGrant(),
        "AI",
        "claude-sonnet-5-5"
      );
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]?.[0])).toContain("claude-sonnet-5-5");
      expect(canUseAnthropicAI()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["an unscoped key without the workspace header", UNSCOPED_KEY_BODY],
    [
      "a malformed workspace header",
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "anthropic-workspace-id: invalid value",
        },
      },
    ],
    [
      "an unknown workspace id",
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid workspace: wrkspc_missing",
        },
      },
    ],
    [
      "a workspace id that does not exist",
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Workspace ID wrkspc_missing does not exist",
        },
      },
    ],
  ])(
    "treats a 400 for %s as a configuration error with one warning",
    (_label, body) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const error = badRequest(body);
        expect(isAnthropicWorkspaceConfigError(error)).toBe(true);
        markAnthropicUnavailableForRuntime(error, "AI");
        markAnthropicUnavailableForRuntime(error, "AI");
        expect(canUseAnthropicAI()).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toContain("ANTHROPIC_WORKSPACE_ID");
        expect(message).toContain("ANTHROPIC_API_KEY");
        expect(message).toContain("is not set");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("test-key");
      } finally {
        warn.mockRestore();
      }
    }
  );

  it("says when a configured workspace id was rejected, without its value", () => {
    process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_secretish";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      markAnthropicUnavailableForRuntime(
        badRequest({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Invalid workspace",
          },
        }),
        "AI"
      );
      expect(warn.mock.calls[0]?.[0]).toContain("is set but was rejected");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("wrkspc_secretish");
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    [
      "a bad request about the prompt",
      badRequest({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages: text content blocks must be non-empty",
        },
      }),
    ],
    [
      "a bad request about the fallbacks beta",
      badRequest({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "fallbacks: Extra inputs are not permitted",
        },
      }),
    ],
    [
      "a rate limit that mentions the workspace",
      new RateLimitError(
        429,
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "anthropic-workspace-id wrkspc_1 is over its rate limit",
          },
        },
        undefined,
        new Headers()
      ),
    ],
    ["a plain error", new Error("not scoped to a workspace")],
  ])("keeps Claude available after %s", (_label, error) => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(isAnthropicWorkspaceConfigError(error)).toBe(false);
      markAnthropicUnavailableForRuntime(error, "AI");
      expect(canUseAnthropicAI()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
