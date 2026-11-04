import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_AD_STOCK_VOICES,
  PRODUCT_AD_VOICE_SAMPLE_TEXT,
  productAdForeignKazakhLetters,
  productAdNumberWords,
  productAdPriceSpeech,
  productAdPriceSpeechIssues,
  productAdRecordingIsPaid,
  productAdShelfPrice,
  productAdSpeechCode,
  productAdSpeechSeconds,
  productAdSpokenAmount,
  productAdSpokenNumbers,
  productAdStockVoice,
  productAdWordsAmount,
  type ProductAdShelfPrice,
} from "./ad-voice";

const NBSP = " ";

test("airi's voices are listed once each, for every shop language", () => {
  assert.ok(
    PRODUCT_AD_STOCK_VOICES.length >= 3 && PRODUCT_AD_STOCK_VOICES.length <= 4,
  );
  assert.equal(
    new Set(PRODUCT_AD_STOCK_VOICES.map((voice) => voice.id)).size,
    PRODUCT_AD_STOCK_VOICES.length,
  );
  for (const voice of PRODUCT_AD_STOCK_VOICES) {
    assert.match(voice.id, /^[A-Za-z0-9]{20}$/);
    assert.deepEqual([...voice.languages].sort(), ["en", "kk", "ru"]);
    assert.equal(productAdStockVoice(voice.id), voice);
  }
  assert.equal(productAdStockVoice("nope"), null);
  assert.equal(productAdStockVoice(undefined), null);
});

test("the samples say no price", () => {
  for (const text of Object.values(PRODUCT_AD_VOICE_SAMPLE_TEXT)) {
    assert.deepEqual(productAdSpokenNumbers(text), []);
    assert.ok(text.length <= 120);
  }
  assert.deepEqual(
    productAdForeignKazakhLetters(PRODUCT_AD_VOICE_SAMPLE_TEXT.kk),
    [],
  );
});

test("going back to the recording is paid only on an ad that never had it cleaned up", () => {
  assert.equal(productAdRecordingIsPaid({ voice: "own" }), false);
  assert.equal(
    productAdRecordingIsPaid({
      voice: "clone",
      voiceResult: { used: "own" },
    }),
    false,
  );
  assert.equal(
    productAdRecordingIsPaid({
      voice: "stock",
      voiceResult: { used: "stock" },
    }),
    true,
  );
  assert.equal(
    productAdRecordingIsPaid({ voice: "none", voiceResult: null }),
    true,
  );
});

test("the voice-over's language is the one the owner spoke, else the fixed words'", () => {
  assert.equal(productAdSpeechCode("Kazakh", "kk"), "kk");
  assert.equal(productAdSpeechCode("қазақ тілі", null), "kk");
  assert.equal(productAdSpeechCode("kk", "en"), "kk");
  assert.equal(productAdSpeechCode("Russian", "ru"), "ru");
  assert.equal(productAdSpeechCode("русский", null), "ru");
  assert.equal(productAdSpeechCode("English", "en"), "en");
  assert.equal(productAdSpeechCode(null, "ru"), "ru");
  assert.equal(productAdSpeechCode("", null), "en");
  // Uzbek is read without a spoken price.
  assert.equal(productAdSpeechCode("Uzbek", "en"), null);
});

test("a shelf price is read back from the text code drew", () => {
  assert.deepEqual(productAdShelfPrice(`15${NBSP}500${NBSP}₸ бастап`), {
    amount: 15_500,
    currency: "KZT",
    from: true,
  });
  assert.deepEqual(productAdShelfPrice(`от 2${NBSP}000${NBSP}RUB`), {
    amount: 2000,
    currency: "RUB",
    from: true,
  });
  assert.deepEqual(productAdShelfPrice(`from 9.99${NBSP}USD`), {
    amount: 9.99,
    currency: "USD",
    from: true,
  });
  assert.deepEqual(productAdShelfPrice(`1${NBSP}250`), {
    amount: 1250,
    currency: null,
    from: false,
  });
  assert.deepEqual(productAdShelfPrice("5 000 ₸"), {
    amount: 5000,
    currency: "KZT",
    from: false,
  });
  assert.equal(productAdShelfPrice(""), null);
  assert.equal(productAdShelfPrice("бес мың"), null);
  assert.equal(productAdShelfPrice("15 500 ₸ дейін"), null);
});

test("Kazakh numbers are written as people say them", () => {
  const kk = (n: number) => productAdNumberWords(n, "kk");
  assert.equal(kk(15_500), "он бес мың бес жүз");
  assert.equal(kk(5000), "бес мың");
  assert.equal(kk(1000), "мың");
  assert.equal(kk(100), "жүз");
  assert.equal(kk(1500), "мың бес жүз");
  assert.equal(kk(2_500), "екі мың бес жүз");
  assert.equal(kk(21), "жиырма бір");
  assert.equal(kk(349_990), "үш жүз қырық тоғыз мың тоғыз жүз тоқсан");
  assert.equal(kk(1_000_000), "бір миллион");
  assert.equal(kk(1_200_000), "бір миллион екі жүз мың");
  assert.equal(kk(0), "нөл");
  assert.equal(kk(1.5), null);
  assert.equal(kk(-1), null);
});

test("Russian numbers agree in the nominative and, after «от», the genitive", () => {
  const nom = (n: number) => productAdNumberWords(n, "ru");
  const gen = (n: number) => productAdNumberWords(n, "ru", "genitive");
  assert.equal(nom(15_500), "пятнадцать тысяч пятьсот");
  assert.equal(nom(1000), "тысяча");
  assert.equal(nom(2000), "две тысячи");
  assert.equal(nom(5000), "пять тысяч");
  assert.equal(nom(21_000), "двадцать одна тысяча");
  assert.equal(nom(12_000), "двенадцать тысяч");
  assert.equal(nom(2_300_000), "два миллиона триста тысяч");
  assert.equal(gen(15_500), "пятнадцати тысяч пятисот");
  assert.equal(gen(1500), "тысячи пятисот");
  assert.equal(gen(2000), "двух тысяч");
  assert.equal(gen(21_000), "двадцати одной тысячи");
  assert.equal(gen(340), "трёхсот сорока");
});

test("English numbers are written in words", () => {
  const en = (n: number) => productAdNumberWords(n, "en");
  assert.equal(en(15_500), "fifteen thousand five hundred");
  assert.equal(en(21), "twenty-one");
  assert.equal(en(1000), "one thousand");
  assert.equal(
    en(999_999),
    "nine hundred ninety-nine thousand nine hundred ninety-nine",
  );
});

test("the voice-over's price sentence is written by code from the shelf", () => {
  const p = (amount: number, currency: string | null, from = false) => ({
    amount,
    currency,
    from,
  });
  assert.equal(
    productAdPriceSpeech(p(15_500, "KZT", true), "kk"),
    "Бағасы — он бес мың бес жүз теңгеден бастап.",
  );
  assert.equal(
    productAdPriceSpeech(p(5000, "KZT"), "kk"),
    "Бағасы — бес мың теңге.",
  );
  assert.equal(
    productAdPriceSpeech(p(1000, null, true), "kk"),
    "Бағасы — мыңнан бастап.",
  );
  assert.equal(
    productAdPriceSpeech(p(10, null, true), "kk"),
    "Бағасы — оннан бастап.",
  );
  assert.equal(
    productAdPriceSpeech(p(15_500, "KZT"), "ru"),
    "Цена — пятнадцать тысяч пятьсот тенге.",
  );
  assert.equal(
    productAdPriceSpeech(p(2000, "RUB", true), "ru"),
    "Цена — от двух тысяч рублей.",
  );
  assert.equal(
    productAdPriceSpeech(p(21, "RUB"), "ru"),
    "Цена — двадцать один рубль.",
  );
  assert.equal(productAdPriceSpeech(p(3, "USD"), "ru"), "Цена — три доллара.");
  assert.equal(productAdPriceSpeech(p(1, "USD"), "en"), "Price: one dollar.");
  assert.equal(
    productAdPriceSpeech(p(15_500, "KZT", true), "en"),
    "Price: from fifteen thousand five hundred tenge.",
  );
  // Code says only what it can write and check.
  assert.equal(productAdPriceSpeech(p(9.99, "USD"), "en"), null);
  assert.equal(productAdPriceSpeech(p(100, "JPY"), "ru"), null);
});

test("every price sentence code writes reads back as the shelf's amount and currency", () => {
  const amounts = [
    1, 2, 5, 10, 11, 21, 99, 100, 101, 999, 1000, 1001, 1500, 2000, 4999,
    12_000, 15_500, 21_000, 99_990, 100_000, 349_990, 1_000_000, 2_345_678,
    999_999_999,
  ];
  let checked = 0;
  for (const code of ["kk", "ru", "en"] as const)
    for (const currency of [null, "KZT", "RUB", "USD", "EUR"])
      for (const from of [false, true])
        for (const amount of amounts) {
          const price: ProductAdShelfPrice = { amount, currency, from };
          const sentence = productAdPriceSpeech(price, code);
          assert.ok(sentence, `${code} ${amount} ${currency} ${from}`);
          assert.deepEqual(
            productAdPriceSpeechIssues(sentence, price),
            [],
            sentence,
          );
          checked++;
        }
  assert.equal(checked, 3 * 5 * 2 * amounts.length);
});

test("a price sentence that says another amount or no currency is caught", () => {
  const price = { amount: 15_500, currency: "KZT", from: false };
  assert.equal(
    productAdPriceSpeechIssues("Бағасы — бес мың теңге.", price).length,
    1,
  );
  assert.equal(
    productAdPriceSpeechIssues("Бағасы — он бес мың бес жүз.", price).length,
    1,
  );
  assert.equal(
    productAdPriceSpeechIssues("Бағасы — он бес мың, бес жүз теңге.", price)
      .length,
    0,
  );
  assert.equal(
    productAdPriceSpeechIssues("Бес мың. Он бес мың бес жүз теңге.", price)
      .length,
    1,
  );
  assert.equal(
    productAdSpokenAmount("Цена — от двадцати одной тысячи рублей."),
    21_000,
  );
  assert.equal(productAdSpokenAmount("Цена — от трех тысяч."), 3000);
  assert.equal(productAdWordsAmount(["екі", "жүз", "мыңнан"]), 200_000);
  assert.equal(productAdWordsAmount(["кукла"]), null);
});

test("a line of Muse Spark's may say no number, price or currency", () => {
  assert.deepEqual(
    productAdSpokenNumbers("Қолдан тоқылған жұмсақ қуыршақ."),
    [],
  );
  // Kazakh's «бір» (a) and English "one" alone are words, not prices.
  assert.deepEqual(productAdSpokenNumbers("Бір керемет сыйлық."), []);
  assert.deepEqual(productAdSpokenNumbers("The one gift she'll love."), []);
  // A cradle starts like five; it isn't one.
  assert.deepEqual(productAdSpokenNumbers("Бесік жырындай жұмсақ."), []);
  assert.deepEqual(productAdSpokenNumbers("Небары бес мың теңге!"), [
    "бес мың",
    "теңге",
  ]);
  assert.deepEqual(productAdSpokenNumbers("Всего пять тысяч."), ["пять тысяч"]);
  assert.deepEqual(productAdSpokenNumbers("Only 3 left."), ["3"]);
  assert.deepEqual(productAdSpokenNumbers("Twenty-five styles."), [
    "twenty five",
  ]);
  assert.deepEqual(productAdSpokenNumbers("Цена в ₸."), ["₸"]);
  assert.deepEqual(productAdSpokenNumbers("От пятнадцати тысяч."), [
    "пятнадцати тысяч",
  ]);
  // A product's own name may hold a number.
  assert.deepEqual(
    productAdSpokenNumbers("Кукла 3 в 1 для дочки.", ["Кукла 3 в 1"]),
    [],
  );
});

test("a line's speaking time grows with its letters and pauses", () => {
  const short = productAdSpeechSeconds("Жұмсақ қуыршақ.", "kk");
  const long = productAdSpeechSeconds(
    "Жұмсақ қуыршақ, қолдан тоқылған. Бағасы — бес мың теңге.",
    "kk",
  );
  assert.ok(short > 0.8 && short < 1.5, String(short));
  assert.ok(long > 3 && long < 5, String(long));
  assert.ok(productAdSpeechSeconds("Soft doll.", null) > 0.5);
});

test("Kazakh text with a letter Kazakh doesn't use is caught", () => {
  assert.deepEqual(productAdForeignKazakhLetters("җуыршақ"), ["җ"]);
  assert.deepEqual(productAdForeignKazakhLetters("қуыршақ"), []);
  assert.deepEqual(productAdForeignKazakhLetters("Ғажап җ", "Җ дүкен"), []);
});
