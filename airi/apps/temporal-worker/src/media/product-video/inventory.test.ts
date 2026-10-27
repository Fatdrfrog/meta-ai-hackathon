import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";

import {
  inventoryChecks,
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

test("a price must come with words the owner said, matching its number", () => {
  assert.equal(quoteInTranscript("БЕС МЫҢ теңге", TRANSCRIPT), true);
  assert.equal(quoteInTranscript("алты мың теңге", TRANSCRIPT), false);
  assert.equal(quoteInTranscript("  ", TRANSCRIPT), false);
  // However Scribe grouped the digits.
  assert.equal(quoteInTranscript("2000 теңге", "Бағасы 2 000 теңге."), true);
  assert.equal(quoteInTranscript("2 000 теңге", "Бағасы 2000 теңге."), true);

  const transcript = `${TRANSCRIPT}\n[20.1] Телефон 2 000 теңге.`;
  assert.deepEqual(
    inventoryChecks(
      [
        item(),
        item({ priceQuote: "алты мың" }),
        item({ price: null, priceQuote: null }),
        item({ currency: "USD", priceQuote: "бес жүз теңге" }),
        // Digits in the quote must be the price.
        item({ price: 20000, priceQuote: "2 000 теңге" }),
      ],
      transcript,
    ),
    [
      [],
      ["This price doesn't match anything in the narration."],
      ["No price was said for this product."],
      ["The price is in USD, not tenge."],
      ["The price differs from the number in the narration."],
    ],
  );
});

test("two products quoting the same words for their price are both flagged", () => {
  const [first, second] = inventoryChecks(
    [item({ name: "Doll" }), item({ name: "Cup" })],
    TRANSCRIPT,
  );
  assert.deepEqual(first, [
    "Another product's price comes from the same words.",
  ]);
  assert.deepEqual(second, first);
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

test("a window always includes the product's clearest moment", () => {
  // A is clearest at 6 s, after B appeared at 4 s.
  const [a] = presentationWindows(
    [
      { firstSeenSeconds: 0, clearestMomentSeconds: 6 },
      { firstSeenSeconds: 4, clearestMomentSeconds: 8 },
    ],
    20,
  );
  assert.deepEqual(a, { fromSeconds: 4, toSeconds: 8 });
});

async function videoFile(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "inventory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "video.mp4");
  await writeFile(path, "video");
  return path;
}

const muse = (text: string) => async () => ({
  id: "r",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 10_000, output_tokens: 1_000 },
});

test("uploads the video, asks Muse Spark with the transcript, prices the call and deletes the upload", async (t) => {
  const videoPath = await videoFile(t);
  const requests: Array<Record<string, unknown>> = [];
  const costs: Array<[number, string]> = [];
  const deleted: string[] = [];
  let pulses = 0;

  const inventory = await readProductInventory(
    { videoPath, transcript: TRANSCRIPT },
    {
      uploadMetaFile: async (file) => {
        assert.equal(file.mimeType, "video/mp4");
        assert.equal(Buffer.from(file.data).toString(), "video");
        return { id: "file_7" };
      },
      deleteMetaFile: async (id) => {
        deleted.push(id);
      },
      createMetaResponse: async (request) => {
        requests.push(request);
        return muse(JSON.stringify({ language: "Kazakh", items: [] }))();
      },
      onCost: (usd, what) => costs.push([usd, what]),
      pulse: () => {
        pulses++;
      },
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
  assert.deepEqual(deleted, ["file_7"]);
  assert.ok(pulses >= 2);
});

test("deletes the upload even when the answer can't be read", async (t) => {
  const videoPath = await videoFile(t);
  const deleted: string[] = [];

  await assert.rejects(
    readProductInventory(
      { videoPath, transcript: "" },
      {
        uploadMetaFile: async () => ({ id: "file_8" }),
        deleteMetaFile: async (id) => {
          deleted.push(id);
        },
        createMetaResponse: muse('{"language": "kk", "items": [{"na'),
      },
    ),
    (error: unknown) =>
      error instanceof MetaModelApiError &&
      error.info.code === "invalid_json" &&
      error.info.transient,
  );
  assert.deepEqual(deleted, ["file_8"]);
});
