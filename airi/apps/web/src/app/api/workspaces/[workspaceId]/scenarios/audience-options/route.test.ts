const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockEnsureIndexes = jest.fn();
const mockConnectDB = jest.fn();
const mockLoggerError = jest.fn();
const mockConversationDistinct = jest.fn();
const mockConversationAggregate = jest.fn();
const mockFetchLiveMetaReferralAudience = jest.fn();
const mockSupabaseFrom = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongo", () => ({
  ensureIndexes: (...args: unknown[]) => mockEnsureIndexes(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/meta-ads/meta-ads-audience", () => ({
  fetchLiveMetaReferralAudience: (...args: unknown[]) =>
    mockFetchLiveMetaReferralAudience(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    distinct: (...args: unknown[]) => mockConversationDistinct(...args),
    aggregate: (...args: unknown[]) => mockConversationAggregate(...args),
  },
}));

import { CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS } from "@icecore/shared/lib/conversation-classification-freshness";

import { GET } from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

function currentRawCustomer(overrides: Record<string, unknown> = {}) {
  return {
    _id: "customer-current",
    channel: "whatsapp",
    chat: "77000000002",
    classificationCategory: "active",
    isClassified: true,
    classificationRevision: 7,
    classificationStateContractVersion: 2,
    classificationStateStatus: "ready",
    classificationStateRequestedRevision: 7,
    classificationStateAppliedRevision: 7,
    classificationMetaSourceRevision: 7,
    classificationMetaProvenanceKind: "v2",
    classificationMetaAnalysisRevisionId: "analysis-current",
    internalLabels: [],
    estimatedCustomerLtv: 0,
    revenueAttributionId: null,
    lastMessageAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /api/workspaces/[workspaceId]/scenarios/audience-options", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: { from: (...args: unknown[]) => mockSupabaseFrom(...args) },
    });
    mockEnsureIndexes.mockResolvedValue(undefined);
    mockConnectDB.mockResolvedValue(undefined);
    mockFetchLiveMetaReferralAudience.mockResolvedValue({
      ads: [],
      campaigns: [],
      adSets: [],
      dataStatus: { state: "complete", reasons: [] },
    });
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "taxonomies") {
        return createSupabaseQueryMock({
          data: { labels: ["Support", "Sales", "Support", " "] },
          error: null,
        });
      }
      if (table === "internal_labels") {
        return createSupabaseQueryMock({
          data: [{ name: "stage:active" }],
          error: null,
        });
      }
      return createSupabaseQueryMock({ data: [], error: null });
    });
    mockConversationDistinct.mockImplementation(async (path: string) =>
      path === "classification.category"
        ? ["Stored stale category"]
        : ["seg:retention"]
    );
    mockConversationAggregate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
  });

  it("uses only normalized workspace taxonomy labels for category options", async () => {
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.options.classificationCategories).toEqual([
      "Sales",
      "Support",
    ]);
    expect(mockConversationDistinct).not.toHaveBeenCalledWith(
      "classification.category",
      expect.anything()
    );
    expect(payload.options.internalLabels).toEqual([
      "seg:retention",
      "stage:active",
    ]);
  });

  it("keeps Facebook and unknown-platform referrals and does not attribute live creatives to Instagram", async () => {
    mockSupabaseFrom.mockImplementation(() =>
      createSupabaseQueryMock({
        data: [{ type: "meta_ads", credentials: {} }],
        error: null,
      })
    );
    mockFetchLiveMetaReferralAudience.mockResolvedValue({
      ads: [
        {
          sourceId: "live-ad",
          sourceType: "ad",
          sourceUrl: "https://instagram.com/p/creative",
        },
      ],
      campaigns: [],
      adSets: [],
      dataStatus: { state: "complete", reasons: [] },
    });
    mockConversationAggregate
      .mockReset()
      .mockResolvedValueOnce([
        {
          sourceId: "facebook-ad",
          sourceType: "ad",
          sourceUrl: "https://facebook.com/ads/1",
          channel: "whatsapp",
        },
        { sourceId: "unknown-ad", sourceType: "ad", channel: "whatsapp" },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    const { options } = await response.json();
    expect(options.metaReferralAds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "facebook-ad",
          sourcePlatform: "facebook",
          channel: "whatsapp",
        }),
        expect.objectContaining({
          sourceId: "unknown-ad",
          label: "Meta ad own-ad",
        }),
        expect.objectContaining({ sourceId: "live-ad" }),
      ])
    );
    expect(
      options.metaReferralAds.find(
        (ad: { sourceId: string }) => ad.sourceId === "live-ad"
      )
    ).not.toHaveProperty("sourcePlatform");
    expect(
      options.metaReferralAds.find(
        (ad: { sourceId: string }) => ad.sourceId === "unknown-ad"
      )
    ).not.toHaveProperty("sourcePlatform");
  });

  it("retains more than 100 campaigns and propagates partial provider results", async () => {
    mockSupabaseFrom.mockImplementation(() =>
      createSupabaseQueryMock({
        data: [{ type: "meta_ads", credentials: {} }],
        error: null,
      })
    );
    mockFetchLiveMetaReferralAudience.mockResolvedValue({
      ads: [],
      adSets: [],
      campaigns: Array.from({ length: 201 }, (_, i) => ({
        campaignId: `campaign-${i}`,
      })),
      dataStatus: { state: "partial", reasons: ["provider_error"] },
    });
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    const { options } = await response.json();
    expect(options.metaReferralCampaigns).toHaveLength(201);
    expect(options.metaAdsDataStatus).toEqual({
      state: "partial",
      reasons: ["provider_error"],
    });
  });

  it("reports the bounded response limit rather than silently hiding campaigns", async () => {
    mockSupabaseFrom.mockImplementation(() =>
      createSupabaseQueryMock({
        data: [{ type: "meta_ads", credentials: {} }],
        error: null,
      })
    );
    mockFetchLiveMetaReferralAudience.mockResolvedValue({
      ads: [],
      adSets: [],
      campaigns: Array.from({ length: 1001 }, (_, i) => ({
        campaignId: `campaign-${i}`,
      })),
      dataStatus: { state: "complete", reasons: [] },
    });
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    const { options } = await response.json();
    expect(options.metaReferralCampaigns).toHaveLength(1000);
    expect(options.metaAdsDataStatus).toEqual({
      state: "partial",
      reasons: ["limit_reached"],
    });
  });

  it("preserves history when one connected catalog cannot be read", async () => {
    mockSupabaseFrom.mockImplementation(() =>
      createSupabaseQueryMock({
        data: [{ type: "meta_ads", credentials: {} }],
        error: null,
      })
    );
    mockFetchLiveMetaReferralAudience.mockRejectedValue(
      new Error("Cannot read connection")
    );
    mockConversationAggregate
      .mockReset()
      .mockResolvedValueOnce([
        {
          sourceId: "observed-ad",
          campaignId: "observed-campaign",
          sourceType: "ad",
          channel: "whatsapp",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    expect(response.status).toBe(200);
    const { options } = await response.json();
    expect(options.metaReferralCampaigns).toEqual([
      expect.objectContaining({ campaignId: "observed-campaign" }),
    ]);
    expect(options.metaAdsDataStatus).toEqual({
      state: "partial",
      reasons: ["provider_error"],
    });
  });

  it("projects every freshness path before grouping and omits only stale customer classification", async () => {
    mockConversationAggregate
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        currentRawCustomer({
          _id: "customer-stale",
          chat: "77000000001",
          classificationCategory: "churn_risk",
          isClassified: false,
          internalLabels: ["seg:retention"],
          estimatedCustomerLtv: 100,
        }),
        currentRawCustomer(),
      ]);

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.options.customers).toEqual([
      expect.objectContaining({
        id: "customer-stale",
        segmentKey: "retention",
        hasPurchaseHistory: true,
      }),
      expect.objectContaining({
        id: "customer-current",
        category: "active",
        segmentKey: "active",
      }),
    ]);
    expect(payload.options.customers[0]).not.toHaveProperty("category");

    const rawCustomerPipeline = mockConversationAggregate.mock.calls[2]?.[0] as
      | Array<Record<string, Record<string, unknown>>>
      | undefined;
    const project = rawCustomerPipeline?.find(
      stage => stage.$project
    )?.$project;
    const group = rawCustomerPipeline?.find(stage => stage.$group)?.$group;
    expect(project).toBeDefined();
    expect(group).toBeDefined();

    const requiredSourcePaths = [
      "$classification.category",
      ...CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS.map(
        path => `$${path}`
      ),
    ];
    const projectedEntries = Object.entries(project || {}).filter(([, value]) =>
      requiredSourcePaths.includes(String(value))
    );
    expect(projectedEntries.map(([, value]) => value)).toEqual(
      requiredSourcePaths
    );
    for (const [alias] of projectedEntries) {
      expect(group?.[alias]).toEqual({ $first: `$${alias}` });
    }
    expect(JSON.stringify(rawCustomerPipeline)).not.toContain("$$ROOT");
    expect(JSON.stringify(rawCustomerPipeline)).not.toContain("$cond");
  });

  it("answers without waiting for a cold instance's index setup", async () => {
    let finishIndexes = () => {};
    mockEnsureIndexes.mockReturnValue(
      new Promise<void>(resolve => {
        finishIndexes = resolve;
      })
    );

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockEnsureIndexes).toHaveBeenCalledTimes(1);
    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockConnectDB.mock.invocationCallOrder[0]).toBeLessThan(
      mockConversationDistinct.mock.invocationCallOrder[0] ?? 0
    );
    finishIndexes();
  });

  it("still answers when index setup fails, and reports the failure", async () => {
    const failure = new Error("index conflict");
    mockEnsureIndexes.mockRejectedValue(failure);

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(response.status).toBe(200);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "scenarios.audience_options_index_setup_failed",
      failure,
      { workspaceId: "workspace-1" }
    );
  });

  it("does not start index setup for a request that fails the access check", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(403);
    expect(mockEnsureIndexes).not.toHaveBeenCalled();
    expect(mockConnectDB).not.toHaveBeenCalled();
  });
});
