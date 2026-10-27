import {
  extractGeminiTextResponse,
  normalizeVertexGeminiGenerationConfig,
} from "./ai/vertex-gemini-rest";

describe("extractGeminiTextResponse", () => {
  it("extracts text and finish metadata from a normal candidate", () => {
    expect(
      extractGeminiTextResponse({
        candidates: [
          {
            finishReason: "STOP",
            finishMessage: "Completed normally",
            content: {
              parts: [{ text: "ru" }],
            },
          },
        ],
      })
    ).toEqual(
      expect.objectContaining({
        text: "ru",
        finishReason: "STOP",
        finishMessage: "Completed normally",
        promptBlockReason: null,
        promptBlockReasonMessage: null,
      })
    );
  });

  it("retains prompt block diagnostics when no candidates are returned", () => {
    expect(
      extractGeminiTextResponse({
        promptFeedback: {
          blockReason: "OTHER",
          blockReasonMessage: "Prompt blocked by policy",
        },
      })
    ).toEqual(
      expect.objectContaining({
        text: "",
        finishReason: null,
        promptBlockReason: "OTHER",
        promptBlockReasonMessage: "Prompt blocked by policy",
      })
    );
  });

  it("retains finish diagnostics when a candidate has no text parts", () => {
    expect(
      extractGeminiTextResponse({
        candidates: [
          {
            finishReason: "SAFETY",
            finishMessage: "Response blocked for safety reasons",
            content: {},
          },
        ],
      })
    ).toEqual(
      expect.objectContaining({
        text: "",
        finishReason: "SAFETY",
        finishMessage: "Response blocked for safety reasons",
      })
    );
  });
});

describe("normalizeVertexGeminiGenerationConfig", () => {
  it("drops Gemini 3.x sampling params", () => {
    expect(
      normalizeVertexGeminiGenerationConfig("gemini-3.5-flash", {
        temperature: 0,
        topP: 0.9,
        topK: 40,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingLevel: "MINIMAL",
        },
      })
    ).toEqual({
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingLevel: "MINIMAL",
      },
    });
  });

  it("keeps non-Gemini 3 configs unchanged", () => {
    const config = {
      temperature: 0,
    };

    expect(
      normalizeVertexGeminiGenerationConfig("gemini-2.0-flash", config)
    ).toBe(config);
  });
});
