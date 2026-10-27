const mockCreateClient = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockResolveCampaignBatchPlanPreview = jest.fn();
const mockResolveApprovedTemplate = jest.fn();
const mockFilterMarketingOptOut = jest.fn();
const mockFilterPriorFailed = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockResolveConversationHistory = jest.fn();
const mockReadCompanyBulkRecipientAllowance = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { kind: "supabase-admin" },
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
jest.mock("@/lib/campaign/marketing-opt-in", () => ({
  filterKnownMarketingOptOutRecipients: (...args: unknown[]) =>
    mockFilterMarketingOptOut(...args),
}));
jest.mock("@/lib/campaign/prior-failed-recipient-filter", () => ({
  filterPriorFailedBulkCampaignCandidates: (...args: unknown[]) =>
    mockFilterPriorFailed(...args),
}));
jest.mock("@/lib/campaign/whatsapp-bulk-preflight", () => ({
  resolveWhatsAppConversationHistoryEligibility: (...args: unknown[]) =>
    mockResolveConversationHistory(...args),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  readCompanyBulkRecipientAllowance: (...args: unknown[]) =>
    mockReadCompanyBulkRecipientAllowance(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";

import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";

import { POST } from "./route";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

const workspaceId = "00000000-0000-4000-8000-000000000201";

function authenticatedClient() {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: { role: "admin" },
    error: null,
  });
  return {
    auth: supabaseAuth(),
    from: jest.fn(() => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle }) }),
      }),
    })),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/campaigns/recipient-eligibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      channel: "whatsapp",
      messageIntent: {
        kind: "whatsapp_template",
        sourceId: "source-1",
        templateName: "offer",
        language: "en",
      },
      templateCategory: "UTILITY",
      recipients: [{ phone: "+10000000001" }, { phone: "+10000000002" }],
      ...overrides,
    }),
  });
}

describe("POST /api/campaigns/recipient-eligibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_SECRET = "test-secret";
    mockCreateClient.mockResolvedValue(authenticatedClient());
    mockReadCompanyBulkRecipientAllowance.mockResolvedValue({
      limit: { subscriptionType: "pro", bulkRecipientLimit: null },
      remaining: null,
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      workspaceId,
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
        maxRecipients: 1,
        source: "live_meta",
        rawLimit: "TIER_1",
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
    mockFilterMarketingOptOut.mockImplementation(
      async ({ recipients }: { recipients: unknown[] }) => ({
        recipients,
        skippedRecipients: [],
        skippedOptIn: 0,
        skippedPhones: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningRecipients: [],
        marketingOptInWarningPhones: [],
      })
    );
    mockFilterPriorFailed.mockImplementation(
      async ({ candidates }: { candidates: unknown[] }) => ({
        candidates,
        skippedPriorFailed: 0,
      })
    );
  });

  it("uses the live plan ceiling and ignores an observed client limit", async () => {
    const response = await POST(request({ maxRecipients: 500 }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requestedTotal: 2,
      acceptedTotal: 1,
      eligibleTotal: 1,
      skippedByReason: { recipient_limit: 1 },
      recipientLimit: { maxRecipients: 1, source: "live_meta" },
    });
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId,
      sourceId: "source-1",
    });
  });

  it.each([
    [1, { acceptedTotal: 1, skippedByReason: { recipient_limit: 1 } }],
    // Nothing left: the plan blocks Send, so the preview counts the list.
    [0, { acceptedTotal: 2, skippedByReason: {} }],
  ])(
    "previews the free bulk allowance when %i recipients are left",
    async (remaining, expected) => {
      mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce({
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "meta_default_throughput",
          throughputLevel: "STANDARD",
        },
        recipientLimit: { maxRecipients: 2000, source: "live_meta" },
      });
      mockReadCompanyBulkRecipientAllowance.mockResolvedValueOnce({
        limit: { subscriptionType: "free", bulkRecipientLimit: 500 },
        remaining,
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        requestedTotal: 2,
        ...expected,
        recipientLimit: { maxRecipients: 2000, source: "live_meta" },
      });
      expect(mockReadCompanyBulkRecipientAllowance).toHaveBeenCalledWith(
        { kind: "supabase-admin" },
        workspaceId
      );
    }
  );

  it("removes history-ineligible utility recipients before the live limit and backfills in stable order", async () => {
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
    mockResolveConversationHistory.mockResolvedValueOnce({
      eligiblePhones: ["10000000002", "10000000003"],
      skippedPhones: ["10000000001"],
    });

    const response = await POST(
      request({
        recipients: [
          { phone: "+10000000001" },
          { phone: "+10000000002" },
          { phone: "+10000000003" },
        ],
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requestedTotal: 3,
      acceptedTotal: 2,
      uniqueRecipients: { requested: 3, accepted: 2 },
      skippedByReason: { ineligible: 1 },
    });
    expect(mockResolveConversationHistory).toHaveBeenCalledWith({
      workspaceId,
      sourceId: "source-1",
      phones: ["10000000001", "10000000002", "10000000003"],
    });
  });

  it("blocks when the approved category conflicts with the compatibility hint", async () => {
    mockResolveApprovedTemplate.mockResolvedValue({
      template: {
        name: "offer",
        language: "en",
        status: "APPROVED",
        category: "MARKETING",
      },
      sameNameLanguages: ["en"],
      source: "live",
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "template_category_conflict" },
    });
    expect(mockFilterMarketingOptOut).not.toHaveBeenCalled();
  });

  it("applies the limit before prior failure without backfill", async () => {
    mockFilterPriorFailed.mockImplementationOnce(
      async ({ candidates }: { candidates: unknown[] }) => ({
        candidates: [],
        skippedPriorFailed: candidates.length,
      })
    );

    const response = await POST(request({ excludePriorFailedBulkSends: true }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requestedTotal: 2,
      acceptedTotal: 0,
      allExcluded: true,
      skippedByReason: { recipient_limit: 1, prior_failure: 1 },
    });
    expect(mockFilterPriorFailed.mock.calls[0][0].candidates).toHaveLength(1);
  });

  it("reports the parsed prior-failure policy when preview resolution fails", async () => {
    mockResolveApprovedTemplate.mockRejectedValueOnce(
      new Error("template catalog unavailable")
    );

    const response = await POST(request({ excludePriorFailedBulkSends: true }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "template_lookup_unavailable" },
    });
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        errorCode: "template_lookup_unavailable",
        policy: { version: 1, excludePriorFailedBulkSends: true },
      })
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId,
        code: "template_lookup_unavailable",
        causeName: "Error",
        causeMessage: "template catalog unavailable",
      })
    );
  });

  it("reports a Meta rate limit with a retry time instead of a generic failure", async () => {
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

    const response = await POST(request());

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
        workspaceId,
        code: "meta_rate_limited",
        causeName: "MetaGraphRequestError",
        graphCode: 80008,
      })
    );
  });

  it("answers a template catalog cooldown with the time it ends", async () => {
    const retryAt = new Date(Date.now() + 240_000).toISOString();
    mockResolveApprovedTemplate.mockRejectedValueOnce(
      new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        message:
          "Meta temporarily limited WhatsApp template requests. Try again after the cooldown.",
        retryAt,
        providerCode: 80008,
      })
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("240");
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "meta_rate_limited" },
      retryAfterSeconds: 240,
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId,
        code: "meta_rate_limited",
        causeName: "WhatsAppTemplateCatalogError",
        catalogCode: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        providerCode: 80008,
        retryAt,
        retryAfterSeconds: 240,
      })
    );
  });

  it("answers a template the saved catalog misses during a Meta cooldown with the time it ends, not as unapproved", async () => {
    const retryAt = new Date(Date.now() + 240_000).toISOString();
    // During a cooldown the shared catalog returns its last saved copy marked
    // stale; a template created in Meta since then isn't in it.
    mockResolveApprovedTemplate.mockResolvedValueOnce({
      template: null,
      sameNameLanguages: [],
      source: "none",
      catalog: {
        source: "cache",
        stale: true,
        fetchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        wabaId: "waba-1",
        refreshOutcome: "cooldown",
        retryAt,
        providerCode: 80008,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("240");
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "meta_rate_limited" },
      retryAfterSeconds: 240,
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        code: "meta_rate_limited",
        catalogCode: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        providerCode: 80008,
        retryAt,
      })
    );
  });

  it("still answers a template a current catalog misses as unapproved", async () => {
    mockResolveApprovedTemplate.mockResolvedValueOnce({
      template: null,
      sameNameLanguages: [],
      source: "none",
      catalog: {
        source: "live",
        stale: false,
        fetchedAt: new Date().toISOString(),
        wabaId: "waba-1",
        refreshOutcome: "succeeded",
        retryAt: null,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "template_unavailable" },
    });
  });

  it("answers an unavailable template catalog without a retry time", async () => {
    mockResolveApprovedTemplate.mockRejectedValueOnce(
      new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
        message: "WhatsApp templates are being refreshed. Try again shortly.",
        retryAt: new Date(Date.now() + 120_000).toISOString(),
      })
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "template_lookup_unavailable" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        code: "template_lookup_unavailable",
        catalogCode: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      })
    );
  });

  it("logs failures that happen before the workspace is known", async () => {
    mockCreateClient.mockRejectedValueOnce(new Error("supabase unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      state: "blocked",
      error: { code: "eligibility_lookup_failed" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId: null,
        code: "eligibility_lookup_failed",
        message: "supabase unavailable",
      })
    );
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
