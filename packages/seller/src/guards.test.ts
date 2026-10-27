import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedAmounts, normalizePhone, pricesInText, unbackedPrices } from "./guards.ts";

test("amounts are read in the ways people write tenge", () => {
  assert.deepEqual(pricesInText("Қуыршақ 5 000 ₸, телефон 2000 тг, кружка 500 теңге, all 7,500 KZT"), [5000, 2000, 500, 7500]);
  assert.deepEqual(pricesInText("Кукла стоит 5 000 тенге."), [5000]);
  assert.deepEqual(pricesInText("We have 7 products"), []);
});

test("catalog prices, multiples of the products in question and the order total pass", () => {
  const allowed = allowedAmounts([5000, 300], [5000], 5600);
  assert.deepEqual(unbackedPrices("Кукла — 5 000 ₸, две — 10 000 ₸, динозавр 300 ₸, итого 5 600 ₸", allowed), []);
});

test("a made-up discount can't hide as a multiple of a cheap product", () => {
  // 4 500 is fifteen 300 ₸ dinosaurs, but the reply is about the doll.
  assert.deepEqual(unbackedPrices("Кукла — 4 500 ₸ со скидкой", allowedAmounts([5000, 300], [5000], null)), [4500]);
});

test("phone numbers are normalized, with Kazakh local forms turned into +7", () => {
  assert.equal(normalizePhone("+7 701 123 45 67"), "+77011234567");
  assert.equal(normalizePhone("8 (701) 123-45-67"), "+77011234567");
  assert.equal(normalizePhone("701 123 45 67"), "+77011234567");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(null), null);
});
