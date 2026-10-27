import { Types } from "mongoose";
import type { CommerceTrackingEvent } from "@icecore/shared/types/commerce-tracking";
import type { WebsiteCartRow } from "@/models/website-cart";
import { reduceWebsiteCart, validateRecoveryUrl } from "./cart-state";

const at = "2026-09-12T10:00:00.000Z";
const event: CommerceTrackingEvent = {
  eventId: "e1",
  type: "cart_updated",
  cartId: "cart-1",
  occurredAt: at,
  currency: "KZT",
  items: [{ id: "sku-1", name: "Tea", price: 2500, quantity: 2 }],
  recoveryUrl: "https://shop.example/cart/1",
};
function current() {
  return {
    _id: new Types.ObjectId(),
    workspaceId: "w",
    widgetSourceId: "s",
    cartId: "cart-1",
    ownerSessionId: "session",
    ...reduceWebsiteCart(null, event),
  } as WebsiteCartRow;
}
test("full snapshots replace quantities, compute value and advance inactivity only on a real change", () => {
  const first = current();
  expect(first.total).toBe(5000);
  const unchanged = reduceWebsiteCart(first, {
    ...event,
    eventId: "e2",
    occurredAt: "2026-09-12T10:10:00.000Z",
  })!;
  expect(unchanged.version).toBe(1);
  expect(unchanged.activityAt).toEqual(new Date(at));
  const changed = reduceWebsiteCart(first, {
    ...event,
    eventId: "e3",
    occurredAt: "2026-09-12T10:10:00.000Z",
    items: [{ ...event.items![0], quantity: 1 }],
  })!;
  expect(changed.total).toBe(2500);
  expect(changed.version).toBe(2);
  expect(changed.activityAt.toISOString()).toBe("2026-09-12T10:10:00.000Z");
});
test("checkout replaces cart journey; later cart updates retain checkout state", () => {
  const first = current();
  const checkout = {
    ...first,
    ...reduceWebsiteCart(first, {
      ...event,
      eventId: "e2",
      type: "checkout_started",
      checkoutId: "checkout-1",
    }),
  } as WebsiteCartRow;
  expect(checkout.status).toBe("checkout");
  expect(checkout.version).toBe(2);
  expect(reduceWebsiteCart(checkout, { ...event, eventId: "e3" })?.status).toBe(
    "checkout"
  );
});

test("an actual checkout milestone resets inactivity even when its cart snapshot is unchanged", () => {
  const first = current();
  const checkout = {
    ...first,
    ...reduceWebsiteCart(first, {
      ...event,
      eventId: "checkout",
      type: "checkout_started",
    }),
  } as WebsiteCartRow;
  const next = reduceWebsiteCart(checkout, {
    ...event,
    eventId: "shipping-submitted",
    type: "checkout_started",
    occurredAt: "2026-09-12T10:15:00.000Z",
  })!;
  expect(next.version).toBe(checkout.version + 1);
  expect(next.activityAt.toISOString()).toBe("2026-09-12T10:15:00.000Z");
});
test("retry does not reset timer or version and altered facts under that ID are rejected", () => {
  expect(reduceWebsiteCart(current(), event)).toBeNull();
  expect(() =>
    reduceWebsiteCart(current(), { ...event, currency: "USD" })
  ).toThrow("different facts");
});
test("stale snapshots cannot overwrite newer cart state", () => {
  expect(
    reduceWebsiteCart(current(), {
      ...event,
      eventId: "old",
      occurredAt: "2026-09-11T10:00:00.000Z",
    })
  ).toBeNull();
});
test.each(["order_placed", "purchase_reported", "checkout_closed"] as const)(
  "%s suppresses reminders without allowing a late browser update to reopen",
  type => {
    const first = current();
    const closed = {
      ...first,
      ...reduceWebsiteCart(first, {
        eventId: type,
        type,
        cartId: event.cartId,
        occurredAt: at,
      }),
    } as WebsiteCartRow;
    expect(["ordered", "purchase_reported", "closed"]).toContain(closed.status);
    expect(
      reduceWebsiteCart(closed, {
        ...event,
        eventId: "late",
        occurredAt: "2026-09-12T11:00:00.000Z",
      })
    ).toBeNull();
  }
);
test("an empty snapshot closes the cart", () => {
  expect(
    reduceWebsiteCart(current(), { ...event, eventId: "empty", items: [] })
      ?.status
  ).toBe("closed");
});

test("an emptied cart can accept new items while an ordered cart cannot reopen", () => {
  const first = current();
  const empty = {
    ...first,
    ...reduceWebsiteCart(first, { ...event, eventId: "empty", items: [] }),
  } as WebsiteCartRow;
  expect(
    reduceWebsiteCart(empty, {
      ...event,
      eventId: "new-items",
      occurredAt: "2026-09-12T11:00:00.000Z",
    })?.status
  ).toBe("cart");
});

test("a delayed browser completion suppresses reminders even with an older timestamp", () => {
  const first = current();
  const closed = reduceWebsiteCart(first, {
    eventId: "delayed-order",
    type: "order_placed",
    cartId: event.cartId,
    occurredAt: "2026-09-12T09:59:00.000Z",
  })!;
  expect(closed.status).toBe("ordered");
  expect(closed.eventAt).toEqual(first.eventAt);
});
test.each([
  "javascript:alert(1)",
  "http://shop.example/cart",
  "https://evil.example/cart",
  "https://shop.example.evil/cart",
  "https://user:secret@shop.example/cart",
])("recovery rejects %s", url => {
  expect(() => validateRecoveryUrl(url, ["shop.example"])).toThrow();
});
test("recovery accepts only configured HTTPS storefronts", () => {
  expect(validateRecoveryUrl(event.recoveryUrl, ["shop.example"])).toBe(
    event.recoveryUrl
  );
  expect(() => validateRecoveryUrl(event.recoveryUrl, [])).toThrow();
});
