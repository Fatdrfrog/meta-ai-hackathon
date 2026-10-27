jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockCreateClient().from(...args),
  },
}));
jest.mock("@/lib/conversions/meta-conversion-intent", () => ({
  prepareMetaConversionIntent: jest
    .fn()
    .mockResolvedValue({
      meta_delivery_status: "not_eligible",
      meta_delivery_snapshot: null,
      meta_delivery_reason: "not_configured",
    }),
}));
const mockConnectDB = jest.fn();
jest.mock("@/lib/conversions/confirmed-payment-scenario", () => ({
  prepareConfirmedPaymentScenarioIntent: jest
    .fn()
    .mockResolvedValue({
      scenario_effect_status: "not_applicable",
      scenario_effect_snapshot: null,
      scenario_effect_reason: "no_matching_payment_wait",
    }),
}));
const mockCreateClient = jest.fn();
const mockConversationFindById = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockEnsureCustomerForConversation = jest.fn();
const mockRecordCustomerConversionEvent = jest.fn();
const mockInsertConversion = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));

jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: (...args: unknown[]) =>
    mockEnsureCustomerForConversation(...args),
  recordCustomerConversionEvent: (...args: unknown[]) =>
    mockRecordCustomerConversionEvent(...args),
}));

import { POST } from "@/app/api/conversions/route";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

function buildCurrentConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    workspaceId: "ws-1",
    channel: "whatsapp",
    handled_by_agent_id: null,
    customerId: "customer-1",
    internal_labels: [],
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
    airi_scenario_state: {
      lockedScenarioId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      lockedScenarioName: "Retention flow",
      currentActionNodeId: "action-1",
      currentBranchNodeIds: [],
      lastMatchedAt: new Date(Date.now() - 60000),
    },
    ...overrides,
  };
}

function buildSupabaseClient() {
  const membershipQuery: {
    select: jest.Mock;
    eq: jest.Mock;
    maybeSingle: jest.Mock;
  } = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: { workspace_id: "ws-1" },
      error: null,
    }),
  };
  membershipQuery.select.mockReturnValue(membershipQuery);
  membershipQuery.eq.mockReturnValue(membershipQuery);

  const conversionQuery: {
    insert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  } = {
    insert: mockInsertConversion,
    select: jest.fn(),
    single: jest.fn().mockResolvedValue({
      data: {
        id: "conversion-1",
        converted_at: "2026-08-10T12:00:00.000Z",
      },
      error: null,
    }),
  };
  conversionQuery.select.mockReturnValue(conversionQuery);
  mockInsertConversion.mockImplementation(() => conversionQuery);

  return {
    auth: supabaseAuth(),
    from: jest.fn((table: string) =>
      table === "company_users" ? membershipQuery : conversionQuery
    ),
  };
}

function conversionRequest() {
  return new Request("http://localhost/api/conversions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: "507f1f77bcf86cd799439011",
      conversionType: "sale",
      conversionValue: 50,
    }),
  });
}

describe("conversion classification freshness", () => {
  let conversation: ReturnType<typeof buildCurrentConversation>;

  beforeEach(() => {
    jest.clearAllMocks();
    conversation = buildCurrentConversation();
    mockCreateClient.mockReturnValue(buildSupabaseClient());
    mockConnectDB.mockResolvedValue(undefined);
    mockConversationFindById.mockImplementation(() =>
      Promise.resolve(conversation)
    );
    mockScenarioFindOne.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue({
          workspaceId: "ws-1",
          presetId: "preset-1",
          segmentKey: "retention",
        }),
      })),
    });
    mockEnsureCustomerForConversation.mockResolvedValue({
      _id: "customer-1",
    });
    mockRecordCustomerConversionEvent.mockResolvedValue({ _id: "event-1" });
  });

  it("uses a current classifier category before the scenario fallback", async () => {
    const response = await POST(conversionRequest());

    expect(response.status).toBe(200);
    expect(mockInsertConversion.mock.calls[0]?.[0].metadata.segment).toBe(
      "active"
    );
  });

  it("treats stale classifier category as absent and falls through to scenario", async () => {
    conversation = buildCurrentConversation({
      classification_state: {
        contractVersion: 2,
        status: "ready",
        requestedRevision: 7,
        appliedRevision: 6,
      },
    });

    const response = await POST(conversionRequest());

    expect(response.status).toBe(200);
    expect(mockInsertConversion.mock.calls[0]?.[0].metadata.segment).toBe(
      "retention"
    );
  });

  it("keeps manual segment precedence when classification is stale", async () => {
    conversation = buildCurrentConversation({
      internal_labels: ["override:segment_locked", "seg:sales_qualified"],
      classification_revision: 7,
    });

    const response = await POST(conversionRequest());

    expect(response.status).toBe(200);
    expect(mockInsertConversion.mock.calls[0]?.[0].metadata.segment).toBe(
      "sales_qualified"
    );
  });
});
