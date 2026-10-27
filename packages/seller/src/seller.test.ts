import assert from "node:assert/strict";
import { test } from "node:test";
import { languageOf, validateAnswer, type SellerTurnInput } from "./seller.ts";

const input = (overrides: Partial<SellerTurnInput> = {}): SellerTurnInput => ({
  shopName: "Test shop",
  channel: "web",
  products: [
    { id: "doll", localName: "Кукла Лол", name: "LOL doll", category: "toy", price: 5000 },
    { id: "phone", localName: "телефон ойыншық", name: "Toy phone", category: "toy", price: 2000 },
    { id: "stand", localName: "подставка", name: "Phone stand", category: "accessory", price: null },
  ],
  history: [],
  buyerText: "Сколько стоит кукла?",
  ...overrides,
});

const answer = (overrides: Record<string, unknown> = {}) => ({ reply: "Кукла стоит 5 000 ₸.", show: [1], order: null, ask_owner: null, ...overrides }) as never;

test("labels become product ids and an honest reply passes", () => {
  const { turn, problems } = validateAnswer(answer(), input());
  assert.deepEqual(problems, []);
  assert.deepEqual(turn.productIds, ["doll"]);
});

test("an invented price is caught", () => {
  const { problems } = validateAnswer(answer({ reply: "Для вас скидка: 4 000 ₸." }), input());
  assert.match(problems.join(), /4000/);
});

test("labels that aren't products are dropped and reported", () => {
  const { turn, problems } = validateAnswer(answer({ show: [1, 9] }), input());
  assert.deepEqual(turn.productIds, ["doll"]);
  assert.match(problems.join(), /9/);
});

test("a web order needs a phone, then gets a total that the reply may state", () => {
  const noPhone = validateAnswer(answer({ order: { items: [{ label: 1, quantity: 2 }], name: "Айгуль", phone: null } }), input());
  assert.equal(noPhone.turn.order, null);
  assert.match(noPhone.problems.join(), /phone/);

  const ok = validateAnswer(
    answer({ reply: "Оформила: 2 куклы и телефон, итого 12 000 ₸.", order: { items: [{ label: 1, quantity: 2 }, { label: 2, quantity: 1 }], name: "Айгуль", phone: "8 701 123 45 67" } }),
    input(),
  );
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.turn.order, {
    items: [
      { productId: "doll", quantity: 2 },
      { productId: "phone", quantity: 1 },
    ],
    buyerName: "Айгуль",
    buyerPhone: "+77011234567",
    total: 12000,
  });
});

test("on WhatsApp the buyer's number is already known", () => {
  const { turn } = validateAnswer(answer({ order: { items: [{ label: 2, quantity: 1 }], name: null, phone: null } }), input({ channel: "whatsapp", buyerPhone: "+77011234567" }));
  assert.equal(turn.order?.buyerPhone, "+77011234567");
});

test("an order with an unpriced item has no total", () => {
  const { turn } = validateAnswer(answer({ reply: "Оформила подставку.", order: { items: [{ label: 3, quantity: 1 }], name: "А", phone: "+77011234567" } }), input());
  assert.equal(turn.order?.total, null);
});

test("the fallback reply follows the buyer's language", () => {
  assert.equal(languageOf("Қуыршақ қанша тұрады?"), "kk");
  assert.equal(languageOf("Сколько стоит?"), "ru");
  assert.equal(languageOf("How much?"), "en");
});
