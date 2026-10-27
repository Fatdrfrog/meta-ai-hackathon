import assert from "node:assert/strict";
import { test } from "node:test";
import type { BasetenClient, ChatCompletionJson } from "@vitrina/meta";
import { languageOf, runSellerTurn } from "./agent.ts";
import { searchProducts } from "./tools.ts";
import type { SellerTurnInput } from "./types.ts";

const products = [
  { id: "cup", localName: "кружка", name: "Frosted plastic cup", category: "cup", price: 500 },
  { id: "doll", localName: "Кукла Лол", name: "LOL doll in blue dress", category: "toy", price: 5000 },
  { id: "dino", localName: "динозавр ойыншық", name: "Green dinosaur toy", category: "toy", price: 300 },
];

const input = (overrides: Partial<SellerTurnInput> = {}): SellerTurnInput => ({
  shopName: "Test shop",
  channel: "web",
  products,
  history: [],
  buyerText: "Сколько стоит кукла?",
  ...overrides,
});

let callId = 0;
const call = (name: string, args: object = {}): ChatCompletionJson => ({
  choices: [{ message: { content: null, tool_calls: [{ id: `call-${callId++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
});
const say = (text: string): ChatCompletionJson => ({ choices: [{ message: { content: text } }] });

/** A model that plays back a script, one completion per call. */
function scripted(...steps: ChatCompletionJson[]) {
  const requests: { messages: unknown[] }[] = [];
  const client: BasetenClient = {
    config: { apiKey: "", baseUrl: "", model: "fake" },
    chatCompletion: async (body) => {
      // A copy: the agent keeps adding to the same message list after each call.
      requests.push({ messages: [...(body as { messages: unknown[] }).messages] });
      const step = steps[requests.length - 1];
      if (!step) throw new Error("The script ran out.");
      return step;
    },
  };
  return { client, requests };
}

test("search finds products across Russian and Kazakh word endings", () => {
  assert.deepEqual(searchProducts(products, "хочу куклу").map((r) => r.ref), ["p2"]);
  assert.deepEqual(searchProducts(products, "ойыншық").map((r) => r.ref), ["p3"]);
  assert.deepEqual(searchProducts(products, "toy").map((r) => r.ref), ["p2", "p3"]);
  assert.equal(searchProducts(products, "").length, 3);
  assert.deepEqual(searchProducts(products, "велосипед"), []);
});

test("the agent searches, shows cards and answers with the real price", async () => {
  const { client, requests } = scripted(call("search_products", { query: "кукла" }), call("show_products", { refs: ["p2"] }), say("Кукла Лол стоит **5 000 ₸**."));
  const turn = await runSellerTurn(client, input());
  assert.equal(turn.reply, "Кукла Лол стоит 5 000 ₸.");
  assert.deepEqual(turn.productIds, ["doll"]);
  assert.deepEqual(turn.trace.map((s) => s.tool), ["search_products", "show_products"]);
  assert.deepEqual(turn.corrections, []);
  // Each round sends the tool results back.
  assert.equal(requests[1]!.messages.filter((m) => (m as { role: string }).role === "tool").length, 1);
});

test("an invented price gets one correction, then a safe answer", async () => {
  const fixed = await runSellerTurn(client(say("Для вас 4 000 ₸."), say("Кукла стоит 5000 ₸.")), input());
  assert.equal(fixed.reply, "Кукла стоит 5000 ₸.");
  assert.match(fixed.corrections.join(), /4000/);

  const fallback = await runSellerTurn(client(say("Для вас 4 000 ₸."), say("Ладно, 3 000 ₸.")), input());
  assert.equal(fallback.reply, "Уточню у владельца магазина и скоро отвечу.");
  assert.match(fallback.ownerQuestion ?? "", /Сколько стоит кукла/);
});

test("an order on the web needs a phone: the tool refuses, then accepts", async () => {
  const noPhone = await runSellerTurn(client(call("place_order", { items: [{ ref: "p2", quantity: 1 }], name: "Айгуль", phone: null }), say("Напишите, пожалуйста, номер телефона.")), input());
  assert.equal(noPhone.order, null);
  assert.equal((noPhone.trace[0]!.result as { ok: boolean }).ok, false);

  const placed = await runSellerTurn(
    client(call("place_order", { items: [{ ref: "p2", quantity: 2 }], name: "Айгуль", phone: "8 701 123 45 67" }), say("Заказ оформлен: две куклы, 10 000 ₸.")),
    input(),
  );
  assert.deepEqual(placed.order, { items: [{ productId: "doll", quantity: 2 }], buyerName: "Айгуль", buyerPhone: "+77011234567", total: 10000 });
  assert.deepEqual(placed.productIds, ["doll"]);
  assert.equal((placed.trace[0]!.result as { total: string }).total, "10 000 ₸");
});

test("an order goes through when the model sends the phone and quantity as numbers", async () => {
  // Muse Spark Open sent "phone": 87011234567 in the eval, against the schema's string.
  const turn = await runSellerTurn(
    client(call("place_order", { items: [{ ref: "p3", quantity: "1" }], name: "Айгуль", phone: 87011234567 }), say("Заказ оформлен, 300 ₸.")),
    input(),
  );
  assert.equal(turn.order?.buyerPhone, "+77011234567");
  assert.equal(turn.order?.total, 300);

  const typo = await runSellerTurn(client(call("place_order", { items: [{ ref: "p3", quantity: 1 }], name: null, phone: "12345" }), say("Проверьте номер, пожалуйста.")), input());
  assert.match((typo.trace[0]!.result as { error: string }).error, /"12345" isn't a phone number/);
});

test("refs and labels stay inside: a reply that mentions them is corrected", async () => {
  const turn = await runSellerTurn(client(say("Это товар p2, 5000 ₸."), say("Это Кукла Лол, 5000 ₸.")), input());
  assert.equal(turn.reply, "Это Кукла Лол, 5000 ₸.");
  assert.match(turn.corrections.join(), /ref or label/);
});

test("questions reach the owner, and photo matching needs a photo", async () => {
  const turn = await runSellerTurn(client(call("match_photo"), call("ask_owner", { question: "Есть ли доставка?" }), say("Уточню у владельца.")), input());
  assert.match(JSON.stringify(turn.trace[0]!.result), /didn't send a photo/);
  assert.equal(turn.ownerQuestion, "Есть ли доставка?");
});

test("an agent that never stops calling tools ends with a safe answer", async () => {
  const turn = await runSellerTurn(client(...Array.from({ length: 6 }, () => call("search_products", { query: "кукла" }))), input());
  assert.equal(turn.reply, "Уточню у владельца магазина и скоро отвечу.");
  assert.equal(turn.trace.length, 6);
});

test("the fallback reply follows the buyer's language", () => {
  assert.equal(languageOf("Қуыршақ қанша тұрады?"), "kk");
  assert.equal(languageOf("Сколько стоит?"), "ru");
  assert.equal(languageOf("How much?"), "en");
});

function client(...steps: ChatCompletionJson[]) {
  return scripted(...steps).client;
}
