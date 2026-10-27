jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockCreateClient().from(...args),
  },
}));
jest.mock("@/lib/conversions/meta-conversion-intent", () => ({
  prepareMetaConversionIntent: jest.fn().mockResolvedValue({
    meta_delivery_status: "not_eligible",
    meta_delivery_snapshot: null,
    meta_delivery_reason: "not_configured",
  }),
}));
const mockCreateClient = jest.fn();
const mockSalesSource = jest.fn();
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockSalesSource(...args),
}));
const mockConversationFindById = jest.fn();
const mockConfirmedQuery = jest.fn();
const mockReportQuery = jest.fn();
const mockConversationScope = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));
jest.mock("@/models/message", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/scenario", () => ({ Scenario: {} }));
jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: jest.fn(),
  recordCustomerConversionEvent: jest.fn(),
}));

import { GET } from "./route";

const suggestion = {
  messageId: "507f1f77bcf86cd799439012",
  kind: "receipt",
  amount: 12000,
  currency: "KZT",
  occurredAt: "2026-07-01T12:00:00.000Z",
};

describe("conversation payment suggestions", () => {
  let conversation: Record<string, unknown>;
  let confirmed: Array<Record<string, unknown>>;
  beforeEach(() => {
    jest.clearAllMocks();
    conversation = {
      _id: "507f1f77bcf86cd799439011",
      workspaceId: "ws-1",
      payment_suggestions: [suggestion],
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
    };
    confirmed = [];
    mockConversationFindById.mockReturnValue({
      select: () => ({ lean: async () => conversation }),
    });
    mockCreateClient.mockReturnValue({
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: (table: string) => {
        let evidenceQuery = false;
        const query = {
          select: jest.fn(),
          eq: jest.fn(),
          gte: mockReportQuery,
          order: jest.fn(),
          in: (...args: unknown[]) => {
            evidenceQuery = true;
            mockConfirmedQuery(...args);
            return query;
          },
          maybeSingle: async () => ({
            data:
              table === "company_users"
                ? { workspace_id: "ws-1" }
                : { ltv_currency: "KZT" },
            error: null,
          }),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: evidenceQuery ? confirmed : [],
              error: null,
            }).then(resolve),
        };
        query.select.mockReturnValue(query);
        query.eq.mockImplementation((...args: unknown[]) => {
          mockConversationScope(...args);
          return query;
        });
        query.gte.mockReturnValue(query);
        query.order.mockReturnValue(query);
        return query;
      },
    });
  });

  function request() {
    return new Request(
      "http://localhost/api/conversions?workspaceId=ws-1&conversationId=507f1f77bcf86cd799439011&paymentSuggestionsOnly=true"
    );
  }

  it("returns current suggestions and the canonical workspace currency", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      defaultCurrency: "KZT",
      paymentSuggestions: [{ ...suggestion, conversionId: null }],
    });
    expect(mockReportQuery).not.toHaveBeenCalled();
  });
  it("returns 404 before looking up an invalid Mongo conversation ID", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/conversions?workspaceId=ws-1&conversationId=invalid&paymentSuggestionsOnly=true"
      )
    );
    expect(response.status).toBe(404);
    expect(mockConversationFindById).not.toHaveBeenCalled();
  });
  it("exposes only the source transaction-reference requirement to the dialog", async () => {
    conversation.channel = "whatsapp";
    conversation.sourceId = "source-1";
    mockSalesSource.mockResolvedValueOnce({
      ok: true,
      source: {
        workspace_id: "ws-1",
        credentials: { sales_webhook_enabled: true, access_token: "secret" },
      },
    });
    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.transactionIdRequired).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("marks evidence confirmed even outside the conversion report date window", async () => {
    confirmed = [
      {
        id: "old-conversion",
        payment_evidence_message_id: suggestion.messageId,
        conversion_value: suggestion.amount,
        currency: suggestion.currency,
      },
    ];
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      paymentSuggestions: [{ ...suggestion, conversionId: "old-conversion" }],
    });
    expect(mockConfirmedQuery).toHaveBeenCalledWith(
      "payment_evidence_message_id",
      [suggestion.messageId]
    );
  });

  it("shows the recorded amount and currency after the merchant corrects the evidence", async () => {
    confirmed = [
      {
        id: "corrected-conversion",
        payment_evidence_message_id: suggestion.messageId,
        conversion_value: 15000,
        currency: "USD",
      },
    ];
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      paymentSuggestions: [
        {
          ...suggestion,
          amount: 15000,
          currency: "USD",
          conversionId: "corrected-conversion",
        },
      ],
    });
  });

  it("hides stale evidence until classification catches up", async () => {
    conversation.classification_revision = 7;
    const response = await GET(request());
    expect(await response.json()).toMatchObject({ paymentSuggestions: [] });
    expect(mockConfirmedQuery).not.toHaveBeenCalled();
  });

  it("looks up confirmations by canonical Mongo ID for uppercase requests", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/conversions?workspaceId=ws-1&conversationId=507F1F77BCF86CD799439011&paymentSuggestionsOnly=true"
      )
    );
    expect(response.status).toBe(200);
    expect(mockConversationScope).toHaveBeenCalledWith(
      "conversation_id",
      "507f1f77bcf86cd799439011"
    );
  });

  it("does not expose another workspace's conversation suggestions", async () => {
    conversation.workspaceId = "other-workspace";
    expect((await GET(request())).status).toBe(404);
    expect(mockConfirmedQuery).not.toHaveBeenCalled();
  });
});
