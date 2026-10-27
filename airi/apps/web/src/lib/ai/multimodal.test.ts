const mockGenerateVertexGeminiContent = jest.fn();
const mockCanUseVertexAI = jest.fn(() => true);
const mockResolveBilling = jest.fn();
const mockHasWorkspaceAction = jest.fn();
const mockMarkVertexUnavailableForRuntime = jest.fn();
const mockChatCompletion = jest.fn();

jest.mock("./workspace-ai-policy", () => ({
  resolveWorkspaceTextAiBilling: () => mockResolveBilling(),
  hasWorkspaceTextAiAction: () => mockHasWorkspaceAction(),
}));

jest.mock("./index", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletion(...args),
  getLightTextModel: () => "test-light-model",
}));
jest.mock("./vertex-config", () => ({
  canUseVertexAI: () => mockCanUseVertexAI(),
  markVertexUnavailableForRuntime: (...args: unknown[]) =>
    mockMarkVertexUnavailableForRuntime(...args),
}));
jest.mock("./vertex-gemini-rest", () => ({
  generateVertexGeminiContent: (...args: unknown[]) =>
    mockGenerateVertexGeminiContent(...args),
  getVertexMultimodalModel: () => "test-multimodal-model",
}));

import { analyzeImage, analyzeVideo } from "./multimodal";

describe("analyzeImage payment evidence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateVertexGeminiContent.mockReset();
    mockCanUseVertexAI.mockReturnValue(true);
    mockHasWorkspaceAction.mockReturnValue(false);
    mockResolveBilling.mockResolvedValue(null);
  });

  it("analyzes with a customer source when platform Vertex is disabled", async () => {
    mockCanUseVertexAI.mockReturnValue(false);
    mockHasWorkspaceAction.mockReturnValue(true);
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      apiKey: "secret",
    });
    mockGenerateVertexGeminiContent.mockResolvedValue("A customer image");
    await expect(
      analyzeImage("https://example.com/image.png", "en")
    ).resolves.toBe("A customer image");
  });

  it("propagates allowance denial instead of returning an unavailable description", async () => {
    mockHasWorkspaceAction.mockReturnValue(true);
    const denial = Object.assign(new Error("Source required"), {
      code: "own_ai_source_required",
    });
    mockResolveBilling.mockRejectedValue(denial);
    await expect(
      analyzeImage("https://example.com/image.png", "en")
    ).rejects.toBe(denial);
  });

  it("does not disable Vertex after a customer authentication error", async () => {
    mockHasWorkspaceAction.mockReturnValue(true);
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      apiKey: "secret",
    });
    mockGenerateVertexGeminiContent.mockRejectedValue(
      Object.assign(new Error("Google AI request failed"), { status: 403 })
    );
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await analyzeImage("https://example.com/image.png", "en");
      expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("requests visible receipt facts as unverified evidence in the existing image call", async () => {
    mockGenerateVertexGeminiContent.mockResolvedValue(
      "Unverified receipt: 7,000 KZT; reference 12345; displayed status successful."
    );

    await expect(
      analyzeImage("https://example.com/receipt.png", "en", "image/png")
    ).resolves.toBe(
      "Unverified receipt: 7,000 KZT; reference 12345; displayed status successful."
    );

    expect(mockGenerateVertexGeminiContent).toHaveBeenCalledTimes(1);
    const request = mockGenerateVertexGeminiContent.mock.calls[0][0];
    const prompt = request.contents[0].parts[0].text as string;
    expect(prompt).toMatch(/amount/i);
    expect(prompt).toMatch(/currency/i);
    expect(prompt).toMatch(/transaction reference/i);
    expect(prompt).toMatch(/displayed (payment )?status/i);
    expect(prompt).toMatch(/unverified/i);
    expect(prompt).toMatch(/invoice/i);
    expect(prompt).toMatch(/payment request/i);
    expect(prompt).toMatch(/failed/i);
    expect(prompt).toMatch(/pending/i);
    expect(prompt).toMatch(/do not infer/i);
    expect(request.contents[0].parts[1]).toEqual({
      fileData: {
        fileUri: "https://example.com/receipt.png",
        mimeType: "image/png",
      },
    });
  });
});

describe("analyzeVideo media input", () => {
  const storedUrl = "https://storage.test/instagram/clip.mp4";

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateVertexGeminiContent.mockReset();
    mockCanUseVertexAI.mockReturnValue(true);
    mockHasWorkspaceAction.mockReturnValue(false);
    mockChatCompletion.mockResolvedValue({
      content: "Intent: Report a damaged box",
    });
  });

  it("summarizes the transcript instead of sending a remote video on platform billing", async () => {
    mockResolveBilling.mockResolvedValue({ billingSource: "platform" });

    await expect(
      analyzeVideo(storedUrl, "en", "video/mp4", {
        precomputedTranscript: "The box arrived damaged.",
      })
    ).resolves.toBe("Intent: Report a damaged box");
    expect(mockGenerateVertexGeminiContent).not.toHaveBeenCalled();
  });

  it("sends a video small enough to go inline on platform billing", async () => {
    mockResolveBilling.mockResolvedValue({ billingSource: "platform" });
    mockGenerateVertexGeminiContent.mockResolvedValue("A dented box.");

    await expect(
      analyzeVideo(storedUrl, "en", "video/mp4", { inlineDataBase64: "AAAA" })
    ).resolves.toBe("A dented box.");
    expect(
      mockGenerateVertexGeminiContent.mock.calls[0][0].contents[0].parts[1]
    ).toEqual({ inlineData: { data: "AAAA", mimeType: "video/mp4" } });
  });

  it("lets a customer key read the video by its link", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      apiKey: "secret",
    });
    mockGenerateVertexGeminiContent.mockResolvedValue("A dented box.");

    await analyzeVideo(storedUrl, "en", "video/mp4");
    expect(
      mockGenerateVertexGeminiContent.mock.calls[0][0].contents[0].parts[1]
    ).toEqual({ fileData: { fileUri: storedUrl, mimeType: "video/mp4" } });
  });
});
