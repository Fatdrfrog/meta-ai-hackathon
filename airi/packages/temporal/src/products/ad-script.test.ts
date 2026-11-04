import assert from "node:assert/strict";
import test from "node:test";

import {
  productAdLettersSupported,
  productAdLines,
  productAdOptionIssues,
  productAdScriptIssues,
  productAdShopName,
  productAdTextIssues,
  PRODUCT_AD_TEXT_LIMITS,
} from "./ad-script";
import { buildProductAdWorkflowId } from "./contracts";

const script = () => ({
  sticker: "Жаңа тауар",
  scenes: [
    {
      productId: "doll",
      caption: "Балаңызға керемет сыйлық",
      setting: "playroom_shelf" as const,
    },
    {
      productId: "mug",
      caption: "Таңғы шайға арналған",
      setting: "oak_table_window" as const,
    },
  ],
  priceCardTitle: "Біздің бағалар",
  ending: "WhatsApp-қа жазыңыз",
  postIntro: "Сөремізде жаңа тауарлар бар.",
  ctwa: {
    headline: "Жаңа тауарлар",
    primaryText: "Ұнағанын таңдап, WhatsApp-қа жазыңыз.",
    greeting: "Сәлеметсіз бе! Қандай тауар қызықтырады?",
    questions: [
      "Жеткізу бар ма?",
      "Қай жерде орналасқансыз?",
      "Басқа түсі бар ма?",
    ],
  },
});

test("buildProductAdWorkflowId names one workflow per render", () => {
  assert.equal(
    buildProductAdWorkflowId({ adId: "651f1f77bcf86cd799439061", renderNo: 2 }),
    "product-ad:651f1f77bcf86cd799439061:r2",
  );
  assert.equal(
    buildProductAdWorkflowId({ adId: "a b/c", renderNo: 0 }),
    "product-ad:a-b-c:r1",
  );
});

test("productAdLines wraps between words, and a long word stands alone", () => {
  assert.deepEqual(productAdLines("Балаңызға керемет сыйлық", 26), [
    "Балаңызға керемет сыйлық",
  ]);
  assert.deepEqual(productAdLines("one two three four", 9), [
    "one two",
    "three",
    "four",
  ]);
  assert.deepEqual(productAdLines("  ", 26), []);
  assert.deepEqual(productAdLines("Supercalifragilistic word", 10), [
    "Supercalifragilistic",
    "word",
  ]);
});

test("productAdLettersSupported takes Latin, Cyrillic with Kazakh's letters, and ₸", () => {
  assert.equal(productAdLettersSupported("Кукла Лол әғқңөұүһі ₸ 5 000"), true);
  assert.equal(productAdLettersSupported("Кружка Web UMN — «жаңа»…"), true);
  assert.equal(productAdLettersSupported("Café № 5™"), true);
  assert.equal(productAdLettersSupported("娃娃"), false);
  assert.equal(productAdLettersSupported("دمية"), false);
  assert.equal(productAdLettersSupported("Кукла 🎀"), false);
});

test("productAdLettersSupported refuses what one of the fonts lacks", () => {
  // Geologica has no narrow or thin space, soft hyphen, Cyrillic Supplement
  // letters or Uzbek's turned comma; Inter has no ŉ.
  assert.equal(productAdLettersSupported("15 500 ₸"), false);
  assert.equal(productAdLettersSupported("15 500"), false);
  assert.equal(productAdLettersSupported("Шежі­ре"), false);
  assert.equal(productAdLettersSupported("Ԓ"), false);
  assert.equal(productAdLettersSupported("oʻzbek"), false);
  assert.equal(productAdLettersSupported("ŉ"), false);
  // A price as the shelf writes it, with no-break spaces, and Azerbaijani's ə.
  assert.equal(productAdLettersSupported("15 500 ₸ бастап"), true);
  assert.equal(productAdLettersSupported("Gözəl çəkmə"), true);
  assert.equal(productAdLettersSupported("Ударе́ние"), true);
});

test("the shop's name is drawn only when the fonts have every letter of it", () => {
  assert.equal(productAdShopName("  QazOner Group "), "QazOner Group");
  assert.equal(productAdShopName("Гүлдер әлемі"), "Гүлдер әлемі");
  // A workspace named with an emoji or CJK: left out, never drawn as boxes.
  assert.equal(productAdShopName("Цветы 🌸"), "");
  assert.equal(productAdShopName("花店"), "");
  assert.equal(productAdShopName("Café ☕"), "");
  assert.equal(productAdShopName(" "), "");
});

test("a script that fits passes", () => {
  assert.deepEqual(productAdScriptIssues(script(), ["doll", "mug"]), []);
});

test("prices stay off every text: no digits, signs or currency words", () => {
  const issues = productAdScriptIssues(
    {
      ...script(),
      sticker: "Тек 5000",
      priceCardTitle: "Бағасы ₸",
      ending: "Бес мың теңгеге",
      ctwa: { ...script().ctwa, headline: "Only five dollars" },
    },
    ["doll", "mug"],
  );
  assert.deepEqual(issues, [
    "sticker has a digit; write no numbers or prices, code adds the prices.",
    "priceCardTitle names a currency; write no prices, code adds the prices.",
    "ending names a currency; write no prices, code adds the prices.",
    "ctwa.headline names a currency; write no prices, code adds the prices.",
  ]);
});

test("each text keeps to its room", () => {
  assert.deepEqual(
    productAdTextIssues(
      "sticker",
      "A sticker far too long for one line",
      PRODUCT_AD_TEXT_LIMITS.sticker,
    ),
    ["sticker must fit one line of 26 characters."],
  );
  assert.deepEqual(
    productAdTextIssues(
      "scenes[0].caption",
      "A caption that runs past two full lines of twenty six characters",
      PRODUCT_AD_TEXT_LIMITS.caption,
    ),
    ["scenes[0].caption must fit 2 lines of 26 characters."],
  );
  assert.deepEqual(
    productAdTextIssues(
      "ctwa.headline",
      "x".repeat(41),
      PRODUCT_AD_TEXT_LIMITS.ctwaHeadline,
    ),
    ["ctwa.headline is longer than 40 characters."],
  );
  assert.deepEqual(
    productAdTextIssues("ending", "  ", PRODUCT_AD_TEXT_LIMITS.ending),
    ["ending is empty."],
  );
  assert.deepEqual(
    productAdTextIssues(
      "sticker",
      "Новинка 娃娃",
      PRODUCT_AD_TEXT_LIMITS.sticker,
    ),
    [
      "sticker has characters the ad's fonts can't draw; use Latin or Cyrillic letters only.",
    ],
  );
});

test("every product has exactly one scene, and no scene shows another", () => {
  const base = script();
  const issues = productAdScriptIssues(
    {
      ...base,
      scenes: [
        base.scenes[0]!,
        base.scenes[0]!,
        { ...base.scenes[1]!, productId: "stand" },
      ],
      ctwa: { ...base.ctwa, questions: base.ctwa.questions.slice(0, 2) },
    },
    ["doll", "mug"],
  );
  assert.deepEqual(issues, [
    "ctwa.questions must hold exactly 3 questions.",
    "Product doll has 2 scenes; give it one.",
    "No scene shows product mug.",
    "scenes show stand, which isn't one of the ad's products.",
  ]);
});

test("a scene's setting is one of the places Muse Image knows", () => {
  const base = script();
  const issues = productAdScriptIssues(
    {
      ...base,
      scenes: [
        base.scenes[0]!,
        { ...base.scenes[1]!, setting: "beach" as never },
      ],
    },
    ["doll", "mug"],
  );
  assert.deepEqual(issues, [
    "scenes[1].setting must be one of oak_table_window, linen_shelf, stone_counter, playroom_shelf, gift_table, market_stall, marble_boutique, festive_table, vanity_table, kitchen_counter.",
  ]);
});

test("openings and endings pass the words' own checks, one of each kind, at most three", () => {
  const limit = PRODUCT_AD_TEXT_LIMITS.sticker;
  assert.deepEqual(
    productAdOptionIssues(
      "openings",
      [
        { text: "Сөреде жаңа тауар", kind: "news", gloss: "New on the shelf" },
        {
          text: "Сыйлық іздейсіз бе?",
          kind: "question",
          gloss: "Looking for a gift?",
        },
      ],
      limit,
    ),
    [],
  );
  const issues = productAdOptionIssues(
    "openings",
    [
      { text: "5000 ₸ ғана", kind: "news", gloss: "Only 5000" },
      { text: "Жаңа", kind: "news", gloss: "New" },
      { text: "Жаңа", kind: "question", gloss: "New" },
      { text: "Жаңа", kind: "promise", gloss: "New" },
    ],
    limit,
  );
  assert.ok(
    issues.some((issue) => issue.startsWith("openings[0] has a digit")),
  );
  assert.ok(issues.includes("openings must hold at most 3."));
  assert.ok(issues.includes("openings must each be of a different kind."));
});
