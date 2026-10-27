import type {
  CommerceTrackingInput,
  CommerceTrackingItem,
} from "@icecore/shared/types/commerce-tracking";
import type { WidgetCommerce } from "./commerce";

type DataLayerEntry = Record<string, unknown>;
type CommerceTrackTarget = Pick<WidgetCommerce, "track">;

export type GtmCartSnapshot = Pick<
  CommerceTrackingInput,
  "cartId" | "items" | "currency" | "recoveryUrl" | "checkoutId"
>;

export type GtmCommerceAdapterOptions = {
  commerce: CommerceTrackTarget;
  dataLayer?: unknown[] & { push: (...entries: unknown[]) => number };
  getCartSnapshot?: (
    entry: DataLayerEntry,
  ) => GtmCartSnapshot | Promise<GtmCartSnapshot>;
  processExisting?: boolean;
  onError?: (error: Error, entry: DataLayerEntry) => void;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Converts a GA4 ecommerce payload only when it contains a full cart snapshot. */
export function normalizeGtmCartSnapshot(
  entry: DataLayerEntry,
): GtmCartSnapshot {
  const ecommerce = record(entry.ecommerce);
  if (!ecommerce) throw new Error("GTM ecommerce payload is required");
  const airi = record(entry.airi);
  const cartId =
    text(airi?.cartId) ||
    text(entry.airi_cart_id) ||
    text(ecommerce.cart_id) ||
    text(ecommerce.cartId);
  if (!cartId) throw new Error("GTM cart snapshot requires airi.cartId");
  if (!Array.isArray(ecommerce.items)) {
    throw new Error(
      "GTM cart snapshot requires the full ecommerce.items array",
    );
  }

  const currency = (
    text(ecommerce.currency) ||
    text(airi?.currency) ||
    ""
  ).toUpperCase();
  if (!currency)
    throw new Error("GTM cart snapshot requires ecommerce.currency");

  const items: CommerceTrackingItem[] = ecommerce.items.map((value, index) => {
    const item = record(value);
    if (!item)
      throw new Error(`GTM ecommerce.items[${index}] must be an object`);
    const itemCurrency = text(item.currency)?.toUpperCase();
    if (itemCurrency && itemCurrency !== currency) {
      throw new Error("GTM cart snapshot cannot mix currencies");
    }
    const id = text(item.item_id) || text(item.id) || text(item.sku);
    const name = text(item.item_name) || text(item.name);
    const price = number(item.price);
    const quantity = number(item.quantity) ?? 1;
    if (!id || !name || price === undefined) {
      throw new Error(`GTM ecommerce.items[${index}] is incomplete`);
    }
    return { id, name, price, quantity };
  });

  return {
    cartId,
    items,
    currency,
    ...(text(airi?.recoveryUrl) || text(entry.airi_recovery_url)
      ? {
          recoveryUrl: text(airi?.recoveryUrl) || text(entry.airi_recovery_url),
        }
      : {}),
    ...(text(airi?.checkoutId) || text(ecommerce.checkout_id)
      ? { checkoutId: text(airi?.checkoutId) || text(ecommerce.checkout_id) }
      : {}),
  };
}

export function installGtmCommerceAdapter(
  options: GtmCommerceAdapterOptions,
): () => void {
  const dataLayer =
    options.dataLayer ||
    ((globalThis as { dataLayer?: GtmCommerceAdapterOptions["dataLayer"] })
      .dataLayer as GtmCommerceAdapterOptions["dataLayer"]);
  if (!dataLayer || typeof dataLayer.push !== "function") {
    throw new Error("GTM dataLayer is not available");
  }

  const getSnapshot = options.getCartSnapshot || normalizeGtmCartSnapshot;
  const originalPush = dataLayer.push;
  let active = true;
  let chain = Promise.resolve();

  const handle = (value: unknown) => {
    const entry = record(value);
    if (!entry || typeof entry.event !== "string") return;
    const mapping = {
      add_to_cart: "cart_updated",
      remove_from_cart: "cart_updated",
      view_cart: "cart_updated",
      begin_checkout: "checkout_started",
      checkout_closed: "checkout_closed",
      purchase: "purchase_reported",
    } as const;
    const type = mapping[entry.event as keyof typeof mapping];
    if (!type) return;

    chain = chain.then(async () => {
      if (!active) return;
      try {
        const snapshot = await getSnapshot(entry);
        const ecommerce = record(entry.ecommerce);
        options.commerce.track(type, {
          ...snapshot,
          ...(text(entry.event_id) || text(ecommerce?.event_id)
            ? { eventId: text(entry.event_id) || text(ecommerce?.event_id) }
            : {}),
          ...(text(entry.event_time)
            ? { occurredAt: text(entry.event_time) }
            : {}),
          ...(type === "purchase_reported" && text(ecommerce?.transaction_id)
            ? { orderId: text(ecommerce?.transaction_id) }
            : {}),
        });
      } catch (error) {
        options.onError?.(
          error instanceof Error
            ? error
            : new Error("Invalid GTM commerce event"),
          entry,
        );
      }
    });
  };

  const patchedPush = function (this: unknown[], ...entries: unknown[]) {
    const result = originalPush.apply(this, entries);
    for (const entry of entries) handle(entry);
    return result;
  };
  dataLayer.push = patchedPush;
  if (options.processExisting) {
    for (const entry of dataLayer) handle(entry);
  }

  return () => {
    active = false;
    if (dataLayer.push === patchedPush) dataLayer.push = originalPush;
  };
}
