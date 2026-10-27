import assert from "node:assert/strict";
import test from "node:test";

import {
  inventoryItemChecks,
  parseInventory,
  presentationWindows,
  quoteInTranscript,
  readProductInventory,
  type InventoryItem,
} from "./inventory";

const TRANSCRIPT = [
  "[1.2] Мынау кружка, бес жүз теңге.",
  "[9.8] Кукла Лол, бес мың теңге!",
].join("\n");

const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  name: "LOL doll",
  localName: "Кукла Лол",
  category: "toy",
  samPhrase: "blonde doll in blue dress",
  price: 5000,
  currency: "KZT",
  priceQuote: "бес мың теңге",
  firstSeenSeconds: 9,
  clearestMomentSeconds: 11,
  doubt: null,
  ...overrides,
});

test("reads the model's JSON into typed items, dropping nameless ones", () => {
  const inventory = parseInventory(
    JSON.stringify({
      language: "Kazakh",
      items: [
        {
          name: " Frosted cup ",
          local_name: "кружка",
          category: "kitchen",
          sam_phrase: "frosted plastic cup",
          price: 500,
          currency: "KZT",
          price_quote: "бес жүз теңге",
          first_seen_s: 1,
          clearest_moment_s: -3,
          doubt: null,
        },
        { name: "", price: 10 },
        "not an item",
        { name: "Phone stand", price: -5, currency: "KZT", price_quote: "x" },
      ],
    }),
  );

  assert.equal(inventory.language, "Kazakh");
  assert.deepEqual(inventory.items[0], {
    name: "Frosted cup",
    localName: "кружка",
    category: "kitchen",
    samPhrase: "frosted plastic cup",
    price: 500,
    currency: "KZT",
    priceQuote: "бес жүз теңге",
    firstSeenSeconds: 1,
    clearestMomentSeconds: 0,
    doubt: null,
  });
  // A negative price is no price, and takes its quote and currency with it.
  assert.deepEqual(inventory.items[1], {
    name: "Phone stand",
    localName: "Phone stand",
    category: "",
    samPhrase: "Phone stand",
    price: null,
    currency: null,
    priceQuote: null,
    firstSeenSeconds: 0,
    clearestMomentSeconds: 0,
    doubt: null,
  });
  assert.equal(inventory.items.length, 2);
});

test("a price must come with words the owner said", () => {
  assert.equal(quoteInTranscript("БЕС МЫҢ теңге", TRANSCRIPT), true);
  assert.equal(quoteInTranscript("алты мың теңге", TRANSCRIPT), false);
  assert.equal(quoteInTranscript("  ", TRANSCRIPT), false);

  assert.deepEqual(inventoryItemChecks(item(), TRANSCRIPT), []);
  assert.deepEqual(
    inventoryItemChecks(item({ priceQuote: "алты мың" }), TRANSCRIPT),
    ["This price doesn't match anything in the narration."],
  );
  assert.deepEqual(
    inventoryItemChecks(item({ price: null, priceQuote: null }), TRANSCRIPT),
    ["No price was said for this product."],
  );
  assert.deepEqual(inventoryItemChecks(item({ currency: "USD" }), TRANSCRIPT), [
    "The price is in USD, not tenge.",
  ]);
});

test("each product's window runs to the next one, kept between 2 and 16 s", () => {
  const windows = presentationWindows(
    [
      { firstSeenSeconds: 0, clearestMomentSeconds: 3 },
      // Shown for under a second: 2 s around its clearest moment.
      { firstSeenSeconds: 5, clearestMomentSeconds: 5.5 },
      // Presented for 40 s: 16 s around its clearest moment.
      { firstSeenSeconds: 5.6, clearestMomentSeconds: 30 },
      // Starts a second before the end.
      { firstSeenSeconds: 59, clearestMomentSeconds: 59.5 },
    ],
    60,
  );

  assert.deepEqual(windows, [
    { fromSeconds: 0, toSeconds: 5 },
    { fromSeconds: 4.5, toSeconds: 6.5 },
    { fromSeconds: 22, toSeconds: 38 },
    { fromSeconds: 58, toSeconds: 60 },
  ]);
});

test("asks Muse Spark about the uploaded video with the transcript, and prices the call", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const costs: Array<[number, string]> = [];

  const inventory = await readProductInventory(
    { videoFileId: "file_7", transcript: TRANSCRIPT },
    {
      createMetaResponse: async (request) => {
        requests.push(request);
        return {
          id: "r",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ language: "Kazakh", items: [] }),
                },
              ],
            },
          ],
          usage: { input_tokens: 10_000, output_tokens: 1_000 },
        };
      },
      onCost: (usd, what) => costs.push([usd, what]),
    },
  );

  assert.deepEqual(inventory, { language: "Kazakh", items: [] });
  const content = (
    requests[0]!.input as Array<{ content: Array<Record<string, string>> }>
  )[0]!.content;
  assert.deepEqual(content[0], { type: "input_video", file_id: "file_7" });
  assert.match(content[1]!.text!, /\[9\.8\] Кукла Лол, бес мың теңге!/);
  assert.equal(requests[0]!.model, "muse-spark-1.3");
  // 10k input at $1.25/M plus 1k output at $4.25/M.
  assert.equal(costs.length, 1);
  assert.ok(Math.abs(costs[0]![0] - 0.01675) < 1e-9);
  assert.equal(costs[0]![1], "inventory");
});
