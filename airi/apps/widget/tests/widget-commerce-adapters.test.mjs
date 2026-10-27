import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const evaluate = (path, requireModule) => {
  const sourceUrl = new URL(path, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(sourceUrl, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    requireModule ||
      ((specifier) => {
        throw new Error(`Unexpected runtime import: ${specifier}`);
      }),
    loaded,
    loaded.exports,
  );
  return loaded.exports;
};

const gtm = evaluate("../src/lib/commerce-gtm.ts");
const commerceContract = evaluate(
  "../../../packages/shared/src/types/commerce-tracking.ts",
  (specifier) => {
    if (specifier === "../lib/value-utils") {
      return evaluate("../../../packages/shared/src/lib/value-utils.ts");
    }
    throw new Error(`Unexpected runtime import: ${specifier}`);
  },
);
const commerceStorageKey = evaluate("../src/lib/commerce-storage-key.ts");
const shopify = evaluate("../src/lib/commerce-shopify.ts", (specifier) => {
  if (specifier === "@icecore/shared/types/commerce-tracking") {
    return commerceContract;
  }
  if (specifier === "./commerce-storage-key") return commerceStorageKey;
  throw new Error(`Unexpected Shopify import: ${specifier}`);
});
const tilda = evaluate("../src/lib/commerce-tilda.ts");

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};
const waitFor = async (predicate, timeoutMs = 1_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test("GTM adapter requires a full same-currency snapshot and restores dataLayer", async () => {
  const calls = [];
  const errors = [];
  const dataLayer = [];
  const originalPush = dataLayer.push;
  const destroy = gtm.installGtmCommerceAdapter({
    commerce: { track: (type, payload) => calls.push({ type, payload }) },
    dataLayer,
    onError: (error) => errors.push(error.message),
  });

  dataLayer.push({
    event: "begin_checkout",
    event_id: "gtm-checkout-1",
    airi: {
      cartId: "cart-1",
      checkoutId: "checkout-1",
      recoveryUrl: "https://shop.example/cart/restore/1",
    },
    ecommerce: {
      currency: "usd",
      items: [{ item_id: "sku-1", item_name: "One", quantity: 2, price: 10 }],
    },
  });
  dataLayer.push({
    event: "add_to_cart",
    airi: { cartId: "cart-1" },
    ecommerce: {
      currency: "USD",
      items: [
        { item_id: "sku-1", item_name: "One", price: 10, currency: "EUR" },
      ],
    },
  });
  await flush();

  assert.equal(calls[0].type, "checkout_started");
  assert.equal(calls[0].payload.cartId, "cart-1");
  assert.equal(calls[0].payload.checkoutId, "checkout-1");
  assert.equal(calls[0].payload.currency, "USD");
  assert.match(errors[0], /mix currencies/);
  destroy();
  assert.equal(dataLayer.push, originalPush);
});

test("Shopify adapter maps native event IDs and preserves cart identity into checkout", async () => {
  const listeners = new Map();
  const calls = [];
  const initialCart = {
    id: "gid://shopify/Cart/native-cart-token",
    lines: [
      {
        quantity: 1,
        merchandise: {
          id: "gid://shopify/ProductVariant/1",
          title: "Small",
          product: { title: "One" },
          price: { amount: 10, currencyCode: "USD" },
        },
        cost: { totalAmount: { amount: 10, currencyCode: "USD" } },
      },
    ],
    cost: { totalAmount: { amount: 10, currencyCode: "USD" } },
  };
  const adapter = shopify.installShopifyCommerceAdapter({
    analytics: { subscribe: (name, listener) => listeners.set(name, listener) },
    init: {
      data: {
        cart: initialCart,
      },
    },
    commerce: { track: (type, payload) => calls.push({ type, payload }) },
    recoveryUrl: () => "https://shop.example/cart/restore/native-cart-token",
    getCartSnapshot: () => ({
      id: "gid://shopify/Cart/native-cart-token",
      lines: [
        ...initialCart.lines,
        {
          quantity: 2,
          merchandise: {
            id: "gid://shopify/ProductVariant/2",
            title: "Blue",
            product: { title: "Two" },
            price: { amount: 5, currencyCode: "USD" },
          },
          cost: { totalAmount: { amount: 10, currencyCode: "USD" } },
        },
      ],
      cost: { totalAmount: { amount: 20, currencyCode: "USD" } },
    }),
  });

  const checkout = {
    token: "native-checkout-token",
    currencyCode: "USD",
    totalPrice: { amount: 10, currencyCode: "USD" },
    lineItems: [
      {
        id: "line-1",
        title: "One / Small",
        quantity: 1,
        variant: {
          id: "gid://shopify/ProductVariant/1",
          price: { amount: 10, currencyCode: "USD" },
        },
      },
    ],
  };
  listeners.get("product_added_to_cart")({
    id: "shopify-cart-event",
    timestamp: new Date().toISOString(),
    data: {
      cartLine: {
        quantity: 2,
        merchandise: {
          id: "gid://shopify/ProductVariant/2",
          title: "Blue",
          product: { title: "Two" },
          price: { amount: 5, currencyCode: "USD" },
        },
        cost: { totalAmount: { amount: 10, currencyCode: "USD" } },
      },
    },
  });
  listeners.get("checkout_started")({
    id: "shopify-event-1",
    timestamp: new Date().toISOString(),
    data: { checkout },
  });
  listeners.get("checkout_completed")({
    id: "shopify-event-2",
    timestamp: new Date().toISOString(),
    data: { checkout: { ...checkout, order: { id: "gid://shopify/Order/2" } } },
  });
  await adapter.flush();

  assert.equal(calls[0].type, "cart_updated");
  assert.equal(calls[0].payload.items.length, 1);
  assert.equal(calls[1].payload.items.length, 2);
  assert.deepEqual(
    calls
      .slice(2)
      .map((call) => [call.type, call.payload.cartId, call.payload.checkoutId]),
    [
      [
        "checkout_started",
        "gid://shopify/Cart/native-cart-token",
        "native-checkout-token",
      ],
      [
        "purchase_reported",
        "gid://shopify/Cart/native-cart-token",
        "native-checkout-token",
      ],
    ],
  );
  assert.equal(calls[3].payload.orderId, "gid://shopify/Order/2");
});

test("Shopify pixel stores canonical events for the widget session and builds a cart permalink", async () => {
  const listeners = new Map();
  const values = new Map();
  const localStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
    key: async (index) => [...values.keys()][index] ?? null,
    length: async () => values.size,
  };
  const adapter = await shopify.installShopifyPixelCommerceAdapter({
    analytics: { subscribe: (name, listener) => listeners.set(name, listener) },
    browser: { localStorage },
    clientKey: "source-a",
    storefrontOrigin: "https://shop.example",
    apiUrl: "https://airi.example/api/widget",
    fetch: async () => Response.json({ carts: [] }),
    init: { data: {} },
  });
  listeners.get("airi:cart_snapshot")({
    id: "shopify-custom-1",
    timestamp: new Date().toISOString(),
    customData: {
      cart: {
        token: "native-cart-token",
        currency: "USD",
        items: [
          {
            variant_id: 70881412,
            product_title: "Green shirt",
            quantity: 2,
            final_price: 2950,
          },
        ],
      },
    },
  });
  await adapter.flush();

  const inboxValues = [...values.entries()]
    .filter(([key]) => key.startsWith("airi_commerce_shopify_v1:"))
    .map(([, value]) => value);
  assert.equal(inboxValues.length, 1);
  const event = JSON.parse(inboxValues[0]);
  assert.equal(event.eventId, "shopify-custom-1");
  assert.equal(event.cartId, "native-cart-token");
  assert.equal(event.items[0].price, 29.5);
  assert.equal(
    event.recoveryUrl,
    "https://shop.example/cart/70881412:2?storefront=true",
  );
  adapter.destroy();
});

test("Shopify pixel directly retries the exact event with the existing signed session", async () => {
  const values = new Map();
  const localStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
    key: async (index) => [...values.keys()][index] ?? null,
    length: async () => values.size,
  };
  values.set(
    commerceStorageKey.widgetCommerceStorageKey("source-a"),
    JSON.stringify({ clientKey: "source-a", sessionToken: "signed-session" }),
  );
  const requests = [];
  const bridge = shopify.createShopifyPixelCommerceBridge({
    browser: { localStorage },
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    retryBaseMs: 0,
    fetch: async (_url, options) => {
      requests.push(options);
      return new Response("{}", { status: requests.length === 1 ? 503 : 200 });
    },
  });
  bridge.track("cart_updated", {
    eventId: "pixel-retry-1",
    cartId: "cart-1",
    items: [{ id: "123", name: "One", quantity: 1, price: 10 }],
    currency: "USD",
  });
  await waitFor(() => requests.length === 2);

  assert.equal(requests[0].credentials, "omit");
  assert.deepEqual(JSON.parse(requests[0].body), JSON.parse(requests[1].body));
  assert.equal(JSON.parse(requests[0].body).action, "events");
  assert.equal(
    requests.some((request) => JSON.parse(request.body).action === "session"),
    false,
  );
  assert.equal(
    [...values.keys()].some((key) => key.includes("pixel-retry-1")),
    false,
  );
  bridge.destroy();
});

test("Shopify pixel aborts a stalled direct send on timeout and destroy", async () => {
  const values = new Map([
    [
      commerceStorageKey.widgetCommerceStorageKey("source-a"),
      JSON.stringify({ clientKey: "source-a", sessionToken: "signed-session" }),
    ],
  ]);
  const localStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
    key: async (index) => [...values.keys()][index] ?? null,
    length: async () => values.size,
  };
  let aborted = false;
  const bridge = shopify.createShopifyPixelCommerceBridge({
    browser: { localStorage },
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    requestTimeoutMs: 5,
    retryBaseMs: 60_000,
    fetch: (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  });
  bridge.track("checkout_closed", {
    eventId: "pixel-timeout-1",
    cartId: "cart-1",
  });
  await waitFor(() => aborted);
  bridge.destroy();
  assert.equal(aborted, true);
});

test("Shopify pixel restart retains original cart identity and recovery URL", async () => {
  const values = new Map();
  const localStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
    key: async (index) => [...values.keys()][index] ?? null,
    length: async () => values.size,
  };
  const firstListeners = new Map();
  const first = await shopify.installShopifyPixelCommerceAdapter({
    analytics: {
      subscribe: (name, listener) => firstListeners.set(name, listener),
    },
    browser: { localStorage },
    clientKey: "source-a",
    storefrontOrigin: "https://shop.example",
    apiUrl: "https://airi.example/api/widget",
    init: { data: {} },
  });
  firstListeners.get("airi:cart_snapshot")({
    id: "cart-snapshot-1",
    timestamp: new Date().toISOString(),
    customData: {
      cart: {
        token: "original-cart-token",
        currency: "USD",
        items: [
          {
            variant_id: 70881412,
            product_title: "One",
            quantity: 1,
            final_price: 1000,
          },
        ],
      },
    },
  });
  await first.flush();
  first.destroy();

  const secondListeners = new Map();
  const second = await shopify.installShopifyPixelCommerceAdapter({
    analytics: {
      subscribe: (name, listener) => secondListeners.set(name, listener),
    },
    browser: { localStorage },
    clientKey: "source-a",
    storefrontOrigin: "https://shop.example",
    apiUrl: "https://airi.example/api/widget",
    init: { data: {} },
  });
  secondListeners.get("checkout_started")({
    id: "checkout-after-restart",
    timestamp: new Date().toISOString(),
    data: {
      checkout: {
        token: "checkout-token",
        currencyCode: "USD",
        lineItems: [
          {
            id: "line-1",
            title: "One",
            quantity: 1,
            variant: {
              id: "gid://shopify/ProductVariant/70881412",
              price: { amount: 10, currencyCode: "USD" },
            },
          },
        ],
      },
    },
  });
  await second.flush();
  const events = [...values.entries()]
    .filter(([key]) => key.startsWith("airi_commerce_shopify_v1:"))
    .map(([, value]) => JSON.parse(value));
  const checkoutEvent = events.find(
    (event) => event.eventId === "checkout-after-restart",
  );
  assert.equal(checkoutEvent.cartId, "original-cart-token");
  assert.equal(
    checkoutEvent.recoveryUrl,
    "https://shop.example/cart/70881412:1?storefront=true",
  );
  second.destroy();
});

test("Shopify storefront bridge publishes full Ajax Cart snapshots after mutations", async (t) => {
  const originalFetch = globalThis.fetch;
  const published = [];
  const fakeFetch = async (input) => {
    const url = String(input);
    if (url.endsWith("cart.js")) {
      return new Response(
        JSON.stringify({ token: "cart-1", currency: "USD", items: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };
  globalThis.fetch = fakeFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bridge = shopify.installShopifyStorefrontBridge({
    analytics: {
      publish: (name, data) => published.push({ name, data }),
    },
    cartJsonUrl: "https://shop.example/cart.js",
  });
  await globalThis.fetch("https://shop.example/cart/add.js", {
    method: "POST",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(published.length, 2);
  assert.equal(published[1].name, "airi:cart_snapshot");
  assert.equal(published[1].data.cart.token, "cart-1");
  bridge.destroy();
  assert.equal(globalThis.fetch, fakeFetch);
});

test("Tilda adapter uses the native after-success event and cleans listeners", () => {
  const form = new EventTarget();
  form.tildaOrderId = "order-7";
  const calls = [];
  const adapter = tilda.installTildaCommerceAdapter({
    commerce: {
      track: (type, payload) => calls.push({ type, payload }) || "id",
    },
    forms: [form],
    getCartSnapshot: () => ({
      cartId: "tilda-cart-1",
      items: [{ id: "product-1", name: "One", quantity: 1, price: 12 }],
      currency: "USD",
      recoveryUrl: "https://store.example/cart/restore/1",
    }),
  });

  form.dispatchEvent(new Event("tildaform:aftersuccess"));
  assert.equal(calls[0].type, "order_placed");
  assert.equal(calls[0].payload.orderId, "order-7");
  assert.equal(calls[0].payload.eventId, "tilda:order-7:order_placed");
  adapter.destroy();
  form.dispatchEvent(new Event("tildaform:aftersuccess"));
  assert.equal(calls.length, 1);
});

test("loader queues track before readiness and loads commerce even in lazy mode", (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const appendedScripts = [];
  const tracked = [];

  class FakeElement {
    constructor(tag = "div") {
      this.tag = tag;
      this.dataset = {};
      this.style = {};
    }
    setAttribute() {}
    getAttribute(name) {
      if (name === "data-client-key") return this.dataset.clientKey;
      if (name === "data-user-id") return this.dataset.userId;
      if (name === "data-user-email") return this.dataset.userEmail;
      if (name === "data-user-name") return this.dataset.userName;
      return null;
    }
    attachShadow() {
      this.shadowRoot = { host: this };
      return this.shadowRoot;
    }
  }

  const loaderScript = new FakeElement("script");
  loaderScript.src = "https://widget.airi.chat/loader.js";
  loaderScript.dataset.clientKey = "source-a";
  loaderScript.dataset.autoLoad = "false";
  const listeners = new Map();
  const document = {
    currentScript: loaderScript,
    readyState: "loading",
    body: { appendChild() {} },
    head: { appendChild: (script) => appendedScripts.push(script) },
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    getElementsByTagName: () => [loaderScript],
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
  const window = {
    addEventListener() {},
    airiWidgetConfig: {},
  };
  window.AiriChat = function () {};
  window.AiriChat.q = [["track", "cart_updated", { cartId: "cart-1" }]];
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = FakeElement;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.HTMLElement = originalHTMLElement;
  });

  evaluate("../src/loader.ts", (specifier) => {
    if (specifier === "@icecore/shared/lib/logger") {
      return { createLogger: () => ({ warn() {}, error() {} }) };
    }
    throw new Error(`Unexpected loader import: ${specifier}`);
  });

  assert.equal(appendedScripts.length, 1);
  assert.equal(window.AiriChat.q.length, 1);

  window.AiriWidget = {
    init: (options) => assert.equal(options.clientKey, "source-a"),
    track: (type, payload) => tracked.push({ type, payload }),
    getCommerce: () => ({ ready: true }),
    createCartHandoff: async () => "https://wa.me/1",
  };
  appendedScripts[0].onload();
  assert.deepEqual(tracked, [
    { type: "cart_updated", payload: { cartId: "cart-1" } },
  ]);
  assert.equal(window.AiriChat.q, undefined);
});
