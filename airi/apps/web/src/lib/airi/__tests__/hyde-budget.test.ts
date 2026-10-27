const mockChat = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockGetLightTextModel = jest.fn(() => "gemini-3.5-flash");
jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) => mockChat(...args),
  getLightTextModel: () => mockGetLightTextModel(),
  // The real per-family config, so assertions cover Gemini and Claude ids.
  getStructuredJsonGenerationConfig: (model: string) =>
    jest
      .requireActual<
        typeof import("@/lib/ai/text-models")
      >("@/lib/ai/text-models")
      .getStructuredJsonGenerationConfig(model),
}));
jest.mock("@/lib/cache", () => ({
  buildCacheKey: (_prefix: string, parts: string[]) => parts.join(":"),
  cache: {
    get: (...args: unknown[]) => mockGet(...args),
    set: (...args: unknown[]) => mockSet(...args),
  },
}));
jest.mock("@/lib/airi/shared/logger", () => ({
  ragLogger: { query: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() } },
}));
import { generateHypotheticalAnswer } from "../rag/pipeline/hyde";
import { estimateTokenCount } from "../shared/token-budget";

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue(null);
  mockChat.mockResolvedValue({ content: "A concise refund policy." });
});
it("caps HyDE thinking and visible output without changing the model", async () => {
  await generateHypotheticalAnswer("Refund policy?");
  expect(mockGetLightTextModel).toHaveBeenCalled();
  expect(mockChat).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "gemini-3.5-flash",
      generationConfig: expect.objectContaining({
        maxOutputTokens: 512,
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      }),
    })
  );
});
it("runs on the Claude light tier with a low thinking level", async () => {
  mockGetLightTextModel.mockReturnValueOnce("claude-haiku-4-5");
  await generateHypotheticalAnswer("Refund policy?");
  expect(mockChat).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "claude-haiku-4-5",
      generationConfig: {
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: 512,
      },
    })
  );
});
it("does not reuse hypothetical answers across workspaces or domain contexts", async () => {
  await generateHypotheticalAnswer("Refund policy?", {
    workspaceId: "tenant-a",
    domainContext: "Travel",
  });
  await generateHypotheticalAnswer("Refund policy?", {
    workspaceId: "tenant-b",
    domainContext: "Travel",
  });
  await generateHypotheticalAnswer("Refund policy?", {
    workspaceId: "tenant-a",
    domainContext: "Health",
  });
  expect(new Set(mockGet.mock.calls.map(([key]) => key)).size).toBe(3);
});
it("bounds seeded and cached expansions", async () => {
  const huge = "退款政策 ".repeat(10000);
  const seeded = await generateHypotheticalAnswer("Refund policy?", {
    seedHypotheticalAnswer: huge,
  });
  expect(estimateTokenCount(seeded.hypotheticalAnswer!)).toBeLessThanOrEqual(
    256
  );
  mockGet.mockResolvedValue(huge);
  const cached = await generateHypotheticalAnswer("Refund policy?");
  expect(estimateTokenCount(cached.hypotheticalAnswer!)).toBeLessThanOrEqual(
    256
  );
});
it("bounds huge generated output before caching and embedding it", async () => {
  const huge = "退款政策 ".repeat(10000);
  mockChat.mockResolvedValueOnce({ content: huge });
  const generated = await generateHypotheticalAnswer("Refund policy?");

  expect(mockChat).toHaveBeenCalledTimes(1);
  expect(generated.applied).toBe(true);
  expect(estimateTokenCount(generated.hypotheticalAnswer!)).toBeLessThanOrEqual(
    256
  );
  expect(generated.hypotheticalAnswer!.length).toBeLessThan(huge.length);
  expect(generated.textForEmbedding).toBe(
    `Refund policy?\n\n${generated.hypotheticalAnswer}`
  );
  expect(mockSet).toHaveBeenCalledWith(
    expect.any(String),
    generated.hypotheticalAnswer,
    12 * 60 * 60
  );
});
