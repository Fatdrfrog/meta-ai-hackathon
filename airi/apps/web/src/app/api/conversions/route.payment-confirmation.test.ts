jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockCreateClient().from(...args),
    rpc: (...args: unknown[]) => mockCommerceRpc(...args),
  },
}));
const mockCommerceRpc = jest.fn();
const mockSalesSource = jest.fn();
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockSalesSource(...args),
}));
jest.mock("@/lib/conversions/meta-conversion-intent", () => ({
  prepareMetaConversionIntent: jest.fn().mockResolvedValue({
    meta_delivery_status: "not_eligible",
    meta_delivery_snapshot: null,
    meta_delivery_reason: "not_configured",
  }),
}));
const mockCreateClient = jest.fn();
jest.mock("@/lib/conversions/confirmed-payment-scenario", () => ({
  prepareConfirmedPaymentScenarioIntent: jest
    .fn()
    .mockResolvedValue({
      scenario_effect_status: "not_applicable",
      scenario_effect_snapshot: null,
      scenario_effect_reason: "no_matching_payment_wait",
    }),
}));
const mockConversationFindById = jest.fn();
const mockMessageFindOne = jest.fn();
const mockInsertConversion = jest.fn();
const mockFindConversion = jest.fn();
const mockConversionScope = jest.fn();
const mockRecordCustomerConversionEvent = jest.fn();
const mockEnsureCustomerForConversation = jest.fn();
const mockScenarioFindOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockMessageFindOne(...args) },
}));
jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: (...args: unknown[]) => mockScenarioFindOne(...args) },
}));
jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: (...args: unknown[]) =>
    mockEnsureCustomerForConversation(...args),
  recordCustomerConversionEvent: (...args: unknown[]) =>
    mockRecordCustomerConversionEvent(...args),
}));

import { POST } from "./route";
import { prepareMetaConversionIntent } from "@/lib/conversions/meta-conversion-intent";
import { prepareConfirmedPaymentScenarioIntent } from "@/lib/conversions/confirmed-payment-scenario";
import mongoose from "mongoose";

const EvidenceDocument = mongoose.model(
  "PaymentConfirmationEvidenceTest",
  new mongoose.Schema({
    payment_suggestions: [
      new mongoose.Schema(
        {
          messageId: String,
          kind: String,
          amount: Number,
          currency: String,
          occurredAt: String,
        },
        { _id: false }
      ),
    ],
  })
);

const conversationId = "507f1f77bcf86cd799439011";
const messageId = "507f1f77bcf86cd799439012";
const occurredAt = "2026-09-09T12:00:00.000Z";
const suggestion = {
  messageId,
  kind: "receipt",
  amount: 12000,
  currency: "KZT",
  occurredAt,
};

function buildConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: conversationId,
    workspaceId: "ws-1",
    channel: "whatsapp",
    sourceId: "source-1",
    handled_by_agent_id: "agent-1",
    classification: { category: "active" },
    is_classified: true,
    classification_revision: 6,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 6,
      appliedRevision: 6,
    },
    classification_meta: {
      source_revision: 6,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-6",
    },
    payment_suggestions: [suggestion],
    whatsappReferral: {
      sourceId: "ad-1",
      campaignId: "campaign-1",
      ctwaClid: "click-1",
      capturedAt: "2026-09-08T12:00:00.000Z",
    },
    ...overrides,
  };
}

const existingConversion = {
  id: "conversion-1",
  workspace_id: "ws-1",
  conversation_id: conversationId,
  conversion_type: "sale",
  conversion_value: 15000,
  currency: "KZT",
  payment_evidence_message_id: messageId,
  converted_at: occurredAt,
  metadata: {
    paymentEvidence: { ...suggestion, confirmedByUserId: "original-manager" },
  },
};

function request(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/conversions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      conversionType: "sale",
      conversionValue: 15000,
      currency: "KZT",
      paymentEvidenceMessageId: messageId,
      ...overrides,
    }),
  });
}

describe("payment suggestion confirmation", () => {
  let conversation: ReturnType<typeof buildConversation>;
  let membership: { workspace_id: string } | null;
  let user: { id: string } | null;

  beforeEach(() => {
    jest.clearAllMocks();
    conversation = buildConversation();
    membership = { workspace_id: "ws-1" };
    user = { id: "manager-1" };
    mockSalesSource.mockResolvedValue({
      ok: true,
      source: {
        id: "source-1",
        workspace_id: "ws-1",
        type: "whatsapp",
        credentials: { sales_webhook_enabled: false },
      },
    });
    mockCommerceRpc.mockResolvedValue({
      data: { conversion: existingConversion, deduplicated: false },
      error: null,
    });
    mockConversationFindById.mockImplementation(() =>
      Promise.resolve(conversation)
    );
    mockMessageFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: messageId, date: occurredAt }),
      }),
    });
    mockFindConversion.mockResolvedValue({ data: null, error: null });
    mockInsertConversion.mockResolvedValue({
      data: existingConversion,
      error: null,
    });
    mockEnsureCustomerForConversation.mockResolvedValue({ _id: "customer-1" });
    mockRecordCustomerConversionEvent.mockResolvedValue({ _id: "event-1" });
    mockCreateClient.mockImplementation(() => ({
      auth: { getUser: async () => ({ data: { user } }) },
      from: (table: string) => {
        if (table === "company_users") {
          const query = {
            select: jest.fn(),
            eq: jest.fn(),
            maybeSingle: async () => ({ data: membership, error: null }),
          };
          query.select.mockReturnValue(query);
          query.eq.mockReturnValue(query);
          return query;
        }
        const query = {
          select: jest.fn(),
          eq: jest.fn(),
          maybeSingle: mockFindConversion,
          insert: (row: unknown) => ({
            select: () => ({ single: () => mockInsertConversion(row) }),
          }),
        };
        query.select.mockReturnValue(query);
        query.eq.mockImplementation((...args: unknown[]) => {
          mockConversionScope(...args);
          return query;
        });
        return query;
      },
    }));
  });

  it("confirms corrected sale value with authoritative evidence and attribution", async () => {
    const response = await POST(
      request({
        metadata: {
          paymentEvidence: { messageId: "forged" },
          whatsappReferral: { ctwaClid: "forged" },
        },
      })
    );
    expect(response.status).toBe(200);
    expect(mockMessageFindOne).toHaveBeenCalledWith({
      _id: messageId,
      conversation: conversationId,
      workspaceId: "ws-1",
      direction: "inbound",
    });
    expect(mockInsertConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        conversion_type: "sale",
        conversion_value: 15000,
        currency: "KZT",
        source: "manual",
        converted_at: occurredAt,
        payment_evidence_message_id: messageId,
        attributed_to_agent: "agent-1",
        attributed_to_channel: "whatsapp",
        metadata: expect.objectContaining({
          sourceId: "source-1",
          paymentEvidence: expect.objectContaining({
            ...suggestion,
            confirmedByUserId: "manager-1",
          }),
          whatsappReferral: expect.objectContaining({
            ctwaClid: "click-1",
            campaignId: "campaign-1",
          }),
        }),
      })
    );
  });

  it("persists the prepared Meta intent in the same manual sale insert", async () => {
    jest.mocked(prepareMetaConversionIntent).mockResolvedValueOnce({
      meta_delivery_status: "pending",
      meta_delivery_reason: null,
      meta_delivery_snapshot: {
        sourceId: "source-1",
        datasetId: "dataset",
        wabaId: "waba",
        ctwaClid: "click-1",
        eventName: "Purchase",
        eventTime: 1788955200,
        value: 15000,
        currency: "KZT",
      },
    });
    expect((await POST(request({ transactionId: "payment-1" }))).status).toBe(
      200
    );
    expect(prepareMetaConversionIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversionType: "sale",
        value: 15000,
        sourceId: "source-1",
        metadata: expect.objectContaining({
          whatsappReferral: expect.objectContaining({ ctwaClid: "click-1" }),
        }),
      })
    );
    expect(mockCommerceRpc).toHaveBeenCalledWith(
      "record_commerce_conversion",
      expect.objectContaining({
        p_conversion: expect.objectContaining({
          source: "manual",
          external_source_id: "source-1",
          external_transaction_id: "payment-1",
          meta_delivery_status: "pending",
          meta_delivery_snapshot: expect.objectContaining({
            datasetId: "dataset",
          }),
        }),
      })
    );
  });

  it("records an identifier-free manual sale locally without a Meta snapshot", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mockInsertConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        meta_delivery_status: "not_eligible",
        meta_delivery_snapshot: null,
        meta_delivery_reason: "transaction_id_missing",
      })
    );
    expect(prepareMetaConversionIntent).not.toHaveBeenCalled();
  });

  it("requires the shared transaction reference when the source webhook is enabled", async () => {
    mockSalesSource.mockResolvedValueOnce({
      ok: true,
      source: {
        workspace_id: "ws-1",
        credentials: { sales_webhook_enabled: true },
      },
    });
    const response = await POST(
      request({ paymentEvidenceMessageId: undefined })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "transaction_id_required",
    });
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });

  it("uses the canonical webhook sale when a manual transaction is already recorded", async () => {
    mockCommerceRpc.mockResolvedValueOnce({
      data: { conversion: existingConversion, deduplicated: true },
      error: null,
    });
    const response = await POST(request({ transactionId: " payment-1 " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversion: existingConversion,
      deduplicated: true,
    });
    expect(mockCommerceRpc).toHaveBeenCalledWith(
      "record_commerce_conversion",
      expect.objectContaining({
        p_conversion: expect.objectContaining({
          external_transaction_id: "payment-1",
        }),
      })
    );
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });

  it("returns 409 for a shared transaction with conflicting sale details", async () => {
    mockCommerceRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "commerce_event_conflict" },
    });
    const response = await POST(request({ transactionId: "payment-1" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "commerce_event_conflict",
    });
    expect(mockRecordCustomerConversionEvent).not.toHaveBeenCalled();
  });
  it.each([
    { transactionId: "different-transaction" },
    { conversionValue: 999 },
    { currency: "USD" },
  ])(
    "rejects conflicting transaction details even when evidence was already confirmed %j",
    async override => {
      mockFindConversion.mockResolvedValueOnce({
        data: {
          ...existingConversion,
          external_source_id: "source-1",
          external_transaction_id: "payment-1",
        },
        error: null,
      });
      const response = await POST(
        request({ transactionId: "payment-1", ...override })
      );
      expect(response.status).toBe(409);
      expect(mockCommerceRpc).not.toHaveBeenCalled();
      expect(mockRecordCustomerConversionEvent).not.toHaveBeenCalled();
    }
  );

  it("keeps playbook attribution when the receipt reply completed a human handoff before confirmation", async () => {
    const scenarioId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const completedAt = "2026-09-09T12:00:01.000Z";
    conversation = buildConversation({
      airi_handoff_active: true,
      airi_scenario_state: {
        lockedScenarioId: null,
        lockedScenarioName: null,
        currentActionNodeId: null,
        pendingConditionNodeId: null,
        startedScenarios: [
          {
            scenarioId,
            scenarioName: "Consultation",
            startedAt: "2026-09-09T11:00:00.000Z",
            firstActionNodeId: "revenue-qualification",
            firstMessageId: "first-message",
          },
        ],
        completedScenarios: [
          {
            scenarioId,
            scenarioName: "Consultation",
            completedAt,
            lastActionNodeId: "revenue-handoff",
            lastMessageId: "handoff-message",
          },
        ],
      },
    });
    mockScenarioFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          workspaceId: "ws-1",
          presetId: "revenue-playbook-ad_consultation",
          segmentKey: "lead_generation",
        }),
      }),
    });
    expect((await POST(request())).status).toBe(200);
    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId: "ws-1",
    });
    expect(mockInsertConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        converted_at: occurredAt,
        metadata: expect.objectContaining({
          scenarioId,
          presetId: "revenue-playbook-ad_consultation",
          scenarioAttribution: expect.objectContaining({
            method: "completed_touch",
            anchorAt: occurredAt,
            completedAt,
            windowHours: 24,
          }),
        }),
        scenario_effect_status: "not_applicable",
      })
    );
  });

  it("rejects refund because it is not an allowed manual conversion type", async () => {
    expect(
      (
        await POST(
          request({
            conversionType: "refund",
            paymentEvidenceMessageId: undefined,
          })
        )
      ).status
    ).toBe(400);
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });
  it("stores the exact wait intent atomically with merchant confirmation and passes evidence time", async () => {
    jest
      .mocked(prepareConfirmedPaymentScenarioIntent)
      .mockResolvedValueOnce({
        scenario_effect_status: "pending",
        scenario_effect_snapshot: {
          sourceId: "source-1",
          scenarioId: "scenario-1",
          scenarioUpdatedAt: occurredAt,
          pendingConditionNodeId: "condition",
          pendingSourceActionNodeId: "action",
          pendingStartedAt: occurredAt,
          pendingLastOutboundMessageId: messageId,
          occurredAt,
        },
        scenario_effect_reason: null,
      });
    expect((await POST(request())).status).toBe(200);
    expect(prepareConfirmedPaymentScenarioIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation,
        conversionType: "sale",
        value: 15000,
        occurredAt,
        paymentEvidenceOccurredAt: occurredAt,
      })
    );
    expect(mockInsertConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "manual",
        scenario_effect_status: "pending",
        scenario_effect_snapshot: expect.objectContaining({
          pendingConditionNodeId: "condition",
        }),
      })
    );
  });

  it("rejects stale classifier suggestions", async () => {
    conversation.classification_revision = 7;
    expect((await POST(request())).status).toBe(409);
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });

  it("does not allow manual metadata to claim AI payment evidence", async () => {
    expect(
      (
        await POST(
          request({
            paymentEvidenceMessageId: undefined,
            metadata: {
              paymentEvidence: { messageId, confirmedByUserId: "forged" },
            },
          })
        )
      ).status
    ).toBe(200);
    expect(
      mockInsertConversion.mock.calls[0][0].metadata.paymentEvidence
    ).toBeNull();
  });

  it("does not attribute an earlier sale to a later ad referral", async () => {
    conversation.whatsappReferral.capturedAt = "2026-09-10T12:00:00.000Z";
    expect((await POST(request())).status).toBe(200);
    expect(mockInsertConversion.mock.calls[0][0].metadata).toMatchObject({
      whatsappReferral: null,
      whatsappReferralStatus: "after_conversion",
    });
  });

  it("marks ad referral attribution unverified when capture timing is unavailable", async () => {
    conversation.whatsappReferral.capturedAt = "";
    expect((await POST(request())).status).toBe(200);
    expect(mockInsertConversion.mock.calls[0][0].metadata).toMatchObject({
      whatsappReferral: null,
      whatsappReferralStatus: "unverified",
    });
  });

  it("stores plain evidence metadata from hydrated Mongo subdocuments", async () => {
    const document = new EvidenceDocument({
      payment_suggestions: [suggestion],
    });
    conversation.payment_suggestions =
      document.payment_suggestions as typeof conversation.payment_suggestions;
    expect((await POST(request())).status).toBe(200);
    const storedEvidence =
      mockInsertConversion.mock.calls[0][0].metadata.paymentEvidence;
    expect(storedEvidence).toMatchObject(suggestion);
    expect(storedEvidence).not.toHaveProperty("_doc");
    expect(storedEvidence).not.toHaveProperty("__parentArray");
  });

  it("rejects messages outside the current suggestion set", async () => {
    conversation.payment_suggestions = [];
    expect((await POST(request())).status).toBe(409);
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });

  it("rejects missing, outbound, or cross-conversation evidence", async () => {
    mockMessageFindOne.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    expect((await POST(request())).status).toBe(409);
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });

  it.each([
    { conversionValue: 0 },
    { conversionValue: -1 },
    { conversionValue: "12000" },
    { conversionValue: 100000000 },
    { conversionValue: null },
    { currency: "invalid" },
    { conversionValue: 0.001 },
    { conversionValue: 12.345 },
    { currency: null },
    { conversionType: "signup" },
    { paymentEvidenceMessageId: "invalid" },
  ])("rejects invalid confirmation input %j", async input => {
    expect((await POST(request(input))).status).toBe(400);
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });

  it("returns the original sale and replays customer history after stale retries", async () => {
    conversation.classification_revision = 7;
    mockFindConversion.mockResolvedValue({
      data: existingConversion,
      error: null,
    });
    const response = await POST(request({ conversionValue: 999 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversion: existingConversion,
      deduplicated: true,
    });
    expect(mockInsertConversion).not.toHaveBeenCalled();
    expect(mockRecordCustomerConversionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversionId: "conversion-1",
        conversionValue: 15000,
        currency: "KZT",
        actor: expect.objectContaining({ userId: "original-manager" }),
      })
    );
  });

  it("recovers a concurrent duplicate insert using the database winner", async () => {
    mockFindConversion
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: existingConversion, error: null });
    mockInsertConversion.mockResolvedValue({
      data: null,
      error: { code: "23505" },
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversion: existingConversion,
      deduplicated: true,
    });
    expect(mockRecordCustomerConversionEvent).toHaveBeenCalledTimes(1);
  });

  it("denies cross-workspace confirmation before checking existing sales", async () => {
    membership = null;
    expect((await POST(request())).status).toBe(403);
    expect(mockFindConversion).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    user = null;
    expect((await POST(request())).status).toBe(401);
    expect(mockConversationFindById).not.toHaveBeenCalled();
  });
  it.each(["invalid", "507f1f77bcf86cd79943901", { id: conversationId }])(
    "returns 404 for malformed conversation identity %j",
    async invalidId => {
      expect((await POST(request({ conversationId: invalidId }))).status).toBe(
        404
      );
      expect(mockConversationFindById).not.toHaveBeenCalled();
    }
  );

  it.each([
    { conversionValue: -1 },
    { conversionValue: 0 },
    { conversionValue: null },
    { conversionValue: undefined },
    { currency: null },
    { currency: "invalid" },
  ])(
    "rejects invalid manual sale money without payment evidence %j",
    async input => {
      expect(
        (await POST(request({ paymentEvidenceMessageId: undefined, ...input })))
          .status
      ).toBe(400);
      expect(mockInsertConversion).not.toHaveBeenCalled();
    }
  );

  it("uses canonical Mongo identity for confirmation retries and customer history", async () => {
    mockFindConversion.mockResolvedValue({
      data: existingConversion,
      error: null,
    });
    const response = await POST(
      request({ conversationId: conversationId.toUpperCase() })
    );
    expect(response.status).toBe(200);
    expect(mockConversionScope).toHaveBeenCalledWith(
      "conversation_id",
      conversationId
    );
    expect(mockRecordCustomerConversionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId })
    );
    expect(mockInsertConversion).not.toHaveBeenCalled();
  });

  it("stores the canonical Mongo conversation identity when confirming", async () => {
    expect(
      (await POST(request({ conversationId: conversationId.toUpperCase() })))
        .status
    ).toBe(200);
    expect(mockInsertConversion).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: conversationId })
    );
  });
});
