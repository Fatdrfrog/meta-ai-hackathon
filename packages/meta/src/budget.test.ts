import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSpendLedger, samVideoCostUsd, tokenCostUsd } from "./budget.ts";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("prices fresh, cached and output tokens separately", () => {
  const usd = tokenCostUsd("muse-spark-1.3", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    input_tokens_details: { cached_tokens: 400_000 },
  });
  // 600k fresh at $1.25/M + 400k cached at $0.15/M + 1M output at $4.25/M
  close(usd, 0.75 + 0.06 + 4.25);
});

test("Muse Spark Open on Baseten is priced under the hackathon model ID", () => {
  close(tokenCostUsd("meta-models/muse-spark-open-1026", { input_tokens: 1_000_000, output_tokens: 0 }), 1.25);
  assert.throws(() => tokenCostUsd("meta-models/muse-spark-open", { input_tokens: 1, output_tokens: 1 }), /No price/);
});

test("refuses models without a known price", () => {
  assert.throws(() => tokenCostUsd("muse-wonder-1.0", { input_tokens: 1, output_tokens: 1 }), /No price/);
});

test("SAM video bills per frame with a 50-frame minimum", () => {
  close(samVideoCostUsd(10), samVideoCostUsd(50));
  close(samVideoCostUsd(1800), 0.36);
});

test("the ledger blocks a call past the cap and keeps its total across reopening", () => {
  const path = join(mkdtempSync(join(tmpdir(), "spend-")), "spend.json");
  const ledger = openSpendLedger(path, 1);
  ledger.record({ model: "sam-3.1", usd: 0.9, note: "test" });
  assert.throws(() => ledger.assertCanSpend(0.2, "sam-3.1"), /Budget cap/);
  ledger.assertCanSpend(0.1, "sam-3.1");
  close(openSpendLedger(path, 1).totalUsd(), 0.9);
});
