import type {
  CommerceTrackingInput,
  CommerceTrackingItem,
  CommerceTrackingEventType,
} from "@icecore/shared/types/commerce-tracking";
import type { WidgetCommerce } from "./commerce";
import {
  shopifyCartIdentityKey,
  shopifyCommerceInboxPrefix,
  widgetCommerceStorageKey,
} from "./commerce-storage-key";
import { normalizeCommerceTrackingEvent } from "@icecore/shared/types/commerce-tracking";

type ShopifyRecord = Record<string, unknown>;
type ShopifyEvent = {
  id?: string;
  name?: string;
  timestamp?: string;
  data?: ShopifyRecord;
  customData?: ShopifyRecord;
};

type ShopifyAnalytics = {
  subscribe: (name: string, listener: (event: ShopifyEvent) => void) => void;
};

type ShopifyBrowserStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<unknown>;
  removeItem: (key: string) => Promise<void>;
  key: (index: number) => Promise<string | null>;
  length: () => Promise<number>;
};

const MAX_SHOPIFY_INBOX_EVENTS = 100;
const SHOPIFY_CART_EVENT = "airi:cart_snapshot";
const DEFAULT_PIXEL_REQUEST_TIMEOUT_MS = 10_000;

export type ShopifyCommerceAdapterOptions = {
  analytics: ShopifyAnalytics;
  init: { data?: { cart?: unknown } };
  commerce: Pick<WidgetCommerce, "track">;
  recoveryUrl?: (
    cart: ShopifyRecord,
    event: ShopifyEvent,
  ) => string | undefined;
  getCartSnapshot?: (event: ShopifyEvent) => unknown | Promise<unknown>;
  initialCartId?: string;
  initialRecoveryUrl?: string;
  persistCartIdentity?: (
    cartId?: string,
    recoveryUrl?: string,
  ) => void | Promise<void>;
  onError?: (error: Error, event: ShopifyEvent) => void;
};

export type ShopifyPixelCommerceAdapterOptions = Omit<
  ShopifyCommerceAdapterOptions,
  "commerce" | "getCartSnapshot" | "recoveryUrl"
> & {
  browser: { localStorage: ShopifyBrowserStorage };
  clientKey: string;
  storefrontOrigin: string;
  apiUrl: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
};

export type ShopifyCommerceAdapterDisposer = (() => void) & {
  flush: () => Promise<void>;
};

function record(value: unknown): ShopifyRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ShopifyRecord)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return text(value);
}

function money(value: unknown): { amount: number; currency: string } | null {
  const candidate = record(value);
  const amount = finite(candidate?.amount);
  const currency = text(candidate?.currencyCode)?.toUpperCase();
  return amount === undefined || !currency ? null : { amount, currency };
}

function normalizeLine(value: unknown, index: number): CommerceTrackingItem {
  const line = record(value);
  const merchandise = record(line?.merchandise) || record(line?.variant);
  const product = record(merchandise?.product);
  const quantity = finite(line?.quantity);
  const total =
    money(record(line?.cost)?.totalAmount) || money(line?.finalLinePrice);
  const variantPrice = money(merchandise?.price) || money(line?.price);
  const id = text(merchandise?.id) || text(line?.id) || text(merchandise?.sku);
  const name =
    text(line?.title) || text(merchandise?.title) || text(product?.title);
  const price =
    variantPrice?.amount ??
    (total && quantity && quantity > 0 ? total.amount / quantity : undefined);
  if (!id || !name || quantity === undefined || price === undefined) {
    throw new Error(`Shopify line ${index} is incomplete`);
  }
  return { id, name, quantity, price };
}

function normalizeAjaxCart(cartValue: unknown): {
  cart: ShopifyRecord;
  cartId: string;
  items: CommerceTrackingItem[];
  currency: string;
} {
  const cart = record(cartValue);
  const cartId = text(cart?.token);
  const currency = text(cart?.currency)?.toUpperCase();
  if (!cart || !cartId || !currency || !Array.isArray(cart.items)) {
    throw new Error("Shopify Ajax cart snapshot is incomplete");
  }
  const items = cart.items.map((value, index) => {
    const line = record(value);
    const id = identifier(line?.variant_id) || identifier(line?.id);
    const name = text(line?.product_title) || text(line?.title);
    const quantity = finite(line?.quantity);
    const priceInMinorUnits = finite(line?.final_price) ?? finite(line?.price);
    if (
      !id ||
      !name ||
      quantity === undefined ||
      priceInMinorUnits === undefined
    ) {
      throw new Error(`Shopify Ajax cart item ${index} is incomplete`);
    }
    return { id, name, quantity, price: priceInMinorUnits / 100 };
  });
  return { cart, cartId, items, currency };
}

function variantId(value: unknown): string {
  const id = identifier(value);
  const numericId = id?.match(/(?:^|\/)(\d+)$/)?.[1];
  if (!numericId)
    throw new Error("Shopify cart item requires a numeric variant ID");
  return numericId;
}

/** Builds Shopify's documented variant/quantity cart permalink. */
export function createShopifyCartPermalink(
  cartValue: unknown,
  storefrontOrigin: string,
): string {
  const cart = record(cartValue);
  const lines = Array.isArray(cart?.items)
    ? cart.items
    : Array.isArray(cart?.lines)
      ? cart.lines
      : null;
  if (!lines || lines.length === 0) {
    throw new Error(
      "Shopify recovery permalink requires at least one cart item",
    );
  }
  const origin = new URL(storefrontOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password) {
    throw new Error("Shopify storefront origin must be HTTPS");
  }
  const path = lines
    .map((value, index) => {
      const line = record(value);
      const merchandise = record(line?.merchandise) || record(line?.variant);
      const quantity = finite(line?.quantity);
      if (!Number.isSafeInteger(quantity) || !quantity || quantity < 1) {
        throw new Error(`Shopify cart item ${index} has an invalid quantity`);
      }
      return `${variantId(line?.variant_id ?? merchandise?.id ?? line?.id)}:${quantity}`;
    })
    .join(",");
  return new URL(`/cart/${path}?storefront=true`, origin).toString();
}

function normalizeCart(cartValue: unknown): {
  cart: ShopifyRecord;
  cartId: string;
  items: CommerceTrackingItem[];
  currency: string;
} {
  const cart = record(cartValue);
  const cartId = text(cart?.id);
  const lines = cart?.lines;
  const total = money(record(cart?.cost)?.totalAmount);
  if (!cart || !cartId || !Array.isArray(lines) || !total) {
    throw new Error("Shopify cart snapshot is incomplete");
  }
  return {
    cart,
    cartId,
    items: lines.map(normalizeLine),
    currency: total.currency,
  };
}

function normalizeCheckout(checkoutValue: unknown): {
  checkout: ShopifyRecord;
  checkoutId: string;
  items: CommerceTrackingItem[];
  currency: string;
  orderId?: string;
} {
  const checkout = record(checkoutValue);
  const checkoutId = text(checkout?.token);
  const lines = checkout?.lineItems;
  const total = money(checkout?.totalPrice);
  const currency =
    text(checkout?.currencyCode)?.toUpperCase() || total?.currency;
  if (!checkout || !checkoutId || !Array.isArray(lines) || !currency) {
    throw new Error("Shopify checkout snapshot is incomplete");
  }
  return {
    checkout,
    checkoutId,
    items: lines.map(normalizeLine),
    currency,
    ...(text(record(checkout.order)?.id)
      ? { orderId: text(record(checkout.order)?.id) }
      : {}),
  };
}

/**
 * Maps Shopify's documented Web Pixels standard events without reading storefront DOM.
 * The adapter deliberately reports checkout completion as browser suppression only.
 */
export function installShopifyCommerceAdapter(
  options: ShopifyCommerceAdapterOptions,
): ShopifyCommerceAdapterDisposer {
  let active = true;
  let latestCart = record(options.init.data?.cart);
  let latestCartId = text(latestCart?.id) || options.initialCartId;
  let latestRecoveryUrl = options.initialRecoveryUrl;
  let chain = Promise.resolve();

  const enqueue = (event: ShopifyEvent, task: () => void | Promise<void>) => {
    chain = chain
      .then(async () => {
        if (active) await task();
      })
      .catch((error) => {
        options.onError?.(
          error instanceof Error
            ? error
            : new Error("Invalid Shopify commerce event"),
          event,
        );
      });
  };

  const report = (
    event: ShopifyEvent,
    type: CommerceTrackingEventType,
    payload: CommerceTrackingInput,
  ) => {
    if (!active) return;
    options.commerce.track(type, {
      ...payload,
      ...(event.id ? { eventId: event.id } : {}),
      ...(event.timestamp ? { occurredAt: event.timestamp } : {}),
    });
  };

  if (latestCart) {
    enqueue({ name: "init" }, () => {
      const snapshot = normalizeCart(latestCart);
      latestCart = snapshot.cart;
      latestCartId = snapshot.cartId;
      const recoveryUrl = options.recoveryUrl?.(snapshot.cart, {
        name: "init",
      });
      latestRecoveryUrl = recoveryUrl;
      void options.persistCartIdentity?.(latestCartId, recoveryUrl);
      options.commerce.track("cart_updated", {
        cartId: snapshot.cartId,
        items: snapshot.items,
        currency: snapshot.currency,
        ...(recoveryUrl ? { recoveryUrl } : {}),
      });
    });
  }

  options.analytics.subscribe("cart_viewed", (event) => {
    enqueue(event, () => {
      const snapshot = normalizeCart(event.data?.cart);
      latestCart = snapshot.cart;
      latestCartId = snapshot.cartId;
      const recoveryUrl = options.recoveryUrl?.(snapshot.cart, event);
      latestRecoveryUrl = recoveryUrl;
      void options.persistCartIdentity?.(latestCartId, recoveryUrl);
      report(event, "cart_updated", {
        cartId: snapshot.cartId,
        items: snapshot.items,
        currency: snapshot.currency,
        ...(recoveryUrl ? { recoveryUrl } : {}),
      });
    });
  });

  options.analytics.subscribe(SHOPIFY_CART_EVENT, (event) => {
    enqueue(event, () => {
      const snapshot = normalizeAjaxCart(event.customData?.cart);
      latestCart = snapshot.cart;
      latestCartId = snapshot.cartId;
      const recoveryUrl = options.recoveryUrl?.(snapshot.cart, event);
      latestRecoveryUrl = recoveryUrl;
      void options.persistCartIdentity?.(latestCartId, recoveryUrl);
      report(event, "cart_updated", {
        cartId: snapshot.cartId,
        items: snapshot.items,
        currency: snapshot.currency,
        ...(recoveryUrl ? { recoveryUrl } : {}),
      });
    });
  });

  const subscribeToCartChange = (
    eventName: "product_added_to_cart" | "product_removed_from_cart",
  ) => {
    options.analytics.subscribe(eventName, (event) => {
      enqueue(event, async () => {
        if (!options.getCartSnapshot) {
          throw new Error(
            "Shopify add/remove events require a full cart snapshot resolver",
          );
        }
        latestCart = record(await options.getCartSnapshot(event));
        const snapshot = normalizeCart(latestCart);
        latestCartId = snapshot.cartId;
        const recoveryUrl = options.recoveryUrl?.(snapshot.cart, event);
        latestRecoveryUrl = recoveryUrl;
        void options.persistCartIdentity?.(latestCartId, recoveryUrl);
        report(event, "cart_updated", {
          cartId: snapshot.cartId,
          items: snapshot.items,
          currency: snapshot.currency,
          ...(recoveryUrl ? { recoveryUrl } : {}),
        });
      });
    });
  };
  if (options.getCartSnapshot) {
    subscribeToCartChange("product_added_to_cart");
    subscribeToCartChange("product_removed_from_cart");
  }

  const checkoutEvents = [
    "checkout_started",
    "checkout_contact_info_submitted",
    "checkout_address_info_submitted",
    "checkout_shipping_info_submitted",
    "payment_info_submitted",
  ];
  for (const eventName of checkoutEvents) {
    options.analytics.subscribe(eventName, (event) => {
      enqueue(event, () => {
        const snapshot = normalizeCheckout(event.data?.checkout);
        const cartId = latestCartId || snapshot.checkoutId;
        report(event, "checkout_started", {
          cartId,
          checkoutId: snapshot.checkoutId,
          items: snapshot.items,
          currency: snapshot.currency,
          ...(latestRecoveryUrl ? { recoveryUrl: latestRecoveryUrl } : {}),
        });
      });
    });
  }

  options.analytics.subscribe("checkout_completed", (event) => {
    enqueue(event, () => {
      const snapshot = normalizeCheckout(event.data?.checkout);
      const completedCartId = latestCartId || snapshot.checkoutId;
      report(event, "purchase_reported", {
        cartId: completedCartId,
        checkoutId: snapshot.checkoutId,
        orderId: snapshot.orderId,
        items: snapshot.items,
        currency: snapshot.currency,
      });
      latestCart = null;
      latestCartId = undefined;
      latestRecoveryUrl = undefined;
      void options.persistCartIdentity?.();
    });
  });

  const dispose = () => {
    active = false;
  };
  dispose.flush = async () => {
    await chain;
  };
  return dispose;
}

function randomEventId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `shopify:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/**
 * Writes normalized pixel events into top-frame storage. WidgetCommerce drains
 * this inbox and sends them with its own signed, source-scoped session.
 */
export function createShopifyPixelCommerceBridge(options: {
  browser: { localStorage: ShopifyBrowserStorage };
  clientKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
  onError?: (error: Error, event?: ShopifyEvent) => void;
}): Pick<WidgetCommerce, "track"> & {
  flush: () => Promise<void>;
  destroy: () => void;
} {
  if (!options.clientKey.trim())
    throw new Error("Shopify pixel requires clientKey");
  const pending: Array<{ key: string; value: string }> = [];
  const prefix = shopifyCommerceInboxPrefix(options.clientKey);
  const endpoint = options.apiUrl
    ? `${options.apiUrl.replace(/\/$/, "")}/commerce`
    : undefined;
  let active = true;
  let chain = Promise.resolve();
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let requestAbort: AbortController | null = null;
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? DEFAULT_PIXEL_REQUEST_TIMEOUT_MS,
  );

  const send = async (body: string): Promise<Response> => {
    const controller =
      typeof AbortController === "undefined" ? null : new AbortController();
    requestAbort = controller;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        (options.fetch || fetch)(endpoint!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          ...(controller ? { signal: controller.signal } : {}),
          body,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller?.abort();
            reject(new Error("Shopify commerce event send timed out"));
          }, requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (requestAbort === controller) requestAbort = null;
    }
  };

  const writePending = async () => {
    while (active && pending.length > 0) {
      const entry = pending[0];
      const count = await options.browser.localStorage.length();
      let sourceCount = 0;
      for (let index = 0; index < count; index += 1) {
        if (
          (await options.browser.localStorage.key(index))?.startsWith(prefix)
        ) {
          sourceCount += 1;
        }
      }
      const existing = await options.browser.localStorage.getItem(entry.key);
      if (existing !== null && existing !== entry.value) {
        throw new Error("eventId cannot be reused for different commerce data");
      }
      if (existing === null && sourceCount >= MAX_SHOPIFY_INBOX_EVENTS) {
        throw new Error("Shopify commerce inbox is full");
      }
      await options.browser.localStorage.setItem(entry.key, entry.value);
      if (endpoint) {
        const rawSession = await options.browser.localStorage.getItem(
          widgetCommerceStorageKey(options.clientKey),
        );
        const state = rawSession ? JSON.parse(rawSession) : null;
        if (
          state?.clientKey === options.clientKey &&
          typeof state.sessionToken === "string" &&
          state.sessionToken
        ) {
          const response = await send(
            JSON.stringify({
              action: "events",
              clientKey: options.clientKey,
              sessionToken: state.sessionToken,
              events: [JSON.parse(entry.value)],
            }),
          );
          if (!response.ok)
            throw new Error("Shopify commerce event send failed");
          await options.browser.localStorage.removeItem(entry.key);
        }
      }
      pending.shift();
      retryAttempt = 0;
    }
  };

  const schedule = () => {
    chain = chain.then(writePending).catch((error) => {
      options.onError?.(
        error instanceof Error
          ? error
          : new Error("Shopify event bridge failed"),
      );
      if (active && pending.length > 0 && retryAttempt < 6 && !retryTimer) {
        const delay = Math.min(
          30_000,
          (options.retryBaseMs ?? 1_000) * 2 ** retryAttempt,
        );
        retryAttempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          schedule();
        }, delay);
      }
    });
  };

  return {
    track: (type, payload) => {
      if (!active) throw new Error("Shopify pixel bridge has been destroyed");
      if (pending.length >= MAX_SHOPIFY_INBOX_EVENTS) {
        throw new Error("Shopify commerce inbox is full");
      }
      const normalized = normalizeCommerceTrackingEvent({
        ...payload,
        type,
        eventId: payload.eventId || randomEventId(),
        occurredAt: payload.occurredAt || new Date().toISOString(),
      });
      pending.push({
        key: `${prefix}${encodeURIComponent(normalized.eventId)}`,
        value: JSON.stringify(normalized),
      });
      schedule();
      return normalized.eventId;
    },
    flush: async () => {
      schedule();
      await chain;
    },
    destroy: () => {
      active = false;
      requestAbort?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      pending.length = 0;
    },
  };
}

export async function installShopifyPixelCommerceAdapter(
  options: ShopifyPixelCommerceAdapterOptions,
): Promise<{ flush: () => Promise<void>; destroy: () => void }> {
  const bridge = createShopifyPixelCommerceBridge(options);
  const identityKey = shopifyCartIdentityKey(options.clientKey);
  const storedIdentity =
    await options.browser.localStorage.getItem(identityKey);
  let identity: { cartId?: string; recoveryUrl?: string } = {};
  try {
    identity = storedIdentity ? JSON.parse(storedIdentity) : {};
  } catch {
    identity = {};
  }
  const stop = installShopifyCommerceAdapter({
    analytics: options.analytics,
    init: options.init,
    commerce: bridge,
    ...(typeof identity.cartId === "string"
      ? { initialCartId: identity.cartId }
      : {}),
    ...(typeof identity.recoveryUrl === "string"
      ? { initialRecoveryUrl: identity.recoveryUrl }
      : {}),
    persistCartIdentity: (cartId, recoveryUrl) =>
      cartId
        ? options.browser.localStorage.setItem(
            identityKey,
            JSON.stringify({ cartId, recoveryUrl }),
          )
        : options.browser.localStorage.removeItem(identityKey),
    recoveryUrl: (cart) =>
      createShopifyCartPermalink(cart, options.storefrontOrigin),
    onError: options.onError,
  });
  return {
    flush: async () => {
      await stop.flush();
      await bridge.flush();
    },
    destroy: () => {
      stop();
      bridge.destroy();
    },
  };
}

export type ShopifyStorefrontBridgeOptions = {
  analytics: { publish: (name: string, data: ShopifyRecord) => unknown };
  cartJsonUrl: string;
  fetch?: typeof fetch;
  onError?: (error: Error) => void;
};

/**
 * Publishes full Shopify Ajax Cart snapshots after documented mutation routes.
 * Themes using XMLHttpRequest can call publishCart() from their success hook.
 */
export function installShopifyStorefrontBridge(
  options: ShopifyStorefrontBridgeOptions,
): { publishCart: () => Promise<void>; destroy: () => void } {
  const originalFetch = globalThis.fetch;
  const storefrontFetch = options.fetch || originalFetch.bind(globalThis);
  const cartUrl = new URL(options.cartJsonUrl, globalThis.location?.href);
  const mutationPattern = /\/cart\/(?:add|change|update|clear)\.js$/;
  let publishChain = Promise.resolve();

  const reportError = (error: unknown) =>
    options.onError?.(
      error instanceof Error
        ? error
        : new Error("Shopify cart snapshot publish failed"),
    );

  const publishCart = async () => {
    const response = await storefrontFetch(cartUrl, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Failed to read Shopify cart snapshot");
    const cart = await response.json();
    if (!record(cart)) {
      throw new Error("Shopify cart endpoint returned invalid data");
    }
    await options.analytics.publish(SHOPIFY_CART_EVENT, { cart });
  };

  const patchedFetch: typeof fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    try {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
        globalThis.location?.href,
      );
      if (response.ok && mutationPattern.test(requestUrl.pathname)) {
        publishChain = publishChain.then(publishCart).catch(reportError);
      }
    } catch {
      // The request does not target a parseable Shopify Ajax Cart URL.
    }
    return response;
  };

  if (options.fetch === undefined) globalThis.fetch = patchedFetch;
  void publishCart().catch(reportError);

  return {
    publishCart,
    destroy: () => {
      if (options.fetch === undefined && globalThis.fetch === patchedFetch) {
        globalThis.fetch = originalFetch;
      }
    },
  };
}
