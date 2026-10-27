/** @jest-environment node */

import { createHmac } from "node:crypto";

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: () => "generic-secret",
}));
jest.mock("@/lib/commerce/integrations", () => {
  class StoreEventValidationError extends Error {
    constructor(
      message = "Invalid store event",
      readonly status = 400
    ) {
      super(message);
    }
  }
  class WebsiteCommerceIntegrationError extends Error {
    constructor(
      message: string,
      readonly status: 404 | 409 | 503,
      readonly code: string
    ) {
      super(message);
    }
  }
  return {
    StoreEventValidationError,
    WebsiteCommerceIntegrationError,
    WEBSITE_COMMERCE_EVENT_BODY_LIMIT: 512 * 1024,
    SHOPIFY_COMMERCE_TOPICS: [
      "orders/create",
      "orders/paid",
      "orders/cancelled",
      "refunds/create",
    ],
    parseGenericWebhookTimestamp: (value: string | null) =>
      /^[0-9]{10}$/.test(value || "") ? value : null,
    resolveWebsiteCommerceContext: jest.fn(),
    normalizeGenericStoreEvent: jest.fn(),
    normalizeShopifyShopDomain: jest.fn(),
    normalizeShopifyStoreEvent: jest.fn(),
    normalizeTildaStoreEvent: jest.fn(),
    readShopifyOrderIdFromRawBody: jest.fn(),
    verifyShopifyWebhookSignature: jest.fn(),
    verifyTildaWebhookToken: jest.fn(),
  };
});
jest.mock("@/lib/commerce/store-events", () => {
  class WebsiteCommerceEventError extends Error {
    constructor(
      message: string,
      readonly status: 409 | 500
    ) {
      super(message);
    }
  }
  return {
    WebsiteCommerceEventError,
    findShopifyPurchaseCorrelation: jest.fn(),
    storeWebsiteCommerceEvent: jest.fn(),
  };
});

import {
  normalizeGenericStoreEvent,
  resolveWebsiteCommerceContext,
  WebsiteCommerceIntegrationError,
} from "@/lib/commerce/integrations";
import { storeWebsiteCommerceEvent } from "@/lib/commerce/store-events";
import { POST } from "./route";

const mockResolve = resolveWebsiteCommerceContext as jest.Mock;
const mockNormalize = normalizeGenericStoreEvent as jest.Mock;
const mockStore = storeWebsiteCommerceEvent as jest.Mock;
const sourceId = "widget-1";
const context = {
  params: Promise.resolve({ sourceId, provider: "generic" }),
};

function request(body = '{"eventId":"event-1"}', signature?: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(
    `https://airi.chat/api/commerce/events/${sourceId}/generic`,
    {
      method: "POST",
      body,
      headers: {
        "x-airi-timestamp": timestamp,
        "x-airi-signature":
          signature ||
          `sha256=${createHmac("sha256", "generic-secret")
            .update(`${timestamp}.${body}`)
            .digest("hex")}`,
      },
    }
  );
}

describe("merchant commerce webhook authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue({
      widgetSource: { id: sourceId, workspace_id: "workspace-1" },
      whatsappSource: { id: "whatsapp-1" },
      settings: { webhookSecret: { ciphertext: "encrypted" } },
    });
    mockNormalize.mockReturnValue({
      eventId: "event-1",
      provider: "generic",
      workspaceId: "workspace-1",
      widgetSourceId: sourceId,
      cartId: "cart-1",
      orderId: "order-1",
      type: "order_placed",
      occurredAt: "2026-09-12T08:00:00.000Z",
    });
    mockStore.mockResolvedValue({ created: true });
  });

  it("verifies timestamped HMAC before normalization and durable receipt", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(202);
    expect(mockNormalize).toHaveBeenCalledTimes(1);
    expect(mockStore).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered signature before parsing normalized facts", async () => {
    const response = await POST(request(undefined, "sha256=bad"), context);
    expect(response.status).toBe(401);
    expect(mockNormalize).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("does not reveal whether commerce is disabled or missing", async () => {
    mockResolve.mockRejectedValue(
      new WebsiteCommerceIntegrationError(
        "Website commerce is disabled",
        409,
        "commerce_disabled"
      )
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Invalid webhook authentication",
    });
  });
});
