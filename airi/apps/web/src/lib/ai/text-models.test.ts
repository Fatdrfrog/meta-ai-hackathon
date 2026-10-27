const mockCanUseAnthropicAI = jest.fn();

jest.mock("./anthropic-config", () => ({
  canUseAnthropicAI: () => mockCanUseAnthropicAI(),
}));
jest.mock("./workspace-ai-policy", () => ({
  resolveWorkspaceTextAiBilling: jest.fn(),
  hasWorkspaceTextAiAction: () => false,
}));

import {
  getHeavyTextModel,
  getLightStructuredJsonGenerationConfig,
  getLightTextModel,
  getReasoningTextModel,
  getStructuredJsonGenerationConfig,
  isClaudeModel,
  resolveTextModelForProvider,
} from "./text-models";

const ENV_KEYS = [
  "ANTHROPIC_LIGHT_MODEL",
  "ANTHROPIC_HEAVY_MODEL",
  "ANTHROPIC_REASONING_MODEL",
  "VERTEX_GEMINI_LIGHT_MODEL",
  "VERTEX_GEMINI_HEAVY_MODEL",
  "VERTEX_FALLBACK_MODEL",
] as const;

describe("text model tiers", () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]])
  );

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    mockCanUseAnthropicAI.mockReturnValue(true);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses the Claude tiers when Anthropic is configured", () => {
    expect(getLightTextModel()).toBe("claude-haiku-4-5");
    expect(getHeavyTextModel()).toBe("claude-sonnet-5-5");
    expect(getReasoningTextModel()).toBe("claude-opus-5-5");
  });

  it("honours tier env overrides", () => {
    process.env.ANTHROPIC_LIGHT_MODEL = " claude-light ";
    process.env.ANTHROPIC_HEAVY_MODEL = "claude-heavy";
    process.env.ANTHROPIC_REASONING_MODEL = "claude-reasoning";
    expect(getLightTextModel()).toBe("claude-light");
    expect(getHeavyTextModel()).toBe("claude-heavy");
    expect(getReasoningTextModel()).toBe("claude-reasoning");
  });

  it("falls back to the Gemini tiers without Anthropic", () => {
    mockCanUseAnthropicAI.mockReturnValue(false);
    process.env.VERTEX_GEMINI_LIGHT_MODEL = "gemini-light";
    process.env.VERTEX_GEMINI_HEAVY_MODEL = "gemini-heavy";
    expect(getLightTextModel()).toBe("gemini-light");
    expect(getHeavyTextModel()).toBe("gemini-heavy");
    expect(getReasoningTextModel()).toBe("gemini-heavy");
  });

  it("returns family-specific structured JSON configs", () => {
    expect(getStructuredJsonGenerationConfig("claude-haiku-4-5")).toEqual({
      thinkingConfig: { thinkingLevel: "LOW" },
    });
    expect(getStructuredJsonGenerationConfig("gemini-3.5-flash")).toEqual({
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    });
    expect(getLightStructuredJsonGenerationConfig()).toEqual({
      thinkingConfig: { thinkingLevel: "LOW" },
    });
    mockCanUseAnthropicAI.mockReturnValue(false);
    expect(getLightStructuredJsonGenerationConfig()).toEqual({
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    });
  });

  it("identifies Claude ids", () => {
    expect(isClaudeModel(" claude-sonnet-5-5")).toBe(true);
    expect(isClaudeModel("gemini-3.5-flash")).toBe(false);
  });
});

describe("resolveTextModelForProvider", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.VERTEX_GEMINI_LIGHT_MODEL = "gemini-light";
    process.env.VERTEX_GEMINI_HEAVY_MODEL = "gemini-heavy";
  });

  afterAll(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it.each([
    ["claude-haiku-4-5", "vertex", "gemini-light"],
    ["claude-sonnet-5-5", "vertex", "gemini-heavy"],
    ["claude-opus-5-5", "google", "gemini-heavy"],
    ["gemini-light", "anthropic", "claude-haiku-4-5"],
    ["gemini-2.5-flash-lite", "anthropic", "claude-haiku-4-5"],
    ["gemini-heavy", "anthropic", "claude-sonnet-5-5"],
    ["gemini-3.5-pro", "anthropic", "claude-sonnet-5-5"],
    ["claude-opus-5-5", "anthropic", "claude-opus-5-5"],
    ["gemini-heavy", "vertex", "gemini-heavy"],
    ["", "anthropic", "claude-sonnet-5-5"],
    ["", "vertex", "gemini-heavy"],
  ] as const)("maps %s on %s to %s", (model, provider, expected) => {
    expect(resolveTextModelForProvider(model, provider)).toBe(expected);
  });

  it("maps the configured Claude light model back to Gemini light", () => {
    process.env.ANTHROPIC_LIGHT_MODEL = "claude-custom-light";
    expect(resolveTextModelForProvider("claude-custom-light", "vertex")).toBe(
      "gemini-light"
    );
  });

  it("treats a shared Gemini light/heavy id as heavy to keep reply quality", () => {
    process.env.VERTEX_GEMINI_LIGHT_MODEL = "gemini-3.5-flash";
    process.env.VERTEX_GEMINI_HEAVY_MODEL = "gemini-3.5-flash";
    expect(resolveTextModelForProvider("gemini-3.5-flash", "anthropic")).toBe(
      "claude-sonnet-5-5"
    );
  });
});
