import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogProduct, CatalogResult } from "@vitrina/catalog";
import type { ShopPageData, StudioData } from "./api.ts";
import { createApp, parseProductPatch } from "./app.ts";
import { openStore, slugify } from "./store.ts";

const product = (overrides: Partial<CatalogProduct>): CatalogProduct => ({
  name: "LOL doll",
  local_name: "Кукла Лол",
  category: "toy",
  sam_phrase: "doll",
  price: 5000,
  currency: "KZT",
  price_quote: "бес мың теңге",
  first_seen_s: 36,
  clearest_moment_s: 38,
  doubt: null,
  checks: [],
  framePath: "frame.jpg",
  frameTimeS: 38,
  cutoutPath: "doll.png",
  samConfidence: 0.9,
  ...overrides,
});

const result = (products: CatalogProduct[]): CatalogResult => ({
  transcript: "[38.0] Кукла Лолдың бағасы бес мың теңге.",
  language: "Kazakh",
  products,
  spentUsd: 0.07,
  seconds: { prepare: 1, listen: 1, watch: 1, cut: 1 },
});

function setup() {
  const store = openStore(":memory:");
  const shop = store.createShop("QazOner Group");
  const video = store.addVideo(shop.id, "video-1", "source.mp4");
  store.finishVideo(video, result([product({}), product({ local_name: "Әтеш", price: null, checks: ["No price was said for this item."] })]));
  const app = createApp(store, { dataDir: ".", onVideoQueued: () => {} });
  return { store, shop, app };
}

test("shop slugs are readable and unique", () => {
  const store = openStore(":memory:");
  assert.equal(store.createShop("QazOner Group").slug, "qazoner-group");
  assert.equal(store.createShop("QazOner Group").slug, "qazoner-group-2");
  assert.equal(slugify("Ақ Орда"), "shop");
});

test("a finished video adds its products in order, with notes from the checks", async () => {
  const { shop, app } = setup();
  const res = await app.request(`/api/studio/${shop.ownerToken}`);
  const data = (await res.json()) as StudioData;
  assert.deepEqual(
    data.products.map((p) => [p.localName, p.price, p.notes.length, p.confirmed]),
    [
      ["Кукла Лол", 5000, 0, false],
      ["Әтеш", null, 1, false],
    ],
  );
  assert.equal(data.videos[0]?.status, "done");
  assert.equal(data.videos[0]?.productCount, 2);
});

test("a wrong studio link is refused", async () => {
  const { app } = setup();
  assert.equal((await app.request("/api/studio/not-a-token")).status, 404);
  assert.equal((await app.request("/api/studio/not-a-token/products/confirm-all", { method: "POST" })).status, 404);
});

test("confirm-all skips products that still have notes, and only confirmed ones reach the shop page", async () => {
  const { shop, app } = setup();
  const confirm = await app.request(`/api/studio/${shop.ownerToken}/products/confirm-all`, { method: "POST" });
  assert.deepEqual(await confirm.json(), { confirmed: 1 });
  const page = (await (await app.request(`/api/shops/${shop.slug}`)).json()) as ShopPageData;
  assert.deepEqual(
    page.products.map((p) => p.localName),
    ["Кукла Лол"],
  );
});

test("the owner can fix a price, and bad edits are refused", async () => {
  const { store, shop, app } = setup();
  const rooster = store.products(shop.id)[1]!;
  const url = `/api/studio/${shop.ownerToken}/products/${rooster.id}`;
  const ok = await app.request(url, { method: "PATCH", body: JSON.stringify({ price: 500, confirmed: true }) });
  assert.equal(ok.status, 200);
  assert.deepEqual([store.product(shop.id, rooster.id)?.price, store.product(shop.id, rooster.id)?.confirmed], [500, true]);
  const bad = await app.request(url, { method: "PATCH", body: JSON.stringify({ price: -1 }) });
  assert.equal(bad.status, 400);
});

test("product edits accept only known fields with sane values", () => {
  assert.deepEqual(parseProductPatch({ localName: "  Әтеш ", price: null }), { localName: "Әтеш", price: null });
  assert.equal(typeof parseProductPatch({ localName: "" }), "string");
  assert.equal(typeof parseProductPatch({ confirmed: "yes" }), "string");
  assert.equal(typeof parseProductPatch(null), "string");
});

test("interrupted videos go back in the queue", () => {
  const store = openStore(":memory:");
  const shop = store.createShop("Shop");
  store.addVideo(shop.id, "v1", "a.mp4");
  store.setProgress("v1", "processing", "watching", null, null);
  assert.equal(store.requeueInterrupted(), 1);
  assert.equal(store.nextQueuedVideo()?.id, "v1");
});
