import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { NextRequest } from "next/server";

import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";

const mockConnectDB = jest.fn(async () => undefined);
const mockRequireScenarioWorkspaceAccess = jest.fn(async () => ({
  ok: true,
}));
const mockResolveBulkAnalyticsAudience = jest.fn();
const mockFilterPriorFailedBulkCampaignCandidates = jest.fn();
const mockFilterKnownMarketingOptOutRecipients = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockResolveCampaignBatchPlanPreview = jest.fn();
const mockResolveApprovedTemplate = jest.fn();
const mockPartitionRecentlyContactedRecipients = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockResolveConversationHistory = jest.fn();
const mockParseBulkAnalyticsAudienceFiltersFromSearchParams = jest.fn(
  () => ({})
);

class MockBulkAnalyticsAudienceUnavailableError extends Error {
  code = "campaign_send_audience_rollup_required";

  constructor(message = "Campaign-send audience preview requires a rollup") {
    super(message);
    this.name = "BulkAnalyticsAudienceUnavailableError";
  }
}

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
  connectDB: () => mockConnectDB(),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: () => mockRequireScenarioWorkspaceAccess(),
}));

jest.mock("@/lib/analytics/bulk-analytics-audience", () => ({
  BulkAnalyticsAudienceUnavailableError:
    MockBulkAnalyticsAudienceUnavailableError,
  parseBulkAnalyticsAudienceFiltersFromSearchParams: () =>
    mockParseBulkAnalyticsAudienceFiltersFromSearchParams(),
  resolveBulkAnalyticsAudience: (...args: unknown[]) =>
    mockResolveBulkAnalyticsAudience(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { client: "supabase-admin" },
}));

jest.mock("@/lib/campaign/prior-failed-recipient-filter", () => ({
  filterPriorFailedBulkCampaignCandidates: (...args: unknown[]) =>
    mockFilterPriorFailedBulkCampaignCandidates(...args),
}));

jest.mock("@/lib/campaign/marketing-opt-in", () => ({
  filterKnownMarketingOptOutRecipients: (...args: unknown[]) =>
    mockFilterKnownMarketingOptOutRecipients(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/lib/campaign/campaign-batch-plan", () => ({
  resolveCampaignBatchPlanPreview: (...args: unknown[]) =>
    mockResolveCampaignBatchPlanPreview(...args),
}));

jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  resolveApprovedWhatsAppTemplateForSend: (...args: unknown[]) =>
    mockResolveApprovedTemplate(...args),
}));

jest.mock("@/lib/campaign/whatsapp-bulk-preflight", () => ({
  resolveWhatsAppConversationHistoryEligibility: (...args: unknown[]) =>
    mockResolveConversationHistory(...args),
}));

jest.mock("@/lib/campaign/customer-contact-policy", () => ({
  partitionRecentlyContactedRecipients: (...args: unknown[]) =>
    mockPartitionRecentlyContactedRecipients(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  readCompanyBulkRecipientAllowance: jest.fn(async () => ({
    limit: { subscriptionType: "pro", bulkRecipientLimit: null },
    remaining: null,
  })),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

const canonicalIntent = "sourceId=source-1&templateName=offer&language=en";

function previewUrl(query = "") {
  return `https://airi.chat/api/workspaces/ws-1/analytics/bulk/audience-preview?${canonicalIntent}${
    query ? `&${query}` : ""
  }`;
}

describe("bulk analytics audience preview route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_SECRET = "test-bulk-campaign-encryption-secret";
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }) => ({
        recipients,
        skippedRecipients: [],
        skippedOptIn: 0,
        skippedPhones: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningRecipients: [],
        marketingOptInWarningPhones: [],
      })
    );
    mockFilterPriorFailedBulkCampaignCandidates.mockImplementation(
      async ({ candidates }) => ({ candidates, skippedPriorFailed: 0 })
    );
    mockResolveWhatsAppSendContext.mockResolvedValue({
      workspaceId: "ws-1",
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      accessToken: "token-1",
    });
    mockResolveCampaignBatchPlanPreview.mockResolvedValue({
      channel: "whatsapp",
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      },
      recipientLimit: {
        maxRecipients: 50_000,
        source: "live_meta",
      },
    });
    mockResolveApprovedTemplate.mockResolvedValue({
      template: {
        name: "offer",
        language: "en",
        status: "APPROVED",
        category: "UTILITY",
      },
      sameNameLanguages: ["en"],
      source: "live",
    });
    mockResolveConversationHistory.mockImplementation(
      async ({ phones }: { phones: string[] }) => ({
        eligiblePhones: phones,
        skippedPhones: [],
      })
    );
    mockPartitionRecentlyContactedRecipients.mockImplementation(
      async ({ recipients }: { recipients: Array<{ phone: string }> }) => ({
        allowed: recipients,
        recentlyContacted: [],
        nextEligibleAt: null,
      })
    );
  });

  it("returns a controlled unavailable preview when the audience would require the old messages aggregate", async () => {
    mockResolveBulkAnalyticsAudience.mockRejectedValue(
      new MockBulkAnalyticsAudienceUnavailableError()
    );

    const { GET } = await import("./route");
    const response = await GET(new NextRequest(previewUrl()), {
      params: Promise.resolve({ workspaceId: "ws-1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        available: false,
        reason: "campaign_send_audience_rollup_required",
        total: 0,
        eligibleTotal: 0,
        capped: false,
      })
    );
    expect(mockConnectDB).toHaveBeenCalledTimes(1);
  });

  it("ignores an observed Analytics preview limit and uses the live plan", async () => {
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 1,
      eligibleTotal: 1,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients: [{ phone: "+15550000001" }],
      capped: false,
      maxRecipients: 50_000,
    });
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce({
      channel: "whatsapp",
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      },
      recipientLimit: { maxRecipients: 1, source: "live_meta" },
    });
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(previewUrl("maxRecipients=50001")),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ maxRecipients: 1, eligibleTotal: 1 })
    );
  });

  it("returns an exact Analytics preview after prior-failure exclusion", async () => {
    const recipients = [
      {
        phone: "+15550000001",
        conversationId: "conversation-1",
        optedIn: true,
      },
      {
        phone: "+15550000002",
        conversationId: "conversation-2",
        optedIn: true,
      },
    ];
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 2,
      eligibleTotal: 2,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients,
      capped: false,
      maxRecipients: 50_000,
    });
    mockFilterPriorFailedBulkCampaignCandidates.mockImplementationOnce(
      async ({ candidates, recipientFor }) => ({
        candidates: candidates.filter(
          (candidate: unknown) =>
            recipientFor(candidate).phone === recipients[1].phone
        ),
        skippedPriorFailed: 1,
      })
    );
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(previewUrl("excludePriorFailedBulkSends=1")),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterPriorFailedBulkCampaignCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        client: { client: "supabase-admin" },
        secret: "test-bulk-campaign-encryption-secret",
        workspaceId: "ws-1",
        channel: "whatsapp",
        candidates: expect.any(Array),
        recipientFor: expect.any(Function),
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        available: true,
        total: 2,
        eligibleTotal: 1,
        excludedOptIn: 0,
        marketingOptInWarningCount: 0,
        skippedPriorFailed: 1,
        capped: false,
        maxRecipients: 50_000,
      })
    );
  });

  it("previews Analytics fill-up recipients through the authoritative merge before exclusion", async () => {
    const baseRecipients = [
      { phone: "+15550000001", conversationId: "conversation-1" },
      { phone: "+15550000002", conversationId: "conversation-2" },
    ];
    const fillUpRecipients = [
      { phone: "+15550000002", name: "Duplicate" },
      { phone: "+15550000003", name: "New" },
    ];
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 2,
      eligibleTotal: 2,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients: baseRecipients,
      capped: false,
      maxRecipients: 50_000,
    });
    mockFilterPriorFailedBulkCampaignCandidates.mockImplementationOnce(
      async ({ candidates, recipientFor }) => ({
        candidates: candidates.filter(
          (candidate: unknown) =>
            recipientFor(candidate).phone !== "+15550000001"
        ),
        skippedPriorFailed: 1,
      })
    );

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(previewUrl("excludePriorFailedBulkSends=1"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fillUpRecipients }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    const priorFailureInput =
      mockFilterPriorFailedBulkCampaignCandidates.mock.calls[0][0];
    expect(
      priorFailureInput.candidates.map(priorFailureInput.recipientFor)
    ).toEqual([baseRecipients[0], baseRecipients[1], fillUpRecipients[1]]);
    expect(payload).toEqual(
      expect.objectContaining({
        eligibleTotal: 2,
        skippedPriorFailed: 1,
      })
    );
  });

  it("applies the WhatsApp recipient limit before prior-failure exclusion", async () => {
    const baseRecipients = [
      { phone: "+15550000001", conversationId: "conversation-1" },
      { phone: "+15550000002", conversationId: "conversation-2" },
    ];
    const fillUpRecipient = { phone: "+15550000003", name: "Fill up" };
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 2,
      eligibleTotal: 2,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients: baseRecipients,
      capped: false,
      maxRecipients: 50_000,
    });
    mockFilterPriorFailedBulkCampaignCandidates.mockImplementationOnce(
      async ({ candidates, recipientFor }) => ({
        candidates: candidates.filter(
          (candidate: unknown) =>
            recipientFor(candidate).phone !== "+15550000001"
        ),
        skippedPriorFailed: 1,
      })
    );
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce({
      channel: "whatsapp",
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      },
      recipientLimit: { maxRecipients: 2, source: "live_meta" },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(
        previewUrl("excludePriorFailedBulkSends=1&maxRecipients=500"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fillUpRecipients: [fillUpRecipient] }),
        }
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    const limitPriorFailureInput =
      mockFilterPriorFailedBulkCampaignCandidates.mock.calls[0][0];
    expect(
      limitPriorFailureInput.candidates.map(limitPriorFailureInput.recipientFor)
    ).toEqual(baseRecipients);
    expect(payload).toEqual(
      expect.objectContaining({
        eligibleTotal: 1,
        skippedPriorFailed: 1,
        capped: false,
        recipientLimitTruncated: true,
        maxRecipients: 2,
      })
    );
  });

  it("applies marketing opt-outs before the limit and prior-failure exclusion", async () => {
    const optedOutRecipient = {
      phone: "+15550000001",
      conversationId: "conversation-1",
    };
    const priorFailedRecipient = {
      phone: "+15550000002",
      conversationId: "conversation-2",
    };
    const fillUpRecipient = { phone: "+15550000003", name: "Fill up" };
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 2,
      eligibleTotal: 2,
      excludedOptIn: 0,
      marketingOptInWarningCount: 2,
      recipients: [optedOutRecipient, priorFailedRecipient],
      capped: false,
      maxRecipients: 50_000,
    });
    mockFilterKnownMarketingOptOutRecipients.mockImplementationOnce(
      async ({ recipients }) => ({
        recipients: [recipients[1], recipients[2]],
        skippedRecipients: [recipients[0]],
        skippedOptIn: 1,
        skippedPhones: [optedOutRecipient.phone],
        marketingOptInWarningCount: 1,
        marketingOptInWarningRecipients: [recipients[2]],
        marketingOptInWarningPhones: [fillUpRecipient.phone],
      })
    );
    mockFilterPriorFailedBulkCampaignCandidates.mockImplementationOnce(
      async ({ candidates, recipientFor }) => ({
        candidates: candidates.filter(
          (candidate: unknown) =>
            recipientFor(candidate).phone === fillUpRecipient.phone
        ),
        skippedPriorFailed: 1,
      })
    );
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce({
      channel: "whatsapp",
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      },
      recipientLimit: { maxRecipients: 2, source: "live_meta" },
    });
    mockResolveApprovedTemplate.mockResolvedValueOnce({
      template: {
        name: "offer",
        language: "en",
        status: "APPROVED",
        category: "MARKETING",
      },
      sameNameLanguages: ["en"],
      source: "live",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(
        previewUrl(
          "templateCategory=MARKETING&excludePriorFailedBulkSends=1&maxRecipients=2"
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fillUpRecipients: [fillUpRecipient] }),
        }
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(payload).toMatchObject({ state: "ready" });
    // Contact windows are checked for every marketing recipient that is
    // not opted out, before the cap and prior-failure stages.
    expect(mockPartitionRecentlyContactedRecipients).toHaveBeenCalledTimes(1);
    expect(mockPartitionRecentlyContactedRecipients).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipients: [
        expect.objectContaining({ phone: priorFailedRecipient.phone }),
        expect.objectContaining({ phone: fillUpRecipient.phone }),
      ],
      now: expect.any(Date),
    });
    expect(mockFilterKnownMarketingOptOutRecipients).toHaveBeenCalledTimes(1);
    expect(mockFilterKnownMarketingOptOutRecipients).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      recipients: [optedOutRecipient, priorFailedRecipient, fillUpRecipient],
    });
    const consentResult =
      await mockFilterKnownMarketingOptOutRecipients.mock.results[0].value;
    expect(consentResult.marketingOptInWarningRecipients).toEqual([
      fillUpRecipient,
    ]);
    expect(consentResult.marketingOptInWarningRecipients[0]).toBe(
      mockFilterKnownMarketingOptOutRecipients.mock.calls[0][0].recipients[2]
    );
    const marketingPriorFailureInput =
      mockFilterPriorFailedBulkCampaignCandidates.mock.calls[0][0];
    expect(
      marketingPriorFailureInput.candidates.map(
        marketingPriorFailureInput.recipientFor
      )
    ).toEqual([priorFailedRecipient, fillUpRecipient]);
    expect(payload).toEqual(
      expect.objectContaining({
        eligibleTotal: 1,
        excludedOptIn: 1,
        marketingOptInWarningCount: 1,
        skippedPriorFailed: 1,
        maxRecipients: 2,
      })
    );
  });

  it("reports the parsed prior-failure policy when analytics preview fails", async () => {
    mockResolveBulkAnalyticsAudience.mockRejectedValueOnce(
      new Error("analytics unavailable")
    );

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(previewUrl("excludePriorFailedBulkSends=1")),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "eligibility_lookup_failed" },
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        policy: { version: 1, excludePriorFailedBulkSends: true },
      })
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId: "ws-1",
        code: "eligibility_lookup_failed",
        message: "analytics unavailable",
      })
    );
  });

  it("reports a Meta rate limit with a retry time instead of a generic failure", async () => {
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 1,
      eligibleTotal: 1,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients: [{ phone: "+15550000001" }],
      capped: false,
      maxRecipients: 50_000,
    });
    mockResolveApprovedTemplate.mockRejectedValueOnce(
      new MetaGraphRequestError({
        message:
          "(#80008) There have been too many calls to this WhatsApp Business account.",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v23.0/waba-1/message_templates",
        details: {},
        metaError: {
          message:
            "(#80008) There have been too many calls to this WhatsApp Business account.",
          type: "OAuthException",
          code: 80008,
        },
      })
    );

    const { GET } = await import("./route");
    const response = await GET(new NextRequest(previewUrl()), {
      params: Promise.resolve({ workspaceId: "ws-1" }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "meta_rate_limited" },
      retryAfterSeconds: 60,
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId: "ws-1",
        code: "meta_rate_limited",
        graphCode: 80008,
      })
    );
  });

  it("answers a template catalog cooldown with the time it ends", async () => {
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 1,
      eligibleTotal: 1,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients: [{ phone: "+15550000001" }],
      capped: false,
      maxRecipients: 50_000,
    });
    mockResolveApprovedTemplate.mockRejectedValueOnce(
      new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        message: "Meta temporarily limited WhatsApp template requests.",
        retryAt: new Date(Date.now() + 600_000).toISOString(),
        providerCode: 80008,
      })
    );

    const { GET } = await import("./route");
    const response = await GET(new NextRequest(previewUrl()), {
      params: Promise.resolve({ workspaceId: "ws-1" }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("600");
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "meta_rate_limited" },
      retryAfterSeconds: 600,
    });
  });

  it("answers a capped Analytics audience with the same 413 as Send", async () => {
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 1,
      eligibleTotal: 1,
      excludedOptIn: 0,
      marketingOptInWarningCount: 0,
      recipients: [{ phone: "+15550000001" }],
      capped: true,
      maxRecipients: 1,
    });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest(previewUrl()), {
      params: Promise.resolve({ workspaceId: "ws-1" }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "incomplete_audience" },
    });
  });
});
