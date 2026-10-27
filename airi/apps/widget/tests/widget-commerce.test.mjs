import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const evaluateTypeScriptModule = (path, requireModule) => {
  const sourceUrl = new URL(path, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(sourceUrl, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  }).outputText;
  const loaded = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    `${compiled}\n//# sourceURL=${sourceUrl.href}`,
  )(requireModule, loaded, loaded.exports);
  return loaded.exports;
};

const sharedCommerce = evaluateTypeScriptModule(
  "../../../packages/shared/src/types/commerce-tracking.ts",
  (specifier) => {
    if (specifier === "../lib/value-utils") {
      return evaluateTypeScriptModule(
        "../../../packages/shared/src/lib/value-utils.ts",
        (nested) => {
          throw new Error(`Unexpected shared value-utils import: ${nested}`);
        },
      );
    }
    throw new Error(`Unexpected shared commerce import: ${specifier}`);
  },
);
const commerceStorageKey = evaluateTypeScriptModule(
  "../src/lib/commerce-storage-key.ts",
  (specifier) => {
    throw new Error(`Unexpected commerce storage import: ${specifier}`);
  },
);

const { WidgetCommerce } = evaluateTypeScriptModule(
  "../src/lib/commerce.ts",
  (specifier) => {
    if (specifier === "@icecore/shared/types/commerce-tracking") {
      return sharedCommerce;
    }
    if (specifier === "./storage") {
      let sequence = 0;
      return { generateUUID: () => `generated-${++sequence}` };
    }
    if (specifier === "./commerce-storage-key") return commerceStorageKey;
    throw new Error(`Unexpected widget commerce import: ${specifier}`);
  },
);

const waitFor = async (predicate, timeoutMs = 1_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const cart = (eventId = "event-1") => ({
  eventId,
  cartId: "cart-1",
  items: [{ id: "sku-1", name: "One", quantity: 2, price: 10 }],
  currency: "usd",
  recoveryUrl: "https://shop.example/cart/restore/1",
});

const responseCart = {
  cartId: "cart-1",
  status: "cart",
  itemCount: 2,
  total: 20,
  currency: "USD",
  recoveryUrl: "https://shop.example/cart/restore/1",
  linked: false,
};

const createStorage = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

test("commerce waits for its session and retries the exact ordered event batch", async () => {
  let releaseSession;
  const sessionGate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  const eventBodies = [];
  let eventAttempts = 0;
  const fetcher = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "session") {
      await sessionGate;
      return Response.json({ sessionToken: "session-1", enabled: true });
    }
    if (body.action === "carts") {
      return Response.json({ carts: [responseCart] });
    }
    eventBodies.push(body.events);
    eventAttempts += 1;
    if (eventAttempts === 1) throw new TypeError("response lost");
    return Response.json({ carts: [responseCart] });
  };

  const commerce = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    fetch: fetcher,
    storage: createStorage(),
    flushDelayMs: 0,
    retryBaseMs: 0,
  });
  commerce.track("cart_updated", cart("immutable-event"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(eventBodies.length, 0);

  releaseSession();
  await waitFor(() => commerce.getSnapshot().pendingCount === 0);
  assert.equal(eventBodies.length, 2);
  assert.deepEqual(eventBodies[1], eventBodies[0]);
  assert.equal(eventBodies[0][0].eventId, "immutable-event");
  assert.equal(commerce.getSnapshot().carts[0].total, 20);
  commerce.track("cart_updated", cart("immutable-event"));
  assert.throws(
    () =>
      commerce.track("cart_updated", {
        ...cart("immutable-event"),
        items: [{ id: "sku-1", name: "One", quantity: 3, price: 10 }],
      }),
    /cannot be reused/,
  );
  assert.equal(eventBodies.length, 2);
  commerce.destroy();
});

test("commerce resets a rejected capability and retains the event identity", async () => {
  const requests = [];
  let sessions = 0;
  let eventAttempts = 0;
  const fetcher = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.action === "session") {
      sessions += 1;
      return Response.json({
        sessionToken: `session-${sessions}`,
        enabled: true,
      });
    }
    if (body.action === "carts") {
      return Response.json({ carts: [responseCart] });
    }
    eventAttempts += 1;
    if (eventAttempts === 1) {
      return Response.json({ error: "expired" }, { status: 401 });
    }
    return Response.json({ carts: [responseCart] });
  };
  const commerce = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget/",
    fetch: fetcher,
    storage: createStorage(),
    flushDelayMs: 0,
    retryBaseMs: 0,
  });
  commerce.track("cart_updated", cart("same-after-reset"));
  await waitFor(() => commerce.getSnapshot().pendingCount === 0);

  const eventRequests = requests.filter(
    (request) => request.action === "events",
  );
  const sessionRequests = requests.filter(
    (request) => request.action === "session",
  );
  assert.equal(sessionRequests.length, 2);
  assert.equal(sessionRequests[1].sessionToken, undefined);
  assert.equal(eventRequests[0].events[0].eventId, "same-after-reset");
  assert.equal(eventRequests[1].events[0].eventId, "same-after-reset");
  commerce.destroy();
});

test("commerce storage is isolated by source and duplicate IDs remain finite", async () => {
  const storage = createStorage();
  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  const fetcher = async () => {
    await gate;
    return Response.json({ sessionToken: "later", enabled: true });
  };

  const sourceA = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    fetch: fetcher,
    storage,
    flushDelayMs: 60_000,
  });
  sourceA.track("cart_updated", cart("duplicate"));
  sourceA.track("cart_updated", cart("duplicate"));
  assert.equal(sourceA.getSnapshot().pendingCount, 1);
  sourceA.destroy();

  const sourceB = new WidgetCommerce({
    clientKey: "source-b",
    apiUrl: "https://airi.example/api/widget",
    fetch: fetcher,
    storage,
    flushDelayMs: 60_000,
  });
  assert.equal(sourceB.getSnapshot().pendingCount, 0);
  sourceB.destroy();

  const restoredA = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    fetch: fetcher,
    storage,
    flushDelayMs: 60_000,
  });
  assert.equal(restoredA.getSnapshot().pendingCount, 1);
  assert.throws(
    () => restoredA.track("checkout_started", { cartId: "cart-1" }),
    /requires a full items snapshot/,
  );
  restoredA.destroy();
  releaseSession();
});

test("commerce bounds an offline queue while preserving the newest full snapshot", () => {
  const fetcher = () => new Promise(() => undefined);
  const commerce = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    fetch: fetcher,
    storage: null,
    flushDelayMs: 60_000,
  });
  for (let index = 0; index < 101; index += 1) {
    commerce.track("cart_updated", {
      ...cart(`event-${index}`),
      items: [{ id: "sku-1", name: "One", quantity: index + 1, price: 10 }],
    });
  }
  assert.equal(commerce.getSnapshot().pendingCount, 100);
  commerce.destroy();
});

test("commerce splits large batches below the public route byte bound", async () => {
  const eventRequestSizes = [];
  const fetcher = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "session") {
      return Response.json({ sessionToken: "session-1", enabled: true });
    }
    eventRequestSizes.push(new TextEncoder().encode(options.body).byteLength);
    return Response.json({ carts: [responseCart] });
  };
  const commerce = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    fetch: fetcher,
    storage: null,
    flushDelayMs: 0,
  });
  for (let index = 0; index < 20; index += 1) {
    commerce.track("cart_updated", {
      eventId: `event-${index}`,
      cartId: "cart-1",
      items: Array.from({ length: 100 }, (_, itemIndex) => ({
        id: `sku-${itemIndex}`,
        name: `Item ${itemIndex} ${"x".repeat(40)}`,
        quantity: 1,
        price: 10,
      })),
      currency: "USD",
    });
  }
  await waitFor(() => commerce.getSnapshot().pendingCount === 0);
  assert.ok(eventRequestSizes.length > 1);
  assert.ok(eventRequestSizes.every((size) => size <= 60 * 1024));
  commerce.destroy();
});

test("commerce drains Shopify pixel inbox events into its signed source queue", () => {
  const values = new Map();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const inboxKey = `${commerceStorageKey.shopifyCommerceInboxPrefix("source-a")}shopify-event-1`;
  values.set(
    inboxKey,
    JSON.stringify({
      type: "cart_updated",
      eventId: "shopify-event-1",
      cartId: "shopify-cart-1",
      occurredAt: new Date().toISOString(),
      items: [{ id: "123", name: "Green shirt", quantity: 1, price: 29.5 }],
      currency: "USD",
      recoveryUrl: "https://shop.example/cart/123:1?storefront=true",
    }),
  );
  const commerce = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    fetch: () => new Promise(() => undefined),
    storage,
    flushDelayMs: 60_000,
    externalInboxPollMs: 60_000,
  });

  assert.equal(commerce.getSnapshot().pendingCount, 1);
  assert.equal(values.has(inboxKey), false);
  commerce.destroy();
});

test("commerce refreshes linked carts with one throttled in-flight request", async () => {
  let releaseCarts;
  const cartsGate = new Promise((resolve) => {
    releaseCarts = resolve;
  });
  let cartsRequests = 0;
  const commerce = new WidgetCommerce({
    clientKey: "source-a",
    apiUrl: "https://airi.example/api/widget",
    storage: null,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.action === "session") {
        return Response.json({ sessionToken: "session-1", enabled: true });
      }
      if (body.action === "carts") {
        cartsRequests += 1;
        await cartsGate;
        return Response.json({ carts: [{ ...responseCart, linked: true }] });
      }
      return Response.json({ carts: [] });
    },
  });
  await waitFor(() => cartsRequests === 1);
  void commerce.refreshCarts();
  void commerce.refreshCarts();
  assert.equal(cartsRequests, 1);
  releaseCarts();
  await waitFor(() => commerce.getSnapshot().carts[0]?.linked === true);
  await commerce.refreshCarts();
  assert.equal(cartsRequests, 1);
  commerce.destroy();
});
