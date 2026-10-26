import assert from "node:assert/strict";
import { test } from "node:test";
import type { InventoryItem } from "./inventory.ts";
import { checkItem, quoteInTranscript } from "./pipeline.ts";

const transcript = "[36.1] Кукла Лол деген бар.\n[38.0] Кукла Лолдың бағасы бес мың теңге.";

const item = (overrides: Partial<InventoryItem>): InventoryItem => ({
  name: "LOL doll",
  local_name: "Кукла Лол",
  category: "toy",
  sam_phrase: "doll in blue dress",
  price: 5000,
  currency: "KZT",
  price_quote: "бағасы бес мың теңге",
  first_seen_s: 36,
  clearest_moment_s: 38,
  doubt: null,
  ...overrides,
});

test("a quote matches the transcript regardless of case and punctuation", () => {
  assert.ok(quoteInTranscript("Бағасы бес мың теңге.", transcript));
  assert.ok(!quoteInTranscript("бағасы бес жүз теңге", transcript));
  assert.ok(!quoteInTranscript("", transcript));
});

test("a price backed by the owner's words passes", () => {
  assert.deepEqual(checkItem(item({}), transcript), []);
});

test("a price the owner never said is flagged", () => {
  assert.deepEqual(checkItem(item({ price: 500, price_quote: "бес жүз теңге" }), transcript), [
    "This price doesn't match anything in the narration.",
  ]);
});

test("a missing price and a foreign currency are flagged", () => {
  assert.deepEqual(checkItem(item({ price: null, currency: null, price_quote: null }), transcript), ["No price was said for this item."]);
  assert.deepEqual(checkItem(item({ currency: "USD" }), transcript), ["The price is in USD, not tenge."]);
});
