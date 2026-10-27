import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogProduct } from "@vitrina/catalog";
import type { SellerTurn, SellerTurnInput } from "@vitrina/seller";
import type { ChatData, StudioData } from "./api.ts";
import { createApp, type AppOptions } from "./app.ts";
import { openStore } from "./store.ts";

const product = (localName: string, price: number): CatalogProduct => ({
  name: localName,
  local_name: localName,
  category: "toy",
  sam_phrase: localName,
  price,
  currency: "KZT",
  price_quote: null,
  first_seen_s: 0,
  clearest_moment_s: 0,
  doubt: null,
  checks: [],
  framePath: "frame.jpg",
  frameTimeS: 0,
  cutoutPath: "cut.png",
  samConfidence: 0.9,
  cutoutMethod: "tracked",
});

function setup(sell: AppOptions["sell"], options: Partial<AppOptions> = {}) {
  const store = openStore(":memory:");
  const shop = store.createShop("Toy shop");
  const video = store.addVideo(shop.id, "v1", "source.mp4");
  store.finishVideo(video, {
    transcript: "",
    language: "Kazakh",
    products: [product("Кукла Лол", 5000), product("Динозавр", 300)],
    spentUsd: 0,
    seconds: { prepare: 0, listen: 0, watch: 0, cut: 0 },
  });
  store.confirmAllWithoutNotes(shop.id);
  const app = createApp(store, { dataDir: ".", onVideoQueued: () => {}, sell, ...options });
  const send = (fields: Record<string, string>, headers: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return app.request(`/api/shops/${shop.slug}/chat`, { method: "POST", body: form, headers });
  };
  return { store, shop, app, send };
}

const turn = (overrides: Partial<SellerTurn> = {}): SellerTurn => ({ reply: "Кукла стоит 5000 ₸.", productIds: [], order: null, ownerQuestion: null, corrections: [], trace: [], ...overrides });

test("a chat keeps its history, and the seller sees it on the next message", async () => {
  const seen: SellerTurnInput[] = [];
  const { store, shop, send, app } = setup(async (input) => {
    seen.push(input);
    return turn({ productIds: [input.products[0]!.id] });
  });
  const first = (await (await send({ text: "Сколько стоит кукла?" })).json()) as ChatData;
  assert.deepEqual(first.messages.map((m) => [m.role, m.products.map((p) => p.localName)]), [["buyer", []], ["seller", ["Кукла Лол"]]]);
  await send({ text: "А динозавр?", conversationId: first.conversationId });
  assert.deepEqual(seen[1]!.history.map((m) => m.text), ["Сколько стоит кукла?", "Кукла стоит 5000 ₸."]);
  assert.deepEqual(seen[1]!.products.map((p) => p.localName), ["Кукла Лол", "Динозавр"]);
  const reopened = (await (await app.request(`/api/shops/${shop.slug}/chat/${first.conversationId}`)).json()) as ChatData;
  assert.equal(reopened.messages.length, 4);
  assert.equal(store.messages(first.conversationId).length, 4);
});

test("orders and questions for the owner reach the studio", async () => {
  const { shop, send, app } = setup(async (input) =>
    turn({
      reply: "Заказ оформлен.",
      order: { items: [{ productId: input.products[1]!.id, quantity: 2 }], buyerName: "Айгуль", buyerPhone: "+77011234567", total: 600 },
      ownerQuestion: "Есть ли доставка?",
    }),
  );
  const chat = (await (await send({ text: "Два динозавра, Айгуль, 87011234567" })).json()) as ChatData;
  assert.deepEqual(chat.messages[1]!.order?.items, [{ localName: "Динозавр", quantity: 2, price: 300 }]);
  const studio = (await (await app.request(`/api/studio/${shop.ownerToken}`)).json()) as StudioData;
  assert.deepEqual(studio.orders.map((o) => [o.total, o.buyerPhone]), [[600, "+77011234567"]]);
  assert.deepEqual(studio.questions.map((q) => [q.question, q.done]), [["Есть ли доставка?", false]]);
  const done = await app.request(`/api/studio/${shop.ownerToken}/questions/${studio.questions[0]!.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
  assert.equal(done.status, 200);
});

test("the seller sees the orders placed earlier in the same chat, and only those", async () => {
  const seen: SellerTurnInput[] = [];
  const { send } = setup(async (input) => {
    seen.push(input);
    return seen.length === 1
      ? turn({ reply: "Заказ оформлен.", order: { items: [{ productId: input.products[1]!.id, quantity: 2 }], buyerName: null, buyerPhone: "+77011234567", total: 600 } })
      : turn({ reply: "Ваш заказ: два динозавра, 600 ₸." });
  });
  const first = (await (await send({ text: "Два динозавра, 87011234567" })).json()) as ChatData;
  await send({ text: "Что я заказала?", conversationId: first.conversationId });
  await send({ text: "Я новый покупатель" });
  assert.equal(seen[0]!.previousOrders?.length, 0);
  assert.deepEqual(seen[1]!.previousOrders?.map((o) => [o.items, o.total]), [[[{ localName: "Динозавр", quantity: 2 }], 600]]);
  assert.equal(seen[2]!.previousOrders?.length, 0);
});

test("a shop with nothing confirmed answers without calling the model", async () => {
  let called = false;
  const store = openStore(":memory:");
  const shop = store.createShop("Empty shop");
  const app = createApp(store, { dataDir: ".", onVideoQueued: () => {}, sell: async () => ((called = true), turn()) });
  const form = new FormData();
  form.append("text", "Привет");
  const chat = (await (await app.request(`/api/shops/${shop.slug}/chat`, { method: "POST", body: form })).json()) as ChatData;
  assert.match(chat.messages[1]!.text, /hasn't put any products/);
  assert.equal(called, false);
});

test("empty messages, a switched-off chat and too many messages are refused", async () => {
  const { send } = setup(async () => turn(), { chatLimits: { perSenderPerHour: 2, perChatPerHour: 10, perShopPerDay: 10 } });
  assert.equal((await send({ text: "   " })).status, 400);
  const headers = { "x-forwarded-for": "203.0.113.7" };
  assert.equal((await send({ text: "one" }, headers)).status, 200);
  assert.equal((await send({ text: "two" }, headers)).status, 200);
  assert.equal((await send({ text: "three" }, headers)).status, 429);
  assert.equal((await setup(undefined).send({ text: "hi" })).status, 503);
});

test("when the seller fails the buyer gets a clear error, not a broken chat", async () => {
  const { send } = setup(async () => {
    throw new Error("Baseten is down");
  });
  const res = await send({ text: "Есть кукла?" });
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /couldn't answer/);
});
