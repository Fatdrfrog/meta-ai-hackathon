import type { AiriChatIntentClassification } from "../src/lib/airi-chats/intent-classifier";
import {
  parseAiriEvalArgs,
  runAiriEval,
  summarizeAiriEval,
  type AiriEvalSample,
} from "./airi-eval";

function classification(
  overrides: Partial<AiriChatIntentClassification>
): AiriChatIntentClassification {
  return {
    intent: "general_answer",
    confidence: 0.9,
    reason: "model",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    latencyMs: 100,
    usage: { prompt_tokens: 1000, completion_tokens: 20 },
    ...overrides,
  };
}

describe("airi-eval guards", () => {
  it("refuses to run without --live and never loads env or calls the model", async () => {
    const classify = jest.fn();
    const loadEnv = jest.fn();
    const errors: string[] = [];
    expect(
      await runAiriEval([], {
        classify,
        loadEnv,
        env: { ANTHROPIC_API_KEY: "test-key" },
        stderr: value => errors.push(value),
      })
    ).toBe(1);
    expect(errors.join("")).toContain("Pass --live");
    expect(loadEnv).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([{}, { ANTHROPIC_API_KEY: "   " }])(
    "refuses to run with --live when ANTHROPIC_API_KEY is missing (%j)",
    async env => {
      const classify = jest.fn();
      const errors: string[] = [];
      expect(
        await runAiriEval(["--live"], {
          classify,
          loadEnv: () => undefined,
          env,
          stderr: value => errors.push(value),
        })
      ).toBe(1);
      expect(errors.join("")).toContain("ANTHROPIC_API_KEY is not set");
      expect(classify).not.toHaveBeenCalled();
    }
  );

  it.each([
    [["--live", "--intent", "campaign"], "Unknown intent"],
    [["--live", "--limit", "0"], "positive integer"],
    [["--live", "--concurrency"], "positive integer"],
    [["--live", "--verbose"], "Unknown argument"],
  ])("rejects bad arguments %j", (argv, message) => {
    const parsed = parseAiriEvalArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("caps concurrency and filters by intent and limit", async () => {
    expect(parseAiriEvalArgs(["--live", "--concurrency", "50"])).toMatchObject({
      ok: true,
      options: { concurrency: 8 },
    });
    const classify = jest.fn(async () =>
      classification({ intent: "meta_ads_mcp" })
    );
    const output: string[] = [];
    expect(
      await runAiriEval(
        ["--live", "--intent", "meta_ads_mcp", "--limit", "3", "--json"],
        {
          classify,
          loadEnv: () => undefined,
          env: { ANTHROPIC_API_KEY: "test-key" },
          stdout: value => output.push(value),
        }
      )
    ).toBe(0);
    expect(classify).toHaveBeenCalledTimes(3);
    const report = JSON.parse(output.join(""));
    expect(report.summary).toMatchObject({ total: 3, correct: 3, accuracy: 1 });
    expect(
      report.samples.every(
        (sample: AiriEvalSample) => sample.expectedIntent === "meta_ads_mcp"
      )
    ).toBe(true);
  });

  it("records a thrown classifier error as a failed sample without its message", async () => {
    const output: string[] = [];
    expect(
      await runAiriEval(
        ["--live", "--intent", "image_generation", "--limit", "1", "--json"],
        {
          classify: async () => {
            throw new TypeError("provider body with customer text");
          },
          loadEnv: () => undefined,
          env: { ANTHROPIC_API_KEY: "test-key" },
          stdout: value => output.push(value),
        }
      )
    ).toBe(0);
    const text = output.join("");
    expect(text).not.toContain("customer text");
    expect(JSON.parse(text).summary).toMatchObject({ failed: 1, correct: 0 });
  });
});

describe("summarizeAiriEval", () => {
  const base = {
    lang: "en" as const,
    reason: null,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    failed: false,
    usage: { prompt_tokens: 1000, completion_tokens: 20 },
  };

  it("computes accuracy, confusion, latency, rule share and cost", () => {
    const samples: AiriEvalSample[] = [
      {
        ...base,
        id: "a",
        expectedIntent: "whatsapp_template",
        predictedIntent: "whatsapp_template",
        routedBy: "model",
        wallMs: 100,
      },
      {
        ...base,
        id: "b",
        expectedIntent: "whatsapp_template",
        predictedIntent: "product_capability",
        routedBy: "model",
        wallMs: 300,
      },
      {
        ...base,
        id: "c",
        lang: "ru",
        expectedIntent: "meta_ads_mcp",
        predictedIntent: "meta_ads_mcp",
        routedBy: "rule",
        provider: null,
        model: null,
        usage: null,
        wallMs: 1,
      },
    ];
    const summary = summarizeAiriEval(samples);
    expect(summary).toMatchObject({
      total: 3,
      correct: 2,
      routedByRule: 1,
      byIntent: {
        whatsapp_template: { total: 2, correct: 1, accuracy: 0.5 },
        meta_ads_mcp: { total: 1, correct: 1, accuracy: 1 },
      },
      byLang: { en: { total: 2, correct: 1 }, ru: { total: 1, correct: 1 } },
      confusion: {
        whatsapp_template: { whatsapp_template: 1, product_capability: 1 },
        meta_ads_mcp: { meta_ads_mcp: 1 },
      },
      latencyMs: { p50: 100, p90: 300, max: 300, modelP50: 100 },
      tokens: { prompt: 2000, completion: 40 },
      providers: { anthropic: 2, rule: 1 },
      misses: [
        {
          id: "b",
          expected: "whatsapp_template",
          predicted: "product_capability",
        },
      ],
    });
    expect(summary.accuracy).toBeCloseTo(2 / 3);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(summary.unpricedModels).toEqual([]);
  });
});
