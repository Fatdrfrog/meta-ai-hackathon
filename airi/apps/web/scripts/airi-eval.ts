/**
 * Live routing eval: runs the production intent classifier over the Airi
 * golden set and reports accuracy, a confusion matrix, latency and token cost.
 *
 * cd apps/web && pnpm eval:airi-intents --live [--intent <kind>] [--limit <n>] [--concurrency <n>] [--json]
 *
 * It calls the real model (Claude when ANTHROPIC_API_KEY is set), so it
 * refuses to start without --live and the key. It passes an empty workspace
 * id, so no llm_trace analytics rows are written, and it never touches Mongo.
 */
import type { LlmTokenUsage } from "@icecore/airi-runtime/llm-analytics";
import { estimateLlmCostUsd } from "@icecore/airi-runtime/llm-pricing";
import type {
  AiriChatIntentClassification,
  AiriChatIntentKind,
} from "../src/lib/airi-chats/intent-classifier";
import {
  AIRI_GOLDEN_INTENT_KINDS,
  loadAiriGoldenIntents,
  type AiriGoldenIntent,
} from "../src/lib/airi-chats/evals/golden-intents";
import { loadWebOperatorEnv } from "./load-web-operator-env";

const USAGE =
  "Usage: airi-eval.ts --live [--intent <kind>] [--limit <n>] [--concurrency <n>] [--json]";
const MAX_CONCURRENCY = 8;
/** Reasons the classifier returns when the model call failed or was unusable. */
const CLASSIFIER_FAILURE_REASONS = new Set([
  "classifier_failed",
  "invalid_classifier_response",
]);

export type AiriEvalOptions = {
  intent: AiriChatIntentKind | null;
  limit: number | null;
  concurrency: number;
  json: boolean;
};

type ParsedArgs =
  | { ok: true; live: boolean; options: AiriEvalOptions }
  | { ok: false; error: string };

function readPositiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

export function parseAiriEvalArgs(argv: readonly string[]): ParsedArgs {
  const options: AiriEvalOptions = {
    intent: null,
    limit: null,
    concurrency: 2,
    json: false,
  };
  let live = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") live = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--intent") {
      const value = argv[(index += 1)];
      const intent = AIRI_GOLDEN_INTENT_KINDS.find(kind => kind === value);
      if (!intent)
        return { ok: false, error: `Unknown intent: ${value ?? ""}` };
      options.intent = intent;
    } else if (arg === "--limit" || arg === "--concurrency") {
      const value = readPositiveInt(argv[(index += 1)]);
      if (value === null)
        return { ok: false, error: `${arg} needs a positive integer` };
      if (arg === "--limit") options.limit = value;
      else options.concurrency = Math.min(value, MAX_CONCURRENCY);
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  return { ok: true, live, options };
}

export type AiriEvalSample = {
  id: string;
  lang: AiriGoldenIntent["lang"];
  expectedIntent: AiriChatIntentKind;
  predictedIntent: AiriChatIntentKind;
  /** "rule" when a deterministic route answered without the model. */
  routedBy: "rule" | "model";
  /** The classifier swallowed a provider failure into general_answer. */
  failed: boolean;
  reason: string | null;
  provider: string | null;
  model: string | null;
  wallMs: number;
  usage: LlmTokenUsage | null;
};

type Rate = { total: number; correct: number; accuracy: number };

export type AiriEvalSummary = {
  total: number;
  correct: number;
  accuracy: number;
  failed: number;
  routedByRule: number;
  byIntent: Record<string, Rate>;
  byLang: Record<string, Rate>;
  byRoute: Record<string, Rate>;
  /** confusion[expected][predicted] = count. */
  confusion: Record<string, Record<string, number>>;
  latencyMs: { p50: number; p90: number; max: number; modelP50: number };
  tokens: {
    prompt: number;
    completion: number;
    thinking: number;
    cached: number;
  };
  costUsd: number;
  unpricedModels: string[];
  providers: Record<string, number>;
  misses: Array<{
    id: string;
    expected: string;
    predicted: string;
    reason: string | null;
  }>;
};

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[index];
}

function addRate(
  rates: Record<string, Rate>,
  key: string,
  correct: boolean
): void {
  const rate = (rates[key] ??= { total: 0, correct: 0, accuracy: 0 });
  rate.total += 1;
  if (correct) rate.correct += 1;
  rate.accuracy = rate.correct / rate.total;
}

function readUsage(value: unknown): LlmTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  return value as LlmTokenUsage;
}

export function summarizeAiriEval(
  samples: readonly AiriEvalSample[]
): AiriEvalSummary {
  const summary: AiriEvalSummary = {
    total: samples.length,
    correct: 0,
    accuracy: 0,
    failed: 0,
    routedByRule: 0,
    byIntent: {},
    byLang: {},
    byRoute: {},
    confusion: {},
    latencyMs: { p50: 0, p90: 0, max: 0, modelP50: 0 },
    tokens: { prompt: 0, completion: 0, thinking: 0, cached: 0 },
    costUsd: 0,
    unpricedModels: [],
    providers: {},
    misses: [],
  };
  const unpriced = new Set<string>();
  for (const sample of samples) {
    const correct = sample.predictedIntent === sample.expectedIntent;
    if (correct) summary.correct += 1;
    else {
      summary.misses.push({
        id: sample.id,
        expected: sample.expectedIntent,
        predicted: sample.predictedIntent,
        reason: sample.reason,
      });
    }
    if (sample.failed) summary.failed += 1;
    if (sample.routedBy === "rule") summary.routedByRule += 1;
    addRate(summary.byIntent, sample.expectedIntent, correct);
    addRate(summary.byLang, sample.lang, correct);
    addRate(summary.byRoute, sample.routedBy, correct);
    const row = (summary.confusion[sample.expectedIntent] ??= {});
    row[sample.predictedIntent] = (row[sample.predictedIntent] ?? 0) + 1;
    const provider =
      sample.provider ?? (sample.routedBy === "rule" ? "rule" : "none");
    summary.providers[provider] = (summary.providers[provider] ?? 0) + 1;

    const usage = sample.usage;
    if (!usage || !sample.model) continue;
    summary.tokens.prompt += usage.prompt_tokens ?? 0;
    summary.tokens.completion += usage.completion_tokens ?? 0;
    summary.tokens.thinking += usage.thinking_tokens ?? 0;
    summary.tokens.cached += usage.cached_prompt_tokens ?? 0;
    const cost = estimateLlmCostUsd({
      model: sample.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      thinkingTokens: usage.thinking_tokens,
      cachedPromptTokens: usage.cached_prompt_tokens,
      cacheWritePromptTokens: usage.cache_write_prompt_tokens,
    });
    summary.costUsd += cost.totalCostUsd;
    if (!cost.pricingMatched) unpriced.add(sample.model);
  }
  summary.accuracy = summary.total ? summary.correct / summary.total : 0;
  const wall = samples.map(sample => sample.wallMs);
  const modelWall = samples
    .filter(sample => sample.routedBy === "model")
    .map(sample => sample.wallMs);
  summary.latencyMs = {
    p50: percentile(wall, 0.5),
    p90: percentile(wall, 0.9),
    max: wall.length ? Math.max(...wall) : 0,
    modelP50: percentile(modelWall, 0.5),
  };
  summary.unpricedModels = [...unpriced].sort();
  return summary;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatAiriEvalReport(summary: AiriEvalSummary): string {
  const lines: string[] = [];
  lines.push(
    `Accuracy ${formatPercent(summary.accuracy)} (${summary.correct}/${summary.total}); ` +
      `${summary.routedByRule} routed by rule; ${summary.failed} classifier failures`
  );
  for (const [label, rates] of [
    ["intent", summary.byIntent],
    ["language", summary.byLang],
    ["route", summary.byRoute],
  ] as const) {
    lines.push(`By ${label}:`);
    for (const [key, rate] of Object.entries(rates)) {
      lines.push(
        `  ${key.padEnd(20)} ${formatPercent(rate.accuracy).padStart(6)} (${rate.correct}/${rate.total})`
      );
    }
  }
  const columns = AIRI_GOLDEN_INTENT_KINDS.map((_, index) => `p${index}`);
  lines.push("Confusion (rows expected, columns predicted):");
  AIRI_GOLDEN_INTENT_KINDS.forEach((intent, index) =>
    lines.push(`  p${index} = ${intent}`)
  );
  lines.push(`  ${"".padEnd(20)} ${columns.map(c => c.padStart(4)).join("")}`);
  for (const expected of AIRI_GOLDEN_INTENT_KINDS) {
    const row = summary.confusion[expected];
    if (!row) continue;
    lines.push(
      `  ${expected.padEnd(20)} ${AIRI_GOLDEN_INTENT_KINDS.map(predicted =>
        String(row[predicted] ?? 0).padStart(4)
      ).join("")}`
    );
  }
  lines.push(
    `Latency ms: p50 ${summary.latencyMs.p50}, p90 ${summary.latencyMs.p90}, max ${summary.latencyMs.max}, model-routed p50 ${summary.latencyMs.modelP50}`
  );
  lines.push(
    `Tokens: prompt ${summary.tokens.prompt} (cached ${summary.tokens.cached}), completion ${summary.tokens.completion}, thinking ${summary.tokens.thinking}`
  );
  lines.push(
    `Estimated cost: $${summary.costUsd.toFixed(4)}` +
      (summary.unpricedModels.length
        ? ` (unpriced: ${summary.unpricedModels.join(", ")})`
        : "")
  );
  lines.push(
    `Providers: ${Object.entries(summary.providers)
      .map(([provider, count]) => `${provider} ${count}`)
      .join(", ")}`
  );
  if (summary.misses.length) {
    lines.push("Misses:");
    for (const miss of summary.misses) {
      lines.push(
        `  ${miss.id}: expected ${miss.expected}, got ${miss.predicted}${miss.reason ? ` (${miss.reason})` : ""}`
      );
    }
  }
  return lines.join("\n");
}

type Classify = (
  item: AiriGoldenIntent
) => Promise<AiriChatIntentClassification>;

async function classifyWithProductionRouter(
  item: AiriGoldenIntent
): Promise<AiriChatIntentClassification> {
  const { classifyAiriChatIntent } = await import(
    "../src/lib/airi-chats/intent-classifier"
  );
  return classifyAiriChatIntent({
    // Empty on purpose: the facade writes llm_trace rows only for a workspace.
    workspaceId: "",
    threadId: "airi-eval",
    userMessageId: item.id,
    userMessage: item.text,
    selectedSources: [],
  });
}

export async function runAiriEval(
  argv: readonly string[],
  dependencies: {
    env?: NodeJS.ProcessEnv;
    loadEnv?: () => void;
    classify?: Classify;
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
    now?: () => number;
  } = {}
): Promise<number> {
  const stdout =
    dependencies.stdout ?? (value => process.stdout.write(`${value}\n`));
  const stderr =
    dependencies.stderr ?? (value => process.stderr.write(`${value}\n`));
  const now = dependencies.now ?? (() => Date.now());
  const parsed = parseAiriEvalArgs(argv);
  if (!parsed.ok) {
    stderr(`${parsed.error}\n${USAGE}`);
    return 1;
  }
  if (!parsed.live) {
    stderr(
      `Refusing to run: this eval calls the live model and costs money. Pass --live.\n${USAGE}`
    );
    return 1;
  }
  (dependencies.loadEnv ?? loadWebOperatorEnv)();
  const env = dependencies.env ?? process.env;
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    stderr(
      "Refusing to run: ANTHROPIC_API_KEY is not set, so the classifier would not run on Claude."
    );
    return 1;
  }

  const { options } = parsed;
  let items = loadAiriGoldenIntents();
  if (options.intent) {
    items = items.filter(item => item.expectedIntent === options.intent);
  }
  if (options.limit) items = items.slice(0, options.limit);

  const classify = dependencies.classify ?? classifyWithProductionRouter;
  const samples: AiriEvalSample[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      const startedAt = now();
      const result = await classify(item).catch(
        (error: unknown): AiriChatIntentClassification => ({
          intent: "general_answer",
          confidence: 0,
          // Only the error class: provider messages can echo request data.
          reason: `classifier_failed:${error instanceof Error ? error.name : "unknown"}`,
          provider: null,
          model: null,
          latencyMs: null,
          usage: null,
        })
      );
      const failed = CLASSIFIER_FAILURE_REASONS.has(
        (result.reason ?? "").split(":")[0]
      );
      samples[index] = {
        id: item.id,
        lang: item.lang,
        expectedIntent: item.expectedIntent,
        predictedIntent: result.intent,
        routedBy: failed || result.provider || result.model ? "model" : "rule",
        failed,
        reason: result.reason,
        provider: result.provider,
        model: result.model,
        wallMs: Math.max(0, now() - startedAt),
        usage: readUsage(result.usage),
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, items.length) }, worker)
  );

  const summary = summarizeAiriEval(samples);
  stdout(
    options.json
      ? JSON.stringify({ summary, samples }, null, 2)
      : formatAiriEvalReport(summary)
  );
  return 0;
}

if (/airi-eval\.(?:ts|js|mjs)$/.test(process.argv[1] || "")) {
  void runAiriEval(process.argv.slice(2)).then(
    code => {
      process.exitCode = code;
    },
    error => {
      process.stderr.write(
        `Airi eval failed: ${error instanceof Error ? error.name : "unknown error"}\n`
      );
      process.exitCode = 1;
    }
  );
}
