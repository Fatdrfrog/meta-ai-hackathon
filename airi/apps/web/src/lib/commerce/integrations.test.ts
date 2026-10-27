/** @jest-environment node */

import { createHmac } from "node:crypto";

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: jest.fn(),
}));
jest.mock("@/models/website-commerce-settings", () => ({
  __esModule: true,
  default: {},
}));

import {
  normalizeGenericStoreEvent,
  normalizeShopifyStoreEvent,
  normalizeTildaStoreEvent,
  readShopifyOrderIdFromRawBody,
  StoreEventValidationError,
  verifyShopifyWebhookSignature,
} from "./integrations";

const scope = { workspaceId: "workspace-1", widgetSourceId: "widget-1" };
const at = "2026-09-12T08:00:00.000Z";

describe("website commerce integration normalization", () => {
  it("normalizes a signed generic purchase without accepting tenant scope", () => {
    expect(
      normalizeGenericStoreEvent(
        {
          eventId: "event-1",
          cartId: "cart-1",
          checkoutId: "checkout-1",
          orderId: "order-1",
          type: "purchase",
          occurredAt: at,
          transactionId: "payment-1",
          value: 129.5,
          currency: "kzt",
        },
        scope
      )
    ).toEqual({
      ...scope,
      provider: "generic",
      eventId: "event-1",
      cartId: "cart-1",
      checkoutId: "checkout-1",
      orderId: "order-1",
      type: "purchase",
      occurredAt: at,
      transactionId: "payment-1",
      value: 129.5,
      currency: "KZT",
    });
  });

  it.each([
    { cartId: undefined, checkoutId: undefined },
    { value: Number.POSITIVE_INFINITY },
    { value: 0 },
    { currency: "KZT", extra: "tenant-controlled" },
  ])("rejects invalid generic payment facts %j", override => {
    expect(() =>
      normalizeGenericStoreEvent(
        {
          eventId: "event-1",
          cartId: "cart-1",
          orderId: "order-1",
          type: "purchase",
          occurredAt: at,
          transactionId: "payment-1",
          value: 100,
          currency: "KZT",
          ...override,
        },
        scope
      )
    ).toThrow(StoreEventValidationError);
  });

  it("verifies Shopify HMAC against the exact raw bytes", () => {
    const raw = Buffer.from('{"id":"order-1"}', "utf8");
    const signature = createHmac("sha256", "shopify-secret")
      .update(raw)
      .digest("base64");
    expect(
      verifyShopifyWebhookSignature(raw, signature, "shopify-secret")
    ).toBe(true);
    expect(
      verifyShopifyWebhookSignature(
        Buffer.from('{ "id":"order-1"}'),
        signature,
        "shopify-secret"
      )
    ).toBe(false);
  });

  it("uses checkout_token after Shopify removed checkout_id", () => {
    const event = normalizeShopifyStoreEvent(
      {
        id: 12345,
        admin_graphql_api_id: "gid://shopify/Order/12345",
        cart_token: "cart-token",
        checkout_token: "checkout-token",
        checkout_id: 999,
        created_at: at,
      },
      {
        ...scope,
        eventId: "receipt-1",
        topic: "orders/create",
        triggeredAt: at,
      }
    );
    expect(event).toMatchObject({
      cartId: "cart-token",
      checkoutId: "checkout-token",
      orderId: "gid://shopify/Order/12345",
      type: "order_placed",
    });
    expect(event.checkoutId).not.toBe("999");
  });

  it("sums only successful paid Shopify transactions and rejects mixed currency", () => {
    const base = {
      id: 12345,
      admin_graphql_api_id: "gid://shopify/Order/12345",
      checkout_token: "checkout-token",
      currency: "USD",
      current_total_price: "60.00",
      transactions: [
        {
          id: 1,
          kind: "sale",
          status: "success",
          amount: "25.00",
          currency: "USD",
        },
        {
          id: 2,
          kind: "capture",
          status: "success",
          amount: "35.00",
          currency: "USD",
        },
        {
          id: 3,
          kind: "authorization",
          status: "success",
          amount: "60.00",
          currency: "USD",
        },
        {
          id: 4,
          kind: "sale",
          status: "failure",
          amount: "500.00",
          currency: "USD",
        },
        {
          id: 5,
          kind: "sale",
          status: "success",
          amount: "10.00",
          currency: "USD",
          gateway: "gift_card",
        },
      ],
    };
    expect(
      normalizeShopifyStoreEvent(base, {
        ...scope,
        eventId: "receipt-paid",
        topic: "orders/paid",
        triggeredAt: at,
      })
    ).toMatchObject({ type: "purchase", value: 60, currency: "USD" });
    expect(() =>
      normalizeShopifyStoreEvent(
        {
          ...base,
          transactions: [
            base.transactions[0],
            { ...base.transactions[1], currency: "CAD" },
          ],
        },
        {
          ...scope,
          eventId: "receipt-mixed",
          topic: "orders/paid",
          triggeredAt: at,
        }
      )
    ).toThrow("mixed currencies");
  });

  it("correlates a Shopify refund to its paid event and ignores failed/gift-card refunds", () => {
    const refund = normalizeShopifyStoreEvent(
      {
        id: 55,
        order_id: 12345,
        processed_at: at,
        transactions: [
          { id: 10, kind: "refund", status: "success", amount: "20.00" },
          { id: 11, kind: "refund", status: "failure", amount: "90.00" },
          {
            id: 12,
            kind: "refund",
            status: "success",
            amount: "5.00",
            gateway: "gift_card",
          },
        ],
      },
      {
        ...scope,
        eventId: "refund-receipt",
        topic: "refunds/create",
        triggeredAt: at,
        previousPurchase: {
          cartId: "cart-1",
          checkoutId: "checkout-1",
          transactionId: "paid-transaction",
          currency: "USD",
        },
      }
    );
    expect(refund).toMatchObject({
      type: "refund",
      orderId: "gid://shopify/Order/12345",
      cartId: "cart-1",
      checkoutId: "checkout-1",
      purchaseTransactionId: "paid-transaction",
      transactionId: "10",
      value: 20,
      currency: "USD",
    });
  });

  it("rejects unsafe numeric Shopify identities instead of rounding them", () => {
    expect(() =>
      normalizeShopifyStoreEvent(
        {
          id: Number.MAX_SAFE_INTEGER + 1,
          checkout_token: "checkout-token",
          created_at: at,
        },
        {
          ...scope,
          eventId: "receipt-unsafe",
          topic: "orders/create",
          triggeredAt: at,
        }
      )
    ).toThrow("Shopify order ID");
  });

  it("preserves an unsafe refund order ID from Shopify raw JSON", () => {
    const raw = '{"id":1,"order_id":820982911946154508,"transactions":[]}';
    expect(
      readShopifyOrderIdFromRawBody(raw, JSON.parse(raw), "refunds/create")
    ).toBe("gid://shopify/Order/820982911946154508");
  });

  it("maps a Tilda form to order_placed and preserves the hidden cart ID exactly", () => {
    const event = normalizeTildaStoreEvent(
      new URLSearchParams({
        tranid: "467251:8442970",
        formid: "form48844953",
        airi_cart_id: "Opaque-Cart_ABC:123",
        paid: "yes",
        amount: "9999",
      }),
      { ...scope, receivedAt: new Date(at) }
    );
    expect(event).toEqual({
      ...scope,
      provider: "tilda",
      eventId: "form:467251:8442970",
      cartId: "Opaque-Cart_ABC:123",
      orderId: "467251:8442970",
      type: "order_placed",
      occurredAt: at,
    });
    expect(event).not.toHaveProperty("value");
  });
});
