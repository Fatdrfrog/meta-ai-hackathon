import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";

import {
  inventoryChecks,
  modelDoubtSubject,
  parseInventory,
  presentationWindows,
  quoteInTranscript,
  readProductInventory,
  reviewClipWindow,
  type InventoryItem,
} from "./inventory";

const TRANSCRIPT = [
  "[1.2] Мынау кружка, бес жүз теңге.",
  "[9.8] Кукла Лол, бес мың теңге!",
].join("\n");

const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  name: "LOL doll",
  localName: "Кукла Лол",
  nameSource: "spoken",
  category: "toy",
  price: 5000,
  currency: "KZT",
  priceQuote: "бес мың теңге",
  priceQuoteSeconds: 9.8,
  priceSource: "spoken",
  priceIsFrom: false,
  options: [
    {
      description: "blonde doll in blue dress",
      samPhrase: "blonde doll in blue dress",
      firstSeenSeconds: 9,
      clearestMomentSeconds: 11,
    },
  ],
  featuredOption: 0,
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
          name_source: "spoken",
          category: "kitchen",
          price: 500,
          currency: "KZT",
          price_quote: "бес жүз теңге",
          price_quote_s: 1.2,
          price_source: "none",
          price_is_from: true,
          options: [
            {
              description: " frosted cup with logo ",
              sam_phrase: "frosted plastic cup",
              first_seen_s: 1,
              clearest_moment_s: -3,
            },
            { description: "", sam_phrase: "" },
            "not an option",
          ],
          featured_option: 4,
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
    nameSource: "spoken",
    category: "kitchen",
    price: 500,
    currency: "KZT",
    priceQuote: "бес жүз теңге",
    priceQuoteSeconds: 1.2,
    // A price never goes unchecked: "none" beside a price counts as spoken.
    priceSource: "spoken",
    priceIsFrom: true,
    // Options with no words are dropped; a featured option out of range
    // falls back to the first.
    options: [
      {
        description: "frosted cup with logo",
        samPhrase: "frosted plastic cup",
        firstSeenSeconds: 1,
        clearestMomentSeconds: 0,
      },
    ],
    featuredOption: 0,
    doubt: null,
  });
  // A negative price is no price, and takes its quote and currency with it.
  assert.deepEqual(inventory.items[1], {
    name: "Phone stand",
    localName: "Phone stand",
    nameSource: "spoken",
    category: "",
    price: null,
    currency: null,
    priceQuote: null,
    priceQuoteSeconds: null,
    priceSource: null,
    priceIsFrom: false,
    options: [],
    featuredOption: 0,
    doubt: null,
  });
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.presenter, null);
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
      ["No price was said or shown for this product."],
      ["The price is in USD, not tenge."],
      ["The price differs from the number in the narration."],
    ],
  );
});

test("a price only written on screen is checked against its own text and flagged", () => {
  assert.deepEqual(
    inventoryChecks(
      [
        item({
          priceSource: "on_screen",
          price: 15500,
          priceQuote: "15500т бастап",
        }),
        item({
          priceSource: "on_screen",
          price: 16900,
          priceQuote: "15 500 ₸",
        }),
        item({ priceSource: "on_screen", price: 3000, priceQuote: null }),
      ],
      TRANSCRIPT,
    ),
    [
      ["This price was read from text in the video, not said aloud."],
      [
        "This price was read from text in the video, not said aloud.",
        "The price differs from the number shown in the video.",
      ],
      [
        "This price was read from text in the video, not said aloud.",
        "The video's text for this price is missing.",
      ],
    ],
  );
});

test("reads the presenter, and on-screen and starting prices", () => {
  const inventory = parseInventory(
    JSON.stringify({
      language: "Kazakh",
      presenter: { present: true, clearest_moment_s: 4.5 },
      items: [
        {
          name: "Family tree panel",
          price: 15500,
          currency: "KZT",
          price_quote: "15500т бастап",
          price_source: "on_screen",
          price_is_from: true,
        },
      ],
    }),
  );

  assert.deepEqual(inventory.presenter, { clearestMomentSeconds: 4.5 });
  assert.equal(inventory.items[0]!.priceSource, "on_screen");
  assert.equal(inventory.items[0]!.priceIsFrom, true);
  assert.equal(
    parseInventory(
      JSON.stringify({
        items: [],
        presenter: { present: false, clearest_moment_s: 3 },
      }),
    ).presenter,
    null,
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

  assert.deepEqual(inventory, {
    language: "Kazakh",
    items: [],
    presenter: null,
  });
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

test("the same short phrase said of two products, in two sentences, isn't flagged", () => {
  // QazOner's promo says "from 15 500" twice: of the family-tree panel, and
  // of panels and clocks together.
  const transcript = [
    "[7.5] Шежірелердің бағасы он бес мың бес жүзден басталады.",
    "[17.9] Этно паннолар мен сағаттар бағасы он бес мың бес жүзден басталады.",
  ].join("\n");
  const phrase = "он бес мың бес жүзден басталады";
  const [tree, panel, clock, untimed] = inventoryChecks(
    [
      item({ price: 15500, priceQuote: phrase, priceQuoteSeconds: 7.5 }),
      item({ price: 15500, priceQuote: phrase, priceQuoteSeconds: 17.9 }),
      item({ price: 15500, priceQuote: phrase, priceQuoteSeconds: 17.9 }),
      // A wrong time falls back to the whole narration, still checked.
      item({ price: 15500, priceQuote: phrase, priceQuoteSeconds: 3 }),
    ],
    transcript,
  );

  assert.deepEqual(tree, []);
  assert.deepEqual(panel, [
    "Another product's price comes from the same words.",
  ]);
  assert.deepEqual(clock, panel);
  assert.deepEqual(untimed, []);
});

test("reads a product named on screen, with several options and its featured one", () => {
  const options = Array.from({ length: 10 }, (_, i) => ({
    description: `design ${i + 1}`,
    sam_phrase: `family tree panel design ${i + 1}`,
    first_seen_s: 7 + i * 0.1,
    clearest_moment_s: 8,
  }));
  const [panel] = parseInventory(
    JSON.stringify({
      language: "Kazakh",
      items: [
        {
          name: "Family tree panel",
          local_name: "Шежіре",
          name_source: "on_screen",
          price: 15500,
          currency: "KZT",
          price_quote: "он бес мың бес жүзден басталады",
          price_quote_s: 7.5,
          price_source: "spoken",
          price_is_from: true,
          options,
          featured_option: 2,
        },
      ],
    }),
  ).items;

  assert.equal(panel!.nameSource, "on_screen");
  // At most eight options a product.
  assert.equal(panel!.options.length, 8);
  assert.equal(panel!.options[7]!.description, "design 8");
  assert.equal(panel!.featuredOption, 2);
});

test("a quote copied across a time mark still matches the narration", () => {
  const transcript =
    "[7.5] Шежірелердің бағасы он бес [9.6] мың бес жүзден басталады.";
  assert.equal(
    quoteInTranscript("он бес мың бес жүзден басталады", transcript),
    true,
  );
  assert.deepEqual(
    inventoryChecks(
      [
        item({
          price: 15500,
          priceQuote: "он бес мың бес жүзден басталады",
          priceQuoteSeconds: 7.5,
        }),
      ],
      transcript,
    ),
    [[]],
  );
});

test("a review clip runs from the time mark before the spoken price to the next one", () => {
  const promo = [
    "[3.0] Мынау біздің шежіре, [4.6] әр отбасына арналған, [6.2] бағасы он бес мың [7.8] бес жүз теңгеден басталады.",
    "[11.0] Келесі тауар.",
  ].join("\n");
  const panel = item({
    priceQuote: "он бес мың бес жүз теңгеден",
    priceQuoteSeconds: 3,
  });

  // The price's words start after the 6.2 mark and run past the 7.8 one.
  assert.deepEqual(reviewClipWindow(panel, promo, 40), {
    fromSeconds: 5.9,
    toSeconds: 11,
  });
  // A sentence start the model got wrong: the sentence with the words wins.
  assert.deepEqual(
    reviewClipWindow({ ...panel, priceQuoteSeconds: 12 }, promo, 40),
    { fromSeconds: 5.9, toSeconds: 11 },
  );
  // A short sentence runs to the next one, at most 6 s.
  assert.deepEqual(reviewClipWindow(item(), TRANSCRIPT, 60), {
    fromSeconds: 9.5,
    toSeconds: 15.5,
  });
  assert.deepEqual(
    reviewClipWindow(
      item({ priceQuote: "бес жүз теңге", priceQuoteSeconds: 1.2 }),
      TRANSCRIPT,
      60,
    ),
    { fromSeconds: 0.9, toSeconds: 6.9 },
  );
  // Near the end of the video it starts earlier, to last 2 s.
  assert.deepEqual(reviewClipWindow(item(), TRANSCRIPT, 10.5), {
    fromSeconds: 8.5,
    toSeconds: 10.5,
  });
});

test("without a spoken price, the clip is 4 s around the featured item's clearest moment", () => {
  const options = [
    {
      description: "round panel",
      samPhrase: "round panel",
      firstSeenSeconds: 2,
      clearestMomentSeconds: 3,
    },
    {
      description: "star plaque",
      samPhrase: "star plaque",
      firstSeenSeconds: 6,
      clearestMomentSeconds: 6.5,
    },
  ];
  const onScreen = item({
    priceSource: "on_screen",
    priceQuote: "15 500 ₸",
    priceQuoteSeconds: null,
    options,
    featuredOption: 1,
  });

  assert.deepEqual(reviewClipWindow(onScreen, TRANSCRIPT, 60), {
    fromSeconds: 4.5,
    toSeconds: 8.5,
  });
  // A quote the narration doesn't have is treated the same way.
  assert.deepEqual(
    reviewClipWindow(
      item({ priceQuote: "жиырма мың", options, featuredOption: 0 }),
      TRANSCRIPT,
      60,
    ),
    { fromSeconds: 1, toSeconds: 5 },
  );
  assert.equal(
    reviewClipWindow(
      item({ price: null, priceQuote: null, priceSource: null, options: [] }),
      TRANSCRIPT,
      60,
    ),
    null,
  );
});

test("the model's doubts that name a price or a number are about the price", () => {
  assert.equal(modelDoubtSubject("Is it 500 or 5000?"), "price");
  assert.equal(
    modelDoubtSubject("The price may belong to the earrings."),
    "price",
  );
  assert.equal(modelDoubtSubject("An unusual currency was said."), "price");
  assert.equal(
    modelDoubtSubject("The name said doesn't match the box shown."),
    "product",
  );
});
