const mockGetAuthenticatedWorkspaceMembership = jest.fn();
const mockGetCampaignDispatchBatchAggregates = jest.fn();
const mockCreateClient = jest.fn();
const mockSupabaseAdminFrom = jest.fn();
const mockAttachWhatsAppCampaignReplyStats: jest.Mock = jest.fn(
  async () => new Map()
);

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetAuthenticatedWorkspaceMembership(...args),
}));

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  getCampaignDispatchBatchAggregates: (...args: unknown[]) =>
    mockGetCampaignDispatchBatchAggregates(...args),
  isMissingOptionalCampaignLinkageColumnError: jest.fn(() => false),
}));

jest.mock("@/lib/campaign/campaign-reply-stats", () => ({
  attachWhatsAppCampaignReplyStats: (...args: unknown[]) =>
    mockAttachWhatsAppCampaignReplyStats(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    kind: "service-role",
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
  },
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { NextResponse } from "next/server";

import { GET, POST } from "./route";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

function createSupabaseMock(options?: {
  hasEmailCampaigns?: boolean;
  campaign?: Record<string, unknown>;
}) {
  let selectedCampaignHistoryColumns = "";
  let selectedCampaignMessageColumns = "";
  const campaignRow = {
    id: CAMPAIGN_ID,
    workspace_id: WORKSPACE_ID,
    name: "July follow-up",
    channel: "whatsapp",
    template_name: "july_follow_up",
    template_language: "en",
    message_text: null,
    total_recipients: 6,
    successful_sends: 0,
    failed_sends: 6,
    sent_at: "2026-07-24T09:36:49.234683+00:00",
    estimated_cost: 1.2,
    cost_coverage_started_at: "2026-10-02T00:00:00Z",
    unknown_cost_count: 0,
    delivery_rate: 0,
    read_rate: 0,
    open_rate: null,
    click_rate: null,
    unsubscribe_rate: null,
    bounce_rate: null,
    dispatch_status: "failed",
    requested_at: "2026-07-24T09:35:00.000Z",
    scheduled_at: null,
    dispatch_expires_at: "2026-07-24T09:50:00.000Z",
    started_at: "2026-07-24T09:35:05.000Z",
    progress_at: "2026-07-24T09:36:49.000Z",
    finished_at: "2026-07-24T09:36:49.000Z",
    cancelled_at: null,
    expired_at: null,
    processed_count: 6,
    accepted_count: 0,
    attempted_count: 6,
    not_attempted_count: 0,
    stop_reason: "provider_circuit_open",
    provider_circuit_state: "open",
    provider_circuit_provider: "meta",
    provider_circuit_code: "131042",
    provider_circuit_opened_at: "2026-07-24T09:36:49.000Z",
    retry_of_campaign_id: null,
    retry_kind: null,
    // These emulate private ledger fields that must never be spread into JSON.
    workflow_id: "bulk-campaign:private",
    audience_fingerprint: "a".repeat(64),
    audience_hash_version: "v1",
    audience_original_filename: "private.csv",
    provider_circuit_acknowledged_by: "private-user",
    ...options?.campaign,
  };

  type CampaignHistoryQueryMock = {
    select: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    range: jest.Mock;
    limit: jest.Mock;
  };
  const campaignHistoryQuery: CampaignHistoryQueryMock = {
    select: jest.fn((columns: string): CampaignHistoryQueryMock => {
      selectedCampaignHistoryColumns = columns;
      return campaignHistoryQuery;
    }),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockResolvedValue({
      data: [campaignRow],
      error: null,
      count: 1,
    }),
    limit: jest.fn().mockResolvedValue({
      data: options?.hasEmailCampaigns ? [{ id: CAMPAIGN_ID }] : [],
      error: null,
    }),
  };

  type CampaignMessagesQueryMock = {
    select: jest.Mock;
    in: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
  };
  const campaignMessagesQuery: CampaignMessagesQueryMock = {
    select: jest.fn((columns: string): CampaignMessagesQueryMock => {
      selectedCampaignMessageColumns = columns;
      return campaignMessagesQuery;
    }),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({
      data: [
        {
          id: "message-row-1",
          campaign_id: CAMPAIGN_ID,
          message_id: "wamid-1",
          channel: "whatsapp",
          recipient: "77077778624",
          phone: "77077778624",
          provider: "meta",
          status: "failed",
          error_code: "131042",
          error_message: "Business eligibility payment issue",
          failure_reason: null,
          created_at: "2026-07-24T09:36:49.234683+00:00",
          updated_at: "2026-07-24T09:36:50.234683+00:00",
          recipient_hash: "b".repeat(64),
          dispatch_snapshot: { accessToken: "must-not-leak" },
        },
      ],
      error: null,
    }),
  };

  const supabase = {
    from: jest.fn((table: string) => {
      if (table === "campaign_history") return campaignHistoryQuery;
      if (table === "campaign_messages") return campaignMessagesQuery;
      throw new Error(`Unexpected Supabase table: ${table}`);
    }),
  };

  return {
    supabase,
    campaignHistoryQuery,
    campaignMessagesQuery,
    selectedColumns: () => ({
      history: selectedCampaignHistoryColumns,
      messages: selectedCampaignMessageColumns,
    }),
  };
}

function aggregate() {
  return {
    delivery: {
      pending: 0,
      accepted: 0,
      delivered: 0,
      read: 0,
      failed: 6,
    },
    topFailure: {
      reason: "Business eligibility payment issue",
      errorCode: 131042,
      count: 6,
    },
    retryableFailedRecipientCount: 6,
    providerCircuit: {
      state: "open",
      provider: "meta",
      code: "131042",
      failureCount: 6,
    },
  };
}

describe("GET /api/campaigns/history", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCampaignDispatchBatchAggregates.mockResolvedValue(
      new Map([[CAMPAIGN_ID, aggregate()]])
    );
  });

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ])("preserves membership authorization status %s", async (status, error) => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      error: NextResponse.json({ error }, { status }),
    });

    const response = await GET(
      new Request(
        `https://airi.test/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
      )
    );

    expect(response.status).toBe(status);
    expect(mockGetCampaignDispatchBatchAggregates).not.toHaveBeenCalled();
  });

  it("serializes an explicit public history shape and batches operation aggregates once", async () => {
    const fixture = createSupabaseMock();
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      user: { id: "33333333-3333-4333-8333-333333333333" },
      membership: { role: "manager" },
      supabase: fixture.supabase,
    });

    const request = new Request(
      `https://airi.test/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockGetCampaignDispatchBatchAggregates).toHaveBeenCalledTimes(1);
    expect(mockGetCampaignDispatchBatchAggregates).toHaveBeenCalledWith({
      supabase: expect.objectContaining({ kind: "service-role" }),
      workspaceId: WORKSPACE_ID,
      campaignIds: [CAMPAIGN_ID],
    });
    expect(mockAttachWhatsAppCampaignReplyStats).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, signal: request.signal })
    );
    const payload = await response.json();
    expect(payload.campaigns[0]).toEqual(
      expect.objectContaining({
        id: CAMPAIGN_ID,
        name: "July follow-up",
        failure_summary: {
          failedCount: 6,
          topReason: "Business eligibility payment issue",
          topErrorCode: 131042,
          reasons: [
            {
              reason: "Business eligibility payment issue",
              count: 6,
              errorCode: 131042,
            },
          ],
        },
        operation: expect.objectContaining({
          campaignId: CAMPAIGN_ID,
          status: "failed",
          delivery: {
            pending: 0,
            accepted: 0,
            delivered: 0,
            read: 0,
            failed: 6,
          },
          canCancel: false,
          paused: false,
          retry: {
            ofCampaignId: null,
            kind: null,
            failedRecipientCount: 6,
            available: true,
          },
        }),
      })
    );
    expect(payload.campaigns[0].messages).toEqual([
      expect.objectContaining({
        recipient: "77077778624",
        status: "failed",
        error_code: 131042,
      }),
    ]);
    const serialized = JSON.stringify(payload.campaigns[0]);
    expect(serialized).not.toContain("workflow_id");
    expect(serialized).not.toContain("audience_fingerprint");
    expect(serialized).not.toContain("dispatch_snapshot");
    expect(serialized).not.toContain("recipient_hash");
    expect(fixture.selectedColumns().history.trim()).not.toBe("*");
    expect(fixture.selectedColumns().history).not.toContain(
      "audience_fingerprint"
    );
    expect(fixture.selectedColumns().messages).not.toContain(
      "dispatch_snapshot"
    );
  });

  it("marks aggregates unavailable instead of fabricating zero delivery counts", async () => {
    const fixture = createSupabaseMock();
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      user: { id: "33333333-3333-4333-8333-333333333333" },
      membership: { role: "manager" },
      supabase: fixture.supabase,
    });
    mockGetCampaignDispatchBatchAggregates.mockRejectedValue(
      new Error("RPC unavailable")
    );

    const response = await GET(
      new Request(
        `https://airi.test/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
      )
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.campaigns[0].operation).toBeNull();
    expect(payload.campaigns[0].failure_summary).toBeNull();
  });

  it.each([
    {
      label: "bounced-only",
      deliveryFailed: 2,
      retryableFailed: 0,
      available: false,
    },
    {
      label: "mixed failed and bounced",
      deliveryFailed: 3,
      retryableFailed: 1,
      available: true,
    },
  ])(
    "keeps history retry availability truthful for $label failures",
    async ({ deliveryFailed, retryableFailed, available }) => {
      const fixture = createSupabaseMock();
      mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
        user: { id: "33333333-3333-4333-8333-333333333333" },
        membership: { role: "manager" },
        supabase: fixture.supabase,
      });
      mockGetCampaignDispatchBatchAggregates.mockResolvedValue(
        new Map([
          [
            CAMPAIGN_ID,
            {
              ...aggregate(),
              delivery: {
                ...aggregate().delivery,
                failed: deliveryFailed,
              },
              retryableFailedRecipientCount: retryableFailed,
              providerCircuit: { state: "closed" },
            },
          ],
        ])
      );

      const response = await GET(
        new Request(
          `https://airi.test/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
        )
      );
      const payload = await response.json();

      expect(payload.campaigns[0].operation.delivery.failed).toBe(
        deliveryFailed
      );
      expect(payload.campaigns[0].operation.retry).toEqual({
        ofCampaignId: null,
        kind: null,
        failedRecipientCount: retryableFailed,
        available,
      });
    }
  );

  it.each([
    [
      "a covered campaign reports its amount",
      {},
      {
        estimated_cost: 1.2,
        cost_status: "reported",
        unpriced_message_count: 0,
      },
    ],
    [
      "unpriced delivered messages are counted instead of a blank cost",
      {
        estimated_cost: null,
        cost_coverage_started_at: "2026-10-03T09:00:00Z",
        unknown_cost_count: 239,
      },
      {
        estimated_cost: null,
        cost_status: "not_priced",
        unpriced_message_count: 239,
      },
    ],
    [
      "a legacy estimate stays hidden and is labelled as untracked",
      {
        estimated_cost: 13.95,
        cost_coverage_started_at: null,
        unknown_cost_count: 0,
      },
      {
        estimated_cost: null,
        cost_status: "not_tracked",
        unpriced_message_count: null,
      },
    ],
    [
      "non-WhatsApp channels carry no WhatsApp cost status",
      { channel: "email", estimated_cost: null },
      { estimated_cost: null, cost_status: null, unpriced_message_count: null },
    ],
  ])("%s", async (_name, campaign, expected) => {
    const fixture = createSupabaseMock({ campaign });
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      user: { id: "33333333-3333-4333-8333-333333333333" },
      membership: { role: "manager" },
      supabase: fixture.supabase,
    });

    const response = await GET(
      new Request(
        `https://airi.test/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
      )
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.campaigns[0]).toEqual(expect.objectContaining(expected));
    expect(JSON.stringify(payload.campaigns[0])).not.toContain(
      "unknown_cost_count"
    );
  });

  it("reports email presence for the workspace independently of pagination", async () => {
    const fixture = createSupabaseMock({ hasEmailCampaigns: true });
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      user: { id: "33333333-3333-4333-8333-333333333333" },
      membership: { role: "manager" },
      supabase: fixture.supabase,
    });

    const response = await GET(
      new Request(
        `https://airi.test/api/campaigns/history?workspaceId=${WORKSPACE_ID}`
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ hasEmailCampaigns: true })
    );
  });
});

describe("POST /api/campaigns/history", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects legacy direct history writes", async () => {
    const response = await POST();

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({
      code: "campaign_history_write_disabled",
      error:
        "Campaign history is written only by canonical campaign admission.",
    });
    expect(mockSupabaseAdminFrom).not.toHaveBeenCalled();
  });
});
