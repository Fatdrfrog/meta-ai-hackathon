import type { CommerceTrackingInput } from "@icecore/shared/types/commerce-tracking";
import type { WidgetCommerce } from "./commerce";

type TildaOrderForm = HTMLFormElement & {
  tildaOrderId?: string;
  tildaTranId?: string;
};

export type TildaCommerceAdapterOptions = {
  commerce: Pick<WidgetCommerce, "track">;
  forms: Iterable<HTMLFormElement>;
  getCartSnapshot: (
    form?: HTMLFormElement,
  ) => Pick<
    CommerceTrackingInput,
    "cartId" | "items" | "currency" | "recoveryUrl" | "checkoutId"
  >;
  cartEventTarget?: EventTarget;
  cartEventName?: string;
  onError?: (error: Error) => void;
};

/**
 * Uses Tilda's documented `tildaform:aftersuccess` callback for order placement.
 * Cart changes come from an explicit merchant event carrying a full snapshot;
 * Tilda does not document a stable public cart-state callback.
 */
export function installTildaCommerceAdapter(
  options: TildaCommerceAdapterOptions,
): { trackCartSnapshot: (eventId?: string) => string; destroy: () => void } {
  const forms = Array.from(options.forms);
  const target = options.cartEventTarget;
  const cartEventName = options.cartEventName || "airi:tilda-cart-updated";

  const fail = (error: unknown) =>
    options.onError?.(
      error instanceof Error
        ? error
        : new Error("Invalid Tilda commerce event"),
    );

  const trackCartSnapshot = (eventId?: string) => {
    const snapshot = options.getCartSnapshot();
    return options.commerce.track("cart_updated", {
      ...snapshot,
      ...(eventId ? { eventId } : {}),
    });
  };

  const onCartUpdated = (event: Event) => {
    try {
      const detail = (event as CustomEvent<{ eventId?: string }>).detail;
      trackCartSnapshot(detail?.eventId);
    } catch (error) {
      fail(error);
    }
  };

  const onAfterSuccess = (event: Event) => {
    try {
      const form = (event.currentTarget || event.target) as TildaOrderForm;
      const snapshot = options.getCartSnapshot(form);
      const orderId = form.tildaOrderId?.trim();
      const transactionId = form.tildaTranId?.trim();
      options.commerce.track("order_placed", {
        ...snapshot,
        ...(orderId ? { orderId } : {}),
        ...(orderId || transactionId
          ? { eventId: `tilda:${orderId || transactionId}:order_placed` }
          : {}),
      });
    } catch (error) {
      fail(error);
    }
  };

  for (const form of forms) {
    form.addEventListener("tildaform:aftersuccess", onAfterSuccess);
  }
  target?.addEventListener(cartEventName, onCartUpdated);

  return {
    trackCartSnapshot,
    destroy: () => {
      for (const form of forms) {
        form.removeEventListener("tildaform:aftersuccess", onAfterSuccess);
      }
      target?.removeEventListener(cartEventName, onCartUpdated);
    },
  };
}
