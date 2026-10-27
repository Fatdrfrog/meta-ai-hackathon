const mockChat = jest.fn();
// The provider-aware chat path owns billing, provider order and model mapping.
const mockGenerate = jest.fn();

jest.mock("./index", () => ({
  chatCompletionWithFallback: (...args: unknown[]) => mockChat(...args),
}));
jest.mock("./text-models", () => ({
  getHeavyTextModel: () => "claude-sonnet-5-5",
}));

import { generateConversationSummary } from "./summarization";

let mockProvider = "anthropic";
beforeEach(() => {
  mockProvider = "anthropic";
  mockChat.mockImplementation(
    async (options: {
      messages: Array<{ content: string }>;
      generationConfig: Record<string, unknown>;
    }) => {
      const prompt = options.messages[0].content;
      const content = await mockGenerate({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: options.generationConfig,
      });
      return { content, provider: mockProvider, model: "claude-sonnet-5-5" };
    }
  );
});

it("summarizes through the provider-aware heavy tier and reports the serving provider", async () => {
  mockProvider = "google";
  mockGenerate.mockResolvedValue("Customer asked about pricing");
  const result = await generateConversationSummary([
    { text: "What is the price?" },
  ]);
  expect(result.summary).toBe("Customer asked about pricing");
  expect(result.provider).toBe("google");
  expect(mockChat).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "claude-sonnet-5-5",
      temperature: 0.3,
      generationConfig: { maxOutputTokens: 1024 },
      messages: [
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("What is the price?"),
        }),
      ],
    })
  );
});

it("reports Claude as the provider for platform-funded summaries", async () => {
  mockGenerate.mockResolvedValue("Summary");
  const result = await generateConversationSummary([{ text: "Hello" }]);
  expect(result.provider).toBe("anthropic");
});
describe("summary input reuse", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("derives the main summary from ordered chunk evidence rather than sending the transcript twice", async () => {
    mockGenerate.mockImplementation(
      async (request: {
        contents: Array<{ parts: Array<{ text: string }> }>;
      }) => {
        const prompt = request.contents[0].parts[0].text;
        if (prompt.includes("customer paid 500")) return "Payment: 500.";
        if (prompt.includes("customer disputed refund"))
          return "Refund disputed.";
        return "Payment 500 and disputed refund.";
      }
    );
    const result = await generateConversationSummary(
      [{ text: "customer paid 500" }, { text: "customer disputed refund" }],
      { chunkSize: 3, generateChunks: true }
    );
    const inputs = mockGenerate.mock.calls.map(
      ([request]) => request.contents[0].parts[0].text as string
    );
    expect(
      inputs.filter(input => input.includes("customer paid 500"))
    ).toHaveLength(1);
    expect(
      inputs.filter(input => input.includes("customer disputed refund"))
    ).toHaveLength(1);
    expect(inputs[2]).toContain("Payment: 500.");
    expect(inputs[2]).toContain("Refund disputed.");
    expect(inputs[2].indexOf("Payment: 500.")).toBeLessThan(
      inputs[2].indexOf("Refund disputed.")
    );
    expect(result.chunks).toEqual(["Payment: 500.", "Refund disputed."]);
    expect(result.summary).toBe("Payment 500 and disputed refund.");
    expect(
      mockGenerate.mock.calls.every(
        ([request]) => request.generationConfig.maxOutputTokens === 1024
      )
    ).toBe(true);
  });

  it("retains all evidence when one chunk fails instead of deriving from incomplete chunk coverage", async () => {
    mockGenerate.mockImplementation(
      async (request: {
        contents: Array<{ parts: Array<{ text: string }> }>;
      }) => {
        const prompt = request.contents[0].parts[0].text;
        if (
          prompt.includes("customer paid 500") &&
          prompt.includes("customer disputed refund")
        )
          return "Complete payment and refund evidence.";
        if (prompt.includes("customer disputed refund"))
          throw new Error("transient provider error");
        return "Payment: 500.";
      }
    );
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await generateConversationSummary(
        [{ text: "customer paid 500" }, { text: "customer disputed refund" }],
        { chunkSize: 3, generateChunks: true }
      );
      expect(result.summary).toBe("Complete payment and refund evidence.");
      expect(result.chunks).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("chunks an oversized single message so its transcript is summarized only once", async () => {
    mockGenerate.mockImplementation(
      async (request: {
        contents: Array<{ parts: Array<{ text: string }> }>;
      }) => {
        const prompt = request.contents[0].parts[0].text;
        if (prompt.includes("first evidence")) return "First result.";
        if (prompt.includes("last evidence")) return "Last result.";
        return "Combined result.";
      }
    );
    const result = await generateConversationSummary(
      [{ text: "first evidence middle evidence last evidence" }],
      { chunkSize: 2 }
    );
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]).toBe("First result.");
    expect(result.chunks[2]).toBe("Last result.");
    expect(mockGenerate).toHaveBeenCalledTimes(4);
  });
});
