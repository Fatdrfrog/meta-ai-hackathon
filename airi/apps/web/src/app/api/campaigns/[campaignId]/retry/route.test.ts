jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error("Unexpected database access in retry route unit test");
  }),
}));
const mockGetAuthenticatedWorkspaceMembership = jest.fn();
const mockPrepareFailedCampaignRetry = jest.fn();
const mockQueuePreparedBulkCampaignDispatch = jest.fn();
const mockResolveCampaignBatchPlan = jest.fn();
const mockResolveCampaignBatchPlanPreview = jest.fn();
const mockResolveFreshWhatsAppSendContext = jest.fn();
const mockFilterKnownMarketingOptOutRecipients = jest.fn();
const mockEnsureCompanyConversationCapacity = jest.fn();
const mockIsWorkspaceFeatureEnabled = jest.fn();
const mockRandomUUID = jest.fn();
const mockPartitionRecentlyContactedRecipients = jest.fn();

jest.mock("@/lib/campaign/customer-contact-policy", () => ({
  partitionRecentlyContactedRecipients: (...args: unknown[]) =>
    mockPartitionRecentlyContactedRecipients(...args),
}));

// Marks recipients as contacted within the workspace contact policy.
function mockRecentContacts(
  isRecent: (phone: string) => boolean,
  nextEligibleAt: string | null = null
) {
  mockPartitionRecentlyContactedRecipients.mockImplementation(
    async ({ recipients }: { recipients: Array<{ phone: string }> }) => ({
      allowed: recipients.filter(recipient => !isRecent(recipient.phone)),
      recentlyContacted: recipients.filter(recipient =>
        isRecent(recipient.phone)
      ),
      nextEligibleAt,
    })
  );
}

jest.mock("node:crypto", () => {
  const actual = jest.requireActual("node:crypto");
  return {
    ...actual,
    randomUUID: (...args: unknown[]) => mockRandomUUID(...args),
  };
});

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetAuthenticatedWorkspaceMembership(...args),
}));

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  prepareFailedCampaignRetry: (...args: unknown[]) =>
    mockPrepareFailedCampaignRetry(...args),
}));

jest.mock("@/lib/campaign/queue-prepared-bulk-campaign-dispatch", () => {
  const actual = jest.requireActual(
    "@/lib/campaign/queue-prepared-bulk-campaign-dispatch"
  );
  return {
    ...actual,
    queuePreparedBulkCampaignDispatch: (...args: unknown[]) =>
      mockQueuePreparedBulkCampaignDispatch(...args),
  };
});

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveFreshWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveFreshWhatsAppSendContext(...args),
}));

jest.mock("@/lib/campaign/campaign-batch-plan", () => ({
  resolveCampaignBatchPlanPreview: (...args: unknown[]) =>
    mockResolveCampaignBatchPlanPreview(...args),
  resolveCampaignBatchPlan: (...args: unknown[]) =>
    mockResolveCampaignBatchPlan(...args),
}));

jest.mock("@/lib/campaign/marketing-opt-in", () => ({
  filterKnownMarketingOptOutRecipients: (...args: unknown[]) =>
    mockFilterKnownMarketingOptOutRecipients(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyConversationCapacity: (...args: unknown[]) =>
    mockEnsureCompanyConversationCapacity(...args),
}));

jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockIsWorkspaceFeatureEnabled(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { kind: "service-role" },
}));

jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));

import { NextResponse } from "next/server";

import { PreparedBulkCampaignQueueError } from "@/lib/campaign/queue-prepared-bulk-campaign-dispatch";

import { POST } from "./route";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_CAMPAIGN_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function request(body: unknown) {
  return new Request(
    `https://airi.test/api/campaigns/${SOURCE_CAMPAIGN_ID}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function context(campaignId = SOURCE_CAMPAIGN_ID) {
  return { params: Promise.resolve({ campaignId }) };
}

function failedSnapshot(phone: string, code: string | number = 131042) {
  return {
    campaignId: SOURCE_CAMPAIGN_ID,
    channel: "whatsapp",
    recipient: phone.replace(/\D/g, ""),
    snapshotOrdinal: phone.endsWith("2") ? 1 : 0,
    dispatchSnapshot: {
      workspaceId: WORKSPACE_ID,
      campaignId: SOURCE_CAMPAIGN_ID,
      channel: "whatsapp",
      sourceId: "source-1",
      recipient: { phone },
      phoneNumberId: "phone-number-1",
      templateName: "july_follow_up",
      languageCode: "en",
      templateCategory: "MARKETING",
      _audience_upload: {},
    },
    providerFailure: {
      provider: "meta",
      code,
      scope: "provider",
      message: "Payment issue",
    },
  };
}

function failedServiceSnapshot(phone: string) {
  return {
    ...failedSnapshot(phone, 131026),
    dispatchSnapshot: {
      workspaceId: WORKSPACE_ID,
      campaignId: SOURCE_CAMPAIGN_ID,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      sourceId: "source-1",
      recipient: { phone },
      phoneNumberId: "phone-number-1",
      messageText: "Thanks for contacting us.",
      serviceWindowExpiresAt: "2026-07-28T12:00:00.000Z",
    },
    providerFailure: {
      provider: "meta",
      code: 131026,
      scope: "recipient",
      message: "Undeliverable recipient",
    },
  };
}

function preparation(overrides?: Record<string, unknown>) {
  return {
    source: {
      campaignId: SOURCE_CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      channel: "whatsapp",
      name: "July follow-up",
      templateName: "july_follow_up",
      templateLanguage: "en",
      messageText: null,
      totalRecipients: 2,
      status: "failed",
      providerCircuit: {
        state: "closed",
        provider: null,
        code: null,
        openedAt: null,
      },
    },
    failedSnapshots: [
      failedSnapshot("+7 701 000 00 01"),
      failedSnapshot("+7 701 000 00 02"),
    ],
    ...overrides,
  };
}

describe("POST /api/campaigns/[campaignId]/retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_SECRET = "test-fingerprint-secret";
    mockRandomUUID.mockReturnValue(CHILD_CAMPAIGN_ID);
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      user: { id: ACTOR_ID },
      membership: { role: "admin" },
      supabase: {},
    });
    mockPrepareFailedCampaignRetry.mockResolvedValue(preparation());
    mockResolveCampaignBatchPlan.mockResolvedValue({
      batchSize: 20,
      delayMs: 250,
      ratePerSecond: 80,
      rateSource: "meta_default_throughput",
      throughputLevel: "STANDARD",
    });
    mockResolveCampaignBatchPlanPreview.mockImplementation(async () => ({
      channel: "whatsapp",
      batchPlan: await mockResolveCampaignBatchPlan(),
      recipientLimit: { maxRecipients: 250, source: "live_meta" },
      readiness: {
        state: "ready",
        checkedAt: "2026-09-16T00:00:00.000Z",
        remainingCapacity: null,
        reasons: [],
      },
    }));
    mockResolveFreshWhatsAppSendContext.mockImplementation(
      async ({ sourceId }) => ({
        workspaceId: WORKSPACE_ID,
        sourceId: sourceId || "source-1",
        phoneNumberId:
          sourceId === "source-2" ? "phone-number-2" : "phone-number-1",
        wabaId: "waba-1",
        accessToken: "test-token",
      })
    );
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }: { recipients: unknown[] }) => ({
        recipients,
        skippedRecipients: [],
        skippedOptIn: 0,
        skippedPhones: [],
        marketingOptInWarningRecipients: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningPhones: [],
      })
    );
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: { bulkRecipientLimit: 500, subscriptionType: "free" },
    });
    mockIsWorkspaceFeatureEnabled.mockResolvedValue(true);
    mockRecentContacts(() => false);
    mockQueuePreparedBulkCampaignDispatch.mockResolvedValue({
      campaignId: CHILD_CAMPAIGN_ID,
      dispatchId: CHILD_CAMPAIGN_ID,
      workflowId: "bulk-campaign:child",
      status: "queued",
      requestedAt: "2026-07-24T10:00:00.000Z",
      dispatchExpiresAt: "2026-07-24T10:15:00.000Z",
      temporalDispatchStaging: "inline",
      total: 2,
      items: [],
      idempotentReplay: false,
      audience: {
        fingerprint: "a".repeat(64),
        requestedTotal: 2,
        queuedTotal: 2,
        skippedOptIn: 0,
      },
      audienceConfirmation: {
        required: true,
        confirmed: true,
        fingerprint: "a".repeat(64),
      },
    });
  });

  it.each(["blocked", "unavailable"])(
    "requires live provider readiness even after acknowledging history (%s)",
    async state => {
      mockResolveCampaignBatchPlanPreview.mockResolvedValue({
        channel: "whatsapp",
        batchPlan: await mockResolveCampaignBatchPlan(),
        recipientLimit: { maxRecipients: 250, source: "live_meta" },
        readiness: {
          state,
          checkedAt: "2026-09-16T00:00:00.000Z",
          remainingCapacity: null,
          reasons: [
            {
              code:
                state === "blocked"
                  ? "meta_business_limit"
                  : "meta_check_unavailable",
            },
          ],
        },
      });
      const response = await POST(
        request({
          workspaceId: WORKSPACE_ID,
          providerCircuitAcknowledged: true,
        }),
        context()
      );
      expect(response.status).toBe(state === "blocked" ? 409 : 503);
      expect(await response.json()).toMatchObject({
        code:
          state === "blocked"
            ? "whatsapp_sending_blocked"
            : "whatsapp_sending_unavailable",
        readiness: { state },
      });
      expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
    }
  );
  it("checks every immutable template sender and blocks the whole retry when one is restricted", async () => {
    const second = failedSnapshot("+7 701 000 00 02");
    second.dispatchSnapshot.sourceId = "source-2";
    second.dispatchSnapshot.phoneNumberId = "phone-number-2";
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [failedSnapshot("+7 701 000 00 01"), second],
      })
    );
    mockResolveCampaignBatchPlanPreview.mockImplementation(
      async ({ phoneNumberId }) => ({
        channel: "whatsapp",
        batchPlan: await mockResolveCampaignBatchPlan(),
        recipientLimit: { maxRecipients: 250, source: "live_meta" },
        readiness: {
          state: phoneNumberId === "phone-number-2" ? "blocked" : "ready",
          checkedAt: "2026-09-16T00:00:00.000Z",
          remainingCapacity: null,
          reasons:
            phoneNumberId === "phone-number-2"
              ? [{ code: "meta_business_limit" }]
              : [],
        },
      })
    );
    const response = await POST(
      request({ workspaceId: WORKSPACE_ID, providerCircuitAcknowledged: true }),
      context()
    );
    expect(response.status).toBe(409);
    expect(mockResolveFreshWhatsAppSendContext).toHaveBeenCalledTimes(2);
    expect(mockResolveCampaignBatchPlanPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: "phone-number-2",
        wabaId: "waba-1",
      })
    );
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });
  it("cannot check a different phone after the pinned sender has changed", async () => {
    mockResolveFreshWhatsAppSendContext.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      sourceId: "source-1",
      phoneNumberId: "replacement-phone",
      wabaId: "waba-1",
      accessToken: "test-token",
    });
    const response = await POST(
      request({ workspaceId: WORKSPACE_ID, providerCircuitAcknowledged: true }),
      context()
    );
    expect(response.status).toBe(503);
    expect(mockResolveCampaignBatchPlanPreview).not.toHaveBeenCalled();
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });
  it("retains an original provider restriction through locally suppressed retry children", async () => {
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        ancestorProviderCircuit: {
          state: "open",
          provider: "meta",
          code: "131048",
          failureCount: 84,
        },
        failedSnapshots: [
          failedSnapshot("+7 701 000 00 01", "contact_frequency_limit"),
        ],
      })
    );
    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "provider_circuit_acknowledgement_required",
      providerCircuit: { code: "131048" },
    });
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_SECRET;
  });

  it("retries a historical spreadsheet phone without changing its immutable snapshot", async () => {
    const source = failedSnapshot("'+77010000001");
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({ failedSnapshots: [source] })
    );

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID, providerCircuitAcknowledged: true }),
      context()
    );

    expect(response.status).toBe(202);
    expect(mockQueuePreparedBulkCampaignDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedTotal: 1,
        retryOfCampaignId: SOURCE_CAMPAIGN_ID,
        retryKind: "failed_only",
        items: [
          expect.objectContaining({
            campaignId: CHILD_CAMPAIGN_ID,
            snapshotOrdinal: 0,
            recipient: { phone: "'+77010000001" },
          }),
        ],
      })
    );
  });

  it("keeps contact cooldown authoritative for historical spreadsheet phones", async () => {
    const source = failedSnapshot("'+77010000001");
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({ failedSnapshots: [source] })
    );
    mockRecentContacts(() => true, "2026-09-19T15:07:13.000Z");

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID, providerCircuitAcknowledged: true }),
      context()
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "retry_contact_cooldown",
      cooldown: {
        blockedRecipientCount: 1,
        nextEligibleAt: "2026-09-19T15:07:13.000Z",
      },
    });
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it("rejects invalid historical phone input before consent checks or queueing", async () => {
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [failedSnapshot('=\"77010000001\"')],
      })
    );

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "invalid_retry_snapshot" });
    expect(mockFilterKnownMarketingOptOutRecipients).not.toHaveBeenCalled();
    expect(mockPartitionRecentlyContactedRecipients).not.toHaveBeenCalled();
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid source id", { workspaceId: WORKSPACE_ID }, "not-a-uuid"],
    ["invalid workspace id", { workspaceId: "not-a-uuid" }, SOURCE_CAMPAIGN_ID],
    [
      "recipient escalation",
      {
        workspaceId: WORKSPACE_ID,
        recipients: [{ phone: "+7 999 999 99 99" }],
      },
      SOURCE_CAMPAIGN_ID,
    ],
    [
      "metadata escalation",
      {
        workspaceId: WORKSPACE_ID,
        audienceUploadEvidence: { originalFilename: "replacement.csv" },
      },
      SOURCE_CAMPAIGN_ID,
    ],
  ])("strictly rejects %s", async (_label, body, campaignId) => {
    const response = await POST(request(body), context(campaignId));

    expect(response.status).toBe(400);
    expect(mockPrepareFailedCampaignRetry).not.toHaveBeenCalled();
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it("requires the same manager role as bulk send", async () => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      user: { id: ACTOR_ID },
      membership: { role: "agent" },
      supabase: {},
    });

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(403);
    expect(mockPrepareFailedCampaignRetry).not.toHaveBeenCalled();
  });

  it("preserves membership failures before using the service store", async () => {
    mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(403);
    expect(mockPrepareFailedCampaignRetry).not.toHaveBeenCalled();
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it.each([
    [null, 404, "campaign_not_found"],
    [
      preparation({
        source: {
          ...preparation().source,
          status: "running",
        },
      }),
      409,
      "campaign_not_terminal",
    ],
    [preparation({ failedSnapshots: [] }), 409, "no_failed_recipients"],
  ])(
    "rejects an ineligible retry source %#",
    async (prepared, expectedStatus, expectedCode) => {
      mockPrepareFailedCampaignRetry.mockResolvedValue(prepared);

      const response = await POST(
        request({ workspaceId: WORKSPACE_ID }),
        context()
      );

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ code: expectedCode })
      );
      expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
    }
  );

  it("fails closed when a persisted immutable snapshot is malformed", async () => {
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [
          {
            ...failedSnapshot("+7 701 000 00 01"),
            dispatchSnapshot: {
              ...failedSnapshot("+7 701 000 00 01").dispatchSnapshot,
              accessToken: "must-not-be-replayed",
            },
          },
        ],
      })
    );

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "invalid_retry_snapshot",
      error: "Campaign failed-recipient snapshots cannot be retried safely.",
    });
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it("requires explicit acknowledgement for a complete common provider failure without exposing recipients", async () => {
    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toEqual({
      code: "provider_circuit_acknowledgement_required",
      error: "Confirm that the provider problem was repaired before retrying.",
      providerCircuit: {
        state: "open",
        provider: "meta",
        code: "131042",
        failureCount: 2,
        requiresAcknowledgement: true,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("7701");
    expect(JSON.stringify(payload)).not.toContain("dispatchSnapshot");
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it("queues only parsed failed snapshots and records provider acknowledgement server-side", async () => {
    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      }),
      context()
    );

    expect(response.status).toBe(202);
    expect(mockPrepareFailedCampaignRetry).toHaveBeenCalledWith({
      supabase: { kind: "service-role" },
      workspaceId: WORKSPACE_ID,
      campaignId: SOURCE_CAMPAIGN_ID,
    });
    expect(mockQueuePreparedBulkCampaignDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        storeClient: { kind: "service-role" },
        fingerprintSecret: "test-fingerprint-secret",
        campaignId: CHILD_CAMPAIGN_ID,
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        campaignName: "July follow-up",
        templateName: "july_follow_up",
        templateLanguage: "en",
        messageText: null,
        sentBy: ACTOR_ID,
        executionSource: "ad_hoc",
        scheduledAt: null,
        requestedTotal: 2,
        skippedOptIn: 0,
        retryOfCampaignId: SOURCE_CAMPAIGN_ID,
        retryKind: "failed_only",
        companyBulkCampaignLimit: 500,
        companySubscriptionType: "free",
        confirmAudience: true,
        providerCircuitAcknowledgement: {
          acknowledgedBy: ACTOR_ID,
        },
        items: [
          expect.objectContaining({
            workspaceId: WORKSPACE_ID,
            campaignId: CHILD_CAMPAIGN_ID,
            sentByUserId: ACTOR_ID,
            recipient: { phone: "+7 701 000 00 01" },
          }),
          expect.objectContaining({
            workspaceId: WORKSPACE_ID,
            campaignId: CHILD_CAMPAIGN_ID,
            sentByUserId: ACTOR_ID,
            recipient: { phone: "+7 701 000 00 02" },
          }),
        ],
      })
    );
    const payload = await response.json();
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        scheduled: false,
        total: 2,
        campaignId: CHILD_CAMPAIGN_ID,
        dispatchId: CHILD_CAMPAIGN_ID,
        workflowId: "bulk-campaign:child",
        status: "queued",
        idempotentReplay: false,
        retry: {
          kind: "failed_only",
          ofCampaignId: SOURCE_CAMPAIGN_ID,
          providerCircuit: {
            state: "open",
            provider: "meta",
            code: "131042",
            failureCount: 2,
            acknowledged: true,
          },
        },
      })
    );
    expect(payload).not.toHaveProperty("items");
  });

  it("refuses the retry before queueing when every recipient was contacted recently", async () => {
    mockRecentContacts(() => true, "2026-09-16T10:59:29.247Z");
    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      }),
      context()
    );
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toEqual({
      code: "retry_contact_cooldown",
      error:
        "Every recipient is still in the local contact cooldown. No retry was queued.",
      cooldown: {
        blockedRecipientCount: 2,
        eligibleRecipientCount: 0,
        nextEligibleAt: "2026-09-16T10:59:29.247Z",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("7701");
    expect(mockPartitionRecentlyContactedRecipients).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recipients: [
        expect.objectContaining({ phone: "+7 701 000 00 01" }),
        expect.objectContaining({ phone: "+7 701 000 00 02" }),
      ],
    });
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
    expect(mockResolveCampaignBatchPlan).not.toHaveBeenCalled();
  });

  it("leaves recently contacted recipients out of the retry and reports them", async () => {
    mockRecentContacts(
      phone => phone === "+7 701 000 00 01",
      "2026-09-16T10:59:29.247Z"
    );
    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      }),
      context()
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      queued: true,
      skippedRecentContact: 1,
    });
    const queued = mockQueuePreparedBulkCampaignDispatch.mock.calls[0][0];
    expect(queued.requestedTotal).toBe(2);
    expect(queued.items).toEqual([
      expect.objectContaining({
        recipient: expect.objectContaining({ phone: "+7 701 000 00 02" }),
      }),
    ]);
  });

  it("fails closed when contact eligibility cannot be read", async () => {
    mockPartitionRecentlyContactedRecipients.mockRejectedValue(
      new Error("Contact policy unavailable")
    );
    const response = await POST(
      request({ workspaceId: WORKSPACE_ID, providerCircuitAcknowledged: true }),
      context()
    );
    expect(response.status).toBe(500);
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it("checks service-message cooldowns but does not apply marketing caps to utility templates", async () => {
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [failedServiceSnapshot("+7 701 000 00 01")],
      })
    );
    expect(
      (await POST(request({ workspaceId: WORKSPACE_ID }), context())).status
    ).toBe(202);
    expect(mockPartitionRecentlyContactedRecipients).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_ID,
      recipients: [expect.objectContaining({ phone: "+7 701 000 00 01" })],
    });
    mockPartitionRecentlyContactedRecipients.mockClear();
    const utility = failedServiceSnapshot("+7 701 000 00 01");
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [
          {
            ...utility,
            dispatchSnapshot: {
              ...failedSnapshot("+7 701 000 00 01").dispatchSnapshot,
              templateCategory: "UTILITY",
            },
          },
        ],
      })
    );
    expect(
      (await POST(request({ workspaceId: WORKSPACE_ID }), context())).status
    ).toBe(202);
    expect(mockPartitionRecentlyContactedRecipients).not.toHaveBeenCalled();
  });

  it("queues every failed item when one recipient owns multiple source ordinals", async () => {
    const repeated = failedSnapshot("+7 701 000 00 01");
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [
          {
            ...repeated,
            snapshotOrdinal: 0,
            dispatchSnapshot: {
              ...repeated.dispatchSnapshot,
              snapshotOrdinal: 0,
              generatedRecipientMessageId: "source-message-0",
            },
          },
          {
            ...repeated,
            snapshotOrdinal: 1,
            dispatchSnapshot: {
              ...repeated.dispatchSnapshot,
              snapshotOrdinal: 1,
              generatedRecipientMessageId: "source-message-1",
            },
          },
        ],
      })
    );

    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      }),
      context()
    );

    expect(response.status).toBe(202);
    const queueInput = mockQueuePreparedBulkCampaignDispatch.mock.calls[0]?.[0];
    expect(queueInput.items).toHaveLength(2);
    expect(queueInput.items).toEqual([
      expect.objectContaining({
        recipient: { phone: "+7 701 000 00 01" },
        snapshotOrdinal: 0,
      }),
      expect.objectContaining({
        recipient: { phone: "+7 701 000 00 01" },
        snapshotOrdinal: 1,
      }),
    ]);
  });

  it("passes the real plan quota when conversation capacity is exhausted", async () => {
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: false,
      limit: { bulkRecipientLimit: null, subscriptionType: "premium" },
    });

    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      }),
      context()
    );

    expect(response.status).toBe(202);
    expect(mockQueuePreparedBulkCampaignDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        companyBulkCampaignLimit: null,
        companySubscriptionType: "premium",
      })
    );
  });

  it("excludes an explicit WhatsApp MARKETING opt-out and retries the remaining failed recipients", async () => {
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }: { recipients: Array<{ phone?: string }> }) => ({
        recipients: recipients.slice(0, 1),
        skippedRecipients: recipients.slice(1),
        skippedOptIn: 1,
        skippedPhones: ["77010000002"],
        marketingOptInWarningRecipients: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningPhones: [],
      })
    );
    mockQueuePreparedBulkCampaignDispatch.mockResolvedValue({
      campaignId: CHILD_CAMPAIGN_ID,
      dispatchId: CHILD_CAMPAIGN_ID,
      workflowId: "bulk-campaign:child",
      status: "queued",
      requestedAt: "2026-07-24T10:00:00.000Z",
      dispatchExpiresAt: "2026-07-24T10:15:00.000Z",
      temporalDispatchStaging: "inline",
      total: 1,
      items: [],
      idempotentReplay: false,
      audience: {
        fingerprint: "a".repeat(64),
        requestedTotal: 2,
        queuedTotal: 1,
        skippedOptIn: 1,
      },
      audienceConfirmation: {
        required: true,
        confirmed: true,
        fingerprint: "a".repeat(64),
      },
    });

    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      }),
      context()
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        queued: true,
        total: 1,
        audience: expect.objectContaining({
          requestedTotal: 2,
          queuedTotal: 1,
          skippedOptIn: 1,
        }),
      })
    );
    expect(mockFilterKnownMarketingOptOutRecipients).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recipients: [
        expect.objectContaining({ phone: "+7 701 000 00 01" }),
        expect.objectContaining({ phone: "+7 701 000 00 02" }),
      ],
    });
    expect(mockQueuePreparedBulkCampaignDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedTotal: 2,
        skippedOptIn: 1,
        items: [
          expect.objectContaining({
            recipient: { phone: "+7 701 000 00 01" },
          }),
        ],
      })
    );
  });

  it("rejects a retry when every failed recipient explicitly opted out", async () => {
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }: { recipients: Array<{ phone?: string }> }) => ({
        recipients: [],
        skippedRecipients: recipients,
        skippedOptIn: recipients.length,
        skippedPhones: ["77010000001", "77010000002"],
        marketingOptInWarningRecipients: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningPhones: [],
      })
    );

    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        providerCircuitAcknowledged: true,
      }),
      context()
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "retry_consent_changed",
      error:
        "No failed recipients remain after excluding explicit WhatsApp marketing opt-outs.",
    });
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it("keeps WhatsApp service retries behind the workspace feature flag", async () => {
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        source: {
          ...preparation().source,
          messageText: "Thanks for contacting us.",
          totalRecipients: 1,
        },
        failedSnapshots: [failedServiceSnapshot("+7 701 000 00 01")],
      })
    );
    mockIsWorkspaceFeatureEnabled.mockResolvedValue(false);

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "whatsapp_service_bulk_not_enabled",
      error: "WhatsApp service bulk messages are not enabled.",
    });
    expect(mockIsWorkspaceFeatureEnabled).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "whatsapp_service_bulk"
    );
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
  });

  it("requires acknowledgement when a historical Meta restriction is mixed with recipient failures", async () => {
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [
          failedSnapshot("+7 701 000 00 01", 131042),
          {
            ...failedSnapshot("+7 701 000 00 02", 131026),
            providerFailure: {
              provider: "meta",
              code: 131026,
              scope: "recipient",
              message: "Undeliverable recipient",
            },
          },
        ],
      })
    );

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(409);
    expect(mockQueuePreparedBulkCampaignDispatch).not.toHaveBeenCalled();
    expect(mockPartitionRecentlyContactedRecipients).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "provider_circuit_acknowledgement_required",
        providerCircuit: {
          state: "open",
          provider: "meta",
          code: "131042",
          failureCount: 1,
          requiresAcknowledgement: true,
        },
      })
    );
  });

  it("maps prepared queue failures without widening their contract", async () => {
    mockPrepareFailedCampaignRetry.mockResolvedValue(
      preparation({
        failedSnapshots: [
          {
            ...failedSnapshot("+7 701 000 00 01"),
            providerFailure: {
              provider: "meta",
              code: 131026,
              scope: "recipient",
              message: "Undeliverable recipient",
            },
          },
        ],
        source: { ...preparation().source, totalRecipients: 2 },
      })
    );
    mockQueuePreparedBulkCampaignDispatch.mockRejectedValue(
      new PreparedBulkCampaignQueueError(409, {
        code: "bulk_campaign_admission_lock_busy",
        error: "Another campaign is being queued. Try again.",
        retryable: true,
      })
    );

    const response = await POST(
      request({ workspaceId: WORKSPACE_ID }),
      context()
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "bulk_campaign_admission_lock_busy",
      error: "Another campaign is being queued. Try again.",
      retryable: true,
    });
  });
});
