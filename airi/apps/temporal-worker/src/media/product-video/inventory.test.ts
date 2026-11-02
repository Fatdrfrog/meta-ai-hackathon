import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";
import {
  PRODUCT_NO_CURRENCY_DOUBT,
  PRODUCT_UNKNOWN_CURRENCY_DOUBT,
  PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS,
  productCurrencyTextDoubt,
} from "@icecore/temporal";

import {
  inventoryChecks,
  inventoryMaxCostMicros,
  inventoryPrompt,
  mainCurrency,
  modelDoubtSubject,
  parseInventory,
  presentationWindows,
  quoteInTranscript,
  readProductInventory,
  reviewClipWindow,
  settleCurrencies,
  type InventoryItem,
} from "./inventory";
import { scribeTranscriptLines } from "./transcript";

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

test("reads any currency's ISO code, keeps one that isn't a code for the owner, and caps prices", () => {
  const [mug, bag, carpet] = parseInventory(
    JSON.stringify({
      language: "English",
      items: [
        { name: "Mug", price: 9.99, currency: "usd", price_quote: "$9.99" },
        { name: "Bag", price: 450, currency: "TL", price_quote: "450 TL" },
        { name: "Carpet", price: 2e12, currency: "IRR", price_quote: "x" },
      ],
    }),
  ).items;

  assert.equal(mug!.price, 9.99);
  assert.equal(mug!.currency, "USD");
  assert.equal("currencyText" in mug!, false);
  // No ISO code: no currency, and what was given, for the owner to check.
  assert.equal(bag!.price, 450);
  assert.equal(bag!.currency, null);
  assert.equal(bag!.currencyText, "TL");
  // More than any price, in any currency: no price, so no currency either.
  assert.equal(carpet!.price, null);
  assert.equal(carpet!.currency, null);
  assert.equal("currencyText" in carpet!, false);
});

test("an unpriced product takes the video's currency, so its price opens in it", () => {
  const items = parseInventory(
    JSON.stringify({
      items: [
        { name: "Doll", price: 5000, currency: "KZT" },
        { name: "Rooster", price: null, currency: "KZT" },
      ],
    }),
  ).items;
  // A currency beside no price isn't kept, nor left for the owner to check.
  assert.equal(items[1]!.currency, null);
  assert.equal("currencyText" in items[1]!, false);

  const [doll, rooster] = settleCurrencies(items);
  assert.equal(doll!.currency, "KZT");
  assert.equal(rooster!.price, null);
  assert.equal(rooster!.currency, "KZT");
  assert.equal("currencyText" in rooster!, false);
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
      ["This price is in USD, but other prices in the video are in KZT."],
      ["The price differs from the number in the narration."],
    ],
  );
});

test("a quote matches the narration in any script, as a whole number", () => {
  for (const [quote, transcript] of [
    ["iki yüz lira", "[0.3] İki yüz lira."],
    ["Cafe\u0301", "Café"],
    ["500円", "５００円です。"],
    ["50ريال", "50\u200fريال"],
    ["50 ريال", "٥٠ ريال"],
    ["خمسون ريالا", "خَمْسُونَ رِيَالًا"],
    ["خَمْسُونَ رِيَالًا", "خمسون ريالا"],
  ] as const) {
    assert.equal(quoteInTranscript(quote, transcript), true, quote);
  }
  // Not the end of a longer number.
  assert.equal(quoteInTranscript("500 теңге", "Кружка 1500 теңге."), false);
  assert.equal(quoteInTranscript("五百円", "千五百円"), false);
  assert.deepEqual(
    inventoryChecks(
      [item({ price: 500, priceQuote: "500 теңге", priceQuoteSeconds: 0.3 })],
      "[0.3] Кружка 1500 теңге.",
    ),
    [["This price doesn't match anything in the narration."]],
  );
});

test("Japanese prices said in three sentences are three quotes", () => {
  const plates = (...said: Array<[number, string, number]>) =>
    said.map(([price, priceQuote, priceQuoteSeconds]) =>
      item({ price, currency: "JPY", priceQuote, priceQuoteSeconds }),
    );
  const digits = [
    "[0.5] この大きいマグは1500円です。",
    "[6.0] このお皿も1500円です。",
    "[12.0] この小さいお皿は500円です。",
  ].join("\n");
  const [mug, plate, small] = plates(
    [1500, "1500円", 0.5],
    [1500, "1500円", 6],
    [500, "500円", 12],
  );
  assert.deepEqual(inventoryChecks([mug!, plate!, small!], digits), [
    [],
    [],
    [],
  ]);
  assert.deepEqual(reviewClipWindow(small!, digits, 30), {
    fromSeconds: 11.7,
    toSeconds: 17.7,
  });

  // Scribe v2 wrote a synthetic Japanese narration (2026-11-01) in kanji
  // numerals, one sentence a line.
  const kanji = [
    "[0.1] このマグカップは千五百円です。",
    "[3.3] このお皿も千五百円です。",
    "[6.4] この小さいお皿は五百円です。",
  ].join("\n");
  assert.deepEqual(
    inventoryChecks(
      plates(
        [1500, "千五百円", 0.1],
        [1500, "千五百円", 3.3],
        [500, "五百円", 6.4],
      ),
      kanji,
    ),
    [[], [], []],
  );
  // "五百円" said only inside "千五百円" is no price of 500.
  assert.equal(
    quoteInTranscript("五百円", kanji.split("\n").slice(0, 2).join("\n")),
    false,
  );
});

test("an Arabic quote matches without its vowel marks, and past a direction mark", () => {
  // As Scribe v2 wrote a synthetic narration (2026-11-01): tanween on
  // "ريالًا", and an unpaired right-to-left embedding before "1850".
  const arabic = [
    "[0.1] هذا الكوب بـ 50 ريالًا، [2.3] وهذا الصحن أيضًا بـ 50 [4.1] ريالًا.",
    "[5.3] كم سعر هذا الإبريق؟",
    "[7.6] \u202b1850 ريال.",
  ].join("\n");
  assert.deepEqual(
    inventoryChecks(
      [
        item({
          price: 50,
          currency: "SAR",
          priceQuote: "50 ريالا",
          priceQuoteSeconds: 0.1,
        }),
        item({
          price: 1850,
          currency: "SAR",
          priceQuote: "1850 ريال",
          priceQuoteSeconds: 7.6,
        }),
      ],
      arabic,
    ),
    [[], []],
  );
});

test("a currency said once covers the video", () => {
  const unpriced = { price: null, priceQuote: null, priceSource: null };
  const settled = (items: InventoryItem[]) =>
    settleCurrencies(items).map((settledItem) => settledItem.currency);

  // "Бес жүз" said bare, "бес мың теңге" with its currency.
  assert.deepEqual(
    settled([
      item({ price: 500, currency: null }),
      item({ currency: "KZT" }),
      item({ ...unpriced, currency: null }),
    ]),
    ["KZT", "KZT", "KZT"],
  );
  // No currency held by most prices: nothing changes.
  assert.deepEqual(
    settled([
      item({ currency: "KZT" }),
      item({ currency: "USD" }),
      item({ currency: null }),
    ]),
    ["KZT", "USD", null],
  );
  assert.deepEqual(
    settled([
      item({ currency: "KZT" }),
      item({ currency: "KZT" }),
      item({ currency: "USD" }),
      item({ currency: null }),
    ]),
    ["KZT", "KZT", "USD", "KZT"],
  );
  // A currency the model gave some other way is the owner's to check.
  assert.deepEqual(
    settled([
      item({ currency: "KZT" }),
      item({ currency: null, currencyText: "TL" }),
    ]),
    ["KZT", null],
  );
  assert.deepEqual(
    settled([item({ currency: null }), item({ currency: null })]),
    [null, null],
  );
  // Only priced items count toward the video's currency.
  assert.equal(
    mainCurrency([
      item({ currency: "USD" }),
      item({ ...unpriced, currency: "KZT" }),
      item({ ...unpriced, currency: "KZT" }),
    ]),
    "USD",
  );
});

test("cents and other groupings match their quote", () => {
  const checks = (overrides: Partial<InventoryItem>, transcript: string) =>
    inventoryChecks(
      [item({ priceQuoteSeconds: 0.3, ...overrides })],
      transcript,
    )[0];

  for (const [price, currency, quote] of [
    [4.99, "USD", "$4.99"],
    [12.5, "EUR", "12,50 €"],
    [1299.99, "USD", "$1,299.99"],
    [149999, "INR", "₹1,49,999"],
    [1250, "CHF", "1'250 Franken"],
    [1250, "EUR", "1.250 Euro"],
    [1.25, "KWD", "1.250 KD"],
    [150000, "VND", "150.000đ"],
    // Zero cents, written even where prices have none.
    [15000, "IDR", "Rp15.000,00"],
  ] as const) {
    assert.deepEqual(
      checks({ price, currency, priceQuote: quote }, `[0.3] ${quote}.`),
      [],
      quote,
    );
  }
  // A time mark copied into the quote isn't read as digits.
  assert.deepEqual(
    checks(
      {
        price: 15500,
        currency: "KZT",
        priceQuote: "15 [4.6] 500 теңге",
        priceQuoteSeconds: 3,
      },
      "[3.0] Бағасы 15 [4.6] 500 теңге [6.4] болады.",
    ),
    [],
  );

  const differs = ["The price differs from the number in the narration."];
  assert.deepEqual(
    checks(
      { price: 499, currency: "USD", priceQuote: "$4.99" },
      "[0.3] $4.99.",
    ),
    differs,
  );
  assert.deepEqual(
    checks(
      { price: 4.99, currency: "RUB", priceQuote: "499 рублей" },
      "[0.3] 499 рублей.",
    ),
    differs,
  );
  // Digits of any script are read.
  assert.deepEqual(
    checks(
      { price: 500, currency: "SAR", priceQuote: "٥٠ ريالا" },
      "[0.3] هذا الكوب بـ ٥٠ ريالا.",
    ),
    differs,
  );
});

test("a price without an ISO currency, or in a second currency, is flagged", () => {
  const english = [
    "[0.3] This mug is twenty.",
    "[2.0] The plate is fifteen.",
  ].join("\n");
  const none = "No currency was said or shown for this price.";
  assert.deepEqual(
    inventoryChecks(
      [
        item({
          price: 20,
          currency: null,
          priceQuote: "twenty",
          priceQuoteSeconds: 0.3,
        }),
        item({
          price: 15,
          currency: null,
          priceQuote: "fifteen",
          priceQuoteSeconds: 2,
        }),
      ],
      english,
    ),
    [[none], [none]],
  );
  assert.deepEqual(
    inventoryChecks(
      [
        item({
          price: 450,
          currency: null,
          currencyText: "TL",
          priceQuote: "450 TL",
          priceQuoteSeconds: 0.3,
        }),
      ],
      "[0.3] Bu çanta 450 TL.",
    ),
    [["Check the currency: it was given as “TL”."]],
  );
  // A tie: either currency may be the misread one.
  assert.deepEqual(
    inventoryChecks(
      [
        item({
          price: 500,
          currency: "KZT",
          priceQuote: "бес жүз теңге",
          priceQuoteSeconds: 1.2,
        }),
        item({ currency: "USD" }),
        item({
          price: 2000,
          currency: null,
          priceQuote: "екі мың",
          priceQuoteSeconds: 20.1,
        }),
      ],
      `${TRANSCRIPT}\n[20.1] Әтеш екі мың.`,
    ),
    [
      ["This price is in KZT, but other prices in the video are in USD."],
      ["This price is in USD, but other prices in the video are in KZT."],
      [none],
    ],
  );
  // An unpriced product is flagged for its price alone.
  assert.deepEqual(
    inventoryChecks(
      [item({ price: null, currency: null, priceQuote: null })],
      TRANSCRIPT,
    ),
    [["No price was said or shown for this product."]],
  );
});

test("the review tells the doubts about an unknown currency from the other price doubts", () => {
  // A price set without a currency leaves the ones that match.
  const checks = inventoryChecks(
    [
      item({
        price: 20,
        currency: null,
        priceQuote: "twenty",
        priceQuoteSeconds: 0.3,
      }),
      item({
        price: 450,
        currency: null,
        currencyText: "TL",
        priceQuote: "450 TL",
        priceQuoteSeconds: 2,
      }),
      item({
        price: 499,
        currency: "USD",
        priceQuote: "$4.99",
        priceQuoteSeconds: 4,
      }),
      item({
        price: 5,
        currency: "EUR",
        priceQuote: "five euros",
        priceQuoteSeconds: 6,
      }),
    ],
    [
      "[0.3] This mug is twenty.",
      "[2.0] Bu çanta 450 TL.",
      "[4.0] The plate is $4.99.",
      "[6.0] The cup is five euros.",
    ].join("\n"),
  );
  assert.deepEqual(checks, [
    [PRODUCT_NO_CURRENCY_DOUBT],
    [productCurrencyTextDoubt("TL")],
    [
      "The price differs from the number in the narration.",
      "This price is in USD, but other prices in the video are in EUR.",
    ],
    ["This price is in EUR, but other prices in the video are in USD."],
  ]);
  assert.deepEqual(
    checks.flat().filter((text) => PRODUCT_UNKNOWN_CURRENCY_DOUBT.test(text)),
    [PRODUCT_NO_CURRENCY_DOUBT, productCurrencyTextDoubt("TL")],
  );
});

// The first 60 of the codes a price may be in.
const CODES = (
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND " +
  "BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK " +
  "DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD " +
  "HKD HNL HRK HTG HUF IDR"
).split(" ");

/** Products priced in these currencies, each said in a sentence of its own. */
function pricedIn(codes: string[]) {
  return {
    items: codes.map((currency, index) =>
      item({
        price: 100 + index,
        currency,
        priceQuote: `${100 + index} ${currency}`,
        priceQuoteSeconds: index * 2,
      }),
    ),
    transcript: codes
      .map(
        (code, index) =>
          `[${index * 2}.0] Item ${index} is ${100 + index} ${code}.`,
      )
      .join("\n"),
  };
}

test("a price in one of many currencies names three of the others, then how many more", () => {
  // No currency is the video's own, so every price is flagged.
  const four = pricedIn(["KZT", "USD", "EUR", "GBP"]);
  assert.deepEqual(inventoryChecks(four.items, four.transcript)[0], [
    "This price is in KZT, but other prices in the video are in USD, EUR and GBP.",
  ]);
  const many = pricedIn(CODES.slice(0, 45));
  const checks = inventoryChecks(many.items, many.transcript);
  assert.deepEqual(checks[0], [
    "This price is in AED, but other prices in the video are in AFN, ALL, AMD and 41 more.",
  ]);
  assert.deepEqual(checks[44], [
    "This price is in FJD, but other prices in the video are in AED, AFN, ALL and 41 more.",
  ]);
  assert.ok(checks.every((doubts) => doubts.length === 1));
});

test("every doubt the checks write fits the product model", async () => {
  // The import checks each draft against the model before saving any, and
  // one it refuses fails the whole import, so none may be refused for ours.
  const { readDefaultExport } = await import(
    "@icecore/airi-runtime/module-interop"
  );
  const { WorkspaceProduct } = readDefaultExport<
    typeof import("@/models/workspace-product")
  >(await import("@/models/workspace-product"));
  // The most currencies one video may have: one for each product.
  const many = pricedIn(CODES.slice(0, PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS));
  // Every other check, with the longest text the model's answer can bring
  // into one: what it gave as a currency, and its own doubt, both cut short.
  const [given] = parseInventory(
    JSON.stringify({
      items: [
        {
          name: "Bag",
          price: 450,
          currency: "Somaliland shillings",
          price_quote: "x".repeat(1000),
          doubt: "y".repeat(1000),
        },
      ],
    }),
  ).items;
  const others = [
    given!,
    item({ price: null, priceQuote: null, priceSource: null }),
    item({ priceSource: "on_screen", priceQuote: null }),
    item({ priceSource: "on_screen", priceQuote: "15 500 ₸" }),
    item({ priceQuote: "алты мың" }),
    item({ price: 20000, priceQuote: "2 000 теңге" }),
    item({ currency: null }),
    item(),
    item(),
  ];
  const otherChecks = inventoryChecks(
    others,
    `${TRANSCRIPT}\n[20.1] Телефон 2 000 теңге.`,
  ).flat();
  // Each kind of check is among them.
  assert.deepEqual(
    [...new Set(otherChecks)].sort(),
    [
      "No price was said or shown for this product.",
      "This price was read from text in the video, not said aloud.",
      "The video's text for this price is missing.",
      "The price differs from the number shown in the video.",
      "This price doesn't match anything in the narration.",
      "The price differs from the number in the narration.",
      "Another product's price comes from the same words.",
      PRODUCT_NO_CURRENCY_DOUBT,
      productCurrencyTextDoubt("Somalila"),
    ].sort(),
  );
  const texts = [
    ...inventoryChecks(many.items, many.transcript).flat(),
    ...otherChecks,
    given!.doubt!,
  ];
  assert.ok(
    texts.includes(
      "This price is in AED, but other prices in the video are in AFN, ALL, AMD and 56 more.",
    ),
  );
  const refusal = new WorkspaceProduct({
    workspaceId: "workspace-1",
    name: "Bag",
    doubts: texts.map((text) => ({ about: "price", text })),
  }).validateSync();
  assert.deepEqual(
    Object.keys(refusal?.errors ?? {}).filter((path) =>
      path.startsWith("doubts"),
    ),
    [],
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
  // Any currency as said or shown, none when none was, and its decimals.
  const prompt = content[1]!.text!;
  assert.doesNotMatch(prompt, /also for a number without a currency/);
  assert.match(prompt, /ISO 4217/);
  assert.match(prompt, /never invent one from the language or the place alone/);
  assert.match(prompt, /A price without a currency is not a doubt/);
  assert.match(prompt, /A currency in a product's name/);
  assert.match(prompt, /three digits after a mark group thousands/);
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
  const costs: number[] = [];

  await assert.rejects(
    readProductInventory(
      { videoPath, transcript: "" },
      {
        uploadMetaFile: async () => ({ id: "file_8" }),
        deleteMetaFile: async (id) => {
          deleted.push(id);
        },
        createMetaResponse: muse('{"language": "kk", "items": [{"na'),
        onCost: (usd) => costs.push(usd),
      },
    ),
    (error: unknown) =>
      error instanceof MetaModelApiError &&
      error.info.code === "invalid_json" &&
      error.info.transient,
  );
  assert.deepEqual(deleted, ["file_8"]);
  // Priced before it was read, so the import settles what it cost.
  assert.equal(costs.length, 1);
});

test("reserves for the video it reads and a full-length answer", () => {
  // 24,000 tokens of answer at $4.25/M, and the video's input at $1.25/M.
  assert.equal(inventoryMaxCostMicros(30), 139_000);
  // The first production import's 31 s video cost $0.0276 to read.
  assert.ok(inventoryMaxCostMicros(31) > 27_600);
  // The longest video an import reads.
  assert.equal(inventoryMaxCostMicros(300), 382_000);
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

test("a price cited at a time mark inside its sentence is that sentence's", () => {
  // Muse cited the mark before a price instead of its sentence's start for 4
  // of 11 Kazakh products on 2026-11-02 (shelf 40.7 and 62.3, promo 21.6 and
  // 27.9). Lines in the promo's words, each price after a mark.
  const phrase = "он бес мың бес жүзден басталады";
  const priced = (priceQuoteSeconds: number) =>
    item({ price: 15500, priceQuote: phrase, priceQuoteSeconds });
  const twoLong = [
    "[7.5] Отбасылық шежірелер мен шеңберлердің бағасы [9.3] он бес мың бес жүзден басталады.",
    "[17.9] Заманауи интерьерде былайша көрінетін [20.0] этно паннолар мен сағаттар бағасы [21.6] он бес мың бес жүзден басталады.",
  ].join("\n");
  // Cited at the sentences' starts or at the marks before the prices: two
  // sentences' words, and each its own clip.
  for (const [tree, clock] of [
    [7.5, 17.9],
    [9.3, 21.6],
  ] as const) {
    const cited = `${tree} and ${clock}`;
    assert.deepEqual(
      inventoryChecks([priced(tree), priced(clock)], twoLong),
      [[], []],
      cited,
    );
    assert.deepEqual(
      reviewClipWindow(priced(tree), twoLong, 30),
      { fromSeconds: 9, toSeconds: 15 },
      cited,
    );
    assert.deepEqual(
      reviewClipWindow(priced(clock), twoLong, 30),
      { fromSeconds: 21.3, toSeconds: 27.3 },
      cited,
    );
  }
  // One sentence's words, cited at its start and at its mark.
  const sameWords = ["Another product's price comes from the same words."];
  assert.deepEqual(inventoryChecks([priced(7.5), priced(9.3)], twoLong), [
    sameWords,
    sameWords,
  ]);

  // The next sentence says the same words and starts nearer the mark, but
  // the clip is still the cited sentence's.
  const longThenShort = [
    "[10.0] Заманауи интерьерде былайша көрінетін [11.5] этно паннолар мен сағаттар бағасы [13.4] он бес мың бес жүзден басталады.",
    "[15.6] Шеңберлер де он бес мың бес жүзден басталады.",
  ].join("\n");
  assert.deepEqual(reviewClipWindow(priced(13.4), longThenShort, 30), {
    fromSeconds: 13.1,
    toSeconds: 15.6,
  });
  assert.deepEqual(reviewClipWindow(priced(15.6), longThenShort, 30), {
    fromSeconds: 15.3,
    toSeconds: 21.3,
  });
  assert.deepEqual(
    inventoryChecks([priced(13.4), priced(15.6)], longThenShort),
    [[], []],
  );
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

test("a quote across a time mark inside a word still finds its clip", () => {
  // Chinese is written without spaces, so a mark can fall inside "五十元".
  assert.deepEqual(
    reviewClipWindow(
      item({ priceQuote: "五十元", priceQuoteSeconds: 0 }),
      "[0.0] 这个杯子只要五十[1.6] 元真的[3.4] 很便宜。",
      30,
    ),
    { fromSeconds: 0, toSeconds: 3.4 },
  );
  // Scribe v2's words of a synthetic Thai narration (2026-11-01), as one
  // line. The glass's "ห้าสิบบาท" runs across the 1.6 mark; read apart
  // there, it would only be found in the plate's words at 3.5.
  const thai =
    "[0.1] แก้วใบนี้ราคาห้าสิบ[1.6] บาท จานใบนี้[3.5] ก็ราคาห้าสิบบาทเหมือนกัน [5.8] ส่วนกาน้ำชาใบนี้[7.4] ราคาหนึ่งร้อยยี่สิบเก้า[8.9] บาท";
  assert.deepEqual(
    reviewClipWindow(
      item({
        price: 50,
        currency: "THB",
        priceQuote: "ห้าสิบบาท",
        priceQuoteSeconds: 0.1,
      }),
      thai,
      9.2,
    ),
    { fromSeconds: 0, toSeconds: 3.5 },
  );
});

// Scribe v2's words for the probe's synthetic Chinese narration (2026-11-01),
// as it returned them: a token per character, each comma its own, no spaces.
const CHINESE_PROBE: Array<[string, number, number]> = [
  ["这", 0.12, 0.2],
  ["个", 0.2, 0.32],
  ["杯", 0.32, 0.52],
  ["子", 0.64, 0.94],
  ["五", 0.94, 1.1],
  ["十", 1.1, 1.26],
  ["元", 1.44, 1.54],
  ["，", 1.54, 2.02],
  ["那", 2.02, 2.16],
  ["个", 2.16, 2.28],
  ["娃", 2.28, 2.48],
  ["娃", 2.48, 2.78],
  ["也", 2.78, 3.04],
  ["是", 3.04, 3.24],
  ["五", 3.24, 3.4],
  ["十", 3.4, 3.56],
  ["元", 3.74, 3.82],
  ["，", 3.82, 4.44],
  ["这", 4.44, 4.56],
  ["个", 4.56, 4.66],
  ["钥", 4.66, 4.86],
  ["匙", 4.86, 5.02],
  ["扣", 5.02, 5.5],
  ["只", 5.5, 5.64],
  ["要", 5.78, 5.94],
  ["十", 5.94, 6.2],
  ["九", 6.2, 6.44],
  ["点", 6.44, 6.68],
  ["九", 6.68, 6.92],
  ["元", 6.92, 7.26],
  ["。", 7.26, 7.26],
];

test("a quote that drops only a time mark inside a word still matches and keeps its clip", () => {
  const transcript = scribeTranscriptLines({
    words: CHINESE_PROBE.map(([text, start, end]) => ({
      text,
      type: "word",
      start,
      end,
    })),
  });
  // The marks fall inside words, and are written into them.
  assert.equal(
    transcript,
    "[0.1] 这个杯子五十元，[2.0]那个娃娃也是五十[3.7]元，这个钥匙扣[5.5]只要十九点九元[7.3]。",
  );
  const cup = item({
    price: 50,
    currency: "CNY",
    priceQuote: "五十元",
    priceQuoteSeconds: 0.1,
  });
  const doll = (priceQuote: string) =>
    item({ price: 50, currency: "CNY", priceQuote, priceQuoteSeconds: 0.1 });
  // An older line wrote a space after each mark, as some quotes copy it.
  const older = transcript.replaceAll(/(\[\d+\.\d\])(?! )/g, "$1 ");
  assert.match(older, /五十\[3\.7\] 元/);
  for (const narration of [transcript, older]) {
    // The doll's words with the mark, without it, or as the older line had
    // them: not the same words as the cup's, and the clip of its own.
    for (const quote of ["也是五十[3.7]元", "也是五十元", "也是五十[3.7] 元"]) {
      assert.deepEqual(
        inventoryChecks([cup, doll(quote)], narration),
        [[], []],
        quote,
      );
      assert.deepEqual(
        reviewClipWindow(doll(quote), narration, 7.4),
        { fromSeconds: 1.7, toSeconds: 5.5 },
        quote,
      );
    }
  }
});

test("two Thai products at one price, said apart, are two quotes", () => {
  // Scribe writes Thai without sentence marks: the 2.8 s pause between the
  // glass and the plate ends a sentence.
  const said = [
    ["แก้ว", 0.3],
    ["ใบนี้", 0.7],
    ["ราคา", 1.1],
    ["ห้าสิบ", 1.5],
    ["บาท", 1.9],
    ["จาน", 5],
    ["ใบนี้", 5.4],
    ["ก็", 5.8],
    ["ห้าสิบ", 6.1],
    ["บาท", 6.5],
  ] as const;
  const transcript = scribeTranscriptLines({
    words: said.map(([text, start]) => ({
      text,
      type: "word",
      start,
      end: start + 0.3,
    })),
  });
  const [glass, plate] = [0.3, 5].map((at) =>
    item({
      price: 50,
      currency: "THB",
      priceQuote: "ห้าสิบบาท",
      priceQuoteSeconds: at,
    }),
  );
  assert.deepEqual(inventoryChecks([glass!, plate!], transcript), [[], []]);
  assert.deepEqual(reviewClipWindow(plate!, transcript, 30), {
    fromSeconds: 4.7,
    toSeconds: 10.7,
  });
});

test("a Thai price the owner pauses inside still matches and keeps its clip", () => {
  // A 0.9 s pause inside "ห้าสิบ…บาท" (fifty … baht), where Scribe writes no
  // space, ends a line inside the price.
  const word = (text: string, start: number, end: number) => ({
    text,
    type: "word",
    start,
    end,
  });
  const transcript = scribeTranscriptLines({
    words: [
      word("แก้ว", 0.3, 0.6),
      word("ใบนี้", 0.6, 0.9),
      word("ราคา", 0.9, 1.2),
      word("ห้าสิบ", 1.2, 1.6),
      word("บาท", 2.5, 2.8),
      { text: " ", type: "spacing", start: 2.8, end: 4.8 },
      word("จาน", 4.8, 5.1),
      word("ใบนี้", 5.1, 5.4),
      word("ราคา", 5.4, 5.7),
      word("ร้อย", 5.7, 6),
      word("บาท", 6, 6.3),
    ],
  });
  assert.equal(
    transcript,
    "[0.3] แก้วใบนี้ราคาห้าสิบ\n[2.5] บาท\n[4.8] จานใบนี้ราคาร้อยบาท",
  );
  const plate = item({
    price: 100,
    currency: "THB",
    priceQuote: "ร้อยบาท",
    priceQuoteSeconds: 4.8,
  });
  // The price's line reads on into the next, whether the quote copies the
  // break as said or as a space.
  for (const priceQuote of ["ห้าสิบบาท", "ราคาห้าสิบ บาท"]) {
    const glass = item({
      price: 50,
      currency: "THB",
      priceQuote,
      priceQuoteSeconds: 0.3,
    });
    assert.deepEqual(
      inventoryChecks([glass, plate], transcript),
      [[], []],
      priceQuote,
    );
    // From the line the price starts in to the one after it ends.
    assert.deepEqual(
      reviewClipWindow(glass, transcript, 8),
      { fromSeconds: 0, toSeconds: 4.8 },
      priceQuote,
    );
  }
  assert.deepEqual(reviewClipWindow(plate, transcript, 8), {
    fromSeconds: 4.5,
    toSeconds: 8,
  });
});

test("a starting price is one in any language", () => {
  assert.match(
    inventoryPrompt(""),
    /"бастап", or the same words in any language\)/,
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
  // Asked for the likeliest of a currency word several countries use.
  assert.equal(modelDoubtSubject("Was it dollars or euros?"), "price");
  assert.equal(modelDoubtSubject("Not sure which peso this is."), "price");
  assert.equal(modelDoubtSubject("The tag shows €."), "price");
  assert.equal(
    modelDoubtSubject("The costume shown doesn't match the name."),
    "product",
  );
  assert.equal(modelDoubtSubject("Is this the real one?"), "product");
  // A currency named by its character or its ISO code.
  assert.equal(modelDoubtSubject("Assumed CNY for 元; could be HKD."), "price");
  assert.equal(modelDoubtSubject("Likely BYN, not RUB."), "price");
  assert.equal(modelDoubtSubject("円 or 元 on the tag?"), "price");
  // Capitals that are no currency's code, and a code's letters in lower case.
  assert.equal(
    modelDoubtSubject("Is the LOL doll the one shown at the end?"),
    "product",
  );
  assert.equal(
    modelDoubtSubject("Are all of them one product, or each its own?"),
    "product",
  );
  // A currency word that is part of a thing's name.
  assert.equal(
    modelDoubtSubject("Are the toy dollar bills one product or two?"),
    "product",
  );
  assert.equal(
    modelDoubtSubject("Is the Euro plug charger a different product?"),
    "product",
  );
  assert.equal(
    modelDoubtSubject("Is the dollar-print mug the plain one's design?"),
    "product",
  );
});

test("a currency word before a word that only starts like a thing's name is about the price", () => {
  // "printed" isn't "print", nor "styled" "style", nor "billion" "bill".
  assert.equal(
    modelDoubtSubject("Were dollars printed on the sticker?"),
    "price",
  );
  assert.equal(
    modelDoubtSubject("Dollars printed on the tag may be Australian."),
    "price",
  );
  assert.equal(modelDoubtSubject("Was it euros styled as cents?"), "price");
  assert.equal(modelDoubtSubject("Euros noted on the box?"), "price");
  assert.equal(modelDoubtSubject("A dollar billed per piece?"), "price");
  // The things themselves still aren't.
  assert.equal(
    modelDoubtSubject("Are the toy dollar bills one product or two?"),
    "product",
  );
  assert.equal(modelDoubtSubject("Is it a dollar-print mug?"), "product");
  assert.equal(modelDoubtSubject("Is the euro-style plate new?"), "product");
});
