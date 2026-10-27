const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockUpdate = jest.fn();
const mockContext = jest.fn();
const mockRecord = jest.fn();
const mockConsent = jest.fn();
const mockSale = jest.fn();
const mockConversation = jest.fn();
const mockIssue = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/website-cart", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => {
      mockFind(...args);
      return {
        limit: () => ({ lean: () => mockFind.mock.results.at(-1)?.value }),
      };
    },
    findOne: (...args: unknown[]) => ({ lean: () => mockFindOne(...args) }),
    updateOne: (...args: unknown[]) => mockUpdate(...args),
    findOneAndUpdate: (...args: unknown[]) => ({
      lean: () => mockIssue(...args),
    }),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: () => {
      const query = { lean: () => mockConversation(), select: () => query };
      return query;
    },
  },
}));
jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: async () => ({
    _id: "1234567890abcdef12345679",
  }),
  recordCustomerEvent: jest.fn(),
}));
jest.mock("./integrations", () => ({
  resolveWebsiteCommerceContext: (...args: unknown[]) => mockContext(...args),
}));
jest.mock("@/lib/conversions/commerce-events", () => ({
  recordCommerceEvent: (...args: unknown[]) => mockRecord(...args),
  resolveOriginalCommerceSaleConversation: (...args: unknown[]) =>
    mockSale(...args),
}));
jest.mock("@/lib/whatsapp/marketing-consent", () => ({
  upsertWhatsAppMarketingConsent: (...args: unknown[]) => mockConsent(...args),
}));
import {
  applyWebsiteStoreEvent,
  claimWebsiteCartFromWhatsApp,
  recordBrowserCartEvent,
  createCartHandoff,
} from "./carts";
import type { StoreEvent } from "./store-events";

const conversationId = "1234567890abcdef12345678";
const cart = {
  _id: "1234567890abcdef12345670",
  workspaceId: "w",
  widgetSourceId: "widget",
  cartId: "cart",
  ownerSessionId: "owner",
  conversationId,
  whatsappSourceId: "wa",
};
const event: StoreEvent = {
  eventId: "e".repeat(200),
  provider: "generic",
  workspaceId: "w",
  widgetSourceId: "widget",
  cartId: "cart",
  orderId: "order",
  transactionId: "t".repeat(200),
  type: "purchase",
  occurredAt: new Date().toISOString(),
  value: 200,
  currency: "KZT",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockResolvedValue([cart]);
  mockFindOne.mockResolvedValue(cart);
  mockUpdate.mockResolvedValue({ matchedCount: 1 });
  mockContext.mockResolvedValue({ whatsappSource: { id: "wa" } });
  mockSale.mockResolvedValue(conversationId);
  mockConversation.mockResolvedValue({
    _id: conversationId,
    whatsapp_opt_in: { status: true },
  });
});

test("concurrent issuance cannot invalidate the returned URL and retry reuses it", async () => {
  const previousSecret = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = "fixture-handoff-signing-key";
  const original = {
    ...cart,
    items: [{ id: "sku", quantity: 1 }],
    recoveryUrl: "https://shop.example/cart/restore",
  };
  let stored: Record<string, unknown> = original;
  mockContext.mockResolvedValue({
    widgetSource: {
      workspace_id: "w",
      credentials: { allowed_domains: ["shop.example"] },
    },
    whatsappSource: {
      id: "wa",
      credentials: { display_phone_number: "+77010000000" },
    },
  });
  mockFindOne.mockImplementation(async () => ({ ...stored }));
  mockIssue.mockImplementation(async (query, update) => {
    if (stored.handoffHash && query.handoffHash?.$exists === false) return null;
    stored = { ...stored, ...update.$set };
    return stored;
  });
  try {
    const input = {
      widgetSourceId: "widget",
      ownerSessionId: "owner",
      cartId: "cart",
    };
    const results = await Promise.allSettled([
      createCartHandoff(input),
      createCartHandoff(input),
    ]);
    const successes = results.filter(result => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    expect(await createCartHandoff(input)).toBe(successes[0].value);
  } finally {
    if (previousSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = previousSecret;
  }
});

test("handoff cannot collect consent without a restorable cart", async () => {
  mockFindOne.mockResolvedValue({ ...cart, items: [{}] });
  mockContext.mockResolvedValue({
    widgetSource: {
      workspace_id: "w",
      credentials: { allowed_domains: ["shop.example"] },
    },
    whatsappSource: { id: "wa" },
  });
  await expect(
    createCartHandoff({
      widgetSourceId: "widget",
      ownerSessionId: "owner",
      cartId: "cart",
    })
  ).rejects.toThrow("Cart recovery link");
  expect(mockIssue).not.toHaveBeenCalled();
});

test("a stale handoff cannot mark consent after a newer opt-out", async () => {
  mockFindOne.mockResolvedValue({
    ...cart,
    handoffConsentText: "Consent",
    handoffIssuedAt: new Date(Date.now() - 1000),
    handoffExpiresAt: new Date(Date.now() + 60000),
  });
  mockConversation.mockResolvedValue({
    _id: conversationId,
    whatsapp_opt_in: { status: false },
  });
  expect(
    await claimWebsiteCartFromWhatsApp({
      workspaceId: "w",
      sourceId: "wa",
      conversationId,
      text: `Consent\nAIRI-CART:${"a".repeat(48)}`,
      messageId: "message",
      occurredAt: new Date(),
    })
  ).toBe(false);
  expect(mockUpdate.mock.calls.at(-1)[1]).toEqual({
    $unset: { handoffHash: "", consentAt: "" },
    $set: { admissionPending: false },
  });
});
test("another browser session cannot edit a known cart ID", async () => {
  await expect(
    recordBrowserCartEvent({
      workspaceId: "w",
      widgetSourceId: "widget",
      ownerSessionId: "attacker",
      allowedDomains: ["shop.example"],
      event: {
        eventId: "e",
        type: "cart_updated",
        cartId: "cart",
        occurredAt: new Date().toISOString(),
        currency: "KZT",
        items: [],
      },
    })
  ).rejects.toThrow("another session");
  expect(mockUpdate).not.toHaveBeenCalled();
});
test("purchase before WhatsApp identity closes the cart and leaves ledger projection retryable", async () => {
  mockFind.mockResolvedValue([{ ...cart, conversationId: undefined }]);
  expect(await applyWebsiteStoreEvent(event)).toBe(false);
  expect(mockUpdate).toHaveBeenCalledWith(
    { _id: cart._id },
    { $set: { status: "paid", orderId: "order", admissionPending: false } }
  );
  expect(mockRecord).not.toHaveBeenCalled();
});
test("conflicting cart and checkout aliases cannot credit an arbitrary customer", async () => {
  mockFind.mockResolvedValue([cart, { ...cart, _id: "another" }]);
  await expect(
    applyWebsiteStoreEvent({ ...event, checkoutId: "checkout" })
  ).rejects.toThrow("Conflicting");
  expect(mockUpdate).not.toHaveBeenCalled();
});
test("bounded source/provider transaction identities are shared by purchase and refund", async () => {
  expect(await applyWebsiteStoreEvent(event)).toBe(true);
  const purchase = mockRecord.mock.calls[0][0].input;
  expect(purchase.transactionId.length).toBeLessThanOrEqual(200);
  expect(purchase.eventId.length).toBeLessThanOrEqual(200);
  await applyWebsiteStoreEvent({
    ...event,
    eventId: "refund",
    type: "refund",
    transactionId: "refund-id",
    purchaseTransactionId: event.transactionId,
  });
  expect(mockRecord.mock.calls[1][0].input.purchaseTransactionId).toBe(
    purchase.transactionId
  );
  await applyWebsiteStoreEvent({ ...event, provider: "shopify" });
  expect(mockRecord.mock.calls[2][0].input.transactionId).not.toBe(
    purchase.transactionId
  );
});
test("handoff token cannot transfer a linked cart to a different WhatsApp sender", async () => {
  const token = "a".repeat(48);
  mockFindOne.mockResolvedValue({
    ...cart,
    handoffConsentText: "Consent",
    handoffIssuedAt: new Date(Date.now() - 1000),
    handoffExpiresAt: new Date(Date.now() + 60000),
  });
  expect(
    await claimWebsiteCartFromWhatsApp({
      workspaceId: "w",
      sourceId: "wa",
      conversationId: "2234567890abcdef12345678",
      text: `Consent\nAIRI-CART:${token}`,
      messageId: "message",
      occurredAt: new Date(),
    })
  ).toBe(false);
  expect(mockConsent).not.toHaveBeenCalled();
});

test("refund uses durable original-sale identity after the short-lived cart expires", async () => {
  mockFind.mockResolvedValue([]);
  expect(
    await applyWebsiteStoreEvent({
      ...event,
      eventId: "refund",
      type: "refund",
      transactionId: "refund-id",
      purchaseTransactionId: event.transactionId,
    })
  ).toBe(true);
  expect(mockRecord.mock.calls[0][0].input.conversationId).toBe(conversationId);
  mockSale.mockResolvedValue(null);
  expect(
    await applyWebsiteStoreEvent({
      ...event,
      eventId: "missing",
      type: "refund",
      transactionId: "refund-id",
      purchaseTransactionId: "not-received",
    })
  ).toBe(false);
  expect(mockRecord).toHaveBeenCalledTimes(1);
});

test("a claimed handoff permits retries of its original message only", async () => {
  mockFindOne.mockResolvedValue({
    ...cart,
    handoffMessageId: "first-message",
    handoffConsentText: "Consent",
    handoffIssuedAt: new Date(Date.now() - 1000),
    handoffExpiresAt: new Date(Date.now() + 60000),
  });
  expect(
    await claimWebsiteCartFromWhatsApp({
      workspaceId: "w",
      sourceId: "wa",
      conversationId,
      text: `Consent\nAIRI-CART:${"a".repeat(48)}`,
      messageId: "copied-message",
      occurredAt: new Date(),
    })
  ).toBe(false);
  expect(mockConsent).not.toHaveBeenCalled();
});
test("failed consent persistence cannot make a cart eligible for admission", async () => {
  const token = "a".repeat(48);
  mockFindOne.mockResolvedValue({
    ...cart,
    handoffConsentText: "Consent",
    handoffIssuedAt: new Date(Date.now() - 1000),
    handoffExpiresAt: new Date(Date.now() + 60000),
  });
  mockConsent.mockRejectedValueOnce(new Error("Consent store unavailable"));
  await expect(
    claimWebsiteCartFromWhatsApp({
      workspaceId: "w",
      sourceId: "wa",
      conversationId,
      text: `Consent\nAIRI-CART:${token}`,
      messageId: "message",
      occurredAt: new Date(),
    })
  ).rejects.toThrow("Consent store unavailable");
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockUpdate.mock.calls[0][1].$set).not.toHaveProperty("consentAt");
});
