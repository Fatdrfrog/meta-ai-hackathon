import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedAmounts, checkReply, normalizePhone, plainText, pricesInText, unbackedPrices } from "./guards.ts";

test("a reply is refused for invented prices, leaked refs or nothing at all", () => {
  const allowed = allowedAmounts([5000], [5000], null);
  assert.deepEqual(checkReply("Кукла стоит 5 000 ₸.", allowed), []);
  assert.equal(checkReply("Скидка: 4 000 ₸.", allowed).length, 1);
  assert.equal(checkReply("Это товар 5, p2.", allowed).length, 1);
  assert.equal(checkReply(" ", allowed).length, 1);
  assert.equal(checkReply("Вот что нашлось:", allowed).length, 1);
});

test("a price without the tenge sign is still checked; phone numbers and product names aren't prices", () => {
  const allowed = allowedAmounts([5000], [5000], null);
  assert.deepEqual(unbackedPrices("Для вас 4000.", allowed), [4000]);
  assert.deepEqual(unbackedPrices("Кукла — 5 000 ₸, или так: 5 000 4 000", allowed), [4000]);
  assert.deepEqual(unbackedPrices("Позвоните +7 (701) 123-45-67 или 8 701 123 45 67.", allowed), []);
  assert.deepEqual(unbackedPrices("Lego 60321 стоит 5 000 ₸, скидки 100% нет, 2 шт.", allowed, ["Lego 60321"]), []);
});

test("markdown is stripped so chats don't show stray asterisks", () => {
  assert.equal(plainText("Кукла стоит **5 000 ₸**.\n## Итого"), "Кукла стоит 5 000 ₸.\nИтого");
  assert.equal(plainText("Нашлось:\n\n\n* Кукла — 5 000 ₸\n- Динозавр — 300 ₸"), "Нашлось:\n\n• Кукла — 5 000 ₸\n• Динозавр — 300 ₸");
});

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
