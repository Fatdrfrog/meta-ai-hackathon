const mockCreateClient = jest.fn();
const mockConnectDB = jest.fn();
const mockResolveCampaignBatchPlanPreview = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockListTemplates = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockStartBulkCampaignDispatchWorkflow = jest.fn();
const mockConversationFind = jest.fn();
const mockDeriveBulkSendCampaignId = jest.fn();
const mockReserveLegacyIdempotency = jest.fn();
const mockCompleteLegacyIdempotency = jest.fn();
const mockReleaseLegacyIdempotency = jest.fn();
const mockCreateLegacyRequestDigest = jest.fn();
const mockNormalizeHeaderMedia = jest.fn();
const mockEnsureCompanyConversationCapacity = jest.fn();
const mockBuildCompanyLimitExceededResponse = jest.fn();
const mockReadCompanyBulkRecipientAllowance = jest.fn();
const mockBuildCompanyBulkRecipientLimitExceededResponse = jest.fn();
const mockResolveBulkAnalyticsAudience = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockSaveScenario = jest.fn();
const mockIsBulkDispatchPayloadStoreConfigured = jest.fn();
const mockStoreBulkCampaignDispatchItems = jest.fn();
const mockSupabaseAdminListUsers = jest.fn();
const mockSupabaseAdminFrom = jest.fn();
const mockGetWorkspaceEmailProviderConfig = jest.fn();
const mockGetWorkspaceEmailSource = jest.fn();
const mockResolveEmailProviderForWorkspaceSource = jest.fn();
const mockIsManagedEmailProviderPending = jest.fn(
  (..._args: unknown[]) => false
);
const mockCreateCampaignHistoryRecord = jest.fn();
const mockUpdateCampaignHistoryRecipientCount = jest.fn();
const mockResolveRegisteredBusinessPhoneAudience = jest.fn();
const mockResolveTelegramSubscribersAudience = jest.fn();
const mockFindEligibleTelegramSubscriberMap = jest.fn();
const mockFindTelegramSubscriberStatusMap = jest.fn();
const mockAdmitBulkCampaign = jest.fn();
const mockLookupAdmittedBulkCampaignReplay = jest.fn();
const mockFailCampaignDispatchBeforeStart = jest.fn();
const mockEmitCampaignHistoryCreatedUsageBestEffort = jest.fn();
const mockFilterKnownMarketingOptOutRecipients = jest.fn();
const mockFilterPriorFailedBulkCampaignCandidates = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockIsWorkspaceFeatureEnabled = jest.fn();
const mockFilterEmailUnsubscribedRecipients = jest.fn();
const mockEnsureAdmittedBulkCampaignReplayStarted = jest.fn();
const mockQueuePreparedBulkCampaignDispatchOverride = jest.fn();
const mockPartitionRecentlyContactedRecipients = jest.fn();

jest.mock("@/lib/campaign/customer-contact-policy", () => ({
  partitionRecentlyContactedRecipients: (...args: unknown[]) =>
    mockPartitionRecentlyContactedRecipients(...args),
}));

// Marks the given phones as contacted within the workspace contact policy.
function mockRecentContacts(
  phones: readonly string[],
  nextEligibleAt: string | null = "2026-09-16T10:59:29.247Z"
) {
  const digits = (phone: string) => phone.replace(/\D/g, "");
  const recent = new Set(phones.map(digits));
  mockPartitionRecentlyContactedRecipients.mockImplementation(
    async ({ recipients }: { recipients: Array<{ phone: string }> }) => ({
      allowed: recipients.filter(
        recipient => !recent.has(digits(recipient.phone))
      ),
      recentlyContacted: recipients.filter(recipient =>
        recent.has(digits(recipient.phone))
      ),
      nextEligibleAt,
    })
  );
}

const mockCaptureFunnelEvent = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

jest.mock("@/lib/analytics/bulk-analytics-audience", () => {
  class BulkAnalyticsAudienceUnavailableError extends Error {
    code = "campaign_send_audience_rollup_required";

    constructor(message = "Campaign-send audience requires a rollup") {
      super(message);
      this.name = "BulkAnalyticsAudienceUnavailableError";
    }
  }

  return {
    BulkAnalyticsAudienceUnavailableError,
    resolveBulkAnalyticsAudience: (...args: unknown[]) =>
      mockResolveBulkAnalyticsAudience(...args),
  };
});

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    client: "supabase-admin",
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
    auth: {
      admin: {
        listUsers: (...args: unknown[]) => mockSupabaseAdminListUsers(...args),
      },
    },
  },
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/campaign/campaign-batch-plan", () => ({
  resolveCampaignBatchPlanPreview: (...args: unknown[]) =>
    mockResolveCampaignBatchPlanPreview(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/lib/whatsapp/templates/service", () => ({
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    find: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve([]),
      }),
    })),
  },
}));

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
}));

jest.mock("@/lib/temporal/bulk-campaign-dispatch", () => ({
  startBulkCampaignDispatchWorkflow: (...args: unknown[]) =>
    mockStartBulkCampaignDispatchWorkflow(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
  },
}));

jest.mock("@/lib/scenarios/scenario-save", () => ({
  saveScenario: (...args: unknown[]) => mockSaveScenario(...args),
}));

jest.mock("@/lib/campaign/bulk-send-api-idempotency", () => ({
  createLegacyBulkSendRequestDigest: (...args: unknown[]) =>
    mockCreateLegacyRequestDigest(...args),
  reserveLegacyBulkSendOperation: (...args: unknown[]) =>
    mockReserveLegacyIdempotency(...args),
  completeLegacyBulkSendOperation: (...args: unknown[]) =>
    mockCompleteLegacyIdempotency(...args),
  releaseLegacyBulkSendOperation: (...args: unknown[]) =>
    mockReleaseLegacyIdempotency(...args),
  deriveBulkSendCampaignId: (...args: unknown[]) =>
    mockDeriveBulkSendCampaignId(...args),
}));

jest.mock("@/lib/whatsapp/templates/header-media", () => ({
  normalizeWhatsAppTemplateHeaderMediaComponents: (...args: unknown[]) =>
    mockNormalizeHeaderMedia(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE:
    "company_bulk_campaign_limit_exceeded",
  ensureCompanyConversationCapacity: (...args: unknown[]) =>
    mockEnsureCompanyConversationCapacity(...args),
  buildCompanyLimitExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyLimitExceededResponse(...args),
  readCompanyBulkRecipientAllowance: (...args: unknown[]) =>
    mockReadCompanyBulkRecipientAllowance(...args),
  buildCompanyBulkRecipientLimitExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyBulkRecipientLimitExceededResponse(...args),
}));

jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockIsWorkspaceFeatureEnabled(...args),
}));

jest.mock("@/lib/campaign/email-bulk-preflight", () => {
  const actual = jest.requireActual(
    "@/lib/campaign/email-bulk-preflight"
  ) as Record<string, unknown>;
  return {
    ...actual,
    filterEmailUnsubscribedRecipients: (...args: unknown[]) =>
      mockFilterEmailUnsubscribedRecipients(...args),
  };
});

jest.mock("@icecore/shared/lib/bulk-dispatch-payload-store", () => ({
  isBulkDispatchPayloadStoreConfigured: (...args: unknown[]) =>
    mockIsBulkDispatchPayloadStoreConfigured(...args),
  storeBulkCampaignDispatchItems: (...args: unknown[]) =>
    mockStoreBulkCampaignDispatchItems(...args),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderConfig(...args),
  isManagedEmailProviderPending: (...args: unknown[]) =>
    mockIsManagedEmailProviderPending(...args),
}));

jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: (...args: unknown[]) =>
    mockGetWorkspaceEmailSource(...args),
  resolveEmailProviderForWorkspaceSource: (...args: unknown[]) =>
    mockResolveEmailProviderForWorkspaceSource(...args),
}));

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  createCampaignHistoryRecord: (...args: unknown[]) =>
    mockCreateCampaignHistoryRecord(...args),
  updateCampaignHistoryRecipientCount: (...args: unknown[]) =>
    mockUpdateCampaignHistoryRecipientCount(...args),
  failCampaignDispatchBeforeStart: (...args: unknown[]) =>
    mockFailCampaignDispatchBeforeStart(...args),
  emitCampaignHistoryCreatedUsageBestEffort: (...args: unknown[]) =>
    mockEmitCampaignHistoryCreatedUsageBestEffort(...args),
}));

jest.mock("@/lib/campaign/bulk-campaign-admission", () => {
  const actual = jest.requireActual(
    "@/lib/campaign/bulk-campaign-admission"
  ) as Record<string, unknown>;
  return {
    ...actual,
    admitBulkCampaign: (...args: unknown[]) => mockAdmitBulkCampaign(...args),
    lookupAdmittedBulkCampaignReplay: (...args: unknown[]) =>
      mockLookupAdmittedBulkCampaignReplay(...args),
  };
});

jest.mock("@/lib/campaign/queue-prepared-bulk-campaign-dispatch", () => {
  const actual = jest.requireActual(
    "@/lib/campaign/queue-prepared-bulk-campaign-dispatch"
  ) as Record<string, (...args: unknown[]) => unknown>;
  return {
    ...actual,
    ensureAdmittedBulkCampaignReplayStarted: (...args: unknown[]) =>
      mockEnsureAdmittedBulkCampaignReplayStarted(...args),
    queuePreparedBulkCampaignDispatch: (...args: unknown[]) => {
      const override =
        mockQueuePreparedBulkCampaignDispatchOverride.getMockImplementation();
      return override
        ? mockQueuePreparedBulkCampaignDispatchOverride(...args)
        : actual.queuePreparedBulkCampaignDispatch(...args);
    },
  };
});

jest.mock("@/lib/campaign/marketing-opt-in", () => {
  const actual = jest.requireActual(
    "@/lib/campaign/marketing-opt-in"
  ) as Record<string, unknown>;
  return {
    ...actual,
    filterKnownMarketingOptOutRecipients: (...args: unknown[]) =>
      mockFilterKnownMarketingOptOutRecipients(...args),
  };
});

jest.mock("@/lib/campaign/prior-failed-recipient-filter", () => ({
  filterPriorFailedBulkCampaignCandidates: (...args: unknown[]) =>
    mockFilterPriorFailedBulkCampaignCandidates(...args),
}));

jest.mock("@/lib/customers/registration-contact", () => ({
  resolveRegisteredBusinessPhoneAudience: (...args: unknown[]) =>
    mockResolveRegisteredBusinessPhoneAudience(...args),
}));

jest.mock("@/lib/telegram/subscribers", () => ({
  resolveTelegramSubscribersAudience: (...args: unknown[]) =>
    mockResolveTelegramSubscribersAudience(...args),
  findEligibleTelegramSubscriberMap: (...args: unknown[]) =>
    mockFindEligibleTelegramSubscriberMap(...args),
  findTelegramSubscriberStatusMap: (...args: unknown[]) =>
    mockFindTelegramSubscriberStatusMap(...args),
}));

import { POST } from "./route";
import { parseBulkCampaignSendRequest } from "@/lib/campaign/bulk-campaign-contracts";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
import {
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  buildRecipientColumnSplitPathHandleId,
  buildWhatsAppTemplateButtonPayload,
} from "@icecore/scenario-contracts";
import {
  SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
  SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
} from "@icecore/scenario-contracts";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { NextResponse } from "next/server";
import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";

function createSupabaseMock(options?: {
  platformAdmin?: boolean;
  telegramSource?: { id: string; credentials: Record<string, unknown> } | null;
  membershipRole?: string;
  workspace?: {
    id?: string | null;
    name?: string | null;
    company_id?: string | null;
    companies?:
      | { id?: string | null; name?: string | null; slug?: string | null }
      | Array<{
          id?: string | null;
          name?: string | null;
          slug?: string | null;
        }>;
  } | null;
  registeredUserLanguageRows?: unknown[];
}) {
  const membershipQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: { role: options?.membershipRole ?? "admin" },
      error: null,
    }),
  };
  const registeredUserLanguageQuery = {
    in: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({
      data: options?.registeredUserLanguageRows ?? [],
      error: null,
    }),
  };
  const companyUsersQuery = {
    select: jest.fn((columns?: string) =>
      String(columns || "").includes("workspaces!fk_workspace")
        ? registeredUserLanguageQuery
        : membershipQuery
    ),
  };
  const telegramSourceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: options?.telegramSource ?? null,
      error: null,
    }),
  };
  const workspaceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: options?.workspace ?? {
        id: workspaceIdForAiriTests,
        name: "Airi workspace",
        company_id: companyIdForAiriTests,
        companies: {
          id: companyIdForAiriTests,
          name: "airi.chat",
          slug: "airichat",
        },
      },
      error: null,
    }),
  };
  return {
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: {
          user: {
            id: "user-1",
            app_metadata:
              options?.platformAdmin === false
                ? {}
                : { platform_role: "admin" },
            user_metadata: { platform_role: "admin" },
          },
        },
      }),
    },
    from: jest.fn((table: string) => {
      if (table === "company_users") {
        return companyUsersQuery;
      }
      if (table === "workspaces") return workspaceQuery;
      if (table === "sources") return telegramSourceQuery;
      throw new Error(`Unexpected Supabase table: ${table}`);
    }),
  };
}

const workspaceIdForAiriTests = "41b51d55-697c-4455-875a-9a7238bdf272";
const companyIdForAiriTests = "d81123b4-b2fa-49d3-86af-25b4482b8269";

function selectLeanResult<T>(value: T) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function scenarioLeanResult<T>(value: T) {
  const query = {
    select: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  return query;
}

function whatsappMarketingOptIns(...phones: string[]) {
  return selectLeanResult(
    phones.map(phone => ({
      chat: phone,
      whatsapp_opt_in: {
        status: true,
        source: "manual_import_with_proof",
      },
    }))
  );
}

function forceOversizedBulkDispatchPayload() {
  const realByteLength = Buffer.byteLength.bind(
    Buffer
  ) as typeof Buffer.byteLength;
  return jest
    .spyOn(Buffer, "byteLength")
    .mockImplementation((value, encoding) => {
      if (
        typeof value === "string" &&
        value.includes('"contractVersion"') &&
        value.includes('"items"')
      ) {
        return 1_000_000;
      }
      return realByteLength(value, encoding);
    });
}

function metaThrottleError() {
  const message =
    "(#80008) There have been too many calls to this WhatsApp Business account.";
  return new MetaGraphRequestError({
    message,
    status: 400,
    statusText: "Bad Request",
    url: "https://graph.facebook.com/v23.0/waba-1/message_templates",
    details: {},
    metaError: { message, type: "OAuthException", code: 80008 },
  });
}

// Sends exactly `body`: tests opt in to every field they need.
function bulkSendRequest(body: unknown) {
  return new Request("http://localhost/api/campaigns/bulk-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postBulkSend(body: unknown) {
  return POST(bulkSendRequest(body));
}

function scenarioRunNowProvenance(
  scenarioId: string,
  target: Record<string, string> = { actionNodeId: "tpl-1" }
) {
  return {
    kind: "scenario_run_now",
    scenarioId,
    rootNodeId: "node-bulk-root",
    ...target,
  };
}

function channelBatchPlanPreview(
  channel: string,
  batchPlan: Record<string, unknown>
) {
  return {
    channel,
    batchPlan,
    recipientLimit: {
      maxRecipients: 1000,
      rawLimit: "1000",
      source: "channel_default",
    },
  };
}

function emailBatchPlanPreview() {
  return channelBatchPlanPreview("email", {
    batchSize: 20,
    delayMs: 334,
    ratePerSecond: 60,
    rateSource: "channel_default",
  });
}

function telegramFreeBroadcastPreview() {
  return channelBatchPlanPreview("telegram", {
    batchSize: 30,
    delayMs: 1000,
    ratePerSecond: 30,
    rateSource: "telegram_free_broadcast_limit",
  });
}

async function withSilencedConsoleError(run: () => Promise<void>) {
  const consoleErrorSpy = jest
    .spyOn(console, "error")
    .mockImplementation(() => {});
  try {
    await run();
  } finally {
    consoleErrorSpy.mockRestore();
  }
}

function expectNothingDispatched() {
  expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
}

describe("POST /api/campaigns/bulk-send", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";

  // The approved "promo" WhatsApp template body; every other field is opt-in.
  function promoBody(fields: Record<string, unknown> = {}) {
    return {
      workspaceId,
      channel: "whatsapp",
      templateName: "promo",
      ...fields,
    };
  }

  function postPromo(fields: Record<string, unknown> = {}) {
    return postBulkSend(promoBody(fields));
  }

  function unlimitedBulkRecipientAllowance() {
    return {
      limit: {
        subscriptionType: "pro",
        bulkRecipientLimit: null,
        bulkRecipientCount: null,
        bulkRecipientsRemaining: null,
        bulkRecipientExhausted: false,
      },
      remaining: null,
    };
  }

  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalEncryptionSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    [
      mockCreateClient,
      mockConnectDB,
      mockResolveCampaignBatchPlanPreview,
      mockResolveWhatsAppSendContext,
      mockListTemplates,
      mockIsTemporalConfigured,
      mockStartBulkCampaignDispatchWorkflow,
      mockConversationFind,
      mockDeriveBulkSendCampaignId,
      mockReserveLegacyIdempotency,
      mockCompleteLegacyIdempotency,
      mockReleaseLegacyIdempotency,
      mockCreateLegacyRequestDigest,
      mockNormalizeHeaderMedia,
      mockEnsureCompanyConversationCapacity,
      mockBuildCompanyLimitExceededResponse,
      mockReadCompanyBulkRecipientAllowance,
      mockBuildCompanyBulkRecipientLimitExceededResponse,
      mockResolveBulkAnalyticsAudience,
      mockScenarioFindOne,
      mockScenarioUpdateOne,
      mockSaveScenario,
      mockIsBulkDispatchPayloadStoreConfigured,
      mockStoreBulkCampaignDispatchItems,
      mockSupabaseAdminListUsers,
      mockSupabaseAdminFrom,
      mockGetWorkspaceEmailProviderConfig,
      mockGetWorkspaceEmailSource,
      mockResolveEmailProviderForWorkspaceSource,
      mockIsManagedEmailProviderPending,
      mockCreateCampaignHistoryRecord,
      mockUpdateCampaignHistoryRecipientCount,
      mockResolveRegisteredBusinessPhoneAudience,
      mockResolveTelegramSubscribersAudience,
      mockFindEligibleTelegramSubscriberMap,
      mockFindTelegramSubscriberStatusMap,
      mockAdmitBulkCampaign,
      mockLookupAdmittedBulkCampaignReplay,
      mockFailCampaignDispatchBeforeStart,
      mockEmitCampaignHistoryCreatedUsageBestEffort,
      mockFilterKnownMarketingOptOutRecipients,
      mockFilterPriorFailedBulkCampaignCandidates,
      mockLoggerInfo,
      mockLoggerWarn,
      mockIsWorkspaceFeatureEnabled,
      mockFilterEmailUnsubscribedRecipients,
      mockEnsureAdmittedBulkCampaignReplayStarted,
      mockQueuePreparedBulkCampaignDispatchOverride,
      mockPartitionRecentlyContactedRecipients,
    ].forEach(mock => mock.mockReset());
    process.env.NEXT_PUBLIC_APP_URL = "https://app.airi.chat";
    process.env.ENCRYPTION_SECRET = "test-bulk-campaign-encryption-secret";
    mockCreateClient.mockResolvedValue(createSupabaseMock());
    mockConnectDB.mockResolvedValue(undefined);
    mockRecentContacts([], null);
    mockDeriveBulkSendCampaignId.mockReturnValue(
      "9f29e513-bf52-54f0-b63e-f1f23eef8f22"
    );
    mockCreateLegacyRequestDigest.mockReturnValue("d".repeat(64));
    mockReserveLegacyIdempotency.mockResolvedValue({
      status: "acquired",
      reservationToken: "legacy-owner-token",
    });
    mockCompleteLegacyIdempotency.mockResolvedValue(true);
    mockReleaseLegacyIdempotency.mockResolvedValue(true);
    mockLookupAdmittedBulkCampaignReplay.mockResolvedValue(null);
    mockEnsureAdmittedBulkCampaignReplayStarted.mockResolvedValue({
      workflowStart: {
        status: "started",
        temporalDispatchStaging: "inline",
      },
      admittedItems: [],
      requestedAt: "2026-08-21T09:00:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2026-08-21T09:15:00.000Z",
    });
    mockIsWorkspaceFeatureEnabled.mockResolvedValue(true);
    mockFilterEmailUnsubscribedRecipients.mockImplementation(
      async (...args: unknown[]) => {
        const actual = jest.requireActual(
          "@/lib/campaign/email-bulk-preflight"
        ) as {
          filterEmailUnsubscribedRecipients: (
            ...innerArgs: unknown[]
          ) => Promise<unknown>;
        };
        return actual.filterEmailUnsubscribedRecipients(...args);
      }
    );
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: {
        subscriptionType: "free",
        conversationLimit: 500,
        conversationCount: 100,
        conversationsRemaining: 400,
        bulkRecipientLimit: 500,
        bulkRecipientCount: null,
        bulkRecipientsRemaining: null,
        bulkRecipientExhausted: false,
        exhausted: false,
        lockedCapabilities: [],
      },
    });
    mockReadCompanyBulkRecipientAllowance.mockResolvedValue({
      limit: {
        subscriptionType: "free",
        bulkRecipientLimit: 500,
        bulkRecipientCount: 0,
        bulkRecipientsRemaining: 500,
        bulkRecipientExhausted: false,
      },
      remaining: 500,
    });
    mockBuildCompanyBulkRecipientLimitExceededResponse.mockImplementation(() =>
      NextResponse.json(
        {
          code: "company_bulk_campaign_limit_exceeded",
          error: "Company bulk recipient allowance used.",
        },
        { status: 402 }
      )
    );
    mockBuildCompanyLimitExceededResponse.mockReturnValue(
      NextResponse.json(
        {
          code: "company_conversation_limit_exceeded",
          error: "Company conversation limit exceeded",
        },
        { status: 402 }
      )
    );
    mockIsTemporalConfigured.mockReturnValue(true);
    mockResolveWhatsAppSendContext.mockResolvedValue({
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      accessToken: "token-1",
      cachedMessagingLimit: "TIER_1K",
    });
    mockResolveCampaignBatchPlanPreview.mockResolvedValue({
      readiness: {
        state: "ready",
        checkedAt: "2026-09-16T00:00:00.000Z",
        remainingCapacity: null,
        reasons: [],
      },
      channel: "whatsapp",
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_throughput",
      },
      recipientLimit: {
        maxRecipients: 1000,
        rawLimit: "TIER_1K",
        source: "cached_meta",
      },
    });
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "promo",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [],
        },
      ],
    });
    mockConversationFind.mockReturnValue(selectLeanResult([]));
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async (...args: unknown[]) => {
        const actual = jest.requireActual(
          "@/lib/campaign/marketing-opt-in"
        ) as {
          filterKnownMarketingOptOutRecipients: (
            ...innerArgs: unknown[]
          ) => Promise<unknown>;
        };
        return actual.filterKnownMarketingOptOutRecipients(...args);
      }
    );
    mockFilterPriorFailedBulkCampaignCandidates.mockImplementation(
      async ({ candidates }: { candidates: unknown[] }) => ({
        candidates,
        skippedPriorFailed: 0,
      })
    );
    mockResolveBulkAnalyticsAudience.mockResolvedValue({
      total: 0,
      eligibleTotal: 0,
      excludedOptIn: 0,
      recipients: [],
      capped: false,
      maxRecipients: 1000,
    });
    mockResolveRegisteredBusinessPhoneAudience.mockResolvedValue({
      total: 1,
      complete: true,
      truncated: false,
      recipients: [
        {
          phone: "+15550000002",
          name: "Founder",
          variables: {
            recipientName: "Founder",
            name: "Founder",
            phone: "15550000002",
          },
        },
      ],
    });
    mockResolveTelegramSubscribersAudience.mockResolvedValue({
      total: 1,
      recipients: [
        {
          chatId: "123456",
          sourceId: "telegram-source-1",
          name: "Ada",
          variables: { name: "Ada" },
        },
      ],
    });
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(
      new Map([
        [
          "123456:telegram-source-1",
          {
            chatId: "123456",
            sourceId: "telegram-source-1",
            status: "imported",
          },
        ],
      ])
    );
    mockFindTelegramSubscriberStatusMap.mockResolvedValue(
      new Map([
        [
          "123456:telegram-source-1",
          {
            chatId: "123456",
            sourceId: "telegram-source-1",
            status: "imported",
          },
        ],
      ])
    );
    mockNormalizeHeaderMedia.mockImplementation(
      async ({ components }: { components?: unknown[] }) => components
    );
    mockStartBulkCampaignDispatchWorkflow.mockResolvedValue({
      workflowId: "bulk-campaign-dispatch:test",
    });
    mockAdmitBulkCampaign.mockImplementation(
      async (
        _client: unknown,
        input: {
          campaignId: string;
          dispatchStatus: "queued" | "scheduled";
          audience: { fingerprint: string; count: number };
          workflowId: string;
          requestedAt: string;
          dispatchExpiresAt: string;
        }
      ) => ({
        status: "admitted",
        campaignId: input.campaignId,
        workflowId: input.workflowId,
        dispatchStatus: input.dispatchStatus,
        requestedAt: input.requestedAt,
        dispatchExpiresAt: input.dispatchExpiresAt,
        audienceCount: input.audience.count,
        idempotentReplay: false,
        audienceFingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: input.audience.count,
          ratio: 0,
        },
      })
    );
    mockFailCampaignDispatchBeforeStart.mockResolvedValue(true);
    mockScenarioFindOne.mockImplementation((query: Record<string, unknown>) => {
      const scenarioProjectionQuery = {
        select: jest.fn(),
        lean: jest.fn().mockResolvedValue({
          _id: query._id,
          workspaceId: query.workspaceId,
          mode: "bulk_campaign",
          deletedAt: null,
          status: "draft",
          nodes: [
            {
              id: "node-bulk-root",
              data: {
                kind: "bulk",
                bulkRootConfig: {
                  workflowKind: "bulk_campaign",
                  channels: ["whatsapp"],
                  sourceIds: ["source-1"],
                },
              },
            },
            {
              id: "tpl-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "promo",
                actionWhatsAppTemplateLanguage: "en",
                actionWhatsAppTemplateCategory: "MARKETING",
                actionWhatsAppTemplateComponents: [],
              },
            },
          ],
          edges: [
            {
              source: "node-bulk-root",
              sourceHandle: "right-source",
              target: "tpl-1",
            },
          ],
        }),
      };
      scenarioProjectionQuery.select.mockReturnValue(scenarioProjectionQuery);
      return scenarioProjectionQuery;
    });
    mockScenarioUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockIsBulkDispatchPayloadStoreConfigured.mockReturnValue(false);
    mockStoreBulkCampaignDispatchItems.mockResolvedValue({
      payloadKey: `bulk_campaign_dispatch/v1/${workspaceId}/payload-1.json`,
      byteLength: 1_000_000,
    });
    mockCreateCampaignHistoryRecord.mockResolvedValue({
      campaignId: "campaign-1",
      errorMessage: null,
    });
    mockUpdateCampaignHistoryRecipientCount.mockResolvedValue(undefined);
    mockSupabaseAdminFrom.mockImplementation((table: string) => {
      if (table === "email_unsubscribes") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      throw new Error(`Unexpected Supabase admin table: ${table}`);
    });
    mockSupabaseAdminListUsers.mockResolvedValue({
      data: { users: [], nextPage: null, total: 0 },
      error: null,
    });
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue({
      defaultFromAddress: "updates@airi.chat",
      postmarkServerToken: "postmark-server-token",
      transactionalStream: "outbound",
      broadcastStream: "broadcast",
      status: "active",
    });
    mockIsManagedEmailProviderPending.mockReturnValue(false);
    mockGetWorkspaceEmailSource.mockResolvedValue(null);
    mockResolveEmailProviderForWorkspaceSource.mockResolvedValue(null);
  });

  afterAll(() => {
    if (originalAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
    if (originalEncryptionSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = originalEncryptionSecret;
    }
  });

  it.each(["viewer", "member", "owner"])(
    "rejects unauthorized workspace role %s before provenance, audience, catalog, or media work",
    async membershipRole => {
      mockCreateClient.mockResolvedValueOnce(
        createSupabaseMock({ membershipRole })
      );

      const response = await postPromo({
        audience: {
          kind: "analytics_with_fill_up",
          analytics: { filters: { days: 30 } },
          fillUpRecipients: [],
        },
        provenance: scenarioRunNowProvenance("65f000000000000000000001"),
      });

      expect(response.status).toBe(403);
      expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
      expect(mockScenarioFindOne).not.toHaveBeenCalled();
      expect(mockResolveBulkAnalyticsAudience).not.toHaveBeenCalled();
      expect(mockListTemplates).not.toHaveBeenCalled();
      expect(mockNormalizeHeaderMedia).not.toHaveBeenCalled();
    }
  );

  it.each(["manager", "admin"])(
    "queues uploaded marketing recipients for %s without recorded positive consent",
    async membershipRole => {
      mockCreateClient.mockResolvedValueOnce(
        createSupabaseMock({ membershipRole })
      );
      const response = await postBulkSend({
        workspaceId,
        campaignName: "promo test",
        channel: "whatsapp",
        templateName: "promo",
        languageCode: "en",
        templateCategory: "MARKETING",
        templateComponents: [],
        recipients: [{ phone: "+15550000002" }],
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mockAdmitBulkCampaign).toHaveBeenCalledTimes(1);
      expect(mockAdmitBulkCampaign).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyBulkCampaignLimit: 500,
          companySubscriptionType: "free",
        })
      );
      expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          items: [
            expect.objectContaining({
              recipient: { phone: "+15550000002" },
            }),
          ],
        })
      );
      expect(payload).toEqual(
        expect.objectContaining({
          queued: true,
          requestedTotal: 1,
          skippedOptIn: 0,
          audience: expect.objectContaining({
            requestedTotal: 1,
            queuedTotal: 1,
            skippedOptIn: 0,
          }),
        })
      );
      expect(
        mockFilterPriorFailedBulkCampaignCandidates
      ).not.toHaveBeenCalled();
      expect(payload).toHaveProperty("skippedPriorFailed", 0);
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "bulk_campaign.policy",
        expect.objectContaining({
          disposition: "queued",
          itemCounts: { requested: 1, accepted: 1, queued: 1 },
          idempotentReplay: false,
        })
      );
      expect(JSON.stringify(mockLoggerInfo.mock.calls[0]?.[1])).not.toContain(
        "15550000002"
      );
    }
  );

  it("passes each row's own name, never the phone, on WhatsApp dispatch items", async () => {
    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo test",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      templateComponents: [],
      recipients: [
        { phone: "+15550000002", name: " Aigerim " },
        { phone: "+15550000003", fields: { "Full Name": "Dana Sadykova" } },
        { phone: "+15550000004" },
      ],
    });

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000002", name: "Aigerim" },
          }),
          expect.objectContaining({
            recipient: { phone: "+15550000003", name: "Dana Sadykova" },
          }),
          expect.objectContaining({
            recipient: { phone: "+15550000004" },
          }),
        ],
      })
    );
  });

  it.each([
    ["blocked", 409, "whatsapp_sending_blocked"],
    ["unavailable", 503, "whatsapp_sending_unavailable"],
  ])(
    "rejects %s provider health before fresh admission",
    async (state, status, code) => {
      mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce({
        readiness: {
          state,
          checkedAt: "2026-09-15T19:00:00.000Z",
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
      const response = await postPromo({
        languageCode: "en",
        templateCategory: "MARKETING",
        recipients: [{ phone: "+15550000002" }],
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        code,
        readiness: { state, remainingCapacity: null },
      });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expectNothingDispatched();
      expect(mockStoreBulkCampaignDispatchItems).not.toHaveBeenCalled();
    }
  );

  it("skips a recently contacted marketing recipient and queues the rest", async () => {
    mockRecentContacts(["+15550000002"]);
    const response = await postBulkSend({
      workspaceId,
      campaignName: "fresh cooldown",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      templateComponents: [],
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockPartitionRecentlyContactedRecipients).toHaveBeenCalledTimes(1);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000003" },
          }),
        ],
      })
    );
    // The admission ledger stores the skip with the campaign.
    expect(mockAdmitBulkCampaign.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        audience: expect.objectContaining({
          count: 1,
          metadata: expect.objectContaining({
            outcome: expect.objectContaining({
              requestedTotal: 2,
              acceptedTotal: 1,
              skippedByReason: { recent_contact: 1 },
            }),
          }),
        }),
      })
    );
    expect(payload).toMatchObject({
      outcome: {
        requestedTotal: 2,
        acceptedTotal: 1,
        queuedTotal: 1,
        skippedByReason: { recent_contact: 1 },
      },
    });
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "campaign_queued", workspaceId })
    );
  });

  it("sends nothing and reports the skip when every marketing recipient was contacted recently", async () => {
    mockRecentContacts(["+15550000002", "+15550000003"]);
    const response = await postBulkSend({
      workspaceId,
      campaignName: "fresh cooldown",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      templateComponents: [],
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      outcome: {
        disposition: "no_op",
        lifecycleStatus: "completed",
        requestedTotal: 2,
        acceptedTotal: 0,
        queuedTotal: 0,
        skippedByReason: { recent_contact: 2 },
      },
    });
    expectNothingDispatched();
    expect(mockStoreBulkCampaignDispatchItems).not.toHaveBeenCalled();
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "campaign_send_blocked",
        properties: expect.objectContaining({ code: "no_op", status: 200 }),
      })
    );
  });

  it("skips recent service-text contacts only among recipients inside the service window", async () => {
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        { chat: "15550000002", last_inbound_at: new Date() },
        { chat: "15550000003", last_inbound_at: new Date() },
      ])
    );
    mockRecentContacts(["+15550000002"]);

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Your support update",
      recipients: [
        { phone: "+15550000002" },
        { phone: "+15550000003" },
        { phone: "+15550000004" },
      ],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockPartitionRecentlyContactedRecipients).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        recipients: [
          expect.objectContaining({ phone: "+15550000002" }),
          expect.objectContaining({ phone: "+15550000003" }),
        ],
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: expect.objectContaining({ phone: "+15550000003" }),
          }),
        ],
      })
    );
    expect(payload).toMatchObject({
      requestedTotal: 3,
      skippedServiceWindow: 1,
      outcome: {
        requestedTotal: 3,
        acceptedTotal: 1,
        queuedTotal: 1,
        skippedByReason: { service_window: 1, recent_contact: 1 },
      },
    });
  });

  it("fails closed before fresh admission when the contact policy cannot be read", async () => {
    mockPartitionRecentlyContactedRecipients.mockRejectedValue(
      new Error("contact store unavailable")
    );
    const response = await postBulkSend({
      workspaceId,
      campaignName: "fresh cooldown",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      templateComponents: [],
      recipients: [{ phone: "+15550000002" }],
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "contact_policy_unavailable",
    });
    expectNothingDispatched();
  });

  it.each(["template", "service_text"] as const)(
    "reports the %s outcome as of the contact policy check, not the response time",
    async messageType => {
      const evaluatedAt = new Date("2026-09-19T15:00:00.000Z");
      jest.useFakeTimers({ now: evaluatedAt });
      try {
        mockConversationFind.mockReturnValueOnce(
          selectLeanResult([
            { chat: "15550000002", last_inbound_at: evaluatedAt },
          ])
        );
        mockPartitionRecentlyContactedRecipients.mockImplementation(
          async ({ recipients }: { recipients: unknown[] }) => {
            jest.setSystemTime(new Date("2026-09-19T15:00:10.000Z"));
            return {
              allowed: [],
              recentlyContacted: recipients,
              nextEligibleAt: "2026-09-19T15:05:00.000Z",
            };
          }
        );
        const response = await postBulkSend({
          workspaceId,
          channel: "whatsapp",
          ...(messageType === "template"
            ? {
                templateName: "promo",
                languageCode: "en",
                templateCategory: "MARKETING",
              }
            : {
                whatsappMessageType: "service_text",
                messageText: "Your support update",
              }),
          recipients: [{ phone: "+15550000002" }],
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          outcome: {
            disposition: "no_op",
            evaluatedAt: "2026-09-19T15:00:00.000Z",
            skippedByReason: { recent_contact: 1 },
          },
        });
        expect(mockPartitionRecentlyContactedRecipients).toHaveBeenCalledWith(
          expect.objectContaining({ now: evaluatedAt })
        );
        expectNothingDispatched();
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it("blocks a conflicting browser category before media or admission", async () => {
    const response = await postPromo({
      languageCode: "en",
      templateCategory: "UTILITY",
      recipients: [{ phone: "+15550000002" }],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      disposition: "blocked",
      code: "template_category_conflict",
    });
    expect(mockNormalizeHeaderMedia).not.toHaveBeenCalled();
    expectNothingDispatched();
  });

  it("answers a Meta rate limit during the template check with a retryable 503", async () => {
    mockListTemplates.mockRejectedValueOnce(metaThrottleError());

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      disposition: "blocked",
      code: "meta_rate_limited",
      retryAfterSeconds: 60,
    });
    expectNothingDispatched();
  });

  it("answers a template catalog cooldown during the template check with the time it ends", async () => {
    const retryAt = new Date(Date.now() + 180_000).toISOString();
    mockListTemplates.mockRejectedValueOnce(
      new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        message:
          "Meta temporarily limited WhatsApp template requests. Try again after the cooldown.",
        retryAt,
        providerCode: 80008,
      })
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("180");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      disposition: "blocked",
      code: "meta_rate_limited",
      retryAfterSeconds: 180,
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId,
        code: "meta_rate_limited",
        catalogCode: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        providerCode: 80008,
        retryAt,
        retryAfterSeconds: 180,
      })
    );
    expectNothingDispatched();
  });

  it("answers a failed Analytics template catalog with a coded 503, not raw Graph text", async () => {
    mockListTemplates.mockRejectedValueOnce(metaThrottleError());

    const response = await postPromo({
      languageCode: "en",
      analyticsAudience: {
        type: "bulk_analytics",
        filters: { days: 14 },
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(payload).toMatchObject({ ok: false, code: "meta_rate_limited" });
    expect(JSON.stringify(payload)).not.toContain("80008");
    expect(mockResolveBulkAnalyticsAudience).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("excludes prior recipient-scoped failures from the final WhatsApp dispatch", async () => {
    mockFilterPriorFailedBulkCampaignCandidates.mockImplementationOnce(
      async ({ candidates }: { candidates: unknown[] }) => ({
        candidates: candidates.slice(1),
        skippedPriorFailed: 1,
      })
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "exclude prior failures",
      channel: "whatsapp",
      templateName: "promo",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
      excludePriorFailedBulkSends: true,
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterPriorFailedBulkCampaignCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({ client: "supabase-admin" }),
        secret: "test-bulk-campaign-encryption-secret",
        workspaceId,
        channel: "whatsapp",
        candidates: expect.arrayContaining([
          expect.objectContaining({ recipient: { phone: "+15550000002" } }),
          expect.objectContaining({ recipient: { phone: "+15550000003" } }),
        ]),
        recipientFor: expect.any(Function),
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000003" },
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        total: 1,
        requestedTotal: 2,
        skippedPriorFailed: 1,
      })
    );
    expect(payload.recipientLimit).toMatchObject({
      originalCount: 2,
      acceptedCount: 1,
      truncated: false,
    });
  });

  it("returns a canonical no-op before capacity when prior-failure exclusion removes every recipient", async () => {
    mockEnsureCompanyConversationCapacity.mockResolvedValueOnce({
      allowed: false,
      limit: {
        subscriptionType: "free",
        conversationLimit: 500,
        conversationCount: 500,
        conversationsRemaining: 0,
        exhausted: true,
        lockedCapabilities: ["bulk_campaigns"],
      },
    });
    mockFilterPriorFailedBulkCampaignCandidates.mockResolvedValueOnce({
      candidates: [],
      skippedPriorFailed: 2,
    });

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
      excludePriorFailedBulkSends: true,
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      outcome: {
        disposition: "no_op",
        lifecycleStatus: "completed",
        requestedTotal: 2,
        acceptedTotal: 0,
        queuedTotal: 0,
        skippedByReason: { prior_failure: 2 },
      },
    });
    expectNothingDispatched();
    expect(mockNormalizeHeaderMedia).not.toHaveBeenCalled();
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        disposition: "no_op",
        itemCounts: { requested: 2, accepted: 0, queued: 0 },
        skippedByReason: { prior_failure: 2 },
      })
    );
  });

  it("fails closed before admission when prior-failure history is unavailable", async () => {
    mockFilterPriorFailedBulkCampaignCandidates.mockRejectedValueOnce(
      new Error("Prior failed recipient lookup is unavailable.")
    );
    await withSilencedConsoleError(async () => {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        excludePriorFailedBulkSends: true,
      });
      const payload = await response.json();

      expect(response.status).toBe(503);
      expect(payload).toMatchObject({
        ok: false,
        disposition: "blocked",
        code: "prior_failure_lookup_failed",
      });
      expectNothingDispatched();
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "bulk_campaign.policy",
        expect.objectContaining({
          disposition: "blocked",
          errorCode: "prior_failure_lookup_failed",
        })
      );
    });
  });

  it("excludes an explicit opt-out and queues the remaining uploaded recipient", async () => {
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "+15550000002",
          whatsapp_opt_in: {
            status: false,
            source: "whatsapp_user_preferences",
            updatedAt: "2026-07-25T08:00:00.000Z",
          },
        },
        {
          chat: "+15550000003",
          whatsapp_opt_in: {
            status: true,
            source: "manual_import_with_proof",
          },
        },
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo all opt-outs",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000003" },
          }),
        ],
      })
    );
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(mockUpdateCampaignHistoryRecipientCount).not.toHaveBeenCalled();
    expect(payload).toEqual(
      expect.objectContaining({
        total: 1,
        requestedTotal: 2,
        skippedOptIn: 1,
      })
    );
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "campaign_queued",
        workspaceId,
        properties: expect.objectContaining({
          channel: "whatsapp",
          source: "page",
          requested_recipients: 2,
        }),
      })
    );
  });

  it("resolves the complete registered-phone audience at the shared 50,000 cap", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "Registered business phone follow-up",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      registeredBusinessPhonesAudience: {
        type: SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.total).toBe(1);
    expect(mockResolveRegisteredBusinessPhoneAudience).toHaveBeenCalledWith({
      workspaceId,
      selectedPhones: undefined,
      limit: 50_000,
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            channel: "whatsapp",
            recipient: { phone: "+15550000002", name: "Founder" },
            components: expect.arrayContaining([
              expect.objectContaining({
                type: "body",
              }),
            ]),
            templateName: "promo",
            templateCategory: "MARKETING",
          }),
        ],
      })
    );
  });

  it("keeps the approved marketing category when a registered audience is all excluded", async () => {
    mockFilterKnownMarketingOptOutRecipients.mockImplementationOnce(
      async ({ recipients }: { recipients: unknown[] }) => ({
        recipients: [],
        skippedRecipients: recipients,
        skippedOptIn: recipients.length,
        skippedPhones: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningRecipients: [],
        marketingOptInWarningPhones: [],
      })
    );

    const response = await postPromo({
      languageCode: "en",
      registeredBusinessPhonesAudience: {
        type: SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      outcome: {
        disposition: "no_op",
        acceptedTotal: 0,
        queuedTotal: 0,
        skippedByReason: { marketing_opt_out: 1 },
      },
    });
    expectNothingDispatched();
  });

  it("queues Telegram subscriber audience recipients without requiring conversation rows", async () => {
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({
        telegramSource: {
          id: "telegram-source-1",
          credentials: { bot_token: "telegram-token" },
        },
      })
    );
    mockResolveCampaignBatchPlanPreview.mockResolvedValue(
      telegramFreeBroadcastPreview()
    );
    mockConversationFind.mockReturnValueOnce(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      campaignName: "Telegram subscriber update",
      channel: "telegram",
      messageText: "Hello {{name}}",
      telegramSubscribersAudience: {
        type: SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
        sourceId: "telegram-source-1",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.total).toBe(1);
    expect(mockResolveTelegramSubscribersAudience).toHaveBeenCalledWith({
      workspaceId,
      sourceId: "telegram-source-1",
      selectedChatIds: undefined,
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            channel: "telegram",
            sourceId: "telegram-source-1",
            recipient: expect.objectContaining({ chatId: "123456" }),
            messageText: "Hello Ada",
          }),
        ],
      })
    );
  });

  it("returns a canonical no-op when every Telegram recipient is ineligible", async () => {
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({
        telegramSource: {
          id: "telegram-source-1",
          credentials: { bot_token: "telegram-token" },
        },
      })
    );
    mockResolveCampaignBatchPlanPreview.mockResolvedValue(
      telegramFreeBroadcastPreview()
    );
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "123456",
          sourceId: "telegram-source-1",
          first_inbound_at: new Date().toISOString(),
          last_inbound_at: new Date().toISOString(),
        },
      ])
    );
    mockFindTelegramSubscriberStatusMap.mockResolvedValueOnce(
      new Map([
        [
          "123456:telegram-source-1",
          {
            chatId: "123456",
            sourceId: "telegram-source-1",
            status: "blocked",
          },
        ],
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "Telegram blocked user",
      channel: "telegram",
      messageText: "Hello",
      recipients: [{ chatId: "123456", sourceId: "telegram-source-1" }],
      idempotencyKey: "telegram-all-ineligible-no-detail",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      skippedIneligible: 1,
      outcome: {
        disposition: "no_op",
        lifecycleStatus: "completed",
        requestedTotal: 1,
        acceptedTotal: 0,
        queuedTotal: 0,
        uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
        skippedByReason: { ineligible: 1 },
      },
    });
    expectNothingDispatched();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(payload).not.toHaveProperty("skippedRecipientDetails");
    expect(JSON.stringify(payload)).not.toContain("123456");
    expect(mockCompleteLegacyIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: expect.not.objectContaining({
          skippedRecipientDetails: expect.anything(),
        }),
      })
    );
    expect(
      JSON.stringify(mockCompleteLegacyIdempotency.mock.calls[0]?.[0])
    ).not.toContain("123456");
  });

  it("rejects registered business phone audiences outside the Airi workspace", async () => {
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({
        workspace: {
          id: workspaceId,
          company_id: "22222222-2222-4222-8222-222222222222",
          companies: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Other company",
            slug: "other",
          },
        },
      })
    );

    const response = await postPromo({
      languageCode: "en",
      registeredBusinessPhonesAudience: {
        type: SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe(
      "Registered business phone audience requires platform admin access in the airi.chat workspace."
    );
    expect(mockResolveRegisteredBusinessPhoneAudience).not.toHaveBeenCalled();
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("queues WhatsApp marketing message pricing for onboarded Marketing Messages sources", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockResolveWhatsAppSendContext.mockResolvedValue({
      sourceId: "source-1",
      phoneNumberId: "phone-number-1",
      accessToken: "token-1",
      cachedMessagingLimit: "TIER_1K",
      marketingMessagesEnabled: true,
    });

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo with bid",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      marketingMessagePricing: {
        perMessageBidMultiplier: 1.4,
      },
    });
    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            channel: "whatsapp",
            marketingMessagePricing: {
              perMessageBidMultiplier: 1.4,
            },
          }),
        ],
      })
    );
    const queuedItem =
      mockStartBulkCampaignDispatchWorkflow.mock.calls[0]?.[0]?.items?.[0];
    expect(queuedItem).not.toHaveProperty("accessToken");
    expect(queuedItem).not.toHaveProperty("messagingAccountId");
    expect(queuedItem).not.toHaveProperty("marketingMessagesEnabled");
  });

  it("rejects WhatsApp marketing message pricing when Marketing Messages is not enabled", async () => {
    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo with bid",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      marketingMessagePricing: {
        perMessageBidMultiplier: 1.4,
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/Marketing Messages API/);
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("adds scenario quick-reply payloads to uploaded WhatsApp template buttons", async () => {
    const scenarioId = "65f000000000000000000001";
    mockListTemplates.mockResolvedValueOnce({
      templates: [
        {
          name: "promo",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Interested" }],
            },
          ],
        },
      ],
    });
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo all opt-outs",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      scenarioId,
      scenarioNodeId: "tpl-1",
      executionSource: "scenario_run_now",
      templateComponents: [
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Interested" }],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            scenarioId,
            scenarioNodeId: "tpl-1",
            components: [
              {
                type: "button",
                sub_type: "quick_reply",
                index: "0",
                parameters: [
                  {
                    type: "payload",
                    payload: buildWhatsAppTemplateButtonPayload("tpl-1", 0),
                  },
                ],
              },
            ],
          }),
        ],
      })
    );
  });

  it("names the scenario step's buttons in quick-reply payloads when the approved template orders them differently", async () => {
    const scenarioId = "65f000000000000000000003";
    const quickReplies = (...labels: string[]) => [
      {
        type: "BUTTONS",
        buttons: labels.map(text => ({ type: "QUICK_REPLY", text })),
      },
    ];
    mockScenarioFindOne.mockImplementation(() =>
      scenarioLeanResult({
        _id: scenarioId,
        workspaceId,
        mode: "bulk_campaign",
        deletedAt: null,
        status: "draft",
        nodes: [
          {
            id: "node-bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                workflowKind: "bulk_campaign",
                channels: ["whatsapp"],
                sourceIds: ["source-1"],
              },
            },
          },
          {
            id: "tpl-1",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "promo",
              actionWhatsAppTemplateLanguage: "en",
              actionWhatsAppTemplateCategory: "MARKETING",
              actionWhatsAppTemplateComponents: quickReplies(
                "Basic",
                "Premium"
              ),
            },
          },
        ],
        edges: [
          {
            source: "node-bulk-root",
            sourceHandle: "right-source",
            target: "tpl-1",
          },
        ],
      })
    );
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "promo",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: quickReplies("Premium", "Basic"),
        },
      ],
    });
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      provenance: scenarioRunNowProvenance(scenarioId),
    });

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            scenarioNodeId: "tpl-1",
            components: [0, 1].map(index => ({
              type: "button",
              sub_type: "quick_reply",
              index: String(index),
              parameters: [
                {
                  type: "payload",
                  // Premium is sent first but keeps the step's id 1.
                  payload: buildWhatsAppTemplateButtonPayload(
                    "tpl-1",
                    1 - index
                  ),
                },
              ],
            })),
          }),
        ],
      })
    );
  });

  it("adds scenario Flow tokens to uploaded WhatsApp template Flow buttons", async () => {
    const scenarioId = "65f000000000000000000002";
    mockListTemplates.mockResolvedValueOnce({
      templates: [
        {
          name: "promo",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [
            {
              type: "BUTTONS",
              buttons: [{ type: "FLOW", text: "Start", flow_id: "123" }],
            },
          ],
        },
      ],
    });
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo test",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      scenarioId,
      scenarioNodeId: "tpl-1",
      executionSource: "scenario_run_now",
      templateComponents: [
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Start", flow_id: "123" }],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            scenarioId,
            scenarioNodeId: "tpl-1",
            components: [
              {
                type: "button",
                sub_type: "flow",
                index: "0",
                parameters: [
                  {
                    type: "action",
                    action: {
                      flow_token: `bulk:${scenarioId}:tpl-1`,
                    },
                  },
                ],
              },
            ],
          }),
        ],
      })
    );
  });

  it("queues only the uploaded recipient that did not explicitly opt out", async () => {
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "+15550000002",
          whatsapp_opt_in: {
            status: false,
            source: "whatsapp_user_preferences",
            updatedAt: "2026-07-25T08:00:00.000Z",
          },
        },
        {
          chat: "+15550000003",
          whatsapp_opt_in: {
            status: true,
            source: "manual_import_with_proof",
          },
        },
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo all opt-outs",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000003" },
          }),
        ],
      })
    );
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(mockUpdateCampaignHistoryRecipientCount).not.toHaveBeenCalled();
    expect(payload).toEqual(
      expect.objectContaining({
        total: 1,
        requestedTotal: 2,
        skippedOptIn: 1,
      })
    );
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
  });

  it("resolves the WhatsApp send context from the number picked on the page", async () => {
    mockConversationFind.mockReturnValueOnce(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo from second number",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      whatsappSourceId: "source-2",
      recipients: [{ phone: "+15550000003" }],
    });

    expect(response.status).toBe(200);
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId,
      sourceId: "source-2",
    });
  });

  it("keeps the workspace default WhatsApp number when none is picked", async () => {
    mockConversationFind.mockReturnValueOnce(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo from default number",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000003" }],
    });

    expect(response.status).toBe(200);
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId,
      sourceId: undefined,
    });
  });

  it("queues uploaded marketing recipients when one has no consent record", async () => {
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "+15550000002",
          whatsapp_opt_in: {
            status: true,
            source: "manual_import_with_proof",
          },
        },
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo with unknown consent",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000002" },
          }),
          expect.objectContaining({
            recipient: { phone: "+15550000003" },
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        total: 2,
        requestedTotal: 2,
        skippedOptIn: 0,
      })
    );
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
  });

  it("rejects an uploaded marketing audience containing only opt-outs", async () => {
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "+15550000002",
          whatsapp_opt_in: {
            status: false,
            source: "whatsapp_user_preferences",
            updatedAt: "2026-07-25T08:00:00.000Z",
          },
        },
        {
          chat: "+15550000003",
          whatsapp_opt_in: {
            status: false,
            source: "whatsapp_user_preferences",
            updatedAt: "2026-07-25T08:00:00.000Z",
          },
        },
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "promo all opt-outs",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      outcome: {
        disposition: "no_op",
        lifecycleStatus: "completed",
        requestedTotal: 2,
        acceptedTotal: 0,
        queuedTotal: 0,
        skippedByReason: { marketing_opt_out: 2 },
      },
    });
    expectNothingDispatched();
    expect(mockNormalizeHeaderMedia).not.toHaveBeenCalled();
  });

  it("keeps analytics and uploaded recipients without explicit opt-outs", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002", "+15550000004")
    );
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 2,
      eligibleTotal: 2,
      excludedOptIn: 0,
      marketingOptInWarningCount: 1,
      capped: false,
      maxRecipients: 1000,
      recipients: [
        {
          phone: "+15550000002",
          name: "Opted In",
          conversationId: "conversation-1",
          optedIn: true,
        },
        {
          phone: "+15550000003",
          name: "Unknown consent",
          conversationId: "conversation-2",
          optedIn: false,
        },
      ],
    });

    const response = await postPromo({
      languageCode: "en",
      analyticsAudience: {
        type: "bulk_analytics",
        filters: { days: 14 },
      },
      recipients: [{ phone: "+15550000004" }],
      audienceUploadEvidence: {
        originalFilename: "fill-up.csv",
        selectedAt: "2026-07-24T08:00:00.000Z",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockResolveBulkAnalyticsAudience).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        templateCategory: "MARKETING",
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000002", name: "Opted In" },
          }),
          expect.objectContaining({
            recipient: { phone: "+15550000003", name: "Unknown consent" },
          }),
          expect.objectContaining({
            recipient: { phone: "+15550000004" },
          }),
        ],
      })
    );
    expect(mockAdmitBulkCampaign.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        audience: expect.objectContaining({
          count: 3,
          sourceType: "bulk_analytics_with_upload",
          metadata: expect.objectContaining({
            originalFilename: "fill-up.csv",
          }),
        }),
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        total: 3,
        requestedTotal: 3,
        skippedOptIn: 0,
      })
    );
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
  });

  it("queues an analytics marketing audience without stored positive consent", async () => {
    mockConversationFind.mockReturnValueOnce(selectLeanResult([]));
    mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
      total: 1,
      eligibleTotal: 1,
      excludedOptIn: 0,
      capped: false,
      maxRecipients: 1000,
      recipients: [
        {
          phone: "+15550000002",
          name: "Advisory opt-in only",
          conversationId: "conversation-1",
          optedIn: true,
        },
      ],
    });

    const response = await postPromo({
      languageCode: "en",
      analyticsAudience: {
        type: "bulk_analytics",
        filters: { days: 14 },
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdmitBulkCampaign).toHaveBeenCalledTimes(1);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000002", name: "Advisory opt-in only" },
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        total: 1,
        requestedTotal: 1,
        skippedOptIn: 0,
      })
    );
  });

  it("does not dispatch analytics audiences when resolution is unavailable", async () => {
    const { BulkAnalyticsAudienceUnavailableError } = jest.requireMock(
      "@/lib/analytics/bulk-analytics-audience"
    ) as {
      BulkAnalyticsAudienceUnavailableError: new () => Error;
    };
    mockResolveBulkAnalyticsAudience.mockRejectedValueOnce(
      new BulkAnalyticsAudienceUnavailableError()
    );

    const response = await postPromo({
      languageCode: "en",
      analyticsAudience: {
        type: "bulk_analytics",
        filters: { status: "replied", days: 14 },
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(
      expect.objectContaining({
        code: "campaign_send_audience_rollup_required",
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("blocks bulk sends when the company conversation limit is exhausted", async () => {
    mockEnsureCompanyConversationCapacity.mockResolvedValueOnce({
      allowed: false,
      limit: {
        subscriptionType: "free",
        conversationLimit: 500,
        conversationCount: 500,
        conversationsRemaining: 0,
        exhausted: true,
        lockedCapabilities: [
          "new_conversations",
          "scenario_creation",
          "bulk_campaigns",
        ],
      },
    });

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.code).toBe("company_conversation_limit_exceeded");
    expect(mockEnsureCompanyConversationCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ client: "supabase-admin" }),
      workspaceId
    );
    expect(mockBuildCompanyLimitExceededResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionType: "free",
        exhausted: true,
      })
    );
    expect(mockFilterKnownMarketingOptOutRecipients).toHaveBeenCalledTimes(1);
    expect(mockNormalizeHeaderMedia).not.toHaveBeenCalled();
    expectNothingDispatched();
  });

  it("refuses a free-plan send once the bulk recipient allowance is used", async () => {
    const usedUp = {
      subscriptionType: "free",
      bulkRecipientLimit: 500,
      bulkRecipientCount: 500,
      bulkRecipientsRemaining: 0,
      bulkRecipientExhausted: true,
    };
    mockReadCompanyBulkRecipientAllowance.mockResolvedValueOnce({
      limit: usedUp,
      remaining: 0,
    });

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.code).toBe("company_bulk_campaign_limit_exceeded");
    expect(mockReadCompanyBulkRecipientAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ client: "supabase-admin" }),
      workspaceId
    );
    expect(
      mockBuildCompanyBulkRecipientLimitExceededResponse
    ).toHaveBeenCalledWith(usedUp);
    expect(mockFilterKnownMarketingOptOutRecipients).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    expectNothingDispatched();
  });

  it("keeps only the first recipients that fit the free bulk allowance", async () => {
    mockReadCompanyBulkRecipientAllowance.mockResolvedValueOnce({
      limit: {
        subscriptionType: "free",
        bulkRecipientLimit: 500,
        bulkRecipientCount: 498,
        bulkRecipientsRemaining: 2,
        bulkRecipientExhausted: false,
      },
      remaining: 2,
    });

    const response = await postPromo({
      languageCode: "en",
      recipients: [
        { phone: "+15550000002" },
        { phone: "+15550000003" },
        { phone: "+15550000004" },
      ],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      outcome: {
        requestedTotal: 3,
        acceptedTotal: 2,
        queuedTotal: 2,
        skippedByReason: { recipient_limit: 1 },
      },
    });
    expect(mockAdmitBulkCampaign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyBulkCampaignLimit: 500,
        companySubscriptionType: "free",
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: expect.objectContaining({ phone: "+15550000002" }),
          }),
          expect.objectContaining({
            recipient: expect.objectContaining({ phone: "+15550000003" }),
          }),
        ],
      })
    );
  });

  it("answers an admission allowance refusal with the plan limit", async () => {
    mockAdmitBulkCampaign.mockImplementationOnce(
      async (
        _client: unknown,
        input: { audience: { fingerprint: string } }
      ) => ({
        status: "blocked",
        code: "company_bulk_campaign_limit_exceeded",
        retryable: false,
        audienceFingerprint: input.audience.fingerprint,
        companyBulkCampaignLimit: 500,
        companyBulkCampaignCount: 500,
      })
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.code).toBe("company_bulk_campaign_limit_exceeded");
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("rejects Telegram bulk sends when Telegram credentials are missing", async () => {
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({ telegramSource: null })
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "telegram",
      messageText: "Hello {{name}}",
      recipients: [{ chatId: "123456", variables: { name: "Aibek" } }],
    });
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toBe("Telegram credentials not found");
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("queues Telegram bulk sends with the workspace Telegram source id", async () => {
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({
        telegramSource: {
          id: "telegram-source-1",
          // Saved encrypted; the route only needs to know a token exists.
          credentials: {
            bot_token: { iv: "aXY=", tag: "dGFn", ciphertext: "c2VjcmV0" },
          },
        },
      })
    );
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      channelBatchPlanPreview("telegram", {
        batchSize: 30,
        delayMs: 300,
        ratePerSecond: 100,
        rateSource: "channel_default",
      })
    );
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "123456",
          sourceId: "telegram-source-1",
          channel: "telegram",
          first_inbound_at: new Date("2026-01-01T00:00:00.000Z"),
          last_inbound_at: new Date("2026-01-01T00:00:00.000Z"),
        },
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "telegram",
      messageText: "Hello {{name}}",
      recipients: [{ chatId: "123456", variables: { name: "Aibek" } }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            channel: "telegram",
            sourceId: "telegram-source-1",
            recipient: { chatId: "123456" },
            messageText: "Hello Aibek",
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        total: 1,
        workflowId: expect.stringMatching(/^bulk-campaign-dispatch:/),
      })
    );
  });

  it("returns one canonical Telegram outcome for eligible and ineligible recipients", async () => {
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({
        telegramSource: {
          id: "telegram-source-1",
          credentials: { bot_token: "telegram-token" },
        },
      })
    );
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      channelBatchPlanPreview("telegram", {
        batchSize: 30,
        delayMs: 300,
        ratePerSecond: 100,
        rateSource: "channel_default",
      })
    );
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "tg_123456_telegram-source-1",
          sourceId: "telegram-source-1",
          channel: "telegram",
          first_inbound_at: new Date("2026-01-01T00:00:00.000Z"),
          last_inbound_at: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          chat: "777000",
          sourceId: "telegram-source-1",
          channel: "telegram",
          business_connection_id: "business-connection-1",
          first_inbound_at: new Date("2026-06-22T23:00:00.000Z"),
          last_inbound_at: new Date(),
        },
        {
          chat: "555000",
          sourceId: "telegram-source-1",
          channel: "telegram",
          business_connection_id: "business-connection-stale",
          first_inbound_at: new Date("2026-06-20T00:00:00.000Z"),
          last_inbound_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
        },
      ])
    );
    mockSupabaseAdminFrom.mockImplementation((table: string) => {
      if (table === "email_unsubscribes") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      if (table === "telegram_business_connections") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({
            data: [
              {
                business_connection_id: "business-connection-1",
                workspace_id: workspaceId,
                source_id: "telegram-source-1",
                can_reply: true,
                is_enabled: true,
              },
            ],
            error: null,
          }),
        };
      }
      throw new Error(`Unexpected Supabase admin table: ${table}`);
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "telegram",
      messageText: "Hello {{name}}",
      recipients: [
        {
          chatId: "tg_123456_telegram-source-1",
          variables: { name: "Aibek" },
        },
        {
          chatId: "tg_777000_telegram-source-1",
          variables: { name: "Dana" },
        },
        {
          chatId: "tg_555000_telegram-source-1",
          variables: { name: "Stale" },
        },
        {
          chatId: "-1001234567890",
          variables: { name: "Group" },
        },
      ],
      idempotencyKey: "telegram-mixed-no-detail",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            channel: "telegram",
            sourceId: "telegram-source-1",
            recipient: { chatId: "123456" },
            messageText: "Hello Aibek",
          }),
          expect.objectContaining({
            channel: "telegram",
            sourceId: "telegram-source-1",
            businessConnectionId: "business-connection-1",
            recipient: { chatId: "777000" },
            messageText: "Hello Dana",
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        total: 2,
        skippedRecipientCount: 2,
        requestedTotal: 4,
        successful: 2,
        skippedIneligible: 2,
        outcome: expect.objectContaining({
          requestedTotal: 4,
          acceptedTotal: 2,
          queuedTotal: 2,
          uniqueRecipients: { requested: 4, accepted: 2, queued: 2 },
          skippedByReason: { ineligible: 2 },
        }),
        workflowId: expect.stringMatching(/^bulk-campaign-dispatch:/),
      })
    );
    expect(payload).not.toHaveProperty("skippedRecipientDetails");
    expect(JSON.stringify(payload)).not.toContain("555000");
    expect(JSON.stringify(payload)).not.toContain("-1001234567890");
    expect(mockCompleteLegacyIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: expect.not.objectContaining({
          skippedRecipientDetails: expect.anything(),
        }),
      })
    );
    const cachedResponse = mockCompleteLegacyIdempotency.mock.calls[0]?.[0];
    expect(JSON.stringify(cachedResponse)).not.toContain("555000");
    expect(JSON.stringify(cachedResponse)).not.toContain("-1001234567890");
  });

  it("keeps only the first service-text recipients that fit the free bulk allowance", async () => {
    mockReadCompanyBulkRecipientAllowance.mockResolvedValueOnce({
      limit: {
        subscriptionType: "free",
        bulkRecipientLimit: 500,
        bulkRecipientCount: 499,
        bulkRecipientsRemaining: 1,
        bulkRecipientExhausted: false,
      },
      remaining: 1,
    });
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        { chat: "15550000002", last_inbound_at: new Date() },
        { chat: "15550000003", last_inbound_at: new Date() },
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Your support update",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      total: 1,
      outcome: {
        requestedTotal: 2,
        acceptedTotal: 1,
        queuedTotal: 1,
        skippedByReason: { recipient_limit: 1 },
      },
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: expect.objectContaining({ phone: "+15550000002" }),
          }),
        ],
      })
    );
  });

  it("returns one canonical service-text outcome after service-window exclusions", async () => {
    mockConversationFind.mockReturnValueOnce(
      selectLeanResult([
        {
          chat: "15550000002",
          last_inbound_at: new Date(),
        },
      ])
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Your support update",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      requestedTotal: 2,
      successful: 1,
      total: 1,
      skippedRecipientCount: 1,
      skippedServiceWindow: 1,
      outcome: {
        requestedTotal: 2,
        acceptedTotal: 1,
        queuedTotal: 1,
        skippedByReason: { service_window: 1 },
      },
    });
  });

  it("returns a canonical no-op when every service-text recipient is outside the service window", async () => {
    mockConversationFind.mockReturnValueOnce(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Your support update",
      recipients: [{ phone: "+15550000002" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      skippedServiceWindow: 1,
      outcome: {
        disposition: "no_op",
        lifecycleStatus: "completed",
        requestedTotal: 1,
        acceptedTotal: 0,
        queuedTotal: 0,
        uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
        skippedByReason: { service_window: 1 },
      },
    });
    expectNothingDispatched();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it("queues email bulk sends to registered app auth users", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    mockSupabaseAdminListUsers.mockResolvedValueOnce({
      data: {
        users: [
          {
            id: "auth-user-1",
            email: "First@Example.com",
            email_confirmed_at: "2026-01-01T00:01:00.000Z",
            created_at: "2026-01-01T00:00:00.000Z",
            user_metadata: { full_name: "First User" },
          },
          {
            id: "auth-user-2",
            email: "pending@example.com",
            email_confirmed_at: null,
            confirmed_at: null,
            created_at: "2026-01-02T00:00:00.000Z",
            user_metadata: { full_name: "Pending User" },
          },
          {
            id: "auth-user-3",
            email: "dupe@example.com",
            email_confirmed_at: "2026-01-03T00:01:00.000Z",
            created_at: "2026-01-03T00:00:00.000Z",
            user_metadata: { full_name: "Dupe User" },
          },
          {
            id: "auth-user-4",
            email: "DUPE@example.com",
            email_confirmed_at: "2026-01-04T00:01:00.000Z",
            created_at: "2026-01-04T00:00:00.000Z",
            user_metadata: { full_name: "Duplicate User" },
          },
        ],
        nextPage: null,
        total: 4,
      },
      error: null,
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Registered users update",
      registeredUsersAudience: { type: "registered_users" },
      templateKey: "announcement",
      templateModel: {
        company: "airi.chat",
        headline: "Product update",
        body: "We shipped a product update.",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockSupabaseAdminFrom).not.toHaveBeenCalledWith("company_users");
    expect(mockSupabaseAdminListUsers).toHaveBeenCalledWith({
      page: 1,
      perPage: 1000,
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            channel: "email",
            recipient: {
              email: "first@example.com",
              variables: expect.objectContaining({
                userId: "auth-user-1",
                recipientName: "First User",
                name: "First User",
              }),
            },
            fromAddress: "updates@airi.chat",
            templateKey: "announcement",
            messageStream: "broadcast",
          }),
          expect.objectContaining({
            channel: "email",
            recipient: {
              email: "dupe@example.com",
              variables: expect.objectContaining({
                userId: "auth-user-3",
                recipientName: "Dupe User",
                name: "Dupe User",
              }),
            },
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        total: 2,
      })
    );
  });

  it("queues only selected registered app auth users", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    mockSupabaseAdminListUsers.mockResolvedValueOnce({
      data: {
        users: [
          {
            id: "auth-user-1",
            email: "first@example.com",
            email_confirmed_at: "2026-01-01T00:01:00.000Z",
            created_at: "2026-01-01T00:00:00.000Z",
            user_metadata: { full_name: "First User" },
          },
          {
            id: "auth-user-2",
            email: "second@example.com",
            email_confirmed_at: "2026-01-02T00:01:00.000Z",
            created_at: "2026-01-02T00:00:00.000Z",
            user_metadata: { full_name: "Second User" },
          },
        ],
        nextPage: null,
        total: 2,
      },
      error: null,
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Registered users update",
      registeredUsersAudience: {
        type: "registered_users",
        selectedUserIds: ["auth-user-2"],
      },
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hi {{recipientName}}",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            channel: "email",
            recipient: {
              email: "second@example.com",
              variables: expect.objectContaining({
                userId: "auth-user-2",
                recipientName: "Second User",
              }),
            },
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        total: 1,
      })
    );
  });

  it("returns only aggregate facts when selected registered users have no eligible match", async () => {
    const privateEmail = "registered-private@example.com";
    const privateUserId = "auth-user-private";
    mockSupabaseAdminListUsers.mockResolvedValueOnce({
      data: {
        users: [
          {
            id: privateUserId,
            email: privateEmail,
            email_confirmed_at: "2026-01-01T00:01:00.000Z",
            created_at: "2026-01-01T00:00:00.000Z",
            user_metadata: { full_name: "Private Registered User" },
          },
        ],
        nextPage: null,
        total: 1,
      },
      error: null,
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      registeredUsersAudience: {
        type: "registered_users",
        selectedUserIds: ["auth-user-not-found"],
      },
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hello",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "No registered app users with valid email addresses were found.",
      eligibleRecipientCount: 1,
      selectedRecipientCount: 0,
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /registered-private@example\.com|auth-user-private|Private Registered User/
    );
    expectNothingDispatched();
  });

  it("returns only an aggregate invalid-email count before dispatch side effects", async () => {
    const invalidEmails = ["private-invalid-one", "private-invalid-two@"];

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      recipients: [
        { email: invalidEmails[0] },
        { email: "valid@example.com" },
        { email: invalidEmails[1] },
      ],
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hello",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "Some recipient emails are invalid. Fix the list and retry.",
      invalidRecipientCount: 2,
    });
    for (const invalidEmail of invalidEmails) {
      expect(JSON.stringify(payload)).not.toContain(invalidEmail);
    }
    expectNothingDispatched();
    expect(mockStoreBulkCampaignDispatchItems).not.toHaveBeenCalled();
  });

  it("queues localized custom email content for registered users based on company language", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({
        registeredUserLanguageRows: [
          {
            user_id: "auth-user-1",
            workspaces: {
              companies: {
                airi_language: "ru",
                lang: "en",
              },
            },
          },
          {
            user_id: "auth-user-2",
            workspaces: {
              companies: {
                airi_language: null,
                lang: "kz",
              },
            },
          },
        ],
      })
    );
    mockSupabaseAdminListUsers.mockResolvedValueOnce({
      data: {
        users: [
          {
            id: "auth-user-1",
            email: "ru@example.com",
            email_confirmed_at: "2026-01-01T00:01:00.000Z",
            created_at: "2026-01-01T00:00:00.000Z",
            user_metadata: { full_name: "Russian User" },
          },
          {
            id: "auth-user-2",
            email: "kz@example.com",
            email_confirmed_at: "2026-01-02T00:01:00.000Z",
            created_at: "2026-01-02T00:00:00.000Z",
            user_metadata: { full_name: "Kazakh User" },
          },
        ],
        nextPage: null,
        total: 2,
      },
      error: null,
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Localized registered users update",
      registeredUsersAudience: { type: "registered_users" },
      emailContent: {
        format: "markdown",
        subject: "English update",
        markdown: "Hello {{recipientName}}",
      },
      emailContentByLocale: {
        ru: {
          format: "markdown",
          subject: "Русское обновление",
          markdown: "Здравствуйте, {{recipientName}}",
        },
        kz: {
          format: "markdown",
          subject: "Қазақша жаңарту",
          markdown: "Сәлеметсіз бе, {{recipientName}}",
        },
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdmitBulkCampaign.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        channel: "email",
        templateLanguage: "multi",
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            channel: "email",
            recipient: {
              email: "ru@example.com",
              variables: expect.objectContaining({
                userId: "auth-user-1",
                locale: "ru",
                language: "ru",
              }),
            },
            emailContent: {
              format: "markdown",
              subject: "Русское обновление",
              markdown: "Здравствуйте, {{recipientName}}",
            },
            templateModel: expect.objectContaining({
              recipientName: "Russian User",
              locale: "ru",
              language: "ru",
            }),
          }),
          expect.objectContaining({
            channel: "email",
            recipient: {
              email: "kz@example.com",
              variables: expect.objectContaining({
                userId: "auth-user-2",
                locale: "kz",
                language: "kz",
              }),
            },
            emailContent: {
              format: "markdown",
              subject: "Қазақша жаңарту",
              markdown: "Сәлеметсіз бе, {{recipientName}}",
            },
            templateModel: expect.objectContaining({
              recipientName: "Kazakh User",
              locale: "kz",
              language: "kz",
            }),
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        total: 2,
      })
    );
  });

  it("rejects global registered-user email sends by an airi workspace admin without platform authority", async () => {
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({ platformAdmin: false })
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Registered users update",
      registeredUsersAudience: { type: "registered_users" },
      templateKey: "announcement",
      templateModel: { headline: "Update", body: "Product update" },
    });

    expect(response.status).toBe(403);
    expect(mockSupabaseAdminListUsers).not.toHaveBeenCalled();
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("rejects registered app auth users for non-Airi workspaces", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    mockCreateClient.mockResolvedValue(
      createSupabaseMock({
        workspace: {
          id: workspaceId,
          name: "Customer workspace",
          company_id: "22222222-2222-4222-8222-222222222222",
          companies: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Customer Inc",
            slug: "customer-inc",
          },
        },
      })
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Registered users update",
      registeredUsersAudience: { type: "registered_users" },
      templateKey: "announcement",
      templateModel: {
        headline: "Product update",
        body: "We shipped a product update.",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe(
      "Registered app users audience requires platform admin access in the airi.chat workspace."
    );
    expect(mockSupabaseAdminListUsers).not.toHaveBeenCalled();
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("queues custom markdown email content with per-recipient variables", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Custom email",
      recipients: [
        {
          email: "First@Example.com",
          variables: { recipientName: "First User", plan: "Pro" },
        },
      ],
      emailContent: {
        format: "markdown",
        subject: "Hello {{recipientName}}",
        markdown: "Hi {{recipientName}}, your plan is {{plan}}.",
      },
    });

    expect(response.status).toBe(200);
    expect(mockAdmitBulkCampaign.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        channel: "email",
        templateName: "custom_email",
        templateLanguage: "en",
        messageText: "Hello {{recipientName}}",
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        items: [
          expect.objectContaining({
            channel: "email",
            recipient: {
              email: "first@example.com",
              variables: expect.objectContaining({
                recipientName: "First User",
                plan: "Pro",
              }),
            },
            fromAddress: "updates@airi.chat",
            emailContent: {
              format: "markdown",
              subject: "Hello {{recipientName}}",
              markdown: "Hi {{recipientName}}, your plan is {{plan}}.",
            },
            templateModel: expect.objectContaining({
              company: "airi.chat",
              workspaceName: "Airi workspace",
              workspaceUrl: `https://app.airi.chat/panel/w/${workspaceId}`,
              recipientName: "First User",
              plan: "Pro",
            }),
            messageStream: "broadcast",
          }),
        ],
      })
    );
  });

  it("returns one canonical email outcome after unsubscribe exclusions", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    mockSupabaseAdminFrom.mockImplementation((table: string) => {
      if (table === "email_unsubscribes") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({
            data: [{ email: "blocked@example.com" }],
            error: null,
          }),
        };
      }
      throw new Error(`Unexpected Supabase admin table: ${table}`);
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Custom email",
      recipients: [
        {
          email: "Allowed@Example.com",
          variables: { recipientName: "Allowed" },
        },
        {
          email: "Blocked@Example.com",
          variables: { recipientName: "Blocked" },
        },
      ],
      emailContent: {
        format: "markdown",
        subject: "Hello {{recipientName}}",
        markdown: "Hi {{recipientName}}",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            channel: "email",
            recipient: expect.objectContaining({
              email: "allowed@example.com",
            }),
          }),
        ],
      })
    );
    const workflowInput =
      mockStartBulkCampaignDispatchWorkflow.mock.calls[0][0];
    expect(workflowInput.items).toHaveLength(1);
    expect(mockAdmitBulkCampaign.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        audience: expect.objectContaining({
          count: 1,
          metadata: expect.objectContaining({
            policy: { version: 1, excludePriorFailedBulkSends: false },
            authoritativeRecipientLimit: {
              source: "channel_default",
              value: 1000,
              rawLimit: "1000",
            },
            requestDigest: { version: 1, digest: "d".repeat(64) },
            batchPlan: {
              batchSize: 20,
              delayMs: 334,
              ratePerSecond: 60,
              rateSource: "channel_default",
            },
            outcome: expect.objectContaining({
              requestedTotal: 2,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 2, accepted: 1 },
              skippedByReason: { unsubscribed: 1 },
              warnings: { missingMarketingConsent: 0 },
            }),
          }),
        }),
        snapshots: [expect.any(Object)],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        total: 1,
        requestedTotal: 2,
        skippedUnsubscribed: 1,
        skippedRecipientCount: 1,
        successful: 1,
        outcome: expect.objectContaining({
          requestedTotal: 2,
          acceptedTotal: 1,
          queuedTotal: 1,
          skippedByReason: { unsubscribed: 1 },
        }),
      })
    );
  });

  it("keeps the canonical skipped alias when email exclusions include late details", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    mockFilterEmailUnsubscribedRecipients.mockImplementationOnce(
      async ({
        recipients,
      }: {
        recipients: Array<Record<string, unknown>>;
      }) => ({
        recipients: [recipients[0], { ...recipients[1], email: "" }],
        skippedUnsubscribed: 1,
        skippedRecipientDetails: [
          { reason: "email_unsubscribed", detail: "blocked@example.com" },
        ],
      })
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      recipients: [
        { email: "allowed@example.com" },
        { email: "late-ineligible@example.com" },
        { email: "blocked@example.com" },
      ],
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hello",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      total: 1,
      skippedRecipientCount: 2,
      outcome: {
        requestedTotal: 3,
        acceptedTotal: 1,
        queuedTotal: 1,
        skippedByReason: { ineligible: 1, unsubscribed: 1 },
      },
    });
    expect(payload).not.toHaveProperty("skippedRecipientDetails");
    expect(JSON.stringify(payload)).not.toContain("blocked@example.com");
    expect(JSON.stringify(payload)).not.toContain(
      "late-ineligible@example.com"
    );
  });

  it("replays a queued email result when late ineligible and unsubscribe exclusions surround the limiter", async () => {
    let cachedResponse: Record<string, unknown> | null = null;
    let cachedEventFacts: Record<string, unknown> | null = null;
    mockCompleteLegacyIdempotency.mockImplementationOnce(
      async ({
        responseBody,
        eventFacts,
      }: {
        responseBody: Record<string, unknown>;
        eventFacts: Record<string, unknown>;
      }) => {
        cachedResponse = structuredClone(responseBody);
        cachedEventFacts = structuredClone(eventFacts);
        return true;
      }
    );
    mockFilterEmailUnsubscribedRecipients.mockImplementationOnce(
      async ({
        recipients,
      }: {
        recipients: Array<Record<string, unknown>>;
      }) => ({
        recipients: [recipients[0], { ...recipients[1], email: "" }],
        skippedUnsubscribed: 1,
        skippedRecipientDetails: [],
      })
    );
    const buildRequest = () =>
      bulkSendRequest({
        workspaceId,
        channel: "email",
        recipients: [
          { email: "allowed@example.com" },
          { email: "late-ineligible@example.com" },
          { email: "blocked@example.com" },
        ],
        emailContent: {
          format: "markdown",
          subject: "Hello",
          markdown: "Hello",
        },
        idempotencyKey: "email-late-exclusions-replay",
      });

    const firstResponse = await POST(buildRequest());
    const firstPayload = await firstResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstPayload).toMatchObject({
      recipientLimit: {
        originalCount: 2,
        acceptedCount: 1,
        rawLimit: "TIER_1K",
        source: "cached_meta",
        truncated: false,
      },
      outcome: {
        requestedTotal: 3,
        acceptedTotal: 1,
        queuedTotal: 1,
        skippedByReason: { ineligible: 1, unsubscribed: 1 },
      },
    });
    expect(cachedResponse).toEqual(firstPayload);

    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: cachedResponse,
      eventFacts: cachedEventFacts,
    });
    const replayResponse = await POST(buildRequest());
    const replayPayload = await replayResponse.json();

    expect(replayResponse.status).toBe(200);
    expect(replayPayload).toEqual(firstPayload);
    expect(mockAdmitBulkCampaign).toHaveBeenCalledTimes(1);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it("requires overflow-queue confirmation when unique email recipients exceed the daily cap", async () => {
    mockReadCompanyBulkRecipientAllowance.mockResolvedValueOnce(
      unlimitedBulkRecipientAllowance()
    );
    mockIsBulkDispatchPayloadStoreConfigured.mockReturnValueOnce(true);
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    const recipients = Array.from({ length: 1001 }, (_, index) => ({
      email: `recipient-${index}@example.com`,
    }));

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      recipients,
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hello",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe(
      "bulk_campaign_overflow_queue_confirmation_required"
    );
    expect(payload.overflowQueue).toMatchObject({
      required: true,
      confirmed: false,
      recipientCount: 1001,
      dailyLimit: 1000,
      exceedsDailyLimit: true,
      waveCount: 2,
      firstWaveCount: 1000,
      queuedCount: 1,
    });
    expectNothingDispatched();
  });

  it("queues leftover unique email recipients in 24h waves after overflow confirmation", async () => {
    mockReadCompanyBulkRecipientAllowance.mockResolvedValueOnce(
      unlimitedBulkRecipientAllowance()
    );
    mockIsBulkDispatchPayloadStoreConfigured.mockReturnValueOnce(true);
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    const recipients = Array.from({ length: 1001 }, (_, index) => ({
      email: `recipient-${index}@example.com`,
    }));

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      overflowQueueConfirmed: true,
      recipients,
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hello",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    const storedItems =
      mockStoreBulkCampaignDispatchItems.mock.calls[0][0].items;
    expect(storedItems).toHaveLength(1001);
    expect(storedItems[0].recipient.email).toBe("recipient-0@example.com");
    expect(storedItems[1000].recipient.email).toBe(
      "recipient-1000@example.com"
    );
    expect(payload).toMatchObject({
      requestedTotal: 1001,
      total: 1001,
      overflowQueue: {
        recipientCount: 1001,
        dailyLimit: 1000,
        exceedsDailyLimit: true,
        waveCount: 2,
        firstWaveCount: 1000,
        queuedCount: 1,
      },
    });
    expect(mockAdmitBulkCampaign.mock.calls[0][1].audience.count).toBe(1001);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        dailyWaveLimit: 1000,
        batchPlan: expect.objectContaining({ dailyWaveLimit: 1000 }),
      })
    );
  });

  it("returns a canonical no-op when every email recipient is unsubscribed", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );
    mockSupabaseAdminFrom.mockImplementation((table: string) => {
      if (table === "email_unsubscribes") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({
            data: [{ email: "blocked@example.com" }],
            error: null,
          }),
        };
      }
      throw new Error(`Unexpected Supabase admin table: ${table}`);
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      campaignName: "Custom email",
      recipients: [{ email: "Blocked@Example.com" }],
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hello",
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      skippedUnsubscribed: 1,
      outcome: {
        disposition: "no_op",
        lifecycleStatus: "completed",
        requestedTotal: 1,
        acceptedTotal: 0,
        queuedTotal: 0,
        uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
        skippedByReason: { unsubscribed: 1 },
      },
    });
    expectNothingDispatched();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it("does not queue email dispatch when atomic admission fails", async () => {
    await withSilencedConsoleError(async () => {
      mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
        emailBatchPlanPreview()
      );
      const { BulkCampaignAdmissionError } = jest.requireActual(
        "@/lib/campaign/bulk-campaign-admission"
      ) as {
        BulkCampaignAdmissionError: new (message: string) => Error;
      };
      mockAdmitBulkCampaign.mockRejectedValueOnce(
        new BulkCampaignAdmissionError("database rejected admission")
      );

      const response = await postBulkSend({
        workspaceId,
        channel: "email",
        campaignName: "Custom email",
        recipients: [{ email: "First@Example.com" }],
        emailContent: {
          format: "markdown",
          subject: "Hello",
          markdown: "Hi there.",
        },
      });
      const payload = await response.json();

      expect(response.status).toBe(500);
      expect(payload).toEqual({
        code: "bulk_campaign_admission_failed",
        error: "Bulk campaign could not be admitted safely.",
      });
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    });
  });

  it("rejects registered-user email audiences when Postmark is not connected", async () => {
    mockGetWorkspaceEmailProviderConfig.mockResolvedValueOnce(null);
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      registeredUsersAudience: { type: "registered_users" },
      templateKey: "announcement",
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe(
      "Email source is not configured for this workspace. Connect email in Settings > Integrations first."
    );
    expect(mockSupabaseAdminFrom).not.toHaveBeenCalled();
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("preserves the pending email-provider response contract", async () => {
    mockIsManagedEmailProviderPending.mockReturnValueOnce(true);
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      recipients: [{ email: "reader@example.com" }],
      templateKey: "announcement",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "email_provider_verification_pending: Verify DNS in Settings > Integrations > Email before sending campaigns.",
      code: "email_provider_verification_pending",
    });
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("preserves the inactive email-provider response contract", async () => {
    mockGetWorkspaceEmailProviderConfig.mockResolvedValueOnce({
      defaultFromAddress: "updates@airi.chat",
      postmarkServerToken: "postmark-server-token",
      transactionalStream: "outbound",
      broadcastStream: "broadcast",
      status: "inactive",
    });
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce(
      emailBatchPlanPreview()
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "email",
      recipients: [{ email: "reader@example.com" }],
      templateKey: "announcement",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Email provider is inactive for this workspace.",
    });
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("queues a scheduled scenario bulk send and activates a draft scenario", async () => {
    const scenarioId = "65f000000000000000000001";
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      provenance: scenarioRunNowProvenance(scenarioId),
      scheduledAt: "2099-05-15T10:00:00.000Z",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        scheduledAt: "2099-05-15T10:00:00.000Z",
      })
    );
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      {
        _id: expect.anything(),
        workspaceId,
        mode: "bulk_campaign",
        status: "draft",
        deletedAt: null,
        $nor: [
          {
            nodes: {
              $elemMatch: {
                "data.kind": "trigger",
                "data.triggerConfig.entryPointType": "whatsapp_qr",
              },
            },
          },
        ],
      },
      {
        $set: {
          status: "active",
          updatedBy: "user-1",
        },
      }
    );
    expect(
      mockStartBulkCampaignDispatchWorkflow.mock.invocationCallOrder[0]
    ).toBeLessThan(mockScenarioUpdateOne.mock.invocationCallOrder[0]);
    expect(mockSaveScenario).not.toHaveBeenCalled();
    // The legacy branch is chosen from the projected mode, so it must be read.
    const selectedScenarioFields = mockScenarioFindOne.mock.results.flatMap(
      result =>
        (result.value.select as jest.Mock).mock.calls.map(
          ([fields]) => fields as string
        )
    );
    expect(selectedScenarioFields).toContainEqual(
      expect.stringMatching(/\bmode\b/)
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        scheduled: true,
        scheduledAt: "2099-05-15T10:00:00.000Z",
        scenarioStatus: "active",
      })
    );
    expect(payload).not.toHaveProperty("scenarioUpdatedAt");
    expect(mockAdmitBulkCampaign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scenarioId,
        scenarioNodeId: "node-bulk-root",
        executionSource: "scenario_run_now",
        dispatchStatus: "scheduled",
        snapshots: [
          expect.objectContaining({
            dispatchSnapshot: expect.objectContaining({
              scenarioId,
              scenarioNodeId: "tpl-1",
              executionSource: "scenario_run_now",
            }),
          }),
        ],
      })
    );
    expect(
      JSON.stringify(mockAdmitBulkCampaign.mock.calls[0]?.[1])
    ).not.toContain("scenario_schedule");
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        executionSource: "scenario_run_now",
        disposition: "scheduled",
        lifecycleStatus: "scheduled",
        idempotentReplay: false,
      })
    );
  });

  it("explains how to fix conversation bindings on the bulk primary before audience work", async () => {
    const scenarioId = "65f000000000000000000001";
    const scenarioQuery = mockScenarioFindOne({ _id: scenarioId, workspaceId });
    const scenario = await scenarioQuery.lean();
    scenario.nodes[1].data.actionWhatsAppTemplateBindings = {
      version: 1,
      parameters: { "body:1": { source: "context", key: "first_name" } },
    };
    scenarioQuery.lean.mockResolvedValue(scenario);
    mockScenarioFindOne.mockReturnValueOnce(scenarioQuery);

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      provenance: scenarioRunNowProvenance(scenarioId),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "bulk_campaign_provenance_invalid",
      error: expect.stringContaining(
        "Remove these bindings and use campaign recipient mappings"
      ),
    });
    expect(mockResolveBulkAnalyticsAudience).not.toHaveBeenCalled();
    expect(mockListTemplates).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("rejects foreign scenario provenance before audience or template catalog lookup", async () => {
    const scenarioQuery = {
      select: jest.fn(),
      lean: jest.fn().mockResolvedValue(null),
    };
    scenarioQuery.select.mockReturnValue(scenarioQuery);
    mockScenarioFindOne.mockReturnValueOnce(scenarioQuery);

    const response = await postPromo({
      languageCode: "en",
      audience: {
        kind: "analytics_with_fill_up",
        analytics: { filters: { days: 30 } },
        fillUpRecipients: [],
      },
      provenance: scenarioRunNowProvenance("65f000000000000000000099"),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "bulk_campaign_provenance_invalid",
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.provenance_invalid",
      expect.objectContaining({
        workspaceId,
        provenanceKind: "scenario_run_now",
        scenarioId: "65f000000000000000000099",
        reason: "scenario_not_found",
      })
    );
    expect(mockResolveBulkAnalyticsAudience).not.toHaveBeenCalled();
    expect(mockListTemplates).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockResolveRegisteredBusinessPhoneAudience).not.toHaveBeenCalled();
    expect(mockNormalizeHeaderMedia).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("answers a Meta rate limit while verifying scenario provenance with a retryable 503, not 403", async () => {
    const scenarioId = "65f000000000000000000001";
    mockListTemplates.mockRejectedValueOnce(metaThrottleError());

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      provenance: scenarioRunNowProvenance(scenarioId),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      code: "meta_rate_limited",
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.provenance_invalid",
      expect.objectContaining({ reason: "lookup_failed" })
    );
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it.each([
    ["scenario provenance", "scenario"],
    ["an Analytics audience", "analytics"],
  ] as const)(
    "answers a template catalog cooldown while checking %s with the time it ends",
    async (_label, path) => {
      mockListTemplates.mockRejectedValueOnce(
        new WhatsAppTemplateCatalogError({
          code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
          message: "Meta temporarily limited WhatsApp template requests.",
          // Hours away: the client still checks again within the cap.
          retryAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        })
      );

      const response = await postPromo({
        languageCode: "en",
        ...(path === "scenario"
          ? {
              recipients: [{ phone: "+15550000002" }],
              provenance: scenarioRunNowProvenance("65f000000000000000000001"),
            }
          : {
              analyticsAudience: {
                type: "bulk_analytics",
                filters: { days: 14 },
              },
            }),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("900");
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "meta_rate_limited",
        retryAfterSeconds: 900,
      });
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    }
  );

  it("answers an unavailable template catalog while verifying scenario provenance without a retry time", async () => {
    mockListTemplates.mockRejectedValueOnce(
      new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_INCOMPLETE",
        message: "Meta returned an incomplete template catalog.",
      })
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      provenance: scenarioRunNowProvenance("65f000000000000000000001"),
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(payload).toMatchObject({
      ok: false,
      code: "template_lookup_unavailable",
    });
    expect(payload).not.toHaveProperty("retryAfterSeconds");
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("answers any other failed template lookup while verifying scenario provenance with a 503, not 403", async () => {
    const message = "(#2) Service temporarily unavailable";
    mockListTemplates.mockRejectedValueOnce(
      new MetaGraphRequestError({
        message,
        status: 500,
        statusText: "Internal Server Error",
        url: "https://graph.facebook.com/v23.0/waba-1/message_templates",
        details: {},
        metaError: { message, type: "OAuthException", code: 2 },
      })
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      provenance: scenarioRunNowProvenance("65f000000000000000000001"),
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(payload).toMatchObject({
      ok: false,
      code: "template_lookup_unavailable",
    });
    expect(JSON.stringify(payload)).not.toContain(message);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId,
        code: "template_lookup_unavailable",
        causeName: "MetaGraphRequestError",
        causeMessage: message,
        graphCode: 2,
      })
    );
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it.each([
    ["scenario provenance", "scenario"],
    ["an Analytics audience", "analytics"],
  ] as const)(
    "answers a template the saved catalog misses during a Meta cooldown while checking %s with the time it ends",
    async (_label, path) => {
      // During a cooldown the shared catalog returns its last saved copy
      // marked stale; a template created in Meta since then isn't in it.
      mockListTemplates.mockResolvedValueOnce({
        templates: [
          {
            name: "receipt",
            language: "en",
            status: "APPROVED",
            category: "UTILITY",
            components: [],
          },
        ],
        catalog: {
          source: "cache",
          stale: true,
          fetchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          wabaId: "waba-1",
          refreshOutcome: "cooldown",
          retryAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          providerCode: 80008,
        },
      });
      if (path === "analytics") {
        mockResolveBulkAnalyticsAudience.mockResolvedValueOnce({
          total: 1,
          eligibleTotal: 1,
          excludedOptIn: 0,
          capped: false,
          maxRecipients: 1000,
          recipients: [
            {
              phone: "+15550000002",
              name: "Opted In",
              conversationId: "conversation-1",
              optedIn: true,
            },
          ],
        });
      }

      const response = await postPromo({
        languageCode: "en",
        ...(path === "scenario"
          ? {
              recipients: [{ phone: "+15550000002" }],
              provenance: scenarioRunNowProvenance("65f000000000000000000001"),
            }
          : {
              analyticsAudience: {
                type: "bulk_analytics",
                filters: { days: 14 },
              },
            }),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("900");
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "meta_rate_limited",
        retryAfterSeconds: 900,
      });
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "bulk_campaign.eligibility_failed",
        expect.objectContaining({
          code: "meta_rate_limited",
          catalogCode: "WHATSAPP_TEMPLATES_RATE_LIMITED",
          providerCode: 80008,
        })
      );
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "lost WhatsApp access",
      () =>
        mockListTemplates.mockRejectedValueOnce(
          new Error(
            "Cannot access WhatsApp message templates for this connection. Reconnect WhatsApp or grant whatsapp_business_management access to the selected WhatsApp Business Account in Meta Business Manager."
          )
        ),
    ],
    [
      "a failed scenario read",
      () => {
        const scenarioQuery = {
          select: jest.fn(),
          lean: jest
            .fn()
            .mockRejectedValue(new Error("connection pool was closed")),
        };
        scenarioQuery.select.mockReturnValue(scenarioQuery);
        mockScenarioFindOne.mockReturnValueOnce(scenarioQuery);
      },
    ],
  ])(
    "keeps a 403, not a template lookup retry, when scenario provenance fails on %s",
    async (_label, arrange) => {
      arrange();

      const response = await postPromo({
        languageCode: "en",
        recipients: [{ phone: "+15550000002" }],
        provenance: scenarioRunNowProvenance("65f000000000000000000001"),
      });
      const payload = await response.json();

      expect(response.status).toBe(403);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(payload).toEqual({
        code: "bulk_campaign_provenance_invalid",
        error: "Bulk campaign provenance could not be verified.",
      });
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "bulk_campaign.provenance_invalid",
        expect.objectContaining({ reason: "lookup_failed" })
      );
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    }
  );

  it("logs the real exception behind an ad-hoc template lookup failure", async () => {
    mockListTemplates.mockRejectedValueOnce(
      new Error("Cannot access WhatsApp message templates for this account.")
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "template_lookup_unavailable",
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bulk_campaign.eligibility_failed",
      expect.objectContaining({
        workspaceId,
        code: "template_lookup_unavailable",
        causeName: "Error",
        causeMessage:
          "Cannot access WhatsApp message templates for this account.",
      })
    );
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("sends a builder campaign from a conversation scenario whose bulk root stores no sources", async () => {
    // Production shape: the builder saves bulk roots in conversation mode
    // and never writes bulkRootConfig.sourceIds.
    const scenarioId = "65f000000000000000000004";
    const scenario = {
      _id: scenarioId,
      workspaceId,
      mode: "conversation",
      deletedAt: null,
      status: "active",
      nodes: [
        {
          id: "node-bulk-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
            },
          },
        },
        {
          id: "tpl-1",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "promo",
            actionWhatsAppTemplateLanguage: "en",
            actionWhatsAppTemplateCategory: "MARKETING",
            actionWhatsAppTemplateComponents: [],
          },
        },
      ],
      edges: [
        {
          source: "node-bulk-root",
          sourceHandle: "right-source",
          target: "tpl-1",
        },
      ],
    };
    // Filter on mode like Mongo does, so a lookup that requires
    // mode "bulk_campaign" finds nothing.
    mockScenarioFindOne.mockImplementation((query: Record<string, unknown>) =>
      scenarioLeanResult(
        query.mode === undefined || query.mode === scenario.mode
          ? scenario
          : null
      )
    );
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }],
      provenance: scenarioRunNowProvenance(scenarioId),
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockSaveScenario).not.toHaveBeenCalled();
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(payload).not.toHaveProperty("scenarioActivated");
    expect(payload).not.toHaveProperty("scenarioUpdatedAt");
    expect(mockListTemplates).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ sourceId: "source-1" })
    );
    expect(mockAdmitBulkCampaign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scenarioId,
        executionSource: "scenario_run_now",
        snapshots: [
          expect.objectContaining({
            dispatchSnapshot: expect.objectContaining({
              scenarioId,
              scenarioNodeId: "tpl-1",
            }),
          }),
        ],
      })
    );
  });

  describe("draft builder scenario activation", () => {
    const scenarioId = "65f000000000000000000005";
    const loadedAt = "2026-09-30T10:00:00.000Z";
    const activatedAt = "2026-09-30T12:00:00.000Z";

    // Like Mongo, a projected read returns only the selected fields.
    function projectedScenarioLeanResult(value: Record<string, unknown>) {
      let fields: string[] | null = null;
      const query = {
        select: jest.fn(),
        lean: jest.fn(async () => {
          const selected = fields;
          return selected
            ? Object.fromEntries(
                Object.entries(value).filter(
                  ([key]) => key === "_id" || selected.includes(key)
                )
              )
            : value;
        }),
      };
      query.select.mockImplementation((projection: string) => {
        fields = projection.split(/\s+/).filter(Boolean);
        return query;
      });
      return query;
    }

    // Production shape: the builder saves bulk roots in conversation mode.
    function mockBuilderScenario(
      extraNodes: Array<{ id: string; data: Record<string, unknown> }> = [],
      options: { whatsappOptIn?: boolean } = {}
    ) {
      const scenario = {
        _id: scenarioId,
        workspaceId,
        mode: "conversation",
        deletedAt: null,
        status: "draft",
        updatedAt: new Date(loadedAt),
        nodes: [
          {
            id: "node-bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                workflowKind: "bulk_campaign",
                sendMode: "immediate",
                channels: ["whatsapp"],
              },
            },
          },
          {
            id: "tpl-1",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "promo",
              actionWhatsAppTemplateLanguage: "en",
              actionWhatsAppTemplateCategory: "MARKETING",
              actionWhatsAppTemplateComponents: [],
            },
          },
          ...extraNodes,
        ],
        edges: [
          {
            source: "node-bulk-root",
            sourceHandle: "right-source",
            target: "tpl-1",
          },
        ],
      };
      mockScenarioFindOne.mockImplementation(
        (query: Record<string, unknown>) =>
          query.mode === undefined || query.mode === scenario.mode
            ? projectedScenarioLeanResult(scenario)
            : scenarioLeanResult(null)
      );
      if (options.whatsappOptIn !== false) {
        mockConversationFind.mockReturnValueOnce(
          whatsappMarketingOptIns("+15550000002")
        );
      }
      return scenario;
    }

    function sendBuilderCampaign(extraBody: Record<string, unknown> = {}) {
      return postPromo({
        languageCode: "en",
        recipients: [{ phone: "+15550000002" }],
        provenance: scenarioRunNowProvenance(scenarioId),
        ...extraBody,
      });
    }

    beforeEach(() => {
      mockSaveScenario.mockResolvedValue({
        scenario: { _id: scenarioId, status: "active", updatedAt: activatedAt },
        metadata: { linkedConditionParentCountByNodeId: {} },
      });
    });

    it("turns a draft on through the validated save before queueing its campaign", async () => {
      mockBuilderScenario();

      const response = await sendBuilderCampaign();
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mockSaveScenario).toHaveBeenCalledTimes(1);
      // Fenced to the revision whose trigger and QR checks passed.
      expect(mockSaveScenario).toHaveBeenCalledWith(
        { workspaceId, scenarioId, userId: "user-1" },
        { status: "active", expectedUpdatedAt: loadedAt }
      );
      expect(mockSaveScenario.mock.invocationCallOrder[0]).toBeLessThan(
        mockAdmitBulkCampaign.mock.invocationCallOrder[0]
      );
      expect(mockSaveScenario.mock.invocationCallOrder[0]).toBeLessThan(
        mockStartBulkCampaignDispatchWorkflow.mock.invocationCallOrder[0]
      );
      expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
      expect(payload).toEqual(
        expect.objectContaining({
          queued: true,
          scenarioActivated: true,
          scenarioStatus: "active",
          scenarioUpdatedAt: activatedAt,
          previousScenarioUpdatedAt: loadedAt,
        })
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "bulk_campaign.scenario_activated",
        { workspaceId, scenarioId }
      );
    });

    it("activates a scheduled send's draft when the campaign is queued", async () => {
      mockBuilderScenario();

      const response = await sendBuilderCampaign({
        scheduledAt: "2099-05-15T10:00:00.000Z",
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mockSaveScenario).toHaveBeenCalledTimes(1);
      expect(mockSaveScenario.mock.invocationCallOrder[0]).toBeLessThan(
        mockStartBulkCampaignDispatchWorkflow.mock.invocationCallOrder[0]
      );
      expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledAt: "2099-05-15T10:00:00.000Z" })
      );
      expect(payload).toEqual(
        expect.objectContaining({
          scheduled: true,
          scheduledAt: "2099-05-15T10:00:00.000Z",
          scenarioActivated: true,
          scenarioStatus: "active",
          scenarioUpdatedAt: activatedAt,
        })
      );
    });

    it("blocks the send and names the blocking step when activation fails validation", async () => {
      mockBuilderScenario();
      mockSaveScenario.mockRejectedValueOnce(
        new ScenarioOperationError({
          kind: "graph_invalid",
          code: "whatsappServiceMessageInvalid",
          nodeIds: ["service-1"],
        })
      );

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "scenario_activation_blocked",
        error: expect.any(String),
        reasonCode: "whatsappServiceMessageInvalid",
        nodeIds: ["service-1"],
      });
      expect(mockSaveScenario).toHaveBeenCalledTimes(1);
      expectNothingDispatched();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "bulk_campaign.scenario_activation_blocked",
        {
          workspaceId,
          scenarioId,
          reasonCode: "whatsappServiceMessageInvalid",
        }
      );
    });

    it("asks to activate a draft with a WhatsApp QR trigger before sending", async () => {
      mockBuilderScenario([
        {
          id: "trigger-qr",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "whatsapp_qr" },
          },
        },
      ]);

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "whatsapp_qr_activation_requires_scenario_route",
      });
      expect(mockSaveScenario).not.toHaveBeenCalled();
      expectNothingDispatched();
    });

    it("asks to activate a draft that also has a trigger instead of turning it on", async () => {
      mockBuilderScenario([
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "client_message" },
          },
        },
      ]);

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "scenario_activation_required",
        error: expect.any(String),
      });
      expect(mockSaveScenario).not.toHaveBeenCalled();
      expectNothingDispatched();
    });

    it("queues when a concurrent save already activated the scenario", async () => {
      const scenario = mockBuilderScenario();
      mockSaveScenario.mockImplementationOnce(async () => {
        scenario.status = "active";
        scenario.updatedAt = new Date("2026-09-30T12:05:00.000Z");
        throw new ScenarioOperationError({
          kind: "revision_conflict",
          currentUpdatedAt: null,
          operation: "save",
        });
      });

      const response = await sendBuilderCampaign();
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mockSaveScenario).toHaveBeenCalledTimes(1);
      expect(mockAdmitBulkCampaign).toHaveBeenCalledTimes(1);
      expect(payload).toEqual(
        expect.objectContaining({
          queued: true,
          scenarioActivated: true,
          scenarioStatus: "active",
          scenarioUpdatedAt: "2026-09-30T12:05:00.000Z",
        })
      );
      // Another save activated it, so no editor revision may be replaced.
      expect(payload).not.toHaveProperty("previousScenarioUpdatedAt");
    });

    it("retries on the revision a concurrent save left and reports it as the base", async () => {
      const scenario = mockBuilderScenario();
      mockSaveScenario.mockImplementationOnce(async () => {
        scenario.updatedAt = new Date("2026-09-30T11:00:00.000Z");
        throw new ScenarioOperationError({
          kind: "revision_conflict",
          currentUpdatedAt: scenario.updatedAt,
          operation: "save",
        });
      });

      const response = await sendBuilderCampaign();
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mockSaveScenario).toHaveBeenCalledTimes(2);
      expect(mockSaveScenario).toHaveBeenLastCalledWith(
        { workspaceId, scenarioId, userId: "user-1" },
        { status: "active", expectedUpdatedAt: "2026-09-30T11:00:00.000Z" }
      );
      expect(payload).toEqual(
        expect.objectContaining({
          scenarioActivated: true,
          scenarioUpdatedAt: activatedAt,
          previousScenarioUpdatedAt: "2026-09-30T11:00:00.000Z",
        })
      );
    });

    it("refuses to turn on a trigger that a concurrent save added", async () => {
      const scenario = mockBuilderScenario();
      mockSaveScenario.mockImplementationOnce(async () => {
        scenario.nodes.push({
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "client_message" },
          } as never,
        });
        scenario.updatedAt = new Date("2026-09-30T11:00:00.000Z");
        throw new ScenarioOperationError({
          kind: "revision_conflict",
          currentUpdatedAt: scenario.updatedAt,
          operation: "save",
        });
      });

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "scenario_activation_required",
        error: expect.any(String),
      });
      expect(mockSaveScenario).toHaveBeenCalledTimes(1);
      expectNothingDispatched();
    });

    it("retries a conflicted activation once and queues nothing when it still conflicts", async () => {
      mockBuilderScenario();
      mockSaveScenario
        .mockRejectedValueOnce(
          new ScenarioOperationError({
            kind: "revision_conflict",
            currentUpdatedAt: null,
            operation: "save",
          })
        )
        .mockRejectedValueOnce(
          new ScenarioOperationError({
            kind: "qr_activation_conflict",
            message: "WhatsApp QR activation changed",
          })
        );

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "scenario_activation_conflict",
        error: expect.any(String),
        retryable: true,
      });
      expect(mockSaveScenario).toHaveBeenCalledTimes(2);
      expectNothingDispatched();
    });

    it("names the first link code when activation reports several", async () => {
      mockBuilderScenario();
      mockSaveScenario.mockRejectedValueOnce(
        new ScenarioOperationError({
          kind: "subscenario_links_invalid",
          codes: ["subscenarioTargetMissing", "subscenarioTargetInactive"],
        })
      );

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "scenario_activation_blocked",
        error: expect.any(String),
        reasonCode: "subscenarioTargetMissing",
        nodeIds: [],
      });
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    });

    it("leaves unexpected activation failures to the server error path", async () => {
      mockBuilderScenario();
      mockSaveScenario.mockRejectedValueOnce(new Error("db down"));
      await withSilencedConsoleError(async () => {
        const response = await sendBuilderCampaign();

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: "db down" });
        expectNothingDispatched();
      });
    });

    // WhatsApp trims audiences to the plan limit, so the overflow 409 can't
    // follow a template send; these are the request-level stops it can hit.
    it("keeps a draft off when Temporal is not configured", async () => {
      mockBuilderScenario();
      mockIsTemporalConfigured.mockReturnValue(false);

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(503);
      expect(mockSaveScenario).not.toHaveBeenCalled();
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    });

    it("keeps a draft off when every recipient was contacted recently", async () => {
      mockBuilderScenario();
      mockRecentContacts(["+15550000002"]);

      const response = await sendBuilderCampaign();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        outcome: {
          disposition: "no_op",
          skippedByReason: { recent_contact: 1 },
        },
      });
      expect(mockSaveScenario).not.toHaveBeenCalled();
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    });

    it("reports the activation when admission then asks to confirm a recent audience", async () => {
      mockBuilderScenario();
      mockAdmitBulkCampaign.mockImplementationOnce(
        async (
          _client: unknown,
          input: { audience: { fingerprint: string } }
        ) => ({
          status: "blocked",
          code: "recent_audience_confirmation_required",
          retryable: false,
          audienceFingerprint: input.audience.fingerprint,
          overlap: {
            kind: "exact",
            intersectionCount: 1,
            candidateCount: 1,
            ratio: 1,
          },
        })
      );

      const response = await sendBuilderCampaign();
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload).toEqual(
        expect.objectContaining({
          code: "bulk_campaign_recent_audience_confirmation_required",
          audienceConfirmation: expect.objectContaining({ required: true }),
          scenarioActivated: true,
          scenarioStatus: "active",
          scenarioUpdatedAt: activatedAt,
          previousScenarioUpdatedAt: loadedAt,
        })
      );
      expect(mockSaveScenario).toHaveBeenCalledTimes(1);
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    });

    it("reports the activation when Temporal fails after it", async () => {
      mockBuilderScenario();
      mockStartBulkCampaignDispatchWorkflow.mockRejectedValueOnce(
        new Error("Temporal unavailable")
      );
      await withSilencedConsoleError(async () => {
        const response = await sendBuilderCampaign();
        const payload = await response.json();
        const campaignId = mockAdmitBulkCampaign.mock.calls[0][1].campaignId;

        expect(response.status).toBe(503);
        expect(payload).toEqual({
          code: "bulk_campaign_workflow_start_unconfirmed",
          error:
            "Bulk campaign workflow start is not confirmed yet. Recovery can safely retry.",
          retryable: true,
          campaignId,
          dispatchId: campaignId,
          scenarioActivated: true,
          scenarioStatus: "active",
          scenarioUpdatedAt: activatedAt,
          previousScenarioUpdatedAt: loadedAt,
        });
        expect(mockSaveScenario).toHaveBeenCalledTimes(1);
      });
    });

    it.each([
      [
        "Telegram",
        () => {
          mockCreateClient.mockResolvedValue(
            createSupabaseMock({
              telegramSource: {
                id: "telegram-source-1",
                credentials: { bot_token: "telegram-token" },
              },
            })
          );
          mockResolveCampaignBatchPlanPreview.mockResolvedValue(
            telegramFreeBroadcastPreview()
          );
          mockConversationFind.mockReturnValueOnce(selectLeanResult([]));
          return {
            channel: "telegram",
            messageText: "Hello {{name}}",
            telegramSubscribersAudience: {
              type: SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
              sourceId: "telegram-source-1",
            },
          };
        },
      ],
      [
        "email",
        () => {
          mockResolveCampaignBatchPlanPreview.mockResolvedValue(
            emailBatchPlanPreview()
          );
          return {
            channel: "email",
            recipients: [{ email: "first@example.com" }],
            emailContent: {
              format: "markdown",
              subject: "Hello",
              markdown: "Hello",
            },
          };
        },
      ],
    ])(
      "leaves a %s run-now draft as it is",
      async (_channel, prepareChannel) => {
        mockBuilderScenario([], { whatsappOptIn: false });
        const channelBody = prepareChannel();

        const response = await postBulkSend({
          workspaceId,
          campaignName: "Builder follow-up",
          provenance: scenarioRunNowProvenance(scenarioId),
          ...channelBody,
        });
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(mockAdmitBulkCampaign).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            scenarioId,
            executionSource: "scenario_run_now",
          })
        );
        expect(mockSaveScenario).not.toHaveBeenCalled();
        expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
        expect(payload).not.toHaveProperty("scenarioActivated");
      }
    );
  });

  it("keeps staged scheduled bulk payloads until after the scheduled dispatch date", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockIsBulkDispatchPayloadStoreConfigured.mockReturnValue(true);
    const byteLengthSpy = forceOversizedBulkDispatchPayload();

    try {
      const response = await postPromo({
        languageCode: "en",
        recipients: [{ phone: "+15550000002" }],
        scheduledAt: "2099-05-15T10:00:00.000Z",
      });

      expect(response.status).toBe(200);
      expect(mockStoreBulkCampaignDispatchItems).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          retainUntil: "2099-05-15T10:00:00.000Z",
        })
      );
      expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          itemsPayloadKey: `bulk_campaign_dispatch/v1/${workspaceId}/payload-1.json`,
          scheduledAt: "2099-05-15T10:00:00.000Z",
        })
      );
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  it("terminalizes an admitted oversized campaign when payload staging is unavailable", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockIsBulkDispatchPayloadStoreConfigured.mockReturnValue(false);
    const byteLengthSpy = forceOversizedBulkDispatchPayload();

    try {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
      });
      const payload = await response.json();
      const campaignId = mockAdmitBulkCampaign.mock.calls[0][1].campaignId;

      expect(response.status).toBe(413);
      expect(payload).toEqual({
        code: "bulk_campaign_payload_staging_unavailable",
        error:
          "This bulk campaign is too large to queue because payload staging is unavailable.",
        campaignId,
        dispatchId: campaignId,
        status: "failed",
      });
      expect(mockFailCampaignDispatchBeforeStart).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId,
          stopReason: "payload_staging_unavailable",
        })
      );
      expect(mockStoreBulkCampaignDispatchItems).not.toHaveBeenCalled();
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  it("terminalizes an admitted campaign when payload staging write fails", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockIsBulkDispatchPayloadStoreConfigured.mockReturnValue(true);
    mockStoreBulkCampaignDispatchItems.mockRejectedValueOnce(
      new Error("GCS unavailable")
    );
    const byteLengthSpy = forceOversizedBulkDispatchPayload();

    try {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
      });
      const payload = await response.json();
      const campaignId = mockAdmitBulkCampaign.mock.calls[0][1].campaignId;

      expect(response.status).toBe(503);
      expect(payload).toEqual({
        code: "bulk_campaign_payload_staging_failed",
        error: "Failed to stage bulk campaign payload. Try again.",
        campaignId,
        dispatchId: campaignId,
        status: "failed",
      });
      expect(mockFailCampaignDispatchBeforeStart).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId,
          stopReason: "payload_staging_failed",
        })
      );
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  it("returns a stable safety error when staging failure cleanup also fails", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockIsBulkDispatchPayloadStoreConfigured.mockReturnValue(true);
    mockStoreBulkCampaignDispatchItems.mockRejectedValueOnce(
      new Error("GCS unavailable")
    );
    mockFailCampaignDispatchBeforeStart.mockRejectedValueOnce(
      new Error("cleanup unavailable")
    );
    const byteLengthSpy = forceOversizedBulkDispatchPayload();
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
      });
      const payload = await response.json();
      const campaignId = mockAdmitBulkCampaign.mock.calls[0][1].campaignId;

      expect(response.status).toBe(503);
      expect(payload).toEqual({
        code: "bulk_campaign_prestart_cleanup_failed",
        error:
          "Bulk campaign could not be queued and its safety reservation could not be released. Contact support before retrying.",
        campaignId,
        dispatchId: campaignId,
      });
      expect(mockFailCampaignDispatchBeforeStart).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId,
          stopReason: "payload_staging_failed",
        })
      );
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      byteLengthSpy.mockRestore();
    }
  });

  it("admits both unknown and consented WhatsApp marketing recipients with server-stamped evidence", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000003")
    );

    const response = await postBulkSend({
      workspaceId,
      campaignName: "Consent boundary",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
      audienceUploadEvidence: {
        originalFilename: "customers.csv",
        selectedAt: "2026-07-24T08:00:00.000Z",
        replacementHistory: [
          {
            action: "replaced",
            replacedAt: "2026-07-24T07:59:00.000Z",
            previousFilename: "old.csv",
            nextFilename: "customers.csv",
          },
        ],
      },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdmitBulkCampaign).toHaveBeenCalledTimes(1);
    const admissionInput = mockAdmitBulkCampaign.mock.calls[0][1];
    expect(admissionInput).toEqual(
      expect.objectContaining({
        fingerprintSecret: "test-bulk-campaign-encryption-secret",
        workspaceId,
        channel: "whatsapp",
        sentBy: "user-1",
        dispatchStatus: "queued",
        audience: expect.objectContaining({
          count: 2,
          metadata: expect.objectContaining({
            originalFilename: "customers.csv",
            uploadedAt: "2026-07-24T08:00:00.000Z",
            uploadedBy: "user-1",
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            replacementHistory: [
              {
                action: "replaced",
                replacedAt: "2026-07-24T07:59:00.000Z",
                previousFilename: "old.csv",
                nextFilename: "customers.csv",
                replacedBy: "user-1",
              },
            ],
          }),
        }),
        snapshots: [
          expect.objectContaining({
            recipientHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            snapshotOrdinal: 0,
            recipient: "15550000002",
            dispatchSnapshot: expect.objectContaining({
              channel: "whatsapp",
              recipient: { phone: "+15550000002" },
            }),
          }),
          expect.objectContaining({
            recipientHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            snapshotOrdinal: 1,
            recipient: "15550000003",
            dispatchSnapshot: expect.objectContaining({
              channel: "whatsapp",
              recipient: { phone: "+15550000003" },
            }),
          }),
        ],
      })
    );
    expect(admissionInput.snapshots[0].dispatchSnapshot).not.toHaveProperty(
      "accessToken"
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: admissionInput.campaignId,
        requestedAt: admissionInput.requestedAt,
        dispatchExpiresAt: admissionInput.dispatchExpiresAt,
        items: [
          expect.objectContaining({
            campaignId: admissionInput.campaignId,
            recipient: { phone: "+15550000002" },
          }),
          expect.objectContaining({
            campaignId: admissionInput.campaignId,
            recipient: { phone: "+15550000003" },
          }),
        ],
      })
    );
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        campaignId: admissionInput.campaignId,
        dispatchId: admissionInput.campaignId,
        status: "queued",
        total: 2,
        requestedTotal: 2,
        skippedOptIn: 0,
        audience: {
          fingerprint: admissionInput.audience.fingerprint,
          requestedTotal: 2,
          queuedTotal: 2,
          skippedOptIn: 0,
          overlap: {
            kind: "none",
            intersectionCount: 0,
            candidateCount: 2,
            ratio: 0,
          },
        },
      })
    );
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
    expect(JSON.stringify(payload)).not.toContain("15550000002");
  });

  it("admits a marketing audience with no recorded consent without leaking phones", async () => {
    mockConversationFind.mockReturnValueOnce(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      campaignName: "Unknown consent",
      channel: "whatsapp",
      templateName: "promo",
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        queued: true,
        total: 2,
        requestedTotal: 2,
        skippedOptIn: 0,
      })
    );
    expect(JSON.stringify(payload)).not.toContain("1555000000");
    expect(mockAdmitBulkCampaign).toHaveBeenCalledTimes(1);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it("matches consented marketing recipients by canonical phone when the filter returns clones", async () => {
    mockFilterKnownMarketingOptOutRecipients.mockResolvedValueOnce({
      recipients: [
        {
          phone: "1 (555) 000-0003",
          variables: { clonedByConsentResolver: "true" },
        },
      ],
      skippedRecipients: [{ phone: "+15550000002" }],
      skippedOptIn: 1,
      skippedPhones: ["15550000002"],
      marketingOptInWarningRecipients: [{ phone: "+15550000002" }],
      marketingOptInWarningCount: 1,
      marketingOptInWarningPhones: ["15550000002"],
    });

    const response = await postPromo({
      languageCode: "en",
      recipients: [{ phone: "+15550000002" }, { phone: "+15550000003" }],
    });

    expect(response.status).toBe(200);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000003" },
          }),
        ],
      })
    );
  });

  it("keeps marketing rows without an explicit opt-out in a column-split campaign", async () => {
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "promo",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [],
        },
        {
          name: "receipt",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [],
        },
      ],
    });
    mockConversationFind
      .mockReturnValueOnce(selectLeanResult([{ chat: "15550000005" }]))
      .mockReturnValueOnce(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      useColumnSplitRouting: true,
      recipients: [
        {
          phone: "+15550000004",
          templateName: "promo",
          // A client hint must not downgrade the approved MARKETING
          // template category resolved by the server.
          templateCategory: "UTILITY",
        },
        {
          phone: "+15550000005",
          templateName: "receipt",
          templateCategory: "UTILITY",
        },
      ],
    });

    expect(response.status).toBe(200);
    const admissionInput = mockAdmitBulkCampaign.mock.calls[0][1];
    expect(admissionInput.snapshots).toHaveLength(2);
    expect(
      admissionInput.snapshots.map(
        (snapshot: { recipient: string }) => snapshot.recipient
      )
    ).toEqual(["15550000004", "15550000005"]);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: { phone: "+15550000004" },
            templateName: "promo",
          }),
          expect.objectContaining({
            recipient: { phone: "+15550000005" },
            templateName: "receipt",
          }),
        ],
      })
    );
  });

  it("derives split persistence from verified provenance when the browser split flag is false", async () => {
    const scenarioId = "65f000000000000000000001";
    const scenario = {
      _id: scenarioId,
      workspaceId,
      mode: "bulk_campaign",
      deletedAt: null,
      status: "draft",
      nodes: [
        {
          id: "node-bulk-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["whatsapp"],
              sourceIds: ["source-1"],
            },
          },
        },
        {
          id: "column-split",
          data: {
            kind: "logic",
            logicType: "recipient_column_split",
            recipientColumnSplit: {
              version: 1,
              paths: [
                {
                  id: "marketing",
                  rules: [
                    {
                      id: "marketing-rule",
                      column: "tier",
                      op: "equals",
                      value: "gold",
                    },
                  ],
                },
                {
                  id: "utility",
                  rules: [
                    {
                      id: "utility-rule",
                      column: "tier",
                      op: "equals",
                      value: "silver",
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          id: "promo-action",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "promo",
            actionWhatsAppTemplateLanguage: "en",
            actionWhatsAppTemplateCategory: "MARKETING",
            actionWhatsAppTemplateComponents: [],
          },
        },
        {
          id: "receipt-action",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "receipt",
            actionWhatsAppTemplateLanguage: "en",
            actionWhatsAppTemplateCategory: "UTILITY",
            actionWhatsAppTemplateComponents: [],
          },
        },
      ],
      edges: [
        {
          source: "node-bulk-root",
          sourceHandle: "right-source",
          target: "column-split",
        },
        {
          source: "column-split",
          sourceHandle: buildRecipientColumnSplitPathHandleId("marketing"),
          target: "promo-action",
        },
        {
          source: "column-split",
          sourceHandle: buildRecipientColumnSplitPathHandleId("utility"),
          target: "receipt-action",
        },
        {
          source: "column-split",
          sourceHandle: RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
          target: "receipt-action",
        },
      ],
    };
    mockScenarioFindOne.mockImplementation(() => scenarioLeanResult(scenario));
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "browser_decoy",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [],
        },
        {
          name: "promo",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [],
        },
        {
          name: "receipt",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [],
        },
      ],
    });
    mockConversationFind
      .mockReturnValueOnce(selectLeanResult([{ chat: "15550000005" }]))
      .mockReturnValueOnce(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "browser_decoy",
      languageCode: "en",
      templateCategory: "MARKETING",
      useColumnSplitRouting: false,
      recipients: [
        {
          phone: "+15550000004",
          fields: { tier: "gold" },
          templateName: "promo",
          languageCode: "en",
        },
        {
          phone: "+15550000005",
          fields: { tier: "silver" },
          templateName: "receipt",
          languageCode: "en",
        },
      ],
      provenance: scenarioRunNowProvenance(scenarioId, {
        columnSplitNodeId: "column-split",
      }),
    });

    expect(response.status).toBe(200);
    const admissionInput = mockAdmitBulkCampaign.mock.calls[0][1];
    expect(admissionInput.templateName).toBeNull();
    expect(admissionInput.templateLanguage).not.toBe("en");
    expect(
      admissionInput.snapshots.map(
        (snapshot: { dispatchSnapshot: { templateName: string } }) =>
          snapshot.dispatchSnapshot.templateName
      )
    ).toEqual(["promo", "receipt"]);
  });

  it("queues the canonical column-split body a scenario bulk node posts", async () => {
    const scenarioId = "65f000000000000000000003";
    const templateAction = (
      id: string,
      name: string,
      category: "MARKETING" | "UTILITY"
    ) => ({
      id,
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: name,
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateCategory: category,
        actionWhatsAppTemplateComponents: [],
      },
    });
    const tierPath = (id: string, value: string) => ({
      id,
      rules: [{ id: `${id}-rule`, column: "tier", op: "equals", value }],
    });
    mockScenarioFindOne.mockImplementation(() =>
      scenarioLeanResult({
        _id: scenarioId,
        workspaceId,
        mode: "bulk_campaign",
        deletedAt: null,
        status: "draft",
        nodes: [
          {
            id: "node-bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                workflowKind: "bulk_campaign",
                channels: ["whatsapp"],
                sourceIds: ["source-1"],
              },
            },
          },
          {
            id: "column-split",
            data: {
              kind: "logic",
              logicType: "recipient_column_split",
              recipientColumnSplit: {
                version: 1,
                paths: [
                  tierPath("marketing", "gold"),
                  tierPath("utility", "silver"),
                ],
              },
            },
          },
          templateAction("promo-action", "promo", "MARKETING"),
          templateAction("receipt-action", "receipt", "UTILITY"),
        ],
        edges: [
          {
            source: "node-bulk-root",
            sourceHandle: "right-source",
            target: "column-split",
          },
          {
            source: "column-split",
            sourceHandle: buildRecipientColumnSplitPathHandleId("marketing"),
            target: "promo-action",
          },
          {
            source: "column-split",
            sourceHandle: buildRecipientColumnSplitPathHandleId("utility"),
            target: "receipt-action",
          },
          {
            source: "column-split",
            sourceHandle: RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
            target: "receipt-action",
          },
        ],
      })
    );
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "promo",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [],
        },
        {
          name: "receipt",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [],
        },
      ],
    });
    mockConversationFind
      .mockReturnValueOnce(selectLeanResult([{ chat: "15550000005" }]))
      .mockReturnValueOnce(selectLeanResult([]));
    // postBulkCampaignSend posts the normalized body: an inline audience with
    // per-row template hints, no flat recipients, no top-level template.
    const body = parseBulkCampaignSendRequest({
      workspaceId,
      channel: "whatsapp",
      campaignName: "Split campaign",
      idempotencyKey: "column-split-node-send-1",
      useColumnSplitRouting: true,
      recipientPolicy: { version: 1, excludePriorFailedBulkSends: false },
      audience: {
        kind: "inline",
        recipients: [
          {
            phone: "+15550000004",
            fields: { tier: "gold" },
            templateName: "promo",
            languageCode: "en",
          },
          {
            phone: "+15550000005",
            fields: { tier: "silver" },
            templateName: "receipt",
            languageCode: "en",
          },
        ],
      },
      provenance: scenarioRunNowProvenance(scenarioId, {
        columnSplitNodeId: "column-split",
      }),
    });
    expect(body).not.toHaveProperty("recipients");
    expect(body).not.toHaveProperty("templateName");

    const response = await postBulkSend(body);

    expect(response.status).toBe(200);
    const admissionInput = mockAdmitBulkCampaign.mock.calls[0][1];
    expect(admissionInput.templateName).toBeNull();
    expect(admissionInput.templateLanguage).toBe("multi");
    expect(
      admissionInput.snapshots.map(
        (snapshot: { dispatchSnapshot: { templateName: string } }) =>
          snapshot.dispatchSnapshot.templateName
      )
    ).toEqual(["promo", "receipt"]);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            recipient: expect.objectContaining({ phone: "+15550000004" }),
            templateName: "promo",
          }),
          expect.objectContaining({
            recipient: expect.objectContaining({ phone: "+15550000005" }),
            templateName: "receipt",
          }),
        ],
      })
    );
  });

  describe("column split with the Else path left unconnected", () => {
    // The same graph as the scenario bulk node test: one connected path and an
    // empty Else, which the editor describes as "leave empty to skip send".
    const scenarioId = "65f000000000000000000004";
    function mockSplitScenarioWithEmptyElse() {
      mockScenarioFindOne.mockImplementation(() =>
        scenarioLeanResult({
          _id: scenarioId,
          workspaceId,
          mode: "bulk_campaign",
          deletedAt: null,
          status: "draft",
          nodes: [
            {
              id: "bulk-1",
              data: {
                kind: "bulk",
                bulkRootConfig: {
                  workflowKind: "bulk_campaign",
                  channels: ["whatsapp"],
                  sourceIds: ["source-1"],
                },
              },
            },
            {
              id: "split-1",
              data: {
                kind: "logic",
                logicType: "recipient_column_split",
                recipientColumnSplit: {
                  version: 1,
                  paths: [
                    {
                      id: "almaty",
                      label: "Almaty",
                      rules: [
                        {
                          id: "r1",
                          column: "city",
                          op: "equals",
                          value: "Almaty",
                        },
                      ],
                    },
                  ],
                },
              },
            },
            {
              id: "action-2",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "vip_offer",
                actionWhatsAppTemplateLanguage: "en",
                actionWhatsAppTemplateCategory: "MARKETING",
                actionWhatsAppTemplateComponents: [
                  { type: "BODY", text: "Hi" },
                ],
              },
            },
          ],
          edges: [
            {
              source: "bulk-1",
              sourceHandle: "right-source",
              target: "split-1",
            },
            {
              source: "split-1",
              sourceHandle: buildRecipientColumnSplitPathHandleId("almaty"),
              target: "action-2",
            },
          ],
        })
      );
      mockListTemplates.mockResolvedValue({
        templates: [
          {
            name: "vip_offer",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Hi" }],
          },
        ],
      });
    }

    // The body postBulkCampaignSend posts for that node (captured from
    // node-enrichment/bulk.test.ts): the Else row is already dropped.
    function nodeSendBody(
      recipients: Array<Record<string, unknown>> = [
        {
          phone: "+10000000001",
          fields: { city: "Almaty" },
          templateName: "vip_offer",
          languageCode: "en",
        },
      ]
    ) {
      return {
        workspaceId,
        channel: "whatsapp",
        campaignName: "Split campaign",
        languageCode: "en",
        idempotencyKey: "column-split-empty-else-1",
        useColumnSplitRouting: true,
        audience: { kind: "inline", recipients },
        recipientPolicy: { version: 1, excludePriorFailedBulkSends: false },
        provenance: {
          kind: "scenario_run_now",
          scenarioId,
          rootNodeId: "bulk-1",
          columnSplitNodeId: "split-1",
        },
      };
    }

    it("queues the rows the node sends from the connected path", async () => {
      mockSplitScenarioWithEmptyElse();
      mockConversationFind
        .mockReturnValueOnce(selectLeanResult([{ chat: "10000000001" }]))
        .mockReturnValueOnce(selectLeanResult([]));

      const response = await postBulkSend(nodeSendBody());

      expect(response.status).toBe(200);
      expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [
            expect.objectContaining({
              recipient: expect.objectContaining({ phone: "+10000000001" }),
              templateName: "vip_offer",
            }),
          ],
        })
      );
    });

    it("rejects a row that lands on the empty Else path", async () => {
      mockSplitScenarioWithEmptyElse();

      const response = await postBulkSend(
        nodeSendBody([
          {
            phone: "+10000000001",
            fields: { city: "Almaty" },
            templateName: "vip_offer",
            languageCode: "en",
          },
          {
            phone: "+10000000002",
            fields: { city: "Astana" },
            templateName: "vip_offer",
            languageCode: "en",
          },
        ])
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "bulk_campaign_provenance_invalid",
      });
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "bulk_campaign.provenance_invalid",
        expect.objectContaining({
          workspaceId,
          stage: "recipient_routing",
          reason: "recipient_route_missing",
        })
      );
      expectNothingDispatched();
    });
  });

  it("preflights dispatchability from each approved split template", async () => {
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "plain",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [],
        },
        {
          name: "needs_media",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [{ type: "HEADER", format: "IMAGE" }],
        },
      ],
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "plain",
      languageCode: "en",
      useColumnSplitRouting: true,
      recipients: [
        { phone: "+15550000004", templateName: "plain" },
        { phone: "+15550000005", templateName: "needs_media" },
      ],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.outcome).toMatchObject({
      requestedTotal: 2,
      acceptedTotal: 1,
      queuedTotal: 1,
      skippedByReason: { ineligible: 1 },
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ templateName: "plain" })],
      })
    );
  });

  it("excludes a split recipient missing a variable required by its approved template", async () => {
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "plain",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [],
        },
        {
          name: "coded",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Code {{promo_code}}" }],
        },
      ],
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "plain",
      languageCode: "en",
      useColumnSplitRouting: true,
      recipients: [
        { phone: "+15550000004", templateName: "plain" },
        { phone: "+15550000005", templateName: "coded" },
      ],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.outcome).toMatchObject({
      requestedTotal: 2,
      acceptedTotal: 1,
      queuedTotal: 1,
      skippedByReason: { ineligible: 1 },
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ templateName: "plain" })],
      })
    );
  });

  it("uses the allocated campaign identity in shared variable preflight and dispatch", async () => {
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "campaign_identity",
          language: "en",
          status: "APPROVED",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Campaign {{campaign_id}}" }],
        },
      ],
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "campaign_identity",
      languageCode: "en",
      recipients: [{ phone: "+15550000004" }],
      idempotencyKey: "campaign-id-variable-1",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.outcome).toMatchObject({
      disposition: "queued",
      acceptedTotal: 1,
      queuedTotal: 1,
      campaignId: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            components: [
              expect.objectContaining({
                type: "body",
                parameters: [
                  expect.objectContaining({
                    type: "text",
                    text: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
                  }),
                ],
              }),
            ],
          }),
        ],
      })
    );
  });

  it("loads one bounded provider catalog for a verified twenty-path split", async () => {
    const scenarioId = "65f000000000000000000002";
    const paths = Array.from({ length: 20 }, (_, index) => ({
      id: `path-${index}`,
      rules: [
        {
          id: `rule-${index}`,
          column: "tier",
          op: "equals",
          value: String(index),
        },
      ],
    }));
    const actions = paths.map((_, index) => ({
      id: `action-${index}`,
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: `route_${index}`,
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateCategory: "MARKETING",
        actionWhatsAppTemplateComponents: [],
      },
    }));
    const scenario = {
      _id: scenarioId,
      workspaceId,
      mode: "bulk_campaign",
      deletedAt: null,
      status: "draft",
      nodes: [
        {
          id: "node-bulk-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["whatsapp"],
              sourceIds: ["source-1"],
            },
          },
        },
        {
          id: "column-split",
          data: {
            kind: "logic",
            logicType: "recipient_column_split",
            recipientColumnSplit: { version: 1, paths },
          },
        },
        ...actions,
      ],
      edges: [
        {
          source: "node-bulk-root",
          sourceHandle: "right-source",
          target: "column-split",
        },
        ...paths.map((path, index) => ({
          source: "column-split",
          sourceHandle: buildRecipientColumnSplitPathHandleId(path.id),
          target: `action-${index}`,
        })),
        {
          source: "column-split",
          sourceHandle: RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
          target: "action-19",
        },
      ],
    };
    mockScenarioFindOne.mockImplementation(() => scenarioLeanResult(scenario));
    mockListTemplates.mockResolvedValue({
      templates: paths.map((_, index) => ({
        name: `route_${index}`,
        language: "en",
        status: "APPROVED",
        category: "MARKETING",
        components: [],
      })),
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "route_0",
      languageCode: "en",
      useColumnSplitRouting: true,
      recipients: paths.map((_, index) => ({
        phone: `+15550000${String(index).padStart(3, "0")}`,
        fields: { tier: String(index) },
        templateName: `route_${index}`,
        languageCode: "en",
      })),
      provenance: scenarioRunNowProvenance(scenarioId, {
        columnSplitNodeId: "column-split",
      }),
    });

    expect(response.status).toBe(200);
    expect(mockListTemplates).toHaveBeenCalledTimes(1);
    expect(mockAdmitBulkCampaign.mock.calls[0][1].snapshots).toHaveLength(20);
  });

  it("returns an aggregate no-op when utility history preflight excludes every recipient", async () => {
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "receipt",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [],
        },
      ],
    });
    mockConversationFind.mockReturnValue(selectLeanResult([]));

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "receipt",
      languageCode: "en",
      recipients: [{ phone: "+15550000009" }],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      outcome: {
        disposition: "no_op",
        requestedTotal: 1,
        acceptedTotal: 0,
        queuedTotal: 0,
        skippedByReason: { ineligible: 1 },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("15550000009");
    expect(mockConversationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        channel: "whatsapp",
        sourceId: "source-1",
        $or: [
          expect.objectContaining({
            chat: expect.objectContaining({
              $in: expect.arrayContaining(["15550000009", "wa_15550000009"]),
            }),
          }),
          expect.objectContaining({
            user: expect.objectContaining({
              $in: expect.arrayContaining(["15550000009", "wa_15550000009"]),
            }),
          }),
        ],
      })
    );
    expectNothingDispatched();
  });

  it("preflights utility history before the live limit and persists the exact backfilled outcome", async () => {
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "receipt",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [],
        },
      ],
    });
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce({
      channel: "whatsapp",
      readiness: {
        state: "ready",
        checkedAt: "2026-09-16T00:00:00.000Z",
        remainingCapacity: null,
        reasons: [],
      },
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      },
      recipientLimit: {
        maxRecipients: 2,
        rawLimit: "TIER_2",
        source: "live_meta",
      },
    });
    mockConversationFind.mockReturnValue(
      selectLeanResult([{ chat: "15550000002" }, { chat: "15550000003" }])
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "receipt",
      languageCode: "en",
      recipients: [
        { phone: "+15550000001" },
        { phone: "+15550000002" },
        { phone: "+15550000003" },
      ],
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      outcome: {
        requestedTotal: 3,
        acceptedTotal: 2,
        queuedTotal: 2,
        uniqueRecipients: { requested: 3, accepted: 2, queued: 2 },
        skippedByReason: { ineligible: 1 },
      },
    });
    const admissionInput = mockAdmitBulkCampaign.mock.calls[0][1];
    expect(
      admissionInput.snapshots.map(
        (snapshot: { recipient: string }) => snapshot.recipient
      )
    ).toEqual(["15550000002", "15550000003"]);
    expect(admissionInput.audience.metadata).toMatchObject({
      policy: { version: 1, excludePriorFailedBulkSends: false },
      authoritativeRecipientLimit: {
        source: "live_meta",
        value: 2,
        rawLimit: "TIER_2",
      },
      requestDigest: { version: 1, digest: "d".repeat(64) },
      outcome: {
        requestedTotal: 3,
        acceptedTotal: 2,
        uniqueRecipients: { requested: 3, accepted: 2 },
        skippedByReason: { ineligible: 1 },
      },
    });
    expect(payload.recipientLimit).toMatchObject({
      originalCount: 2,
      acceptedCount: 2,
      truncated: false,
    });
  });

  it.each([
    {
      admissionCode: "active_audience_overlap",
      expectedCode: "bulk_campaign_active_audience_overlap",
    },
    {
      admissionCode: "recent_audience_confirmation_required",
      expectedCode: "bulk_campaign_recent_audience_confirmation_required",
    },
  ])(
    "maps $admissionCode to an aggregate-only conflict",
    async ({ admissionCode, expectedCode }) => {
      mockConversationFind.mockReturnValueOnce(
        whatsappMarketingOptIns("+15550000002")
      );
      mockAdmitBulkCampaign.mockImplementationOnce(
        async (
          _client: unknown,
          input: {
            audience: { fingerprint: string; count: number };
          }
        ) => ({
          status: "blocked",
          code: admissionCode,
          retryable: false,
          audienceFingerprint: input.audience.fingerprint,
          overlap: {
            kind: "exact",
            intersectionCount: 1,
            candidateCount: 1,
            ratio: 1,
          },
        })
      );

      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.code).toBe(expectedCode);
      expect(payload.audience).toEqual({
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        requestedTotal: 1,
        queuedTotal: 1,
        skippedOptIn: 0,
        overlap: {
          kind: "exact",
          intersectionCount: 1,
          candidateCount: 1,
          ratio: 1,
        },
      });
      expect(payload).not.toHaveProperty("recipientHashes");
      expect(JSON.stringify(payload)).not.toContain("15550000002");
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    }
  );

  it("keeps admission recoverable when Temporal start is unconfirmed and leaves the scenario draft", async () => {
    const scenarioId = "65f000000000000000000001";
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockStartBulkCampaignDispatchWorkflow.mockRejectedValueOnce(
      new Error("Temporal unavailable")
    );
    await withSilencedConsoleError(async () => {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        provenance: scenarioRunNowProvenance(scenarioId),
      });
      const payload = await response.json();
      const campaignId = mockAdmitBulkCampaign.mock.calls[0][1].campaignId;

      expect(response.status).toBe(503);
      expect(payload).toEqual({
        code: "bulk_campaign_workflow_start_unconfirmed",
        error:
          "Bulk campaign workflow start is not confirmed yet. Recovery can safely retry.",
        retryable: true,
        campaignId,
        dispatchId: campaignId,
      });
      expect(mockFailCampaignDispatchBeforeStart).not.toHaveBeenCalled();
      expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    });
  });

  it("does not run destructive cleanup for an ambiguous Temporal start", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockStartBulkCampaignDispatchWorkflow.mockRejectedValueOnce(
      new Error("Temporal start result unknown")
    );
    mockFailCampaignDispatchBeforeStart.mockResolvedValueOnce(false);

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
    });
    const payload = await response.json();
    const campaignId = mockAdmitBulkCampaign.mock.calls[0][1].campaignId;

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      code: "bulk_campaign_workflow_start_unconfirmed",
      error:
        "Bulk campaign workflow start is not confirmed yet. Recovery can safely retry.",
      retryable: true,
      campaignId,
      dispatchId: campaignId,
    });
    expect(payload).not.toHaveProperty("status");
    expect(mockFailCampaignDispatchBeforeStart).not.toHaveBeenCalled();
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("returns the accepted dispatch when post-start idempotency caching fails", async () => {
    mockConversationFind.mockReturnValueOnce(
      whatsappMarketingOptIns("+15550000002")
    );
    mockCompleteLegacyIdempotency.mockRejectedValueOnce(
      new Error("idempotency cache unavailable")
    );
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        idempotencyKey: "accepted-cache-failure-123",
      });
      const payload = await response.json();
      const campaignId = mockAdmitBulkCampaign.mock.calls[0][1].campaignId;

      expect(response.status).toBe(200);
      expect(payload).toEqual(
        expect.objectContaining({
          queued: true,
          campaignId,
          dispatchId: campaignId,
          status: "queued",
          workflowId: expect.stringMatching(/^bulk-campaign-dispatch:/),
        })
      );
      expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledTimes(1);
      expect(mockCompleteLegacyIdempotency).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          userId: "user-1",
          idempotencyKey: "accepted-cache-failure-123",
          responseBody: expect.objectContaining({ campaignId }),
          eventFacts: expect.objectContaining({
            disposition: "queued",
            lifecycleStatus: "queued",
          }),
        })
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to cache accepted bulk-send idempotency result",
        expect.objectContaining({
          workspaceId,
          campaignId,
          error: "idempotency cache unavailable",
        })
      );
      expect(mockReleaseLegacyIdempotency).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          userId: "user-1",
          idempotencyKey: "accepted-cache-failure-123",
          reservationToken: "legacy-owner-token",
        })
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("serializes concurrent no-op commands before eligibility can later queue", async () => {
    let markFilterStarted!: () => void;
    const filterStarted = new Promise<void>(resolve => {
      markFilterStarted = resolve;
    });
    let releaseFirstFilter!: () => void;
    const firstFilterGate = new Promise<void>(resolve => {
      releaseFirstFilter = resolve;
    });
    mockReserveLegacyIdempotency
      .mockResolvedValueOnce({
        status: "acquired",
        reservationToken: "winning-owner",
      })
      .mockResolvedValueOnce({ status: "in_progress", retryAfterMs: 30_000 });
    mockFilterKnownMarketingOptOutRecipients
      .mockImplementationOnce(
        async ({ recipients }: { recipients: unknown[] }) => {
          markFilterStarted();
          await firstFilterGate;
          return {
            recipients: [],
            skippedRecipients: recipients,
            skippedOptIn: recipients.length,
            skippedPhones: [],
            marketingOptInWarningCount: 0,
            marketingOptInWarningRecipients: [],
            marketingOptInWarningPhones: [],
          };
        }
      )
      .mockImplementationOnce(
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
    const buildRequest = () =>
      bulkSendRequest(
        promoBody({
          recipients: [{ phone: "+15550000002" }],
          idempotencyKey: "same-concurrent-request-123",
        })
      );

    const firstResponsePromise = POST(buildRequest());
    await filterStarted;
    const secondResponse = await POST(buildRequest());
    releaseFirstFilter();
    const firstResponse = await firstResponsePromise;
    const firstPayload = await firstResponse.json();
    const secondPayload = await secondResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstPayload.outcome.disposition).toBe("no_op");
    expect(secondResponse.status).toBe(409);
    expect(secondPayload).toEqual({
      code: "bulk_campaign_idempotency_in_progress",
      error: "An identical bulk campaign command is already in progress.",
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(mockFilterKnownMarketingOptOutRecipients).toHaveBeenCalledTimes(1);
    expect(mockCompleteLegacyIdempotency).toHaveBeenCalledTimes(1);
    expectNothingDispatched();
  });

  it("rejects an idempotency key reused for a different semantic command", async () => {
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "payload_mismatch",
    });

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "reused-for-different-command",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "bulk_campaign_idempotency_payload_mismatch",
      error: "This idempotency key is already bound to a different request.",
      retryable: false,
    });
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("re-reads the immutable admitted replay after an admission race", async () => {
    const campaignId = "9f29e513-bf52-54f0-b63e-f1f23eef8f22";
    const privateReplayValues = [
      "+15559990003",
      "sql-race-private@example.com",
      "sql-race-chat-987654",
    ];
    const persistedReplay = {
      campaignId: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
      workspaceId,
      result: {
        ok: true,
        outcome: {
          disposition: "queued",
          evaluatedAt: "2026-08-21T08:30:00.000Z",
          lifecycleStatus: "queued",
          requestedTotal: 3,
          acceptedTotal: 1,
          queuedTotal: 1,
          uniqueRecipients: { requested: 3, accepted: 1, queued: 1 },
          skippedByReason: { prior_failure: 2 },
          warnings: { missingMarketingConsent: 0 },
          campaignId,
          dispatchId: campaignId,
          workflowId: `bulk-campaign-dispatch:${workspaceId}:${campaignId}`,
        },
        batchPlan: {
          batchSize: 5,
          delayMs: 1_000,
          ratePerSecond: 5,
          rateSource: "cached_meta_throughput",
        },
        recipientLimit: {
          originalCount: 3,
          acceptedCount: 1,
          rawLimit: "1",
          source: "cached_meta",
          truncated: false,
        },
        marketingOptInWarningPhones: [privateReplayValues[0]],
        invalidRecipients: [privateReplayValues[1]],
        rawChatId: privateReplayValues[2],
      },
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      scenarioId: null,
      rootNodeId: null,
      planLimit: { source: "cached_meta", value: 1 },
      policy: { version: 1, excludePriorFailedBulkSends: true },
    };
    mockLookupAdmittedBulkCampaignReplay
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persistedReplay);
    mockAdmitBulkCampaign.mockImplementationOnce(
      async (
        _client: unknown,
        admissionInput: {
          workflowId: string;
          requestedAt: string;
          dispatchExpiresAt: string;
          audience: { count: number; fingerprint: string };
        }
      ) => ({
        status: "admitted",
        campaignId,
        workflowId: admissionInput.workflowId,
        dispatchStatus: "running",
        requestedAt: admissionInput.requestedAt,
        dispatchExpiresAt: admissionInput.dispatchExpiresAt,
        audienceCount: admissionInput.audience.count,
        idempotentReplay: true,
        audienceFingerprint: admissionInput.audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 1,
          ratio: 0,
        },
      })
    );

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "post-admission-race-123",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      outcome: persistedReplay.result.outcome,
      batchPlan: persistedReplay.result.batchPlan,
      recipientLimit: persistedReplay.result.recipientLimit,
    });
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
    expect(payload).not.toHaveProperty("invalidRecipients");
    expect(payload).not.toHaveProperty("rawChatId");
    const serializedPayload = JSON.stringify(payload);
    for (const privateValue of privateReplayValues) {
      expect(serializedPayload).not.toContain(privateValue);
    }
    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenCalledTimes(2);
    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenNthCalledWith(1, {
      client: expect.anything(),
      campaignId,
      workspaceId,
      sentBy: "user-1",
      requestDigest: { version: 1, digest: "d".repeat(64) },
    });
    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenNthCalledWith(2, {
      client: expect.anything(),
      campaignId,
      workspaceId,
      sentBy: "user-1",
      requestDigest: { version: 1, digest: "d".repeat(64) },
    });
    expect(mockCompleteLegacyIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        idempotencyKey: "post-admission-race-123",
        responseBody: payload,
      })
    );
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        itemCounts: { requested: 3, accepted: 1, queued: 1 },
        planLimit: { source: "cached_meta", value: 1 },
        policy: { version: 1, excludePriorFailedBulkSends: true },
        idempotentReplay: true,
      })
    );
  });

  it.each(["failed", "expired", "cancelled", "completed"] as const)(
    "fails closed when post-admission SQL replay becomes %s before idempotency completion",
    async dispatchStatus => {
      const campaignId = "9f29e513-bf52-54f0-b63e-f1f23eef8f22";
      const persistedReplay = {
        campaignId,
        workspaceId,
        result: {
          ok: true,
          outcome: {
            disposition: "queued",
            evaluatedAt: "2026-08-21T08:30:00.000Z",
            lifecycleStatus: "queued",
            requestedTotal: 3,
            acceptedTotal: 1,
            queuedTotal: 1,
            uniqueRecipients: { requested: 3, accepted: 1, queued: 1 },
            skippedByReason: { prior_failure: 2 },
            warnings: { missingMarketingConsent: 0 },
            campaignId,
            dispatchId: campaignId,
            workflowId: `bulk-campaign-dispatch:${workspaceId}:${campaignId}`,
          },
        },
        batchPlan: {
          batchSize: 5,
          delayMs: 1_000,
          ratePerSecond: 5,
          rateSource: "cached_meta_throughput",
        },
        dispatchStatus,
        requestedAt: "2026-08-21T08:30:00.000Z",
        scheduledAt: null,
        dispatchExpiresAt: "2026-08-21T08:45:00.000Z",
        totalRecipients: 1,
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "ad_hoc",
        scenarioId: null,
        rootNodeId: null,
        planLimit: { source: "cached_meta", value: 1 },
        policy: { version: 1, excludePriorFailedBulkSends: false },
      };
      mockLookupAdmittedBulkCampaignReplay
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(persistedReplay);
      mockAdmitBulkCampaign.mockImplementationOnce(
        async (
          _client: unknown,
          admissionInput: {
            workflowId: string;
            requestedAt: string;
            dispatchExpiresAt: string;
            audience: { count: number; fingerprint: string };
          }
        ) => ({
          status: "admitted",
          campaignId,
          workflowId: admissionInput.workflowId,
          dispatchStatus: "running",
          requestedAt: admissionInput.requestedAt,
          dispatchExpiresAt: admissionInput.dispatchExpiresAt,
          audienceCount: admissionInput.audience.count,
          idempotentReplay: true,
          audienceFingerprint: admissionInput.audience.fingerprint,
          overlap: {
            kind: "none",
            intersectionCount: 0,
            candidateCount: 1,
            ratio: 0,
          },
        })
      );

      const idempotencyKey = `post-admission-terminal-${dispatchStatus}`;
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        idempotencyKey,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "bulk_campaign_terminal_replay",
        error: `This campaign is already ${dispatchStatus} and cannot be queued again.`,
        retryable: false,
        campaignId,
        dispatchId: campaignId,
      });
      expect(mockCompleteLegacyIdempotency).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith("bulk_campaign.policy", {
        workspaceId,
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "ad_hoc",
        itemCounts: { requested: 3, accepted: 1, queued: 0 },
        uniqueRecipientCounts: { requested: 3, accepted: 1, queued: 0 },
        skippedByReason: { prior_failure: 2 },
        warnings: { missingMarketingConsent: 0 },
        disposition: "blocked",
        lifecycleStatus: dispatchStatus,
        planLimit: { source: "cached_meta", value: 1 },
        policy: { version: 1, excludePriorFailedBulkSends: false },
        errorCode: "bulk_campaign_terminal_replay",
        idempotentReplay: true,
      });
      expect(JSON.stringify(mockLoggerInfo.mock.calls[0]?.[1])).not.toContain(
        "+15550000002"
      );
      expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
      expect(mockReleaseLegacyIdempotency).toHaveBeenCalledWith({
        workspaceId,
        userId: "user-1",
        idempotencyKey,
        requestDigestVersion: 1,
        requestDigest: "d".repeat(64),
        reservationToken: "legacy-owner-token",
      });
    }
  );

  it("emits one immutable event when queue recovery discovers a terminal replay", async () => {
    const campaignId = "9f29e513-bf52-54f0-b63e-f1f23eef8f22";
    const persistedReplay = {
      campaignId,
      workspaceId,
      result: {
        ok: true,
        outcome: {
          disposition: "queued",
          evaluatedAt: "2026-08-21T08:30:00.000Z",
          lifecycleStatus: "queued",
          requestedTotal: 3,
          acceptedTotal: 1,
          queuedTotal: 1,
          uniqueRecipients: { requested: 3, accepted: 1, queued: 1 },
          skippedByReason: { prior_failure: 2 },
          warnings: { missingMarketingConsent: 0 },
          campaignId,
          dispatchId: campaignId,
          workflowId: `bulk-campaign-dispatch:${workspaceId}:${campaignId}`,
        },
      },
      batchPlan: {
        batchSize: 5,
        delayMs: 1_000,
        ratePerSecond: 5,
        rateSource: "cached_meta_throughput",
      },
      dispatchStatus: "failed" as const,
      requestedAt: "2026-08-21T08:30:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2026-08-21T08:45:00.000Z",
      totalRecipients: 1,
      channel: "whatsapp" as const,
      messageKind: "template" as const,
      executionSource: "scenario_run_now" as const,
      scenarioId: "scenario-persisted",
      rootNodeId: "root-persisted",
      planLimit: { source: "cached_meta" as const, value: 1 },
      policy: { version: 1 as const, excludePriorFailedBulkSends: true },
    };
    mockLookupAdmittedBulkCampaignReplay
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persistedReplay);
    const { createPreparedBulkCampaignTerminalReplayError } =
      jest.requireActual(
        "@/lib/campaign/queue-prepared-bulk-campaign-dispatch"
      ) as {
        createPreparedBulkCampaignTerminalReplayError: (input: {
          campaignId: string;
          dispatchStatus: "failed";
        }) => Error;
      };
    mockQueuePreparedBulkCampaignDispatchOverride.mockImplementation(() =>
      Promise.reject(
        createPreparedBulkCampaignTerminalReplayError({
          campaignId,
          dispatchStatus: "failed",
        })
      )
    );

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "queue-terminal-no-mutable-event",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "bulk_campaign_terminal_replay",
      error: "This campaign is already failed and cannot be queued again.",
      retryable: false,
      campaignId,
      dispatchId: campaignId,
    });
    expect(mockCompleteLegacyIdempotency).not.toHaveBeenCalled();
    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenCalledTimes(2);
    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenNthCalledWith(2, {
      client: expect.anything(),
      campaignId,
      workspaceId,
      sentBy: "user-1",
      requestDigest: { version: 1, digest: "d".repeat(64) },
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith("bulk_campaign.policy", {
      workspaceId,
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "scenario_run_now",
      scenarioId: "scenario-persisted",
      rootNodeId: "root-persisted",
      itemCounts: { requested: 3, accepted: 1, queued: 0 },
      uniqueRecipientCounts: { requested: 3, accepted: 1, queued: 0 },
      skippedByReason: { prior_failure: 2 },
      warnings: { missingMarketingConsent: 0 },
      disposition: "blocked",
      lifecycleStatus: "failed",
      planLimit: { source: "cached_meta", value: 1 },
      policy: { version: 1, excludePriorFailedBulkSends: true },
      errorCode: "bulk_campaign_terminal_replay",
      idempotentReplay: true,
    });
    expect(JSON.stringify(mockLoggerInfo.mock.calls[0]?.[1])).not.toContain(
      "+15550000002"
    );
    expect(mockReleaseLegacyIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "queue-terminal-no-mutable-event",
        reservationToken: "legacy-owner-token",
      })
    );
  });

  it.each(["missing", "query_error", "malformed"] as const)(
    "emits one facts-unavailable terminal event when the immutable queue replay is %s",
    async replayFailure => {
      const campaignId = "9f29e513-bf52-54f0-b63e-f1f23eef8f22";
      mockLookupAdmittedBulkCampaignReplay.mockResolvedValueOnce(null);
      if (replayFailure === "missing") {
        mockLookupAdmittedBulkCampaignReplay.mockResolvedValueOnce(null);
      } else if (replayFailure === "query_error") {
        mockLookupAdmittedBulkCampaignReplay.mockRejectedValueOnce(
          new Error("persisted replay query unavailable")
        );
      } else {
        mockLookupAdmittedBulkCampaignReplay.mockResolvedValueOnce({
          campaignId,
          workspaceId,
          dispatchStatus: "failed",
          result: {
            ok: true,
            outcome: { invalidRecipients: ["reader@example.com"] },
          },
        } as never);
      }
      const { createPreparedBulkCampaignTerminalReplayError } =
        jest.requireActual(
          "@/lib/campaign/queue-prepared-bulk-campaign-dispatch"
        ) as {
          createPreparedBulkCampaignTerminalReplayError: (input: {
            campaignId: string;
            dispatchStatus: "failed";
          }) => Error;
        };
      mockQueuePreparedBulkCampaignDispatchOverride.mockImplementation(() =>
        Promise.reject(
          createPreparedBulkCampaignTerminalReplayError({
            campaignId,
            dispatchStatus: "failed",
          })
        )
      );

      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        idempotencyKey: `queue-terminal-${replayFailure}`,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "bulk_campaign_terminal_replay",
        error: "This campaign is already failed and cannot be queued again.",
        retryable: false,
        campaignId,
        dispatchId: campaignId,
      });
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith("bulk_campaign.policy", {
        workspaceId,
        factsUnavailable: "terminal_replay",
        errorCode: "bulk_campaign_terminal_replay",
        idempotentReplay: true,
      });
      const serializedEvent = JSON.stringify(mockLoggerInfo.mock.calls[0]?.[1]);
      expect(serializedEvent).not.toMatch(
        /whatsapp|scenario|15550000002|reader@example.com/
      );
      expect(mockCompleteLegacyIdempotency).not.toHaveBeenCalled();
      expect(mockReleaseLegacyIdempotency).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `queue-terminal-${replayFailure}`,
          reservationToken: "legacy-owner-token",
        })
      );
    }
  );

  it("returns the exact completed no-op when queue recovery wins a replay race", async () => {
    const campaignId = "9f29e513-bf52-54f0-b63e-f1f23eef8f22";
    const persistedReplay = {
      campaignId,
      workspaceId,
      result: {
        ok: true,
        outcome: {
          disposition: "no_op",
          evaluatedAt: "2026-08-21T08:30:00.000Z",
          lifecycleStatus: "completed",
          requestedTotal: 1,
          acceptedTotal: 0,
          queuedTotal: 0,
          uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
          skippedByReason: { ineligible: 1 },
          warnings: { missingMarketingConsent: 0 },
        },
      },
      batchPlan: {
        batchSize: 5,
        delayMs: 1_000,
        ratePerSecond: 5,
        rateSource: "cached_meta_throughput",
      },
      dispatchStatus: "completed" as const,
      requestedAt: "2026-08-21T08:30:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2026-08-21T08:45:00.000Z",
      totalRecipients: 1,
      channel: "whatsapp" as const,
      messageKind: "template" as const,
      executionSource: "ad_hoc" as const,
      scenarioId: null,
      rootNodeId: null,
      planLimit: { source: "cached_meta" as const, value: 1 },
      policy: { version: 1 as const, excludePriorFailedBulkSends: false },
    };
    mockLookupAdmittedBulkCampaignReplay
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persistedReplay);
    const { createPreparedBulkCampaignTerminalReplayError } =
      jest.requireActual(
        "@/lib/campaign/queue-prepared-bulk-campaign-dispatch"
      ) as {
        createPreparedBulkCampaignTerminalReplayError: (input: {
          campaignId: string;
          dispatchStatus: "completed";
        }) => Error;
      };
    mockQueuePreparedBulkCampaignDispatchOverride.mockImplementation(() =>
      Promise.reject(
        createPreparedBulkCampaignTerminalReplayError({
          campaignId,
          dispatchStatus: "completed",
        })
      )
    );

    const idempotencyKey = "queue-race-completed-no-op";
    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey,
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      noOp: true,
      queued: false,
      requestedTotal: 1,
      successful: 0,
      skippedIneligible: 1,
      outcome: persistedReplay.result.outcome,
    });
    expect(mockCompleteLegacyIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        idempotencyKey,
        responseBody: payload,
      })
    );
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        workspaceId,
        disposition: "no_op",
        lifecycleStatus: "completed",
        idempotentReplay: true,
      })
    );
    expect(mockReleaseLegacyIdempotency).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toContain("+15550000002");
    expect(JSON.stringify(mockLoggerInfo.mock.calls[0]?.[1])).not.toContain(
      "+15550000002"
    );
  });

  it("maps a post-admission SQL replay digest mismatch to the stable payload conflict", async () => {
    const campaignId = "9f29e513-bf52-54f0-b63e-f1f23eef8f22";
    const { BulkCampaignAdmissionPayloadMismatchError } = jest.requireActual(
      "@/lib/campaign/bulk-campaign-admission"
    ) as {
      BulkCampaignAdmissionPayloadMismatchError: new (message: string) => Error;
    };
    mockLookupAdmittedBulkCampaignReplay
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(
        new BulkCampaignAdmissionPayloadMismatchError("request digest mismatch")
      );
    mockAdmitBulkCampaign.mockImplementationOnce(
      async (
        _client: unknown,
        admissionInput: {
          workflowId: string;
          requestedAt: string;
          dispatchExpiresAt: string;
          audience: { count: number; fingerprint: string };
        }
      ) => ({
        status: "admitted",
        campaignId,
        workflowId: admissionInput.workflowId,
        dispatchStatus: "running",
        requestedAt: admissionInput.requestedAt,
        dispatchExpiresAt: admissionInput.dispatchExpiresAt,
        audienceCount: admissionInput.audience.count,
        idempotentReplay: true,
        audienceFingerprint: admissionInput.audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 1,
          ratio: 0,
        },
      })
    );

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "post-admission-digest-mismatch",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "bulk_campaign_idempotency_payload_mismatch",
      error: "This idempotency key is already bound to a different request.",
      retryable: false,
    });
    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenCalledTimes(2);
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("persists the exact batch plan with immutable admission metadata for replay", async () => {
    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
    });

    expect(response.status).toBe(200);
    expect(
      mockAdmitBulkCampaign.mock.calls[0][1].audience.metadata
    ).toMatchObject({
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_throughput",
      },
      authoritativeRecipientLimit: {
        source: "cached_meta",
        value: 1000,
        rawLimit: "TIER_1K",
      },
      requestDigest: { version: 1, digest: "d".repeat(64) },
    });
  });

  it("returns an authenticated cache replay before mutable WhatsApp context or provenance", async () => {
    const privateReplayValues = [
      "+15559990001",
      "cached-private@example.com",
      "cached-chat-987654",
    ];
    const cachedResponse = {
      ok: true,
      outcome: {
        disposition: "queued",
        evaluatedAt: "2026-08-21T10:00:00.000Z",
        lifecycleStatus: "queued",
        requestedTotal: 1,
        acceptedTotal: 1,
        queuedTotal: 1,
        uniqueRecipients: { requested: 1, accepted: 1, queued: 1 },
        skippedByReason: {},
        warnings: { missingMarketingConsent: 0 },
        campaignId: "7a5dc671-e1f8-4a41-ae39-f01e929f1afd",
        dispatchId: "7a5dc671-e1f8-4a41-ae39-f01e929f1afd",
        workflowId: "workflow-existing",
      },
      marketingOptInWarningPhones: [privateReplayValues[0]],
      invalidRecipients: [privateReplayValues[1]],
      rawChatId: privateReplayValues[2],
      unknownIdentityEnvelope: {
        phone: privateReplayValues[0],
        email: privateReplayValues[1],
      },
    };
    const originalEventFacts = {
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "scenario_run_now",
      scenarioId: "scenario-original",
      rootNodeId: "root-original",
      itemCounts: { requested: 1, accepted: 1, queued: 1 },
      uniqueRecipientCounts: { requested: 1, accepted: 1, queued: 1 },
      skippedByReason: {},
      warnings: { missingMarketingConsent: 0 },
      disposition: "queued",
      lifecycleStatus: "queued",
      planLimit: { source: "live_meta", value: 250 },
      policy: { version: 1, excludePriorFailedBulkSends: true },
    };
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: cachedResponse,
      eventFacts: originalEventFacts,
    });
    mockEnsureCompanyConversationCapacity.mockRejectedValueOnce(
      new Error("conversation capacity must not run for a replay")
    );
    mockResolveWhatsAppSendContext.mockRejectedValueOnce(
      new Error("mutable WhatsApp context must not run for a replay")
    );
    mockScenarioFindOne.mockImplementationOnce(() => {
      throw new Error("Scenario provenance must not run for a replay");
    });

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "idem-existing-123",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.outcome).toMatchObject({
      campaignId: "7a5dc671-e1f8-4a41-ae39-f01e929f1afd",
      requestedTotal: 1,
      acceptedTotal: 1,
      queuedTotal: 1,
    });
    const serializedPayload = JSON.stringify(payload);
    for (const privateValue of privateReplayValues) {
      expect(serializedPayload).not.toContain(privateValue);
    }
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
    expect(payload).not.toHaveProperty("invalidRecipients");
    expect(payload).not.toHaveProperty("rawChatId");
    expect(payload).not.toHaveProperty("unknownIdentityEnvelope");
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        disposition: "queued",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        executionSource: "scenario_run_now",
        scenarioId: "scenario-original",
        rootNodeId: "root-original",
        planLimit: { source: "live_meta", value: 250 },
        policy: { version: 1, excludePriorFailedBulkSends: true },
        idempotentReplay: true,
      })
    );
  });

  it("strictly projects a response-only legacy cached replay without recipient identity fields", async () => {
    const privateReplayValues = [
      "987654321",
      "+15559990002",
      "legacy-private@example.com",
      "legacy-private-variable",
    ];
    const cachedResponse = {
      ok: true,
      outcome: {
        disposition: "no_op",
        evaluatedAt: "2026-08-21T10:00:00.000Z",
        lifecycleStatus: "completed",
        requestedTotal: 1,
        acceptedTotal: 0,
        queuedTotal: 0,
        uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
        skippedByReason: { ineligible: 1 },
        warnings: { missingMarketingConsent: 0 },
      },
      skippedRecipientDetails: [
        { reason: "telegram_ineligible", detail: privateReplayValues[0] },
      ],
      marketingOptInWarningPhones: [privateReplayValues[1]],
      invalidRecipients: [privateReplayValues[2]],
      rawChatId: privateReplayValues[0],
      variables: { name: privateReplayValues[3] },
    };
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: cachedResponse,
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "telegram",
      messageText: "Hello",
      recipients: [{ chatId: "current-request-chat" }],
      idempotencyKey: "telegram-legacy-detail-replay",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      outcome: {
        disposition: "no_op",
        skippedByReason: { ineligible: 1 },
      },
    });
    expect(payload).not.toHaveProperty("skippedRecipientDetails");
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
    expect(payload).not.toHaveProperty("invalidRecipients");
    expect(payload).not.toHaveProperty("rawChatId");
    expect(payload).not.toHaveProperty("variables");
    const serializedPayload = JSON.stringify(payload);
    for (const privateValue of privateReplayValues) {
      expect(serializedPayload).not.toContain(privateValue);
    }
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("marks response-only legacy replay facts unavailable instead of using the current request", async () => {
    const cachedResponse = {
      ok: true,
      outcome: {
        disposition: "no_op",
        evaluatedAt: "2026-08-20T10:00:00.000Z",
        lifecycleStatus: "completed",
        requestedTotal: 2,
        acceptedTotal: 0,
        queuedTotal: 0,
        uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
        skippedByReason: { ineligible: 2 },
        warnings: { missingMarketingConsent: 0 },
      },
    };
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: cachedResponse,
    });

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "current-request-must-not-be-logged",
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: true,
      },
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "legacy-response-only-replay",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: cachedResponse.outcome,
      noOp: true,
      queued: false,
      requestedTotal: 2,
      successful: 0,
      skippedRecipientCount: 2,
      skippedIneligible: 2,
    });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith("bulk_campaign.policy", {
      workspaceId,
      factsUnavailable: "legacy_response_only",
      itemCounts: { requested: 2, accepted: 0, queued: 0 },
      uniqueRecipientCounts: { requested: 1, accepted: 0, queued: 0 },
      skippedByReason: { ineligible: 2 },
      warnings: { missingMarketingConsent: 0 },
      disposition: "no_op",
      lifecycleStatus: "completed",
      idempotentReplay: true,
    });
    const event = mockLoggerInfo.mock.calls[0]?.[1];
    expect(event).not.toHaveProperty("channel");
    expect(event).not.toHaveProperty("executionSource");
    expect(event).not.toHaveProperty("planLimit");
    expect(event).not.toHaveProperty("policy");
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("replays a fixed scheduled command after its scheduled clock time", async () => {
    const cachedResponse = {
      ok: true,
      outcome: {
        disposition: "scheduled",
        evaluatedAt: "2026-08-20T10:00:00.000Z",
        lifecycleStatus: "scheduled",
        requestedTotal: 1,
        acceptedTotal: 1,
        queuedTotal: 1,
        uniqueRecipients: { requested: 1, accepted: 1, queued: 1 },
        skippedByReason: {},
        warnings: { missingMarketingConsent: 0 },
        campaignId: "7a5dc671-e1f8-4a41-ae39-f01e929f1afd",
        dispatchId: "7a5dc671-e1f8-4a41-ae39-f01e929f1afd",
        workflowId: "workflow-scheduled-existing",
      },
      scheduledAt: "2026-08-20T12:00:00.000Z",
    };
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: cachedResponse,
      eventFacts: {
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "scenario_run_now",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        uniqueRecipientCounts: { requested: 1, accepted: 1, queued: 1 },
        skippedByReason: {},
        warnings: { missingMarketingConsent: 0 },
        disposition: "scheduled",
        lifecycleStatus: "scheduled",
        planLimit: { source: "cached_meta", value: 1000 },
        policy: { version: 1, excludePriorFailedBulkSends: false },
      },
    });

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      scheduledAt: "2026-08-20T12:00:00.000Z",
      idempotencyKey: "past-fixed-schedule-replay",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: cachedResponse.outcome,
      queued: true,
      scheduled: true,
      scheduledAt: "2026-08-20T12:00:00.000Z",
      campaignId: "7a5dc671-e1f8-4a41-ae39-f01e929f1afd",
      dispatchId: "7a5dc671-e1f8-4a41-ae39-f01e929f1afd",
      workflowId: "workflow-scheduled-existing",
    });
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("fails closed on malformed completed idempotency state before live work", async () => {
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: { not: "a canonical bulk campaign result" },
    });
    await withSilencedConsoleError(async () => {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        idempotencyKey: "malformed-completed-cache",
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        code: "bulk_campaign_idempotency_unavailable",
        error: "Bulk campaign result could not be recovered safely. Retry.",
        retryable: true,
      });
      expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    });
  });

  it("fails closed on malformed completed replay event facts before live work", async () => {
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: {
        ok: true,
        outcome: {
          disposition: "no_op",
          evaluatedAt: "2026-08-21T10:00:00.000Z",
          lifecycleStatus: "completed",
          requestedTotal: 1,
          acceptedTotal: 0,
          queuedTotal: 0,
          uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
          skippedByReason: { ineligible: 1 },
          warnings: { missingMarketingConsent: 0 },
        },
      },
      eventFacts: { channel: "whatsapp" },
    });
    await withSilencedConsoleError(async () => {
      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        idempotencyKey: "malformed-completed-event-facts",
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        code: "bulk_campaign_idempotency_unavailable",
        error: "Bulk campaign result could not be recovered safely. Retry.",
        retryable: true,
      });
      expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
      expect(mockLoggerInfo).not.toHaveBeenCalled();
    });
  });

  it("fails closed when completed replay aggregate scalars contain recipient data", async () => {
    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: {
        ok: true,
        outcome: {
          disposition: "no_op",
          evaluatedAt: "2026-08-21T10:00:00.000Z",
          lifecycleStatus: "completed",
          requestedTotal: 1,
          acceptedTotal: 0,
          queuedTotal: 0,
          uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
          skippedByReason: { ineligible: 1 },
          warnings: { missingMarketingConsent: 0 },
        },
      },
      eventFacts: {
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "ad_hoc",
        itemCounts: {
          requested: "+15550000002",
          accepted: 0,
          queued: 0,
        },
        uniqueRecipientCounts: { requested: 1, accepted: 0, queued: 0 },
        skippedByReason: { ineligible: 1 },
        warnings: { missingMarketingConsent: 0 },
        disposition: "no_op",
        lifecycleStatus: "completed",
        planLimit: { source: "channel_default", value: 1000 },
        policy: { version: 1, excludePriorFailedBulkSends: false },
      },
    });

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "recipient-data-in-event-facts",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "bulk_campaign_idempotency_unavailable",
      error: "Bulk campaign result could not be recovered safely. Retry.",
      retryable: true,
    });
    expect(mockLoggerInfo).not.toHaveBeenCalled();
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("recovers an admitted pre-Temporal crash before exact cache-miss replay", async () => {
    const privateReplayValues = [
      "+15559990004",
      "sql-early-private@example.com",
      "sql-early-chat-987654",
    ];
    const persistedReplay = {
      campaignId: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
      workspaceId,
      result: {
        ok: true,
        outcome: {
          disposition: "queued",
          evaluatedAt: "2026-08-21T09:00:00.000Z",
          lifecycleStatus: "queued",
          requestedTotal: 4,
          acceptedTotal: 2,
          queuedTotal: 2,
          uniqueRecipients: { requested: 4, accepted: 2, queued: 2 },
          skippedByReason: { prior_failure: 1, marketing_opt_out: 1 },
          warnings: { missingMarketingConsent: 1 },
          campaignId: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
          dispatchId: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
          workflowId: "bulk-campaign-dispatch:persisted",
        },
        batchPlan: {
          batchSize: 5,
          delayMs: 1000,
          ratePerSecond: 5,
          rateSource: "live_meta_throughput",
        },
        recipientLimit: {
          originalCount: 3,
          acceptedCount: 2,
          rawLimit: "TIER_2",
          source: "live_meta",
          truncated: false,
        },
        marketingOptInWarningPhones: [privateReplayValues[0]],
        invalidRecipients: [privateReplayValues[1]],
        rawChatId: privateReplayValues[2],
      },
      batchPlan: {
        batchSize: 5,
        delayMs: 1000,
        ratePerSecond: 5,
        rateSource: "live_meta_throughput",
      },
      dispatchStatus: "queued",
      requestedAt: "2026-08-21T09:00:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2026-08-21T09:15:00.000Z",
      totalRecipients: 2,
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      scenarioId: null,
      rootNodeId: null,
      planLimit: { source: "live_meta", value: 2 },
      policy: { version: 1, excludePriorFailedBulkSends: true },
    };
    mockLookupAdmittedBulkCampaignReplay.mockResolvedValueOnce(persistedReplay);
    mockResolveWhatsAppSendContext.mockRejectedValueOnce(
      new Error("current source is unavailable")
    );

    const response = await postBulkSend({
      workspaceId,
      channel: "whatsapp",
      templateName: "now-broken",
      recipients: [{ phone: "+15550000009" }],
      excludePriorFailedBulkSends: false,
      idempotencyKey: "admitted-replay-123",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.outcome).toEqual(
      expect.objectContaining({
        evaluatedAt: "2026-08-21T09:00:00.000Z",
        requestedTotal: 4,
        acceptedTotal: 2,
        queuedTotal: 2,
        skippedByReason: { prior_failure: 1, marketing_opt_out: 1 },
        warnings: { missingMarketingConsent: 1 },
        workflowId: "bulk-campaign-dispatch:persisted",
      })
    );
    expect(payload.batchPlan).toEqual({
      batchSize: 5,
      delayMs: 1000,
      ratePerSecond: 5,
      rateSource: "live_meta_throughput",
    });
    expect(payload.message).toBe(
      "Campaign queued in Temporal. Messages will be sent in the background. Check campaign history for delivery status."
    );
    expect(payload.recipientLimit).toEqual({
      originalCount: 3,
      acceptedCount: 2,
      rawLimit: "TIER_2",
      source: "live_meta",
      truncated: false,
    });
    expect(payload).not.toHaveProperty("marketingOptInWarningPhones");
    expect(payload).not.toHaveProperty("invalidRecipients");
    expect(payload).not.toHaveProperty("rawChatId");
    const serializedPayload = JSON.stringify(payload);
    for (const privateValue of privateReplayValues) {
      expect(serializedPayload).not.toContain(privateValue);
    }
    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenCalledWith({
      client: expect.anything(),
      campaignId: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
      workspaceId,
      sentBy: "user-1",
      requestDigest: { version: 1, digest: "d".repeat(64) },
    });
    expect(mockEnsureAdmittedBulkCampaignReplayStarted).toHaveBeenCalledWith({
      storeClient: expect.anything(),
      replay: persistedReplay,
    });
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bulk_campaign.policy",
      expect.objectContaining({
        warnings: { missingMarketingConsent: 1 },
        planLimit: { source: "live_meta", value: 2 },
        policy: { version: 1, excludePriorFailedBulkSends: true },
        idempotentReplay: true,
      })
    );
  });

  it.each(["failed", "expired", "cancelled", "completed"] as const)(
    "never reconstructs a queued success from an admitted replay that is already %s",
    async dispatchStatus => {
      const campaignId = "9f29e513-bf52-54f0-b63e-f1f23eef8f22";
      const persistedReplay = {
        campaignId,
        workspaceId,
        result: {
          ok: true,
          outcome: {
            disposition: "queued",
            evaluatedAt: "2026-08-21T09:00:00.000Z",
            lifecycleStatus: "queued",
            requestedTotal: 3,
            acceptedTotal: 1,
            queuedTotal: 1,
            uniqueRecipients: { requested: 3, accepted: 1, queued: 1 },
            skippedByReason: { prior_failure: 2 },
            warnings: { missingMarketingConsent: 0 },
            campaignId,
            dispatchId: campaignId,
            workflowId: "bulk-campaign-dispatch:persisted",
          },
        },
        batchPlan: {
          batchSize: 5,
          delayMs: 1_000,
          ratePerSecond: 5,
          rateSource: "cached_meta_throughput",
        },
        dispatchStatus,
        requestedAt: "2026-08-21T09:00:00.000Z",
        scheduledAt: null,
        dispatchExpiresAt: "2026-08-21T09:15:00.000Z",
        totalRecipients: 1,
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "ad_hoc",
        scenarioId: null,
        rootNodeId: null,
        planLimit: { source: "cached_meta", value: 1 },
        policy: { version: 1, excludePriorFailedBulkSends: false },
      };
      mockLookupAdmittedBulkCampaignReplay.mockResolvedValueOnce(
        persistedReplay
      );
      mockEnsureAdmittedBulkCampaignReplayStarted.mockResolvedValueOnce({
        workflowStart: {
          status: "terminal",
          dispatchStatus,
          temporalDispatchStaging: "existing",
        },
        admittedItems: [],
        requestedAt: persistedReplay.requestedAt,
        scheduledAt: persistedReplay.scheduledAt,
        dispatchExpiresAt: persistedReplay.dispatchExpiresAt,
      });

      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        idempotencyKey: `terminal-sql-replay-${dispatchStatus}`,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "bulk_campaign_terminal_replay",
        error: `This campaign is already ${dispatchStatus} and cannot be queued again.`,
        retryable: false,
        campaignId,
        dispatchId: campaignId,
      });
      expect(mockCompleteLegacyIdempotency).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith("bulk_campaign.policy", {
        workspaceId,
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "ad_hoc",
        itemCounts: { requested: 3, accepted: 1, queued: 0 },
        uniqueRecipientCounts: { requested: 3, accepted: 1, queued: 0 },
        skippedByReason: { prior_failure: 2 },
        warnings: { missingMarketingConsent: 0 },
        disposition: "blocked",
        lifecycleStatus: dispatchStatus,
        planLimit: { source: "cached_meta", value: 1 },
        policy: { version: 1, excludePriorFailedBulkSends: false },
        errorCode: "bulk_campaign_terminal_replay",
        idempotentReplay: true,
      });
      expect(JSON.stringify(mockLoggerInfo.mock.calls[0]?.[1])).not.toContain(
        "+15550000002"
      );
      expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    }
  );

  it("preserves an exact completed no-op admitted replay", async () => {
    const persistedReplay = {
      campaignId: "9f29e513-bf52-54f0-b63e-f1f23eef8f22",
      workspaceId,
      result: {
        ok: true,
        outcome: {
          disposition: "no_op",
          evaluatedAt: "2026-08-21T09:00:00.000Z",
          lifecycleStatus: "completed",
          requestedTotal: 1,
          acceptedTotal: 0,
          queuedTotal: 0,
          uniqueRecipients: { requested: 1, accepted: 0, queued: 0 },
          skippedByReason: { ineligible: 1 },
          warnings: { missingMarketingConsent: 0 },
        },
      },
      batchPlan: {
        batchSize: 5,
        delayMs: 1_000,
        ratePerSecond: 5,
        rateSource: "cached_meta_throughput",
      },
      dispatchStatus: "completed",
      requestedAt: "2026-08-21T09:00:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2026-08-21T09:15:00.000Z",
      totalRecipients: 1,
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      scenarioId: null,
      rootNodeId: null,
      planLimit: { source: "cached_meta", value: 1 },
      policy: { version: 1, excludePriorFailedBulkSends: false },
    };
    mockLookupAdmittedBulkCampaignReplay.mockResolvedValueOnce(persistedReplay);
    mockEnsureAdmittedBulkCampaignReplayStarted.mockResolvedValueOnce({
      workflowStart: {
        status: "terminal",
        dispatchStatus: "completed",
        temporalDispatchStaging: "existing",
      },
      admittedItems: [],
      requestedAt: persistedReplay.requestedAt,
      scheduledAt: persistedReplay.scheduledAt,
      dispatchExpiresAt: persistedReplay.dispatchExpiresAt,
    });

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "completed-no-op-sql-replay",
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      outcome: persistedReplay.result.outcome,
      noOp: true,
      queued: false,
      requestedTotal: 1,
      successful: 0,
      skippedRecipientCount: 1,
      skippedIneligible: 1,
    });
    expect(mockCompleteLegacyIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({ responseBody: payload })
    );
  });

  it("maps an authenticated SQL replay digest mismatch to the stable payload conflict", async () => {
    const { BulkCampaignAdmissionPayloadMismatchError } = jest.requireActual(
      "@/lib/campaign/bulk-campaign-admission"
    ) as {
      BulkCampaignAdmissionPayloadMismatchError: new (message: string) => Error;
    };
    mockLookupAdmittedBulkCampaignReplay.mockRejectedValueOnce(
      new BulkCampaignAdmissionPayloadMismatchError("request digest mismatch")
    );

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "sql-replay-payload-mismatch",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "bulk_campaign_idempotency_payload_mismatch",
      error: "This idempotency key is already bound to a different request.",
      retryable: false,
    });
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
  });

  it("maps the atomic SQL admission digest guard to the stable payload conflict", async () => {
    const { BulkCampaignAdmissionPayloadMismatchError } = jest.requireActual(
      "@/lib/campaign/bulk-campaign-admission"
    ) as {
      BulkCampaignAdmissionPayloadMismatchError: new (
        message: string,
        code?: string
      ) => Error;
    };
    mockAdmitBulkCampaign.mockRejectedValueOnce(
      new BulkCampaignAdmissionPayloadMismatchError(
        "campaign request digest identity does not match the admitted dispatch",
        "22000"
      )
    );

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "sql-admission-payload-mismatch",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "bulk_campaign_idempotency_payload_mismatch",
      error: "This idempotency key is already bound to a different request.",
      retryable: false,
    });
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it.each(["query error", "malformed existing row"])(
    "fails closed on an authenticated admitted replay %s without live fallthrough",
    async label => {
      const { BulkCampaignAdmissionUnavailableError } = jest.requireActual(
        "@/lib/campaign/bulk-campaign-admission"
      ) as {
        BulkCampaignAdmissionUnavailableError: new (message: string) => Error;
      };
      mockLookupAdmittedBulkCampaignReplay.mockRejectedValueOnce(
        new BulkCampaignAdmissionUnavailableError(label)
      );

      const response = await postPromo({
        recipients: [{ phone: "+15550000002" }],
        idempotencyKey: `admitted-replay-${label.replaceAll(" ", "-")}`,
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        code: "bulk_campaign_idempotency_unavailable",
        error: "Bulk campaign result could not be recovered safely. Retry.",
        retryable: true,
      });
      expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
      expect(mockScenarioFindOne).not.toHaveBeenCalled();
      expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
      expect(mockConversationFind).not.toHaveBeenCalled();
      expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
      expect(mockLoggerInfo).not.toHaveBeenCalled();
    }
  );

  it("stores and exactly replays a successful no-op before it can later queue", async () => {
    let cachedNoOp: Record<string, unknown> | null = null;
    let cachedEventFacts: Record<string, unknown> | null = null;
    mockCompleteLegacyIdempotency.mockImplementationOnce(
      async ({
        responseBody,
        eventFacts,
      }: {
        responseBody: Record<string, unknown>;
        eventFacts: Record<string, unknown>;
      }) => {
        cachedNoOp = structuredClone(responseBody);
        cachedEventFacts = structuredClone(eventFacts);
        return true;
      }
    );
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }: { recipients: unknown[] }) => ({
        recipients: [],
        skippedRecipients: recipients,
        skippedOptIn: recipients.length,
        skippedPhones: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningRecipients: [],
        marketingOptInWarningPhones: [],
      })
    );
    const buildRequest = () =>
      bulkSendRequest(
        promoBody({
          recipients: [{ phone: "+15550000002" }],
          idempotencyKey: "no-op-exact-replay-123",
        })
      );

    const first = await POST(buildRequest());
    const firstPayload = await first.json();
    expect(first.status).toBe(200);
    expect(firstPayload.outcome.disposition).toBe("no_op");
    expect(cachedNoOp).toEqual(firstPayload);
    expect(cachedEventFacts).toEqual(
      expect.objectContaining({
        disposition: "no_op",
        lifecycleStatus: "completed",
      })
    );
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();

    mockReserveLegacyIdempotency.mockResolvedValueOnce({
      status: "completed",
      responseBody: cachedNoOp,
      eventFacts: cachedEventFacts,
    });
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
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
    const second = await POST(buildRequest());
    const secondPayload = await second.json();

    expect(second.status).toBe(200);
    expect(secondPayload).toEqual(firstPayload);
    expectNothingDispatched();
  });

  it("fails closed when an idempotent no-op cannot be cached", async () => {
    mockCompleteLegacyIdempotency.mockResolvedValueOnce(false);
    mockFilterKnownMarketingOptOutRecipients.mockImplementationOnce(
      async ({ recipients }: { recipients: unknown[] }) => ({
        recipients: [],
        skippedRecipients: recipients,
        skippedOptIn: recipients.length,
        skippedPhones: [],
        marketingOptInWarningCount: 0,
        marketingOptInWarningRecipients: [],
        marketingOptInWarningPhones: [],
      })
    );

    const response = await postPromo({
      recipients: [{ phone: "+15550000002" }],
      idempotencyKey: "no-op-cache-failure-123",
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      code: "bulk_campaign_idempotency_unavailable",
      error: "Bulk campaign result could not be committed safely. Retry.",
      retryable: true,
    });
    expect(mockCompleteLegacyIdempotency).toHaveBeenCalledTimes(1);
    expect(mockReleaseLegacyIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        userId: "user-1",
        idempotencyKey: "no-op-cache-failure-123",
        reservationToken: "legacy-owner-token",
      })
    );
    expectNothingDispatched();
  });
});
