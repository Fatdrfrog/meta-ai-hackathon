const mockRpc = jest.fn();
const mockFindById = jest.fn();
const mockOriginal = jest.fn();
const mockOriginalEq = jest.fn();
const mockFrom = jest.fn();
const mockAttribution = jest.fn();
const mockIntent = jest.fn();
const mockScenarioIntent = jest.fn();
const mockRecord = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => {
      mockFrom(...args);
      const query = {
        eq: (...eqArgs: unknown[]) => {
          mockOriginalEq(...eqArgs);
          return query;
        },
        maybeSingle: (...singleArgs: unknown[]) => mockOriginal(...singleArgs),
      };
      return { select: () => query };
    },
  },
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({
  Conversation: { findById: (...args: unknown[]) => mockFindById(...args) },
}));
jest.mock("./conversion-attribution", () => ({
  buildConversionAttribution: (...args: unknown[]) => mockAttribution(...args),
}));
jest.mock("./meta-conversion-intent", () => ({
  prepareMetaConversionIntent: (...args: unknown[]) => mockIntent(...args),
}));
jest.mock("./confirmed-payment-scenario", () => ({
  prepareConfirmedPaymentScenarioIntent: (...args: unknown[]) =>
    mockScenarioIntent(...args),
}));
jest.mock("@/lib/customers/service", () => ({
  recordCustomerConversionEvent: (...args: unknown[]) => mockRecord(...args),
}));

import {
  normalizeCommerceEvent,
  recordCommerceEvent,
  resolveOriginalCommerceSaleConversation,
} from "./commerce-events";

const source = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "workspace",
  type: "whatsapp",
};
const conversationId = "507f1f77bcf86cd799439abc";
const event = {
  eventId: "event-1",
  eventType: "purchase",
  transactionId: "transaction-1",
  conversationId,
  value: 120,
  currency: "USD",
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
};
describe("verified commerce events", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindById.mockResolvedValue({
      _id: conversationId,
      workspaceId: "workspace",
      sourceId: source.id,
      channel: "whatsapp",
    });
    mockAttribution.mockResolvedValue({
      sourceId: source.id,
      customerId: "customer-1",
    });
    mockIntent.mockResolvedValue({
      meta_delivery_status: "pending",
      meta_delivery_snapshot: {
        datasetId: "dataset",
        wabaId: "waba",
        ctwaClid: "click",
      },
      meta_delivery_reason: null,
    });
    mockRecord.mockResolvedValue(undefined);
    mockScenarioIntent.mockResolvedValue({
      scenario_effect_status: "not_applicable",
      scenario_effect_snapshot: null,
      scenario_effect_reason: "no_matching_payment_wait",
    });
    mockRpc.mockResolvedValue({
      data: {
        conversion: {
          id: "conversion-1",
          conversation_id: conversationId,
          conversion_type: "sale",
          conversion_value: 120,
          currency: "USD",
          converted_at: event.occurredAt,
          metadata: {},
        },
        deduplicated: false,
      },
      error: null,
    });
  });
  it("resolves an original sale conversation within the exact source and workspace scope", async () => {
    mockOriginal.mockResolvedValueOnce({
      data: { conversation_id: conversationId.toUpperCase() },
      error: null,
    });
    await expect(
      resolveOriginalCommerceSaleConversation({
        source,
        purchaseTransactionId: "purchase-transaction",
        currency: "usd",
      })
    ).resolves.toBe(conversationId);
    expect(mockFrom).toHaveBeenCalledWith("conversions");
    expect(mockOriginalEq.mock.calls).toEqual([
      ["workspace_id", "workspace"],
      ["external_source_id", source.id],
      ["external_transaction_id", "purchase-transaction"],
      ["conversion_type", "sale"],
      ["currency", "USD"],
    ]);
  });
  it("returns no original conversation when the scoped sale is absent", async () => {
    mockOriginal.mockResolvedValueOnce({ data: null, error: null });
    await expect(
      resolveOriginalCommerceSaleConversation({
        source,
        purchaseTransactionId: "purchase-transaction",
        currency: "USD",
      })
    ).resolves.toBeNull();
  });
  it("fails closed when the original sale lookup fails", async () => {
    mockOriginal.mockResolvedValueOnce({
      data: null,
      error: { message: "database unavailable" },
    });
    await expect(
      resolveOriginalCommerceSaleConversation({
        source,
        purchaseTransactionId: "purchase-transaction",
        currency: "USD",
      })
    ).rejects.toMatchObject({ status: 500 });
  });
  it("normalizes immutable identities, currency, conversation and time", () => {
    expect(
      normalizeCommerceEvent({
        ...event,
        conversationId: conversationId.toUpperCase(),
        currency: "usd",
      })
    ).toEqual({
      ...event,
      conversationId,
      currency: "USD",
      occurredAt: event.occurredAt,
    });
  });
  it.each([
    { value: 0 },
    { value: 1.234 },
    { value: Infinity },
    { currency: "money" },
    { eventType: "sale" },
    { eventId: "" },
    { conversationId: "invalid" },
    { occurredAt: "invalid" },
    { occurredAt: "2026-02-30T12:00:00Z" },
    { occurredAt: "2026-02-29T12:00:00+05:00" },
    { eventType: "refund" },
    { metadata: { ctwaClid: "spoof" } },
  ])("rejects invalid/extra commerce fields %j", override => {
    expect(() => normalizeCommerceEvent({ ...event, ...override })).toThrow();
  });
  it("rejects future outcome timestamps while webhook signing permits clock skew", () => {
    expect(() =>
      normalizeCommerceEvent({
        ...event,
        occurredAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).toThrow();
  });
  it("atomically persists the pending Meta intent with the canonical sale", async () => {
    await recordCommerceEvent({
      source,
      input: { ...event, conversationId: conversationId.toUpperCase() },
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "record_commerce_conversion",
      expect.objectContaining({
        p_conversion: expect.objectContaining({
          workspace_id: "workspace",
          conversation_id: conversationId,
          external_source_id: source.id,
          external_event_id: "event-1",
          external_transaction_id: "transaction-1",
          conversion_type: "sale",
          source: "integration",
          meta_delivery_status: "pending",
          event_payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      })
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        conversionId: "conversion-1",
        actor: { type: "system", label: "commerce_event" },
      })
    );
  });
  it("atomically persists the scenario intent with a verified purchase", async () => {
    const intent = {
      scenario_effect_status: "pending",
      scenario_effect_snapshot: { scenarioId: "scenario" },
      scenario_effect_reason: null,
    };
    mockScenarioIntent.mockResolvedValueOnce(intent);
    await recordCommerceEvent({ source, input: event });
    expect(mockScenarioIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversionType: "sale",
        value: 120,
        occurredAt: event.occurredAt,
        conversation: expect.objectContaining({ _id: conversationId }),
      })
    );
    expect(mockRpc).toHaveBeenCalledWith(
      "record_commerce_conversion",
      expect.objectContaining({ p_conversion: expect.objectContaining(intent) })
    );
  });
  it.each([
    { workspaceId: "other" },
    { sourceId: "other" },
    { channel: "telegram" },
  ])("rejects cross-tenant/source/channel conversations %j", override => {
    mockFindById.mockResolvedValue({
      _id: conversationId,
      workspaceId: "workspace",
      sourceId: source.id,
      channel: "whatsapp",
      ...override,
    });
    return expect(
      recordCommerceEvent({ source, input: event })
    ).rejects.toMatchObject({ status: 404 });
  });
  it("maps immutable replay conflicts to 409", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "commerce_event_conflict" },
    });
    await expect(
      recordCommerceEvent({ source, input: event })
    ).rejects.toMatchObject({ status: 409 });
  });
  it("replays idempotent customer history on a duplicate ledger response", async () => {
    mockRpc.mockResolvedValue({
      data: {
        conversion: {
          id: "original",
          conversion_type: "sale",
          conversion_value: 120,
          currency: "USD",
          converted_at: event.occurredAt,
          metadata: {},
        },
        deduplicated: true,
      },
      error: null,
    });
    expect(await recordCommerceEvent({ source, input: event })).toMatchObject({
      deduplicated: true,
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ conversionId: "original" })
    );
  });
  it("refunds preserve purchase attribution and reject a changed Meta destination", async () => {
    mockOriginal.mockResolvedValue({
      data: {
        id: "purchase",
        conversation_id: conversationId,
        currency: "USD",
        metadata: {
          sourceId: source.id,
          whatsappReferral: { ctwaClid: "old-click" },
        },
        meta_delivery_snapshot: {
          datasetId: "old-dataset",
          wabaId: "waba",
          ctwaClid: "old-click",
        },
      },
      error: null,
    });
    await recordCommerceEvent({
      source,
      input: {
        ...event,
        eventType: "refund",
        purchaseTransactionId: "purchase-transaction",
      },
    });
    expect(mockAttribution).not.toHaveBeenCalled();
    expect(mockScenarioIntent).toHaveBeenCalledWith(
      expect.objectContaining({ conversionType: "refund" })
    );
    expect(mockIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversionType: "refund",
        metadata: expect.objectContaining({
          whatsappReferral: { ctwaClid: "old-click" },
        }),
      })
    );
    expect(mockRpc).toHaveBeenCalledWith(
      "record_commerce_conversion",
      expect.objectContaining({
        p_purchase_transaction_id: "purchase-transaction",
        p_conversion: expect.objectContaining({
          meta_delivery_status: "not_eligible",
          meta_delivery_reason: "purchase_destination_changed",
          conversion_type: "refund",
          scenario_effect_status: "not_applicable",
          scenario_effect_snapshot: null,
        }),
      })
    );
  });
  it("does not send a production refund for a purchase recorded in Meta test mode", async () => {
    mockOriginal.mockResolvedValue({
      data: {
        id: "purchase",
        conversation_id: conversationId,
        currency: "USD",
        metadata: {},
        meta_delivery_snapshot: {
          datasetId: "dataset",
          wabaId: "waba",
          ctwaClid: "click",
          testEventCode: "TEST123",
        },
      },
      error: null,
    });
    await recordCommerceEvent({
      source,
      input: {
        ...event,
        eventType: "refund",
        purchaseTransactionId: "purchase-transaction",
      },
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "record_commerce_conversion",
      expect.objectContaining({
        p_conversion: expect.objectContaining({
          meta_delivery_status: "not_eligible",
          meta_delivery_reason: "purchase_destination_changed",
        }),
      })
    );
  });
  it("keeps a refund local when its purchase has no eligible Meta snapshot", async () => {
    mockOriginal.mockResolvedValue({
      data: {
        id: "purchase",
        conversation_id: conversationId,
        currency: "USD",
        metadata: {},
        meta_delivery_snapshot: null,
      },
      error: null,
    });
    await recordCommerceEvent({
      source,
      input: {
        ...event,
        eventType: "refund",
        purchaseTransactionId: "purchase-transaction",
      },
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "record_commerce_conversion",
      expect.objectContaining({
        p_conversion: expect.objectContaining({
          meta_delivery_status: "not_eligible",
          meta_delivery_snapshot: null,
          meta_delivery_reason: "purchase_not_eligible",
        }),
      })
    );
  });
});
