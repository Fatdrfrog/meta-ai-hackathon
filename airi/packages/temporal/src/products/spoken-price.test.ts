import assert from "node:assert/strict";
import test from "node:test";

import { spokenNumberRoot, spokenPriceSpan } from "./spoken-price";

const said = (quote: string, name?: string) => {
  const span = spokenPriceSpan(quote, name);
  return span ? quote.slice(span.start, span.end) : null;
};

test("a number word is told with Kazakh's endings, and only its own forms otherwise", () => {
  assert.equal(spokenNumberRoot("мыңға"), "мың");
  assert.equal(spokenNumberRoot("жүзден"), "жүз");
  assert.equal(spokenNumberRoot("hundreds"), "hundred");
  assert.equal(spokenNumberRoot("пятьсот"), "пятьсот");
  // "for", "a table" and "spoke" aren't three, a hundred or five.
  assert.equal(spokenNumberRoot("үшін"), null);
  assert.equal(spokenNumberRoot("стол"), null);
  assert.equal(spokenNumberRoot("пятью"), null);
});

test("the price in the owner's words is their last run of numbers, number words and currencies", () => {
  // The paid gate's narration.
  assert.equal(said("мына кружка бес жүз теңге"), "бес жүз теңге");
  assert.equal(said("кукла бес мың"), "бес мың");
  assert.equal(
    said("Шенжірелердің бағасы небәри он бес мың бес жүзден басталады"),
    "он бес мың бес жүзден",
  );
  assert.equal(said("оршак те отыз бес мыңнан басталады"), "отыз бес мыңнан");
  // Digits, signs and other languages.
  assert.equal(said("всего 15 500 тенге"), "15 500 тенге");
  assert.equal(said("за 3 500 ₸ бастап"), "3 500 ₸");
  assert.equal(said("стол пятьсот рублей"), "пятьсот рублей");
  assert.equal(said("this one is fifty dollars"), "fifty dollars");
  // No price said.
  assert.equal(said("Сәлеметсіздер ме"), null);
  assert.equal(said(""), null);
});

test("a word that only starts like a number word isn't the price", () => {
  // Grapes, a ring, a cradle and "but": a number word with an ending is
  // one only right after another, with nothing but a space between.
  assert.equal(said("жүзім бес жүз теңге"), "бес жүз теңге");
  assert.equal(said("күміс жүзік он бес мың"), "он бес мың");
  assert.equal(said("бесік отыз мың теңге"), "отыз мың теңге");
  assert.equal(said("бағасы бес мың, бірақ жеңілдік бар"), "бес мың");
  assert.equal(said("hundreds of colours"), null);
  // Said with Kazakh's endings, and by digits, a price still counts whole.
  assert.equal(said("кукла бес мыңға"), "бес мыңға");
  assert.equal(said("15 мыңнан басталады"), "15 мыңнан");
  assert.equal(
    said("бағасы он бес мыңнан жиырма мыңға дейін"),
    "он бес мыңнан жиырма мыңға",
  );
  assert.equal(
    said("всего два миллиона пятьсот тысяч рублей"),
    "два миллиона пятьсот тысяч рублей",
  );
});

test("a currency word follows its amount: a bag or a shirt isn't one", () => {
  assert.equal(said("қара сумка бес мың"), "бес мың");
  assert.equal(said("рубашка пять тысяч рублей"), "пять тысяч рублей");
  assert.equal(said("европейская сумка пятьсот"), "пятьсот");
});

test("the product's own name isn't its price", () => {
  // «Two cradles from five thousand», for a product named «Бесік».
  assert.equal(said("екі бесік бес мыңнан", "Бесік"), "бес мыңнан");
  assert.equal(said("Күміс жүзік он бес мың", "Күміс жүзік"), "он бес мың");
});
