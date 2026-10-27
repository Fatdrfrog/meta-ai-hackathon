import { createHmac, timingSafeEqual } from "node:crypto";
import WebsiteCart, { type WebsiteCartRow } from "@/models/website-cart";
import CustomerEvent from "@/models/customer-event";
import WebsiteCommerceEvent from "@/models/website-commerce-event";
import {
  ACTIVE_CART_STATES,
  validateRecoveryUrl,
  WebsiteCartError,
} from "./cart-state";
import {
  resolveWebsiteCommerceContext,
  WebsiteCommerceIntegrationError,
} from "./integrations";
import type { BehaviorRun } from "@/lib/scenarios/behavior-runs";

export async function loadRunWebsiteCart(run: BehaviorRun) {
  if (!run.referenceId.startsWith("website-cart:")) return null;
  const event = await CustomerEvent.findOne({
    _id: run.eventId,
    workspaceId: run.workspaceId,
  })
    .select("payload.behavior")
    .lean<{
      payload?: {
        behavior?: { websiteCartId?: string; websiteCartVersion?: number };
      };
    }>();
  const behavior = event?.payload?.behavior;
  if (!behavior?.websiteCartId)
    throw new Error("Website cart authority missing");
  const cart = await WebsiteCart.findOne({
    _id: behavior.websiteCartId,
    workspaceId: run.workspaceId,
    conversationId: run.conversationId,
    customerId: run.customerId,
    whatsappSourceId: run.sourceId,
  }).lean<WebsiteCartRow>();
  return { cart, version: behavior.websiteCartVersion };
}
export async function websiteCartBlockReason(
  run: BehaviorRun
): Promise<string | null> {
  const resolved = await loadRunWebsiteCart(run);
  if (!resolved) return null;
  const { cart, version } = resolved;
  if (
    !cart ||
    new Date(cart.expiresAt) <= new Date() ||
    !ACTIVE_CART_STATES.includes(cart.status) ||
    !cart.items.length ||
    !cart.consentAt
  )
    return "event_superseded";
  if (cart.version !== version) return "event_superseded";
  try {
    const context = await resolveWebsiteCommerceContext(cart.widgetSourceId);
    if (context.whatsappSource.id !== run.sourceId)
      return "source_or_customer_changed";
    if (!cart.recoveryUrl) return "cart_recovery_unavailable";
    validateRecoveryUrl(
      cart.recoveryUrl,
      context.widgetSource.credentials.allowed_domains
    );
  } catch (error) {
    if (
      error instanceof WebsiteCommerceIntegrationError &&
      error.status !== 503
    )
      return "source_or_customer_changed";
    if (error instanceof WebsiteCartError) return "cart_recovery_unavailable";
    throw error;
  }
  // A received store completion suppresses reminders even before its ledger projection finishes.
  const terminal = await WebsiteCommerceEvent.exists({
    widgetSourceId: cart.widgetSourceId,
    workspaceId: cart.workspaceId,
    type: { $in: ["order_placed", "checkout_closed", "purchase"] },
    $or: [
      { cartId: cart.cartId },
      ...(cart.checkoutId ? [{ checkoutId: cart.checkoutId }] : []),
    ],
  });
  return terminal ? "converted" : null;
}

function recoverySignature(value: string) {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("Cart recovery signing unavailable");
  return createHmac("sha256", secret)
    .update(`website-cart-recovery:${value}`)
    .digest("hex");
}
export function createCartRecoveryToken(cartId: string, now = Date.now()) {
  const value = `${cartId}.${Math.floor(now / 1000) + 7 * 86400}`;
  return `${value}.${recoverySignature(value)}`;
}
export function readCartRecoveryToken(
  token: string,
  now = Date.now()
): string | null {
  const match = token.match(/^([a-f0-9]{24})\.(\d{10})\.([a-f0-9]{64})$/);
  if (!match || Number(match[2]) < now / 1000) return null;
  const expected = Buffer.from(
    recoverySignature(`${match[1]}.${match[2]}`),
    "hex"
  );
  return timingSafeEqual(expected, Buffer.from(match[3], "hex"))
    ? match[1]
    : null;
}
export async function websiteCartTemplateValues(
  run: BehaviorRun
): Promise<Record<string, string>> {
  const resolved = await loadRunWebsiteCart(run);
  if (!resolved) return {};
  if (!resolved.cart || resolved.cart.version !== resolved.version)
    throw new Error("Cart revision changed");
  const cart = resolved.cart;
  const context = await resolveWebsiteCommerceContext(cart.widgetSourceId);
  validateRecoveryUrl(
    cart.recoveryUrl,
    context.widgetSource.credentials.allowed_domains
  );
  const token = createCartRecoveryToken(String(cart._id));
  return {
    "cart.recovery_token": token,
    "cart.recovery_url": `https://www.airi.chat/r/cart/${token}`,
    "cart.total": cart.total.toFixed(2),
    "cart.currency": cart.currency,
    "cart.item_count": String(
      cart.items.reduce((sum, item) => sum + item.quantity, 0)
    ),
    "cart.items": cart.items
      .map(item => `${item.name} × ${item.quantity}`)
      .join(", ")
      .slice(0, 900),
  };
}
