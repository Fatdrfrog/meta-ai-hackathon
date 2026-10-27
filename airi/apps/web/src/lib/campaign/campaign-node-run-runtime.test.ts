const mockBuildCampaignAudienceQueryDefinition = jest.fn();
const mockBuildCampaignAudienceQueryWithFollowUpPrediction = jest.fn();
const mockFindBirthdayAudiencePage = jest.fn();
const mockParseCampaignAudienceFilterParam = jest.fn();
const mockResolveCampaignBatchPlan = jest.fn();
const mockResolveCampaignBatchPlanPreview = jest.fn();
const mockConnectDB = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockResolveTelegramSendContext = jest.fn();
const mockCreateCampaignHistoryRecord = jest.fn();
const mockFindCampaignHistoryRunReservation = jest.fn();
const mockUpdateCampaignHistoryRecipientCount = jest.fn();
const mockCampaignDeliveryTaskBulkWrite = jest.fn();
const mockCampaignDeliveryTaskFind = jest.fn();
const mockCampaignDeliveryTaskFindOne = jest.fn();
const mockCampaignDeliveryTaskCountDocuments = jest.fn();
const mockConversationFind = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockEnsureCompanyConversationCapacity = jest.fn();
const mockEvaluateRecipientPolicy = jest.fn();
const mockVerifyScheduleCapability = jest.fn();
const mockRouteScheduleProvenance = jest.fn();
const mockReadScheduleContext = jest.fn();
const mockEmitBulkCampaignPolicyEvent = jest.fn();
const mockResolveMinimumBulkCampaignPlan = jest.fn();
const mockCampaignNodeRunLoggerInfo = jest.fn();

jest.mock("@/lib/campaign/campaign-audience", () => ({
  buildCampaignAudienceQueryDefinition: (...args: unknown[]) =>
    mockBuildCampaignAudienceQueryDefinition(...args),
  parseCampaignAudienceFilterParam: (...args: unknown[]) =>
    mockParseCampaignAudienceFilterParam(...args),
  resolveFollowUpStatusesForBulkCampaign: jest.fn(() => []),
}));

jest.mock("@/lib/campaign/campaign-audience-follow-up", () => ({
  buildCampaignAudienceQueryWithFollowUpPrediction: (...args: unknown[]) =>
    mockBuildCampaignAudienceQueryWithFollowUpPrediction(...args),
}));

jest.mock("@/lib/campaign/campaign-birthday-audience", () => ({
  findBirthdayAudiencePage: (...args: unknown[]) =>
    mockFindBirthdayAudiencePage(...args),
}));

jest.mock("@/lib/campaign/campaign-batch-plan", () => ({
  ...jest.requireActual("@/lib/campaign/campaign-batch-plan"),
  resolveCampaignBatchPlan: (...args: unknown[]) =>
    mockResolveCampaignBatchPlan(...args),
  resolveCampaignBatchPlanPreview: (...args: unknown[]) =>
    mockResolveCampaignBatchPlanPreview(...args),
}));

jest.mock("@/lib/campaign/campaign-config", () => ({
  isCampaignEmailBatchEnabled: jest.fn(() => false),
}));

jest.mock("@/lib/campaign/campaign-delivery", () => ({
  buildCampaignDeliveryIdempotencyKey: (parts: unknown[]) =>
    parts.map(part => String(part)).join(":"),
}));

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  createCampaignHistoryRecord: (...args: unknown[]) =>
    mockCreateCampaignHistoryRecord(...args),
  findCampaignHistoryRunReservation: (...args: unknown[]) =>
    mockFindCampaignHistoryRunReservation(...args),
  updateCampaignHistoryRecipientCount: (...args: unknown[]) =>
    mockUpdateCampaignHistoryRecipientCount(...args),
}));

jest.mock("@/lib/campaign/campaign-transport", () => ({
  getCampaignTransportCapabilities: (channel: string) => ({
    channel,
    provider:
      channel === "whatsapp"
        ? "meta"
        : channel === "telegram"
          ? "telegram"
          : "postmark",
    supportsBatch: false,
  }),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: jest.fn(),
  isManagedEmailProviderPending: jest.fn(() => false),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE:
    "company_conversation_limit_exceeded",
  COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE:
    "company_bulk_campaign_limit_exceeded",
  ensureCompanyConversationCapacity: (...args: unknown[]) =>
    mockEnsureCompanyConversationCapacity(...args),
  getBulkRecipientsRemaining: (limit: {
    bulkRecipientLimit: number | null;
    bulkRecipientsRemaining?: number | null;
  }) =>
    limit.bulkRecipientLimit === null
      ? null
      : (limit.bulkRecipientsRemaining ?? 0),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/lib/telegram/source-context", () => ({
  resolveTelegramSendContext: (...args: unknown[]) =>
    mockResolveTelegramSendContext(...args),
}));

jest.mock("@/models/campaign-delivery-task", () => ({
  __esModule: true,
  default: {
    bulkWrite: (...args: unknown[]) =>
      mockCampaignDeliveryTaskBulkWrite(...args),
    find: (...args: unknown[]) => mockCampaignDeliveryTaskFind(...args),
    findOne: (...args: unknown[]) => mockCampaignDeliveryTaskFindOne(...args),
    countDocuments: (...args: unknown[]) =>
      mockCampaignDeliveryTaskCountDocuments(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));

jest.mock("./bulk-recipient-policy", () => {
  const actual = jest.requireActual("./bulk-recipient-policy") as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    evaluateBulkRecipientPolicy: (...args: unknown[]) =>
      mockEvaluateRecipientPolicy(...args),
  };
});

jest.mock("./bulk-campaign-provenance", () => ({
  verifyBulkCampaignScenarioScheduleCapability: (...args: unknown[]) =>
    mockVerifyScheduleCapability(...args),
  routeVerifiedBulkCampaignScenarioScheduleProvenance: (...args: unknown[]) =>
    mockRouteScheduleProvenance(...args),
  readVerifiedBulkCampaignScenarioScheduleContext: (...args: unknown[]) =>
    mockReadScheduleContext(...args),
}));

jest.mock("./bulk-campaign-observability", () => ({
  emitBulkCampaignPolicyEvent: (...args: unknown[]) =>
    mockEmitBulkCampaignPolicyEvent(...args),
}));

jest.mock("./bulk-campaign-recipient-eligibility", () => {
  const actual = jest.requireActual(
    "./bulk-campaign-recipient-eligibility"
  ) as Record<string, unknown>;
  return {
    ...actual,
    resolveMinimumBulkCampaignPlan: (...args: unknown[]) =>
      mockResolveMinimumBulkCampaignPlan(...args),
  };
});

jest.mock("@/lib/observability/server-logs", () => {
  const actual = jest.requireActual("@/lib/observability/server-logs") as {
    createServerLogger: (scope: string) => unknown;
  };
  return {
    ...actual,
    // Observe the node-run logger; every other scope keeps the real one.
    createServerLogger: (scope: string) =>
      scope === "campaign-node-run"
        ? {
            info: (...args: unknown[]) =>
              mockCampaignNodeRunLoggerInfo(...args),
            warn: jest.fn(),
            error: jest.fn(),
          }
        : actual.createServerLogger(scope),
  };
});

import { Types } from "mongoose";
import {
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
} from "@icecore/scenario-contracts";
import { BulkRecipientPolicyError } from "./bulk-recipient-policy";
import {
  hashBulkCampaignRecipientIdentity,
  canonicalizeBulkCampaignRecipientIdentity,
} from "./bulk-campaign-safety";
import {
  executeCampaignNodeRun,
  type CampaignNodeRunRuntimeDependencies,
} from "./campaign-node-run-runtime";

function leanQuery<T>(value: T) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

function selectedLeanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function paginatedConversationQuery<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function resetExecuteCampaignNodeRunMocks() {
  jest.clearAllMocks();
  mockConnectDB.mockResolvedValue(undefined);
  mockEnsureCompanyConversationCapacity.mockResolvedValue({
    allowed: true,
    limit: {
      bulkRecipientLimit: 500,
      bulkRecipientsRemaining: 500,
      subscriptionType: "free",
    },
  });
  mockParseCampaignAudienceFilterParam.mockReturnValue(null);
  mockBuildCampaignAudienceQueryDefinition.mockReturnValue({
    eligibleQuery: { workspaceId: "workspace-1", channel: "whatsapp" },
    audienceSource: "dynamic",
  });
  mockBuildCampaignAudienceQueryWithFollowUpPrediction.mockResolvedValue({
    eligibleQuery: {
      workspaceId: "workspace-1",
      channel: "whatsapp",
      "followUpAudience.status": { $in: ["ready_now"] },
    },
    audienceSource: "dynamic",
  });
  mockFindBirthdayAudiencePage.mockResolvedValue({
    recipients: [],
    candidateCount: 0,
    skippedMarketingOptIn: 0,
    nextCursor: null,
  });
  mockResolveWhatsAppSendContext.mockResolvedValue({
    phoneNumberId: "phone-number-id",
    accessToken: "access-token",
  });
  mockResolveTelegramSendContext.mockResolvedValue({
    sourceId: "source-1",
    botToken: "bot-token",
  });
  mockResolveCampaignBatchPlan.mockResolvedValue({
    batchSize: 20,
    delayMs: 250,
    ratePerSecond: 80,
    rateSource: "meta_default_throughput",
  });
  mockResolveCampaignBatchPlanPreview.mockResolvedValue({
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
    },
    recipientLimit: {
      maxRecipients: 250,
      rawLimit: "250",
      source: "live_meta",
    },
  });
  mockCreateCampaignHistoryRecord.mockResolvedValue({
    status: "ready",
    campaignId: "campaign-1",
    created: true,
  });
  mockFindCampaignHistoryRunReservation.mockResolvedValue(null);
  mockUpdateCampaignHistoryRecipientCount.mockResolvedValue(undefined);
  mockCampaignDeliveryTaskBulkWrite.mockResolvedValue({ upsertedCount: 1 });
  mockCampaignDeliveryTaskFind.mockReturnValue(leanQuery([]));
  mockCampaignDeliveryTaskFindOne.mockReturnValue(selectedLeanQuery(null));
  mockCampaignDeliveryTaskCountDocuments.mockResolvedValue(1);
  mockConversationFind.mockReturnValue(paginatedConversationQuery([]));
  process.env.ENCRYPTION_SECRET = "test-campaign-hmac-secret";
  mockReadScheduleContext.mockReturnValue({
    rootNodeId: "bulk-root",
    recipientPolicy: { version: 1, excludePriorFailedBulkSends: false },
  });
  mockVerifyScheduleCapability.mockResolvedValue(Object.freeze({}));
  mockRouteScheduleProvenance.mockImplementation(
    (_capability: unknown, recipients: Array<{ stableId: string }>) => ({
      kind: "scenario_schedule",
      rootNodeId: "bulk-root",
      routes: recipients.map(recipient => ({
        recipientStableId: recipient.stableId,
        actionNodeId: "node-1",
        channel: "whatsapp",
        sourceId: "source-1",
        template: {
          name: "promo",
          language: "en",
          category: "MARKETING",
          components: [],
        },
      })),
    })
  );
  mockEvaluateRecipientPolicy.mockImplementation(
    async (input: { candidates: Array<{ stableId: string }> }) => ({
      retained: input.candidates,
      excluded: [],
      skippedByReason: {},
      warnings: { missingMarketingConsent: 0 },
      uniqueRecipients: {
        requested: input.candidates.length,
        accepted: input.candidates.length,
      },
    })
  );
  mockResolveMinimumBulkCampaignPlan.mockImplementation(
    async (input: {
      resolvePlan: (params: { sourceId: string }) => Promise<unknown>;
      sourceIds: string[];
    }) => {
      const firstSourceId = input.sourceIds[0] || "source-1";
      return input.resolvePlan({ sourceId: firstSourceId });
    }
  );
}

describe("executeCampaignNodeRun WhatsApp template category", () => {
  beforeEach(() => {
    resetExecuteCampaignNodeRunMocks();
  });

  it("keeps an empty scheduled audience terminal on replay", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );
    mockFindCampaignHistoryRunReservation.mockResolvedValue({
      campaignId: "campaign-empty",
      channel: "whatsapp",
      stopReason: "empty_audience",
      bulkQuotaReservedAt: null,
    });

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      executionSource: "scenario_schedule",
    });

    expect(result).toEqual(
      expect.objectContaining({ status: "skipped", reason: "empty_audience" })
    );
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskBulkWrite).not.toHaveBeenCalled();
  });

  it("releases a provisional scheduled reservation when replay skips before task creation", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const scheduledFor = "2099-05-15T10:00:00.000Z";
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "inactive",
        timezone: "UTC",
        nodes: [{ id: "node-1", data: {} }],
        edges: [],
      })
    );
    mockFindCampaignHistoryRunReservation.mockResolvedValue({
      campaignId: "campaign-provisional",
      channel: "whatsapp",
      stopReason: null,
      bulkQuotaReservedAt: "2099-05-15T09:59:59.000Z",
    });

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      scheduledFor,
      executionSource: "scenario_schedule",
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "scenario_not_active",
      })
    );
    expect(mockUpdateCampaignHistoryRecipientCount).toHaveBeenCalledWith({
      supabase: {},
      workspaceId: "workspace-1",
      campaignId: "campaign-provisional",
      channel: "whatsapp",
      totalRecipients: 0,
      scenarioId,
      scenarioNodeId: "node-1",
      executionSource: "scenario_schedule",
      executionRunKey: `scheduled:${scheduledFor}`,
    });
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskBulkWrite).not.toHaveBeenCalled();
  });

  it("releases a provisional run-now reservation after provider configuration changes", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );
    mockFindCampaignHistoryRunReservation.mockResolvedValue({
      campaignId: "campaign-provisional",
      channel: "whatsapp",
      stopReason: null,
      bulkQuotaReservedAt: "2099-05-15T09:59:59.000Z",
    });
    mockResolveWhatsAppSendContext.mockResolvedValue(null);

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      executionSource: "scenario_run_now",
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "missing_whatsapp_credentials",
      })
    );
    expect(mockUpdateCampaignHistoryRecipientCount).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase: {},
        workspaceId: "workspace-1",
        campaignId: "campaign-provisional",
        channel: "whatsapp",
        totalRecipients: 0,
        scenarioId,
        scenarioNodeId: "node-1",
        executionSource: "scenario_run_now",
        executionRunKey: expect.any(String),
      })
    );
    expect(mockEnsureCompanyConversationCapacity).not.toHaveBeenCalled();
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskBulkWrite).not.toHaveBeenCalled();
  });

  it("resumes the original campaign when recipient-count persistence fails after task insertion", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId();
    const scheduledFor = "2099-05-15T10:00:00.000Z";
    let persistedTask: {
      campaignId: string;
      status: "pending";
      workspaceId: string;
    } | null = null;

    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: "MARKETING",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );
    mockConversationFind.mockReturnValue(
      paginatedConversationQuery([
        { _id: conversationId, user: "+15550000001", sourceId: "source-1" },
      ])
    );
    let historyCreateCount = 0;
    mockCreateCampaignHistoryRecord.mockImplementation(async () => ({
      status: "ready",
      campaignId:
        historyCreateCount++ === 0 ? "campaign-original" : "campaign-duplicate",
      created: true,
    }));
    mockCampaignDeliveryTaskFindOne.mockImplementation(() =>
      selectedLeanQuery(
        persistedTask ? { campaignId: persistedTask.campaignId } : null
      )
    );
    mockCampaignDeliveryTaskBulkWrite.mockImplementation(
      async (
        operations: Array<{
          updateOne?: {
            update?: {
              $setOnInsert?: { campaignId?: string };
            };
          };
        }>
      ) => {
        if (persistedTask) return { upsertedCount: 0 };
        const campaignId =
          operations[0]?.updateOne?.update?.$setOnInsert?.campaignId;
        if (!campaignId) {
          throw new Error("Test task is missing its campaign ID");
        }
        persistedTask = {
          campaignId,
          status: "pending",
          workspaceId: "workspace-1",
        };
        return { upsertedCount: 1 };
      }
    );
    mockCampaignDeliveryTaskCountDocuments.mockImplementation(async () =>
      persistedTask ? 1 : 0
    );
    mockUpdateCampaignHistoryRecipientCount
      .mockRejectedValueOnce(new Error("recipient total write failed"))
      .mockResolvedValueOnce(undefined);

    const input = {
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      scheduledFor,
      executionSource: "scenario_schedule" as const,
    };

    await expect(executeCampaignNodeRun(input)).rejects.toThrow(
      "recipient total write failed"
    );
    const resumed = await executeCampaignNodeRun(input);

    expect(resumed).toEqual(
      expect.objectContaining({
        campaignId: "campaign-original",
        created: 0,
        pendingCount: 1,
      })
    );
    expect(mockCreateCampaignHistoryRecord).toHaveBeenCalledTimes(1);
    expect(mockCreateCampaignHistoryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        companyBulkCampaignLimit: 500,
        companySubscriptionType: "free",
      })
    );
    expect(mockEnsureCompanyConversationCapacity).toHaveBeenCalledTimes(1);
    expect(mockUpdateCampaignHistoryRecipientCount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        campaignId: "campaign-original",
        totalRecipients: 1,
      })
    );
  });

  it("resumes the reserved campaign when task insertion failed before the first task", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId();
    const scheduledFor = "2099-05-15T10:00:00.000Z";
    let reservedCampaignId: string | null = null;
    let taskInserted = false;

    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: "MARKETING",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );
    mockConversationFind.mockReturnValue(
      paginatedConversationQuery([
        { _id: conversationId, user: "+15550000001", sourceId: "source-1" },
      ])
    );
    mockFindCampaignHistoryRunReservation.mockImplementation(async () =>
      reservedCampaignId
        ? {
            campaignId: reservedCampaignId,
            channel: "whatsapp",
            stopReason: null,
            bulkQuotaReservedAt: "2099-05-15T09:59:59.000Z",
          }
        : null
    );
    mockCreateCampaignHistoryRecord.mockImplementation(async () => {
      reservedCampaignId = "campaign-original";
      return {
        status: "ready",
        campaignId: reservedCampaignId,
        created: true,
      };
    });
    mockCampaignDeliveryTaskBulkWrite
      .mockRejectedValueOnce(new Error("task insert failed"))
      .mockImplementationOnce(async () => {
        taskInserted = true;
        return { upsertedCount: 1 };
      });
    mockCampaignDeliveryTaskCountDocuments.mockImplementation(async () =>
      taskInserted ? 1 : 0
    );

    const input = {
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      scheduledFor,
      executionSource: "scenario_schedule" as const,
    };

    await expect(executeCampaignNodeRun(input)).rejects.toThrow(
      "task insert failed"
    );
    const resumed = await executeCampaignNodeRun(input);

    expect(resumed).toEqual(
      expect.objectContaining({
        campaignId: "campaign-original",
        created: 1,
        pendingCount: 1,
      })
    );
    expect(mockCreateCampaignHistoryRecord).toHaveBeenCalledTimes(1);
    expect(mockEnsureCompanyConversationCapacity).toHaveBeenCalledTimes(1);
    expect(mockUpdateCampaignHistoryRecipientCount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        campaignId: "campaign-original",
        totalRecipients: 1,
      })
    );
  });

  it("persists MARKETING category on scheduled WhatsApp delivery tasks", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId();
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "Asia/Qyzylorda",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: "MARKETING",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );
    mockConversationFind.mockReturnValue(
      paginatedConversationQuery([
        { _id: conversationId, user: "+15550000001", sourceId: "source-1" },
      ])
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      executionSource: "scenario_schedule",
    });

    expect(result.status).toBe("materialized");
    expect(mockCampaignDeliveryTaskBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            update: expect.objectContaining({
              $setOnInsert: expect.objectContaining({
                templateName: "promo",
                templateLanguage: "en",
                templateCategory: "MARKETING",
              }),
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("uses scheduledFor for run keys, dispatch time, and task metadata", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId();
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: "MARKETING",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );
    mockConversationFind.mockReturnValue(
      paginatedConversationQuery([
        { _id: conversationId, user: "+15550000001", sourceId: "source-1" },
      ])
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      scheduleId: "campaign-node:workspace-1:scenario-1:node-1",
      scheduledFor: "2099-05-15T10:00:00.000Z",
      executionSource: "scenario_schedule",
    });

    expect(result.runKey).toBe("scheduled:2099-05-15T10:00:00.000Z");
    expect(mockCampaignDeliveryTaskFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        executionSource: "scenario_schedule",
        runKey: "scheduled:2099-05-15T10:00:00.000Z",
      })
    );
    expect(mockCampaignDeliveryTaskCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        executionSource: "scenario_schedule",
        runKey: "scheduled:2099-05-15T10:00:00.000Z",
        campaignId: "campaign-1",
      })
    );
    expect(mockBuildCampaignAudienceQueryDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        now: new Date("2099-05-15T10:00:00.000Z"),
      })
    );
    expect(mockCampaignDeliveryTaskBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: {
              executionSource: "scenario_schedule",
              idempotencyKey: `${scenarioId}:node-1:${conversationId.toString()}:scheduled:2099-05-15T10:00:00.000Z`,
            },
            update: expect.objectContaining({
              $setOnInsert: expect.objectContaining({
                idempotencyKey: `${scenarioId}:node-1:${conversationId.toString()}:scheduled:2099-05-15T10:00:00.000Z`,
                scheduleId: "campaign-node:workspace-1:scenario-1:node-1",
                scheduledFor: new Date("2099-05-15T10:00:00.000Z"),
                runKey: "scheduled:2099-05-15T10:00:00.000Z",
                dispatchAt: new Date("2099-05-15T10:00:00.000Z"),
                dispatchExpiresAt: new Date("2099-05-15T10:15:00.000Z"),
              }),
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("uses the live cached follow-up audience path for dynamic follow-up sends", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId();
    mockParseCampaignAudienceFilterParam.mockReturnValue(
      "follow_up_prediction"
    );
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        bulkFollowUpSettings: { preferFollowUpProjection: true },
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: "MARKETING",
              targetingMode: "dynamic",
              audienceFilter: "follow_up_prediction",
            },
          },
        ],
        edges: [],
      })
    );
    mockConversationFind.mockReturnValue(
      paginatedConversationQuery([
        { _id: conversationId, user: "+15550000001", sourceId: "source-1" },
      ])
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      executionSource: "scenario_schedule",
    });

    expect(result.status).toBe("materialized");
    expect(
      mockBuildCampaignAudienceQueryWithFollowUpPrediction
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        nodeId: "node-1",
        bypassFollowUpCache: false,
      })
    );
    expect(
      mockBuildCampaignAudienceQueryWithFollowUpPrediction.mock.calls[0]?.[0]
    ).not.toHaveProperty("followUpSource");
  });

  it("materializes birthday bulk roots as direct WhatsApp recipient tasks", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockFindBirthdayAudiencePage.mockResolvedValueOnce({
      recipients: [
        {
          customerId: "customer-1",
          phone: "+15550000001",
          name: "Alice",
          fields: { name: "Alice", birthday: "04-17" },
          variables: { name: "Alice" },
        },
      ],
      candidateCount: 1,
      skippedMarketingOptIn: 0,
      nextCursor: null,
    });
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                recipientAudienceSource:
                  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
                birthdayConfig: {
                  version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
                  leapDayPolicy: "feb_28",
                },
                scheduleConfig: {
                  version: 2,
                  mode: "recurring",
                  timezone: "America/New_York",
                  recurrence: {
                    kind: "daily",
                    time: "09:00",
                  },
                },
                uploadedRecipients: [
                  {
                    phone: "+1 (555) 000-0001",
                    name: "Alice",
                    birthday: "04-17",
                  },
                ],
              },
            },
          },
          {
            id: "template-1",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "birthday_offer",
              actionWhatsAppTemplateLanguage: "en",
              generatedTemplateDraft: {
                category: "MARKETING",
                components: [
                  {
                    type: "BODY",
                    text: "Happy birthday {{name}}",
                  },
                ],
              },
            },
          },
        ],
        edges: [
          {
            source: "bulk-root",
            sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            target: "template-1",
          },
        ],
      })
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "bulk-root",
      scheduledFor: "2099-04-17T09:00:00.000Z",
      executionSource: "scenario_schedule",
    });

    expect(result.status).toBe("materialized");
    expect(result.audienceSource).toBe("birthday");
    expect(mockBuildCampaignAudienceQueryDefinition).not.toHaveBeenCalled();
    expect(mockFindBirthdayAudiencePage).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/New_York",
        recipientPhones: ["15550000001"],
      })
    );
    expect(mockCampaignDeliveryTaskBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: {
              executionSource: "scenario_schedule",
              idempotencyKey: `${scenarioId}:bulk-root:15550000001:birthday:2099-04-17`,
            },
            update: expect.objectContaining({
              $setOnInsert: expect.objectContaining({
                idempotencyKey: `${scenarioId}:bulk-root:15550000001:birthday:2099-04-17`,
                nodeId: "bulk-root",
                audienceSource: "birthday",
                requiresRevalidation: false,
                recipientPhone: "+15550000001",
                templateName: "birthday_offer",
                templateLanguage: "en",
                templateCategory: "MARKETING",
                scheduledFor: new Date("2099-04-17T09:00:00.000Z"),
                dispatchExpiresAt: new Date("2099-04-17T09:15:00.000Z"),
              }),
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("materializes Telegram birthdays for eligible chats of the selected bot", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockResolveCampaignBatchPlanPreview.mockResolvedValueOnce({
      channel: "telegram",
      batchPlan: {
        batchSize: 30,
        delayMs: 1000,
        ratePerSecond: 30,
        rateSource: "telegram_free_broadcast_limit",
      },
      recipientLimit: {
        maxRecipients: 1000,
        rawLimit: "1000",
        source: "channel_default",
      },
    });
    mockFindBirthdayAudiencePage.mockResolvedValueOnce({
      recipients: [
        {
          customerId: "customer-1",
          chatId: "123456",
          sourceId: "source-1",
          name: "Aibek",
          fields: { name: "Aibek", birthday: "1992-07-23" },
          variables: { name: "Aibek", birthday: "1992-07-23" },
        },
      ],
      candidateCount: 1,
      skippedMarketingOptIn: 0,
      nextCursor: null,
    });
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                recipientAudienceSource:
                  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
                birthdayConfig: {
                  version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
                  leapDayPolicy: "feb_28",
                },
                scheduleConfig: {
                  version: 2,
                  mode: "recurring",
                  timezone: "UTC",
                  recurrence: { kind: "daily", time: "09:00" },
                },
                telegramSubscriberSourceId: "source-1",
                uploadedRecipients: [
                  { chatId: "123456", birthday: "23.07.1992" },
                ],
              },
            },
          },
          {
            id: "reply-1",
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyChannel: "telegram",
              actionReplyMode: "fixed",
              actionReplyText: "Happy birthday {{name}}",
            },
          },
        ],
        edges: [
          {
            source: "bulk-root",
            sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            target: "reply-1",
          },
        ],
      })
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "bulk-root",
      scheduledFor: "2099-07-23T09:00:00.000Z",
      executionSource: "scenario_schedule",
    });

    expect(result.status).toBe("materialized");
    expect(result.audienceSource).toBe("birthday");
    expect(mockResolveTelegramSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
    expect(mockFindBirthdayAudiencePage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        telegramSourceId: "source-1",
        recipientChatIds: ["123456"],
      })
    );
    expect(mockCampaignDeliveryTaskBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: {
              executionSource: "scenario_schedule",
              idempotencyKey: `${scenarioId}:bulk-root:123456:birthday:2099-07-23`,
            },
            update: expect.objectContaining({
              $setOnInsert: expect.objectContaining({
                idempotencyKey: `${scenarioId}:bulk-root:123456:birthday:2099-07-23`,
                channel: "telegram",
                provider: "telegram",
                audienceSource: "birthday",
                recipientChatId: "123456",
                sourceId: "source-1",
                recipientName: "Aibek",
                messageText: "Happy birthday Aibek",
                templateName: null,
              }),
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("skips birthday bulk roots without an uploaded recipient selection", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                recipientAudienceSource:
                  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
                birthdayConfig: {
                  version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
                  leapDayPolicy: "feb_28",
                },
                scheduleConfig: {
                  version: 2,
                  mode: "recurring",
                  timezone: "America/New_York",
                  recurrence: {
                    kind: "daily",
                    time: "09:00",
                  },
                },
                uploadedRecipients: [],
              },
            },
          },
          {
            id: "template-1",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "birthday_offer",
              actionWhatsAppTemplateLanguage: "en",
              generatedTemplateDraft: {
                category: "MARKETING",
                components: [
                  {
                    type: "BODY",
                    text: "Happy birthday {{name}}",
                  },
                ],
              },
            },
          },
        ],
        edges: [
          {
            source: "bulk-root",
            sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            target: "template-1",
          },
        ],
      })
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "bulk-root",
      scheduledFor: "2099-04-17T09:00:00.000Z",
      executionSource: "scenario_schedule",
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("missing_birthday_recipients");
    expect(mockFindBirthdayAudiencePage).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskBulkWrite).not.toHaveBeenCalled();
  });

  it.each([
    ["the WhatsApp daily recipient limit", 1, 500],
    ["the free bulk recipients left", 1000, 1],
  ] as const)(
    "caps birthday materialization to %s",
    async (_cap, metaLimit, recipientsLeft) => {
      const scenarioId = new Types.ObjectId().toHexString();
      mockEnsureCompanyConversationCapacity.mockResolvedValueOnce({
        allowed: true,
        limit: {
          bulkRecipientLimit: 500,
          bulkRecipientsRemaining: recipientsLeft,
          subscriptionType: "free",
        },
      });
      mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
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
        },
        recipientLimit: {
          maxRecipients: metaLimit,
          rawLimit: String(metaLimit),
          source: "live_meta",
        },
      });
      mockFindBirthdayAudiencePage.mockResolvedValueOnce({
        recipients: [
          {
            customerId: "customer-2",
            phone: "+15550000002",
            name: "Bob",
            fields: { name: "Bob", birthday: "04-17" },
            variables: { name: "Bob" },
          },
          {
            customerId: "customer-1",
            phone: "+15550000001",
            name: "Alice",
            fields: { name: "Alice", birthday: "04-17" },
            variables: { name: "Alice" },
          },
        ],
        candidateCount: 2,
        skippedMarketingOptIn: 0,
        nextCursor: null,
      });
      mockCampaignDeliveryTaskBulkWrite.mockResolvedValueOnce({
        upsertedCount: 1,
      });
      mockEvaluateRecipientPolicy.mockImplementationOnce(
        async (input: { candidates: Array<{ stableId: string }> }) => ({
          retained: input.candidates.slice(0, 1),
          excluded: input.candidates.slice(1).map(candidate => ({
            candidate,
            reason: "recipient_limit",
          })),
          skippedByReason: {
            recipient_limit: Math.max(0, input.candidates.length - 1),
          },
          warnings: { missingMarketingConsent: 0 },
          uniqueRecipients: {
            requested: input.candidates.length,
            accepted: Math.min(1, input.candidates.length),
          },
        })
      );
      mockScenarioFindOne.mockReturnValue(
        leanQuery({
          _id: new Types.ObjectId(scenarioId),
          workspaceId: "workspace-1",
          mode: "bulk_campaign",
          status: "active",
          timezone: "UTC",
          nodes: [
            {
              id: "bulk-root",
              data: {
                kind: "bulk",
                bulkRootConfig: {
                  recipientAudienceSource:
                    SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
                  birthdayConfig: {
                    version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
                    leapDayPolicy: "feb_28",
                  },
                  scheduleConfig: {
                    version: 2,
                    mode: "recurring",
                    timezone: "UTC",
                    recurrence: {
                      kind: "daily",
                      time: "09:00",
                    },
                  },
                  uploadedRecipients: [
                    { phone: "+15550000001", birthday: "04-17" },
                    { phone: "+15550000002", birthday: "04-17" },
                  ],
                },
              },
            },
            {
              id: "template-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "birthday_offer",
                actionWhatsAppTemplateLanguage: "en",
                generatedTemplateDraft: {
                  category: "MARKETING",
                  components: [
                    {
                      type: "BODY",
                      text: "Happy birthday {{name}}",
                    },
                  ],
                },
              },
            },
          ],
          edges: [
            {
              source: "bulk-root",
              sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
              target: "template-1",
            },
          ],
        })
      );

      const result = await executeCampaignNodeRun({
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "bulk-root",
        scheduledFor: "2099-04-17T09:00:00.000Z",
        executionSource: "scenario_schedule",
      });

      expect(result.status).toBe("materialized");
      expect(result.candidates).toBe(2);
      expect(result.created).toBe(1);
      if (recipientsLeft < metaLimit) {
        // The run keeps no more recipients than the free allowance has left.
        expect(mockEvaluateRecipientPolicy).toHaveBeenCalledWith(
          expect.objectContaining({ recipientLimit: recipientsLeft })
        );
      }
      expect(mockCampaignDeliveryTaskBulkWrite).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            updateOne: expect.objectContaining({
              update: expect.objectContaining({
                $setOnInsert: expect.objectContaining({
                  recipientPhone: "+15550000001",
                }),
              }),
            }),
          }),
        ],
        { ordered: false }
      );
    }
  );

  it("skips a new scheduled run when no free bulk recipients are left", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockEnsureCompanyConversationCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        bulkRecipientLimit: 500,
        bulkRecipientsRemaining: 0,
        subscriptionType: "free",
      },
    });
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: "MARKETING",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      executionSource: "scenario_schedule",
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("company_bulk_campaign_limit_exceeded");
    expect(mockEnsureCompanyConversationCapacity).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      { includeBulkRecipientUsage: true }
    );
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskBulkWrite).not.toHaveBeenCalled();
  });

  it("skips scheduled bulk node runs when the reservation finds the allowance used", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockCreateCampaignHistoryRecord.mockResolvedValueOnce({
      status: "blocked",
      code: "company_bulk_campaign_limit_exceeded",
      companyBulkCampaignLimit: 500,
      companyBulkCampaignCount: 500,
    });
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: "MARKETING",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );

    const result = await executeCampaignNodeRun({
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      executionSource: "scenario_schedule",
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("company_bulk_campaign_limit_exceeded");
    expect(mockCreateCampaignHistoryRecord).toHaveBeenCalledTimes(1);
    expect(mockCampaignDeliveryTaskBulkWrite).not.toHaveBeenCalled();
  });
});

describe("executeCampaignNodeRun complete-occurrence policy", () => {
  const hmacSecret = "test-campaign-hmac-secret";

  function conversationRow(
    id: Types.ObjectId,
    phone: string,
    sourceId = "source-1"
  ) {
    return { _id: id, user: phone, sourceId };
  }

  function expectedRecipientHash(phone: string) {
    const identity = canonicalizeBulkCampaignRecipientIdentity({
      channel: "whatsapp",
      recipient: { phone },
    });
    return hashBulkCampaignRecipientIdentity({
      secret: hmacSecret,
      workspaceId: "workspace-1",
      channel: "whatsapp",
      identity: identity!,
    });
  }

  function recurringScenario(params?: {
    nodeId?: string;
    recipientPolicy?: { version: 1; excludePriorFailedBulkSends: boolean };
    templateCategory?: string;
  }) {
    const nodeId = params?.nodeId ?? "node-1";
    const scenarioId = new Types.ObjectId().toHexString();
    return {
      scenarioId,
      nodeId,
      scenario: {
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                workflowKind: "bulk_campaign",
                channels: ["whatsapp"],
                sourceIds: ["source-1"],
                recipientPolicy: params?.recipientPolicy ?? {
                  version: 1,
                  excludePriorFailedBulkSends: false,
                },
              },
            },
          },
          {
            id: nodeId,
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              channel: "whatsapp",
              scheduleType: "weekly",
              templateName: "promo",
              templateLanguage: "en",
              templateCategory: params?.templateCategory ?? "MARKETING",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [
          {
            source: "bulk-root",
            sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            target: nodeId,
          },
        ],
      },
    };
  }

  function buildDependencies(overrides?: {
    conversations?: Array<Record<string, unknown>>;
  }): CampaignNodeRunRuntimeDependencies & {
    findAudiencePage: jest.Mock;
    evaluateRecipientPolicy: jest.Mock;
    bulkWrite: jest.Mock;
  } {
    const findAudiencePage = jest
      .fn()
      .mockResolvedValue(
        overrides?.conversations ?? [
          conversationRow(new Types.ObjectId(), "+15550000001"),
          conversationRow(new Types.ObjectId(), "+15550000002"),
        ]
      );
    const evaluateRecipientPolicy = jest
      .fn()
      .mockImplementation((...args: unknown[]) =>
        mockEvaluateRecipientPolicy(...args)
      );
    const bulkWrite = jest
      .fn()
      .mockImplementation((...args: unknown[]) =>
        mockCampaignDeliveryTaskBulkWrite(...args)
      );
    return {
      findAudiencePage,
      evaluateRecipientPolicy,
      bulkWrite,
    };
  }

  beforeEach(() => {
    resetExecuteCampaignNodeRunMocks();
    mockReadScheduleContext.mockReturnValue({
      rootNodeId: "bulk-root",
      recipientPolicy: { version: 1, excludePriorFailedBulkSends: true },
    });
  });

  it("evaluates a complete recurring audience before the first delivery-task bulkWrite", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const dependencies = buildDependencies();
    const recurringInput = {
      workspaceId: "workspace-1",
      scenarioId,
      nodeId,
      executionSource: "scenario_schedule" as const,
    };

    const result = await executeCampaignNodeRun(recurringInput, dependencies);
    expect(dependencies.findAudiencePage).toHaveBeenCalledWith(
      expect.objectContaining({ sort: expect.any(Object), limit: 50_001 })
    );
    expect(dependencies.evaluateRecipientPolicy).toHaveBeenCalledTimes(1);
    expect(
      dependencies.evaluateRecipientPolicy.mock.invocationCallOrder[0]
    ).toBeLessThan(dependencies.bulkWrite.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ status: "materialized", queued: 2 });
  });

  it.each(["blocked", "unavailable"])(
    "blocks a new recurring run before history/task writes when default sender readiness is %s",
    async state => {
      const { scenarioId, nodeId, scenario } = recurringScenario();
      mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
      const dependencies = buildDependencies();
      const preview = await mockResolveCampaignBatchPlanPreview();
      mockResolveCampaignBatchPlanPreview.mockResolvedValue({
        ...preview,
        readiness: {
          state,
          checkedAt: "2026-09-16T00:00:00.000Z",
          remainingCapacity: null,
          reasons: [
            {
              code:
                state === "blocked"
                  ? "meta_sender_restricted"
                  : "meta_check_unavailable",
            },
          ],
        },
      });

      await expect(
        executeCampaignNodeRun(
          {
            workspaceId: "workspace-1",
            scenarioId,
            nodeId,
            executionSource: "scenario_schedule",
          },
          dependencies
        )
      ).rejects.toThrow(/WhatsApp campaign sending/);

      expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
      expect(dependencies.bulkWrite).not.toHaveBeenCalled();
    }
  );

  it("checks the actual recipient source after the default source was ready", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const dependencies = buildDependencies();
    const preview = await mockResolveCampaignBatchPlanPreview();
    mockResolveCampaignBatchPlanPreview
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({
        ...preview,
        readiness: {
          state: "blocked",
          checkedAt: "2026-09-16T00:00:00.000Z",
          remainingCapacity: null,
          reasons: [{ code: "meta_business_limit", providerCode: "141015" }],
        },
      });

    await expect(
      executeCampaignNodeRun(
        {
          workspaceId: "workspace-1",
          scenarioId,
          nodeId,
          executionSource: "scenario_schedule",
        },
        dependencies
      )
    ).rejects.toThrow(/WhatsApp campaign sending/);

    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
  });

  it("preserves existing campaign/task reconciliation after live readiness becomes blocked", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    mockCampaignDeliveryTaskFindOne.mockReturnValue(
      selectedLeanQuery({ campaignId: "campaign-existing" })
    );
    const dependencies = buildDependencies();
    const preview = await mockResolveCampaignBatchPlanPreview();
    mockResolveCampaignBatchPlanPreview.mockResolvedValue({
      ...preview,
      readiness: {
        state: "blocked",
        checkedAt: "2026-09-16T00:00:00.000Z",
        remainingCapacity: null,
        reasons: [{ code: "meta_sender_restricted" }],
      },
    });

    const result = await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(result).toMatchObject({
      status: "materialized",
      campaignId: "campaign-existing",
    });
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(mockUpdateCampaignHistoryRecipientCount).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "campaign-existing" })
    );
  });

  it("writes no partial task batch when prior-failure lookup fails", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const dependencies = buildDependencies();
    dependencies.evaluateRecipientPolicy.mockRejectedValue(
      new BulkRecipientPolicyError("prior_failure_lookup_failed")
    );
    const recurringInput = {
      workspaceId: "workspace-1",
      scenarioId,
      nodeId,
      executionSource: "scenario_schedule" as const,
    };

    await expect(
      executeCampaignNodeRun(recurringInput, dependencies)
    ).rejects.toMatchObject({ code: "prior_failure_lookup_failed" });
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
  });

  it("defers birthday WhatsApp marketing consent to the shared evaluator", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    const actionNode = scenario.nodes[1] as {
      id: string;
      data: Record<string, unknown>;
    };
    actionNode.data.targetingMode = "dynamic";
    actionNode.data.audienceFilter = "birthday";
    actionNode.data.uploadedRecipients = [
      { phone: "+15550000001" },
      { phone: "+15550000002" },
    ];
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    mockFindBirthdayAudiencePage.mockResolvedValue({
      recipients: [
        {
          customerId: "cust-1",
          phone: "15550000001",
          name: "Ada",
          variables: { name: "Ada" },
        },
        {
          customerId: "cust-2",
          phone: "15550000002",
          name: "Ben",
          variables: { name: "Ben" },
        },
      ],
      candidateCount: 2,
      skippedMarketingOptIn: 0,
      nextCursor: null,
    });
    const dependencies = buildDependencies();

    const result = await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(mockFindBirthdayAudiencePage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        deferMarketingPolicy: true,
      })
    );
    expect(dependencies.evaluateRecipientPolicy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "materialized", queued: 2 });
  });

  it("blocks a stale enabled policy with no eligible WhatsApp template before bulkWrite", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    mockReadScheduleContext.mockReturnValue({
      rootNodeId: "bulk-root",
      recipientPolicy: { version: 1, excludePriorFailedBulkSends: true },
    });
    mockRouteScheduleProvenance.mockImplementation(
      (_capability: unknown, recipients: Array<{ stableId: string }>) => ({
        kind: "scenario_schedule",
        rootNodeId: "bulk-root",
        routes: recipients.map(recipient => ({
          recipientStableId: recipient.stableId,
          actionNodeId: nodeId,
          channel: "whatsapp",
          sourceId: "source-1",
        })),
      })
    );
    const dependencies = buildDependencies();

    await expect(
      executeCampaignNodeRun(
        {
          workspaceId: "workspace-1",
          scenarioId,
          nodeId,
          executionSource: "scenario_schedule",
        },
        dependencies
      )
    ).rejects.toMatchObject({ code: "bulk_recipient_policy_unsupported" });
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
  });

  it("keeps Telegram and email recurring tasks outside the WhatsApp policy evaluator", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "telegram",
              scheduleType: "weekly",
              messageText: "hello",
              targetingMode: "dynamic",
            },
          },
        ],
        edges: [],
      })
    );
    const dependencies = buildDependencies({
      conversations: [
        {
          _id: new Types.ObjectId(),
          chat: "123456",
          sourceId: "source-1",
        },
      ],
    });

    await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(dependencies.evaluateRecipientPolicy).not.toHaveBeenCalled();
    expect(dependencies.bulkWrite).toHaveBeenCalled();
  });

  it("returns a completed no-op when the complete WhatsApp occurrence is all-excluded", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const dependencies = buildDependencies();
    dependencies.evaluateRecipientPolicy.mockImplementation(
      async (input: { candidates: Array<{ stableId: string }> }) => ({
        retained: [],
        excluded: input.candidates.map(candidate => ({
          candidate,
          reason: "prior_failure",
        })),
        skippedByReason: { prior_failure: input.candidates.length },
        warnings: { missingMarketingConsent: 0 },
        uniqueRecipients: {
          requested: input.candidates.length,
          accepted: 0,
        },
      })
    );

    const result = await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(result).toMatchObject({
      status: "materialized",
      queued: 0,
      created: 0,
    });
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
    expect(mockCreateCampaignHistoryRecord).toHaveBeenCalled();
  });

  it("sends the matched rows and skips rows routed to an unconnected Else", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const matchedId = new Types.ObjectId();
    const elseId = new Types.ObjectId();
    const dependencies = buildDependencies({
      conversations: [
        conversationRow(matchedId, "+15550000001"),
        conversationRow(elseId, "+15550000002"),
      ],
    });
    // Provenance routes the matched row and skips the row on the empty Else.
    mockRouteScheduleProvenance.mockImplementation(
      (_capability: unknown, recipients: Array<{ stableId: string }>) => ({
        kind: "scenario_schedule",
        rootNodeId: "bulk-root",
        columnSplitNodeId: "column-split",
        routes: recipients
          .filter(recipient => recipient.stableId === matchedId.toHexString())
          .map(recipient => ({
            recipientStableId: recipient.stableId,
            actionNodeId: "node-1",
            channel: "whatsapp",
            sourceId: "source-1",
            template: {
              name: "promo",
              language: "en",
              category: "MARKETING",
              components: [],
            },
          })),
        skippedStableIds: [elseId.toHexString()],
      })
    );

    const result = await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(result).toMatchObject({ status: "materialized", queued: 1 });
    expect(
      dependencies.evaluateRecipientPolicy.mock.calls[0]?.[0].candidates.map(
        (candidate: { stableId: string }) => candidate.stableId
      )
    ).toEqual([matchedId.toHexString()]);
    expect(dependencies.bulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            update: expect.objectContaining({
              $setOnInsert: expect.objectContaining({
                conversationId: matchedId.toHexString(),
              }),
            }),
          }),
        }),
      ],
      { ordered: false }
    );
    expect(mockCampaignNodeRunLoggerInfo).toHaveBeenCalledWith(
      "campaign_node_run.unrouted_rows_skipped",
      expect.objectContaining({
        columnSplitNodeId: "column-split",
        skipped: 1,
        routed: 1,
      })
    );
    expect(mockEmitBulkCampaignPolicyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        itemCounts: expect.objectContaining({ requested: 1, accepted: 1 }),
      })
    );
  });

  it("blocks the 50,001 item sentinel before history or task writes", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const overLimit = Array.from({ length: 50_001 }, (_, index) =>
      conversationRow(
        new Types.ObjectId(),
        `+1555${String(index).padStart(7, "0")}`
      )
    );
    const dependencies = buildDependencies({ conversations: overLimit });

    await expect(
      executeCampaignNodeRun(
        {
          workspaceId: "workspace-1",
          scenarioId,
          nodeId,
          executionSource: "scenario_schedule",
        },
        dependencies
      )
    ).rejects.toThrow();
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
  });

  it("persists the exact canonical recipient HMAC while keeping the claimed scheduled node identity", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const conversationId = new Types.ObjectId();
    const phone = "+15550000001";
    const dependencies = buildDependencies({
      conversations: [conversationRow(conversationId, phone)],
    });

    await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(dependencies.bulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({
              idempotencyKey: expect.stringContaining(`:${nodeId}:`),
            }),
            update: expect.objectContaining({
              $setOnInsert: expect.objectContaining({
                nodeId,
                recipientPhone: expect.stringMatching(/15550000001/),
                recipientHash: expectedRecipientHash(phone),
              }),
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("preserves first-seen duplicate canonical identities without post-prior-failure backfill", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const first = new Types.ObjectId();
    const second = new Types.ObjectId();
    const third = new Types.ObjectId();
    const dependencies = buildDependencies({
      conversations: [
        conversationRow(first, "+15550000001"),
        conversationRow(second, "+15550000001"),
        conversationRow(third, "+15550000003"),
      ],
    });
    const seenStableIds: string[] = [];
    dependencies.evaluateRecipientPolicy.mockImplementation(
      async (input: { candidates: Array<{ stableId: string }> }) => {
        seenStableIds.push(
          ...input.candidates.map(candidate => candidate.stableId)
        );
        return {
          retained: input.candidates.slice(0, 2),
          excluded: [
            {
              candidate: input.candidates[2],
              reason: "prior_failure",
            },
          ],
          skippedByReason: { prior_failure: 1 },
          warnings: { missingMarketingConsent: 0 },
          uniqueRecipients: { requested: 2, accepted: 1 },
        };
      }
    );

    const result = await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(seenStableIds).toEqual([
      String(first),
      String(second),
      String(third),
    ]);
    expect(result).toMatchObject({ queued: 2 });
    const operations = dependencies.bulkWrite.mock.calls[0]?.[0] as Array<{
      updateOne: { update: { $setOnInsert: { conversationId: string } } };
    }>;
    expect(
      operations.map(
        operation => operation.updateOne.update.$setOnInsert.conversationId
      )
    ).toEqual([String(first), String(second)]);
  });

  it("does not reserve history or write tasks when provenance verification fails", async () => {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    mockVerifyScheduleCapability.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        code: "bulk_campaign_provenance_invalid",
      })
    );
    const dependencies = buildDependencies();

    await expect(
      executeCampaignNodeRun(
        {
          workspaceId: "workspace-1",
          scenarioId,
          nodeId,
          executionSource: "scenario_schedule",
        },
        dependencies
      )
    ).rejects.toMatchObject({ code: "bulk_campaign_provenance_invalid" });
    expect(dependencies.findAudiencePage).not.toHaveBeenCalled();
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
  });

  function birthdayPhones(count: number) {
    return Array.from(
      { length: count },
      (_, index) => `+1555${String(index).padStart(7, "0")}`
    );
  }

  function birthdayPageRecipients(phones: string[]) {
    return phones.map((phone, index) => ({
      customerId: `cust-${String(index).padStart(6, "0")}`,
      phone: phone.replace(/\D/g, ""),
      name: `Person ${index}`,
      variables: { name: `Person ${index}` },
    }));
  }

  function pagingBirthdayAudience(
    recipients: Array<{
      customerId: string;
      phone: string;
      name: string;
      variables: Record<string, string>;
    }>,
    pageSize = 500
  ) {
    return jest
      .fn()
      .mockImplementation(
        async (params: { afterId?: string | null; limit?: number }) => {
          const size = params.limit || pageSize;
          const start = params.afterId
            ? recipients.findIndex(
                recipient => recipient.customerId === params.afterId
              ) + 1
            : 0;
          const page = recipients.slice(start, start + size);
          const last = page[page.length - 1];
          return {
            recipients: page,
            candidateCount: page.length,
            skippedMarketingOptIn: 0,
            nextCursor:
              start + page.length < recipients.length && last
                ? last.customerId
                : null,
          };
        }
      );
  }

  function birthdayWhatsAppScenario(phones: string[]) {
    const { scenarioId, nodeId, scenario } = recurringScenario();
    const actionNode = scenario.nodes[1] as {
      id: string;
      data: Record<string, unknown>;
    };
    actionNode.data.targetingMode = "dynamic";
    actionNode.data.audienceFilter = "birthday";
    actionNode.data.uploadedRecipients = phones.map(phone => ({ phone }));
    return { scenarioId, nodeId, scenario };
  }

  it("treats 50,000 birthday WhatsApp recipients as a complete occurrence", async () => {
    const phones = birthdayPhones(50_000);
    const { scenarioId, nodeId, scenario } = birthdayWhatsAppScenario(phones);
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const findBirthdayAudiencePage = pagingBirthdayAudience(
      birthdayPageRecipients(phones)
    );
    const dependencies = {
      ...buildDependencies(),
      findBirthdayAudiencePage,
    };

    const result = await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(findBirthdayAudiencePage).toHaveBeenCalledTimes(100);
    expect(dependencies.evaluateRecipientPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        completeness: expect.objectContaining({
          complete: true,
          uniqueRecipients: 50_000,
          dispatchItems: 50_000,
        }),
      })
    );
    expect(result).toMatchObject({ status: "materialized", queued: 50_000 });
    expect(mockCreateCampaignHistoryRecord).toHaveBeenCalled();
    expect(dependencies.bulkWrite).toHaveBeenCalled();
  });

  it("stops birthday paging at the 50,001 unique-identity sentinel", async () => {
    const phones = birthdayPhones(60_000);
    const { scenarioId, nodeId, scenario } = birthdayWhatsAppScenario(phones);
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const findBirthdayAudiencePage = pagingBirthdayAudience(
      birthdayPageRecipients(phones)
    );
    const dependencies = {
      ...buildDependencies(),
      findBirthdayAudiencePage,
    };

    await expect(
      executeCampaignNodeRun(
        {
          workspaceId: "workspace-1",
          scenarioId,
          nodeId,
          executionSource: "scenario_schedule",
        },
        dependencies
      )
    ).rejects.toThrow("bulk_campaign_occurrence_hard_cap_exceeded");
    expect(findBirthdayAudiencePage.mock.calls.length).toBe(101);
    expect(findBirthdayAudiencePage.mock.calls.length).toBeLessThan(120);
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
  });

  it("stops birthday paging at the 50,001 item sentinel", async () => {
    const uniquePhones = birthdayPhones(10);
    const { scenarioId, nodeId, scenario } =
      birthdayWhatsAppScenario(uniquePhones);
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const repeated = Array.from({ length: 60_000 }, (_, index) => ({
      customerId: `cust-${String(index).padStart(6, "0")}`,
      phone: uniquePhones[index % uniquePhones.length].replace(/\D/g, ""),
      name: `Person ${index}`,
      variables: { name: `Person ${index}` },
    }));
    const findBirthdayAudiencePage = pagingBirthdayAudience(repeated);
    const dependencies = {
      ...buildDependencies(),
      findBirthdayAudiencePage,
    };

    await expect(
      executeCampaignNodeRun(
        {
          workspaceId: "workspace-1",
          scenarioId,
          nodeId,
          executionSource: "scenario_schedule",
        },
        dependencies
      )
    ).rejects.toThrow("bulk_campaign_occurrence_hard_cap_exceeded");
    expect(findBirthdayAudiencePage.mock.calls.length).toBe(101);
    expect(findBirthdayAudiencePage.mock.calls.length).toBeLessThan(120);
    expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
    expect(dependencies.bulkWrite).not.toHaveBeenCalled();
  });

  it("does not defer Telegram birthday subscriber filtering onto the WhatsApp evaluator", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        timezone: "UTC",
        nodes: [
          {
            id: "node-1",
            data: {
              channel: "telegram",
              scheduleType: "weekly",
              messageText: "hello",
              targetingMode: "dynamic",
              audienceFilter: "birthday",
              uploadedRecipients: [{ chatId: "123456" }],
            },
          },
        ],
        edges: [],
      })
    );
    const findBirthdayAudiencePage = jest.fn().mockResolvedValue({
      recipients: [
        {
          customerId: "cust-1",
          chatId: "123456",
          name: "Aibek",
          variables: { name: "Aibek" },
        },
      ],
      candidateCount: 1,
      skippedMarketingOptIn: 0,
      nextCursor: null,
    });
    const dependencies = {
      ...buildDependencies(),
      findBirthdayAudiencePage,
    };

    await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(findBirthdayAudiencePage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        recipientChatIds: ["123456"],
      })
    );
    expect(findBirthdayAudiencePage.mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({ deferMarketingPolicy: true })
    );
    expect(dependencies.evaluateRecipientPolicy).not.toHaveBeenCalled();
    expect(dependencies.bulkWrite).toHaveBeenCalled();
  });

  it("records birthday template preflight misses as ineligible without aborting the occurrence", async () => {
    const { scenarioId, nodeId, scenario } = birthdayWhatsAppScenario([
      "+15550000001",
      "+15550000002",
    ]);
    const actionNode = scenario.nodes[1] as {
      data: Record<string, unknown>;
    };
    actionNode.data.templateComponents = [
      { type: "BODY", text: "Use {{coupon}}" },
    ];
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const findBirthdayAudiencePage = jest.fn().mockResolvedValue({
      recipients: [
        {
          customerId: "cust-1",
          phone: "15550000001",
          name: "Ada",
          variables: { coupon: "SAVE10" },
        },
        {
          customerId: "cust-2",
          phone: "15550000002",
          name: "Ben",
          variables: { name: "Ben" },
        },
      ],
      candidateCount: 2,
      skippedMarketingOptIn: 0,
      nextCursor: null,
    });
    const dependencies = {
      ...buildDependencies(),
      findBirthdayAudiencePage,
    };

    const result = await executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        executionSource: "scenario_schedule",
      },
      dependencies
    );

    expect(dependencies.evaluateRecipientPolicy).toHaveBeenCalledTimes(1);
    expect(dependencies.evaluateRecipientPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            stableId: "15550000001",
          }),
        ],
        completeness: expect.objectContaining({
          complete: true,
          uniqueRecipients: 1,
          dispatchItems: 1,
        }),
      })
    );
    expect(result).toMatchObject({ status: "materialized", queued: 1 });
    expect(mockEmitBulkCampaignPolicyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        skippedByReason: expect.objectContaining({ ineligible: 1 }),
      })
    );
    expect(dependencies.bulkWrite).toHaveBeenCalledTimes(1);
    expect(mockCreateCampaignHistoryRecord).toHaveBeenCalled();
  });
});

describe("executeCampaignNodeRun builder birthday roots", () => {
  const scheduledFor = "2099-04-17T09:00:00.000Z";
  const alice = {
    customerId: "customer-1",
    phone: "+15550000001",
    name: "Alice",
    fields: { name: "Alice", birthday: "04-17" },
    variables: { name: "Alice" },
  };

  beforeEach(() => {
    resetExecuteCampaignNodeRunMocks();
    mockParseCampaignAudienceFilterParam.mockReturnValue("birthday");
    mockResolveWhatsAppSendContext.mockResolvedValue({
      sourceId: "source-1",
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
    });
    mockFindBirthdayAudiencePage.mockResolvedValue({
      recipients: [alice],
      candidateCount: 1,
      skippedMarketingOptIn: 0,
      nextCursor: null,
    });
  });

  // Production shape: the builder keeps Scenario.mode "conversation" and its
  // bulk root stores no sourceIds.
  function builderScenario(
    scenarioId: string,
    overrides: Record<string, unknown> = {},
    target: { id: string; data: Record<string, unknown> } = {
      id: "template-1",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "birthday_offer",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateCategory: "MARKETING",
      },
    }
  ) {
    return {
      _id: new Types.ObjectId(scenarioId),
      workspaceId: "workspace-1",
      mode: "conversation",
      status: "active",
      timezone: "UTC",
      nodes: [
        { id: "trigger-1", data: { kind: "trigger" } },
        {
          id: "bulk-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["whatsapp"],
              recipientAudienceSource:
                SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
              birthdayConfig: {
                version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
                leapDayPolicy: "feb_28",
              },
              scheduleConfig: {
                version: 2,
                mode: "recurring",
                timezone: "UTC",
                recurrence: { kind: "daily", time: "09:00" },
              },
              uploadedRecipients: [
                { phone: "+15550000001", name: "Alice", birthday: "04-17" },
              ],
            },
          },
        },
        target,
      ],
      edges: [
        {
          source: "bulk-root",
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
          target: target.id,
        },
      ],
      ...overrides,
    };
  }

  function runBuilderNode(
    scenarioId: string,
    nodeId = "bulk-root",
    dependencies?: CampaignNodeRunRuntimeDependencies
  ) {
    return executeCampaignNodeRun(
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId,
        scheduledFor,
        executionSource: "scenario_schedule",
      },
      dependencies
    );
  }

  it("verifies the root with the workspace source it resolved once, before provenance", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockScenarioFindOne.mockReturnValue(leanQuery(builderScenario(scenarioId)));

    const result = await runBuilderNode(scenarioId);

    expect(result.status).toBe("materialized");
    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId: "workspace-1",
      deletedAt: null,
    });
    const workspaceSourceLookups =
      mockResolveWhatsAppSendContext.mock.calls.filter(
        ([params]) => !("sourceId" in (params as object))
      );
    expect(workspaceSourceLookups).toEqual([[{ workspaceId: "workspace-1" }]]);
    expect(mockVerifyScheduleCapability).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      scheduledNodeId: "bulk-root",
      channel: "whatsapp",
      messageIntent: {
        kind: "whatsapp_template",
        sourceId: "source-1",
        templateName: "birthday_offer",
        language: "en",
      },
    });
    expect(
      mockResolveWhatsAppSendContext.mock.invocationCallOrder[0]
    ).toBeLessThan(mockVerifyScheduleCapability.mock.invocationCallOrder[0]!);
    expect(mockCampaignNodeRunLoggerInfo).toHaveBeenCalledWith(
      "campaign_node_run.whatsapp_source",
      {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "bulk-root",
        sourceId: "source-1",
      }
    );
  });

  it("skips without provenance when the workspace has no WhatsApp source", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockScenarioFindOne.mockReturnValue(leanQuery(builderScenario(scenarioId)));
    mockResolveWhatsAppSendContext.mockResolvedValue(null);
    mockFindCampaignHistoryRunReservation.mockResolvedValue({
      campaignId: "campaign-provisional",
      channel: "whatsapp",
      stopReason: null,
      bulkQuotaReservedAt: "2099-04-17T08:59:59.000Z",
    });

    const result = await runBuilderNode(scenarioId);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "missing_whatsapp_credentials",
    });
    expect(mockVerifyScheduleCapability).not.toHaveBeenCalled();
    expect(mockUpdateCampaignHistoryRecipientCount).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: "campaign-provisional",
        totalRecipients: 0,
      })
    );
    expect(mockCampaignDeliveryTaskBulkWrite).not.toHaveBeenCalled();
  });

  it.each(["trigger-1", "template-1"])(
    "skips a stale schedule on the non-root node %s",
    async nodeId => {
      const scenarioId = new Types.ObjectId().toHexString();
      mockScenarioFindOne.mockReturnValue(
        leanQuery(builderScenario(scenarioId))
      );

      await expect(runBuilderNode(scenarioId, nodeId)).resolves.toMatchObject({
        status: "skipped",
        reason: "scheduled_node_not_campaign_root",
      });
      expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
      expect(mockVerifyScheduleCapability).not.toHaveBeenCalled();
    }
  );

  it("materializes a Telegram builder birthday root for its selected bot", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const scenario = builderScenario(
      scenarioId,
      {},
      {
        id: "reply-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionReplyMode: "fixed",
          actionReplyText: "Happy birthday {{name}}",
        },
      }
    );
    const rootConfig = scenario.nodes[1]!.data.bulkRootConfig as Record<
      string,
      unknown
    >;
    rootConfig.channels = ["telegram"];
    rootConfig.telegramSubscriberSourceId = "source-1";
    rootConfig.uploadedRecipients = [
      { chatId: "123456", name: "Alice", birthday: "04-17" },
    ];
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));

    mockFindBirthdayAudiencePage.mockResolvedValue({
      recipients: [
        {
          customerId: "customer-1",
          chatId: "123456",
          sourceId: "source-1",
          name: "Alice",
          variables: { name: "Alice" },
        },
      ],
      candidateCount: 1,
      skippedMarketingOptIn: 0,
      nextCursor: null,
    });
    mockRouteScheduleProvenance.mockImplementation(
      (_capability: unknown, recipients: Array<{ stableId: string }>) => ({
        kind: "scenario_schedule",
        rootNodeId: "bulk-root",
        routes: recipients.map(recipient => ({
          recipientStableId: recipient.stableId,
          actionNodeId: "reply-1",
          channel: "telegram",
          sourceId: "source-1",
          messageText: "Happy birthday {{name}}",
        })),
      })
    );
    await expect(runBuilderNode(scenarioId)).resolves.toMatchObject({
      status: "materialized",
      queued: 1,
    });
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockVerifyScheduleCapability).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram" })
    );
    expect(
      mockCampaignDeliveryTaskBulkWrite.mock.calls[0][0][0].updateOne.update
        .$setOnInsert
    ).toMatchObject({
      channel: "telegram",
      sourceId: "source-1",
      recipientChatId: "123456",
      messageText: "Happy birthday Alice",
    });
  });

  it("does not send from a draft builder scenario", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockScenarioFindOne.mockReturnValue(
      leanQuery(builderScenario(scenarioId, { status: "draft" }))
    );

    await expect(runBuilderNode(scenarioId)).resolves.toMatchObject({
      status: "skipped",
      reason: "scenario_not_active",
    });
    expect(mockVerifyScheduleCapability).not.toHaveBeenCalled();
  });

  it("queues tasks on the resolved source through the real schedule provenance", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const scenario = builderScenario(scenarioId);
    mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
    const provenance = jest.requireActual(
      "./bulk-campaign-provenance"
    ) as typeof import("./bulk-campaign-provenance");
    const listApprovedWhatsAppTemplatesForSend = jest.fn(async () => [
      {
        id: "template-birthday",
        name: "birthday_offer",
        language: "en",
        status: "APPROVED" as const,
        category: "MARKETING" as const,
        components: [{ type: "BODY" as const, text: "Happy birthday" }],
      },
    ]);
    const provenanceDependencies = {
      findScenario: jest.fn(async () => scenario),
      listApprovedWhatsAppTemplatesForSend,
    };

    const result = await runBuilderNode(scenarioId, "bulk-root", {
      verifyScheduleCapability: input =>
        provenance.verifyBulkCampaignScenarioScheduleCapability(
          input,
          provenanceDependencies
        ),
      readScheduleContext:
        provenance.readVerifiedBulkCampaignScenarioScheduleContext,
      routeScheduleProvenance:
        provenance.routeVerifiedBulkCampaignScenarioScheduleProvenance,
    });

    expect(result).toMatchObject({ status: "materialized", queued: 1 });
    expect(listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
      "workspace-1",
      { sourceId: "source-1" }
    );
    expect(mockCampaignDeliveryTaskBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            update: expect.objectContaining({
              $setOnInsert: expect.objectContaining({
                nodeId: "bulk-root",
                audienceSource: "birthday",
                sourceId: "source-1",
                templateName: "birthday_offer",
              }),
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it.each(["sequential", "concurrent"])(
    "uses one birthday occurrence after the same day's schedule time changes (%s)",
    async mode => {
      const scenarioId = new Types.ObjectId().toHexString();
      const scenario = builderScenario(scenarioId);
      mockScenarioFindOne.mockReturnValue(leanQuery(scenario));
      const histories = new Map<string, string>();
      const tasks = new Map<string, Record<string, unknown>>();
      mockFindCampaignHistoryRunReservation.mockImplementation(
        async (params: {
          executionRunKey: string;
          legacyScheduledForRange?: unknown;
        }) => {
          if (params.legacyScheduledForRange) return null;
          const campaignId = histories.get(params.executionRunKey);
          return campaignId
            ? {
                campaignId,
                channel: "whatsapp",
                stopReason: null,
                bulkQuotaReservedAt: null,
              }
            : null;
        }
      );
      mockCreateCampaignHistoryRecord.mockImplementation(
        async (params: { executionRunKey: string }) => {
          const campaignId =
            histories.get(params.executionRunKey) ||
            `campaign-${histories.size + 1}`;
          const created = !histories.has(params.executionRunKey);
          histories.set(params.executionRunKey, campaignId);
          return { status: "ready", campaignId, created };
        }
      );
      mockCampaignDeliveryTaskFindOne.mockImplementation(
        (query: { runKey: unknown }) => {
          const task = [...tasks.values()].find(
            task => task.runKey === query.runKey
          );
          return selectedLeanQuery(task || null);
        }
      );
      mockCampaignDeliveryTaskCountDocuments.mockImplementation(
        async (query: { runKey: string }) =>
          [...tasks.values()].filter(task => task.runKey === query.runKey)
            .length
      );
      mockCampaignDeliveryTaskBulkWrite.mockImplementation(
        async (
          operations: Array<{
            updateOne: { update: { $setOnInsert: Record<string, unknown> } };
          }>
        ) => {
          let upsertedCount = 0;
          for (const operation of operations) {
            const task = operation.updateOne.update.$setOnInsert;
            const key = String(task.idempotencyKey);
            if (!tasks.has(key)) {
              tasks.set(key, task);
              upsertedCount += 1;
            }
          }
          return { upsertedCount };
        }
      );
      const rootConfig = scenario.nodes[1]!.data.bulkRootConfig as Record<
        string,
        unknown
      >;
      rootConfig.scheduleConfig = {
        version: 2,
        mode: "recurring",
        timezone: "UTC",
        recurrence: { kind: "daily", time: "10:00" },
      };
      const laterInput = {
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "bulk-root",
        scheduledFor: "2099-04-17T10:00:00.000Z",
        executionSource: "scenario_schedule" as const,
      };
      const [first, second] =
        mode === "concurrent"
          ? await Promise.all([
              runBuilderNode(scenarioId),
              executeCampaignNodeRun(laterInput),
            ])
          : [
              await runBuilderNode(scenarioId),
              await executeCampaignNodeRun(laterInput),
            ];
      expect(first.runKey).toBe("birthday:2099-04-17");
      expect(second.runKey).toBe(first.runKey);
      expect(second.campaignId).toBe(first.campaignId);
      expect(histories.size).toBe(1);
      expect(tasks.size).toBe(1);
      expect(first.created + second.created).toBe(1);
    }
  );

  it.each(["empty", "excluded"])(
    "resumes pending birthday tasks when the birthday audience becomes %s during retry",
    async mode => {
      const scenarioId = new Types.ObjectId().toHexString();
      mockScenarioFindOne.mockReturnValue(
        leanQuery(builderScenario(scenarioId))
      );
      let persistedTask: Record<string, unknown> | null = null;
      mockCampaignDeliveryTaskBulkWrite.mockImplementation(
        async (
          operations: Array<{
            updateOne: { update: { $setOnInsert: Record<string, unknown> } };
          }>
        ) => {
          persistedTask = operations[0]!.updateOne.update.$setOnInsert;
          return { upsertedCount: 1 };
        }
      );
      mockCampaignDeliveryTaskFindOne.mockImplementation(
        (query: { runKey: unknown }) =>
          selectedLeanQuery(
            persistedTask && persistedTask.runKey === query.runKey
              ? persistedTask
              : null
          )
      );
      mockCampaignDeliveryTaskCountDocuments.mockImplementation(async () =>
        persistedTask ? 1 : 0
      );
      mockUpdateCampaignHistoryRecipientCount.mockRejectedValueOnce(
        new Error("count persistence unavailable")
      );
      await expect(runBuilderNode(scenarioId)).rejects.toThrow(
        "count persistence unavailable"
      );
      mockUpdateCampaignHistoryRecipientCount.mockResolvedValue(undefined);
      if (mode === "empty") {
        mockFindBirthdayAudiencePage.mockResolvedValue({
          recipients: [],
          candidateCount: 0,
          skippedMarketingOptIn: 0,
          nextCursor: null,
        });
      } else {
        mockEvaluateRecipientPolicy.mockResolvedValue({
          retained: [],
          skippedByReason: { marketing_opt_out: 1 },
          warnings: { missingMarketingConsent: 0 },
          uniqueRecipients: { requested: 1, accepted: 0 },
        });
      }
      const retried = await runBuilderNode(scenarioId);
      expect(retried).toMatchObject({
        status: "materialized",
        campaignId: "campaign-1",
        pendingCount: 1,
        created: 0,
      });
      expect(mockUpdateCampaignHistoryRecipientCount).toHaveBeenLastCalledWith(
        expect.objectContaining({ totalRecipients: 1 })
      );
    }
  );

  it.each([true, false])(
    "reuses a legacy timestamp birthday reservation after a time edit (tasks=%s)",
    async hasTasks => {
      const scenarioId = new Types.ObjectId().toHexString();
      mockScenarioFindOne.mockReturnValue(
        leanQuery(builderScenario(scenarioId))
      );
      const legacyRunKey = "scheduled:2099-04-17T08:00:00.000Z";
      mockFindCampaignHistoryRunReservation.mockImplementation(
        async (params: {
          legacyScheduledForRange?: unknown;
          executionRunKey: string;
        }) =>
          params.legacyScheduledForRange ||
          params.executionRunKey === legacyRunKey
            ? {
                campaignId: "campaign-legacy",
                executionRunKey: legacyRunKey,
                channel: "whatsapp",
                stopReason: null,
                bulkQuotaReservedAt: "2099-04-17T07:59:00.000Z",
              }
            : null
      );
      mockCampaignDeliveryTaskFindOne.mockImplementation(
        (query: { runKey: unknown }) =>
          selectedLeanQuery(
            hasTasks && typeof query.runKey === "object"
              ? { campaignId: "campaign-legacy", runKey: legacyRunKey }
              : null
          )
      );
      await expect(runBuilderNode(scenarioId)).resolves.toMatchObject({
        campaignId: "campaign-legacy",
        runKey: legacyRunKey,
      });
      expect(mockCreateCampaignHistoryRecord).not.toHaveBeenCalled();
      expect(
        mockCampaignDeliveryTaskBulkWrite.mock.calls[0][0][0].updateOne.update
          .$setOnInsert
      ).toMatchObject({ campaignId: "campaign-legacy", runKey: legacyRunKey });
    }
  );
});
