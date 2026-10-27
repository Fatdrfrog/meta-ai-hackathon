import { createHash } from "node:crypto";
import type { CommerceTrackingEvent } from "@icecore/shared/types/commerce-tracking";
import type { WebsiteCartRow } from "@/models/website-cart";
import { validateDomain } from "@/lib/widget/domain-validator";

export class WebsiteCartError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}
export const ACTIVE_CART_STATES = ["cart", "checkout"];
export function cartEventHash(event: CommerceTrackingEvent) {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}
export function validateRecoveryUrl(
  value: string | undefined,
  allowedDomains: string[]
) {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebsiteCartError("Invalid cart recovery URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !validateDomain(url.origin, allowedDomains)
  )
    throw new WebsiteCartError(
      "Cart recovery URL must belong to the storefront"
    );
  return url.toString();
}

/** Pure ordered reduction; terminal carts cannot be resurrected by late browser requests. */
export function reduceWebsiteCart(
  current: WebsiteCartRow | null,
  event: CommerceTrackingEvent
) {
  const hash = cartEventHash(event);
  const seen = current?.recentEvents.find(item => item.id === event.eventId);
  if (seen) {
    if (seen.hash !== hash)
      throw new WebsiteCartError("Event ID already has different facts", 409);
    return null;
  }
  const at = new Date(event.occurredAt);
  const terminal =
    event.type === "order_placed" ||
    event.type === "purchase_reported" ||
    event.type === "checkout_closed";
  if (current && !terminal && at < new Date(current.eventAt)) return null;
  const restartingEmptyCart =
    current?.status === "closed" &&
    !current.items.length &&
    !terminal &&
    event.items?.length &&
    at > new Date(current.eventAt);
  if (
    current &&
    !ACTIVE_CART_STATES.includes(current.status) &&
    !restartingEmptyCart
  )
    return null;
  const items = event.items || current?.items || [];
  const status: WebsiteCartRow["status"] =
    event.type === "order_placed"
      ? "ordered"
      : event.type === "purchase_reported"
        ? "purchase_reported"
        : event.type === "checkout_closed" || !items.length
          ? "closed"
          : event.type === "checkout_started" || current?.status === "checkout"
            ? "checkout"
            : "cart";
  const currency = event.currency || current?.currency || "KZT";
  const total =
    Math.round(
      items.reduce((sum, item) => sum + item.quantity * item.price, 0) * 100
    ) / 100;
  const changed =
    !current ||
    event.type === "checkout_started" ||
    status !== current.status ||
    currency !== current.currency ||
    JSON.stringify(items) !== JSON.stringify(current.items) ||
    (event.recoveryUrl && event.recoveryUrl !== current.recoveryUrl) ||
    (event.checkoutId && event.checkoutId !== current.checkoutId);
  return {
    items,
    status,
    currency,
    total,
    ...(event.recoveryUrl ? { recoveryUrl: event.recoveryUrl } : {}),
    ...(event.checkoutId ? { checkoutId: event.checkoutId } : {}),
    ...(event.orderId ? { orderId: event.orderId } : {}),
    eventAt: current && at < new Date(current.eventAt) ? current.eventAt : at,
    eventId: event.eventId,
    eventHash: hash,
    expiresAt: new Date(at.getTime() + 90 * 86400_000),
    recentEvents: [
      ...(current?.recentEvents || []).slice(-63),
      { id: event.eventId, hash },
    ],
    activityAt: changed && !terminal ? at : current?.activityAt || at,
    version: (current?.version || 0) + (changed ? 1 : 0),
    ...(changed ? { admissionPending: true, nextAdmissionAt: new Date() } : {}),
  };
}
export function publicCart(cart: WebsiteCartRow) {
  return {
    cartId: cart.cartId,
    status: cart.status,
    itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    total: cart.total,
    currency: cart.currency,
    recoveryUrl: cart.recoveryUrl,
    linked: Boolean(cart.conversationId && cart.consentAt),
  };
}
