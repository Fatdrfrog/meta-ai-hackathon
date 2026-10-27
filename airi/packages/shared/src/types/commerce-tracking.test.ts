import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMERCE_TRACKING_MAX_FUTURE_MS,
  COMMERCE_TRACKING_MAX_PAST_MS,
  normalizeCommerceTrackingEvent,
} from "./commerce-tracking";

const now = Date.parse("2026-09-12T12:00:00.000Z");

describe("normalizeCommerceTrackingEvent", () => {
  it("normalizes a complete snapshot and keeps an empty cart meaningful", () => {
    assert.deepEqual(
      normalizeCommerceTrackingEvent(
        {
          eventId: " cart-1:7 ",
          type: "cart_updated",
          cartId: " cart-1 ",
          occurredAt: "2026-09-12T11:59:59Z",
          items: [],
          currency: "usd",
          recoveryUrl: "https://shop.example/cart/restore?id=1",
        },
        now,
      ),
      {
        eventId: "cart-1:7",
        type: "cart_updated",
        cartId: "cart-1",
        occurredAt: "2026-09-12T11:59:59.000Z",
        items: [],
        currency: "USD",
        recoveryUrl: "https://shop.example/cart/restore?id=1",
      },
    );
  });

  it("requires full snapshots for mutable cart and checkout events", () => {
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          {
            eventId: "event-1",
            type: "cart_updated",
            cartId: "cart-1",
            occurredAt: new Date(now).toISOString(),
            currency: "USD",
          },
          now,
        ),
      /requires a full items snapshot/,
    );
    assert.doesNotThrow(() =>
      normalizeCommerceTrackingEvent(
        {
          eventId: "event-2",
          type: "checkout_closed",
          cartId: "cart-1",
          occurredAt: new Date(now).toISOString(),
        },
        now,
      ),
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          {
            eventId: "event-3",
            type: "order_placed",
            cartId: "cart-1",
            occurredAt: new Date(now).toISOString(),
            items: [],
          },
          now,
        ),
      /supplied together/,
    );
  });

  it("rejects malformed, unsafe, and stale browser payloads", () => {
    const base = {
      eventId: "event-1",
      type: "cart_updated",
      cartId: "cart-1",
      occurredAt: new Date(now).toISOString(),
      items: [{ id: "sku-1", name: "One", quantity: 1, price: 10 }],
      currency: "USD",
    };

    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          { ...base, recoveryUrl: "http://shop.example/cart" },
          now,
        ),
      /HTTPS URL/,
    );
    assert.throws(
      () => normalizeCommerceTrackingEvent({ ...base, currency: "US" }, now),
      /ISO 4217/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          { ...base, items: [{ ...base.items[0], quantity: 0 }] },
          now,
        ),
      /positive safe integer/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          {
            ...base,
            occurredAt: new Date(
              now + COMMERCE_TRACKING_MAX_FUTURE_MS + 1,
            ).toISOString(),
          },
          now,
        ),
      /too far in the future/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          {
            ...base,
            occurredAt: new Date(
              now - COMMERCE_TRACKING_MAX_PAST_MS - 1,
            ).toISOString(),
          },
          now,
        ),
      /too old/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          { ...base, occurredAt: "2026-09-12" },
          now,
        ),
      /valid ISO timestamp/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          {
            ...base,
            recoveryUrl: "https://user:password@shop.example/cart",
          },
          now,
        ),
      /HTTPS URL/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          { ...base, items: [base.items[0], { ...base.items[0] }] },
          now,
        ),
      /duplicate IDs/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          { ...base, eventId: "event\u0000-1" },
          now,
        ),
      /control characters/,
    );
    assert.throws(
      () =>
        normalizeCommerceTrackingEvent(
          {
            ...base,
            items: [
              {
                ...base.items[0],
                quantity: 2,
                price: 50_000_000,
              },
            ],
          },
          now,
        ),
      /supported cart size/,
    );
  });
});
