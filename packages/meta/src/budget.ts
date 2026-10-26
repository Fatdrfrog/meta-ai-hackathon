import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// USD per million tokens, from dev.meta.ai pricing (October 2026).
// A model missing here cannot be called: an unpriced call would make the cap meaningless.
const TOKEN_PRICES: Readonly<Record<string, { input: number; cachedInput: number; output: number }>> = {
  "muse-spark-1.3": { input: 1.25, cachedInput: 0.15, output: 4.25 },
};

const SAM_VIDEO_USD_PER_FRAME = 0.2 / 1000;
const SAM_MIN_BILLED_FRAMES = 50;

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
}

export function requirePrice(model: string): void {
  if (!TOKEN_PRICES[model]) {
    throw new Error(`No price for model "${model}". Add it to TOKEN_PRICES in budget.ts before calling it.`);
  }
}

export function tokenCostUsd(model: string, usage: TokenUsage): number {
  requirePrice(model);
  const price = TOKEN_PRICES[model]!;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const fresh = usage.input_tokens - cached;
  return (fresh * price.input + cached * price.cachedInput + usage.output_tokens * price.output) / 1_000_000;
}

export function samVideoCostUsd(frames: number): number {
  return Math.max(frames, SAM_MIN_BILLED_FRAMES) * SAM_VIDEO_USD_PER_FRAME;
}

export interface SpendEntry {
  readonly at: string;
  readonly model: string;
  readonly usd: number;
  readonly note: string;
}

interface LedgerFile {
  totalUsd: number;
  entries: SpendEntry[];
}

export interface SpendLedger {
  readonly limitUsd: number;
  totalUsd(): number;
  /** Throws before a call that would push estimated spend past the limit. */
  assertCanSpend(usd: number, what: string): void;
  record(entry: Omit<SpendEntry, "at">): void;
}

// Meta's "Spend Limit" only notifies; this ledger is what actually stops calls.
// One process at a time writes it, which holds for scripts; the app will keep spend in its database.
export function openSpendLedger(path: string, limitUsd: number): SpendLedger {
  const load = (): LedgerFile =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LedgerFile) : { totalUsd: 0, entries: [] };

  return {
    limitUsd,
    totalUsd: () => load().totalUsd,
    assertCanSpend(usd, what) {
      const total = load().totalUsd;
      if (total + usd > limitUsd) {
        throw new Error(
          `Budget cap: ${what} would bring estimated spend to $${(total + usd).toFixed(4)}, over the $${limitUsd} limit (META_BUDGET_USD).`,
        );
      }
    },
    record(entry) {
      const ledger = load();
      ledger.totalUsd += entry.usd;
      ledger.entries.push({ ...entry, at: new Date().toISOString() });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
    },
  };
}
