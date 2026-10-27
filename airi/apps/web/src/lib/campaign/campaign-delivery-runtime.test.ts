const mockConnectDB = jest.fn();
const mockIsCampaignEmailBatchEnabled = jest.fn(() => false);
const mockSendCampaignTransportBatch = jest.fn();
const mockSendCampaignTransportSingle = jest.fn();
const mockPersistCampaignMessageSentWithOutbox = jest
  .fn()
  .mockResolvedValue({ applied: true, queuedToOutbox: false });
const mockPersistCampaignMessageAttemptWithOutbox = jest
  .fn()
  .mockResolvedValue({ applied: true, queuedToOutbox: false });
const mockClassifyCampaignTransportFailure = jest.fn();
const mockFindCampaignMessageAcceptance = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockGetWABASendingReadiness = jest.fn();
jest.mock("@/lib/whatsapp/waba-service", () => ({
  getWABASendingReadiness: (...args: unknown[]) =>
    mockGetWABASendingReadiness(...args),
}));
const mockResolveTelegramSendContext = jest.fn();
const mockMarkTelegramSubscriberSendResult = jest.fn();
const mockCampaignDeliveryTaskUpdateMany = jest.fn();
const mockCampaignDeliveryTaskFindOneAndUpdate = jest.fn();
const mockCampaignDeliveryTaskUpdateOne = jest.fn();
const mockCampaignDeliveryTaskCountDocuments = jest.fn();
const mockCampaignDeliveryTaskFindOne = jest.fn();
const mockCampaignDeliveryTaskFind = jest.fn();
const mockCampaignDeliveryTaskAggregate = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockConversationFindOne = jest.fn();
const mockEnsureCompanyConversationCapacity = jest.fn();
const mockReconcileLegacyCampaignSendTotals = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockGetCampaignDispatchProviderCircuit = jest.fn();
const mockTaskSendReceipts = new Map<string, Record<string, unknown>>();
const mockFindTaskSendReceipt = jest.fn();
const mockRecordTaskSendReceipt = jest.fn();

jest.mock("@/lib/campaign/campaign-history-store", () => ({
  getCampaignDispatchProviderCircuit: (...args: unknown[]) =>
    mockGetCampaignDispatchProviderCircuit(...args),
}));
jest.mock("@icecore/airi-runtime/bulk-dispatch-activity-dedupe", () => ({
  findBulkDispatchActivityDedupe: (...args: unknown[]) =>
    mockFindTaskSendReceipt(...args),
  recordBulkDispatchActivityDedupe: (...args: unknown[]) =>
    mockRecordTaskSendReceipt(...args),
}));

beforeEach(() => {
  mockFindCampaignMessageAcceptance.mockReset().mockResolvedValue(null);
  mockGetWABASendingReadiness.mockReset().mockResolvedValue({
    state: "ready",
    checkedAt: new Date().toISOString(),
    remainingCapacity: null,
    reasons: [],
  });
  mockTaskSendReceipts.clear();
  mockGetCampaignDispatchProviderCircuit
    .mockReset()
    .mockResolvedValue({ state: "closed" });
  mockFindTaskSendReceipt
    .mockReset()
    .mockImplementation(
      async (key: string) => mockTaskSendReceipts.get(key) || null
    );
  mockRecordTaskSendReceipt
    .mockReset()
    .mockImplementation(async (receipt: { key: string }) => {
      mockTaskSendReceipts.set(receipt.key, receipt);
    });
});

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/campaign/campaign-transport", () => ({
  sendCampaignTransportBatch: (...args: unknown[]) =>
    mockSendCampaignTransportBatch(...args),
  sendCampaignTransportSingle: (...args: unknown[]) =>
    mockSendCampaignTransportSingle(...args),
  classifyCampaignTransportFailure: (...args: unknown[]) =>
    mockClassifyCampaignTransportFailure(...args),
}));

jest.mock("@/lib/campaign/cron-transitions", () => ({
  applyBulkCampaignCronTransitions: jest.fn(),
}));

jest.mock("@/lib/cross-store-outbox", () => ({
  findCampaignMessageAcceptance: (...args: unknown[]) =>
    mockFindCampaignMessageAcceptance(...args),
  persistCampaignMessageSentWithOutbox: (...args: unknown[]) =>
    mockPersistCampaignMessageSentWithOutbox(...args),
  persistCampaignMessageAttemptWithOutbox: (...args: unknown[]) =>
    mockPersistCampaignMessageAttemptWithOutbox(...args),
}));

jest.mock("@/lib/campaign/campaign-config", () => ({
  isCampaignEmailBatchEnabled: () => mockIsCampaignEmailBatchEnabled(),
}));

jest.mock("@/lib/campaign/campaign-stats", () => ({
  reconcileLegacyCampaignSendTotals: (...args: unknown[]) =>
    mockReconcileLegacyCampaignSendTotals(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE:
    "company_conversation_limit_exceeded",
  ensureCompanyConversationCapacity: (...args: unknown[]) =>
    mockEnsureCompanyConversationCapacity(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/lib/telegram/source-context", () => ({
  resolveTelegramSendContext: (...args: unknown[]) =>
    mockResolveTelegramSendContext(...args),
}));

jest.mock("@/lib/telegram/subscribers", () => ({
  markTelegramSubscriberSendResult: (...args: unknown[]) =>
    mockMarkTelegramSubscriberSendResult(...args),
}));

jest.mock("@/models/campaign-delivery-task", () => ({
  __esModule: true,
  default: {
    updateMany: (...args: unknown[]) =>
      mockCampaignDeliveryTaskUpdateMany(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockCampaignDeliveryTaskFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) =>
      mockCampaignDeliveryTaskUpdateOne(...args),
    countDocuments: (...args: unknown[]) =>
      mockCampaignDeliveryTaskCountDocuments(...args),
    findOne: (...args: unknown[]) => mockCampaignDeliveryTaskFindOne(...args),
    find: (...args: unknown[]) => mockCampaignDeliveryTaskFind(...args),
    aggregate: (...args: unknown[]) =>
      mockCampaignDeliveryTaskAggregate(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));

import { Types } from "mongoose";
import { createWhatsAppStatusWebhookHandler } from "@icecore/airi-runtime/whatsapp-status-webhook-handler";
import { createCampaignTaskProviderAcceptance } from "@icecore/airi-runtime/campaign-task-provider-acceptance";
import {
  buildCurrentConversationClassificationFilter,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  drainCampaignDeliveryTasks,
  finalizeCampaignExecution,
} from "./campaign-delivery-runtime";

function leanQuery<T>(value: T) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

function selectLeanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function sortSelectLeanQuery<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function sortLimitSelectLeanQuery<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function currentClassification(category: string, revision = 11) {
  return {
    classification: { category },
    is_classified: true,
    classification_revision: revision,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: revision,
      appliedRevision: revision,
    },
    classification_meta: {
      source_revision: revision,
      provenance_kind: "v2",
      analysis_revision_id: `analysis-${revision}`,
    },
  };
}

function capturedCurrentCategoryQuery(params: {
  conversationId: string;
  category: string;
  revision: number;
}) {
  const currentFilter = buildCurrentConversationClassificationFilter();
  const analysisIdPredicate = currentFilter[
    "classification_meta.analysis_revision_id"
  ] as Record<string, unknown>;
  delete currentFilter["classification_meta.analysis_revision_id"];
  return {
    _id: params.conversationId,
    workspaceId: "workspace-1",
    "classification.category": params.category,
    classification_revision: params.revision,
    ...currentFilter,
    "classification_meta.analysis_revision_id": {
      $eq: `analysis-${params.revision}`,
      ...analysisIdPredicate,
    },
  };
}

function mockCampaignHistoryTotal(
  result: {
    data: { total_recipients: unknown } | null;
    error: { message?: string } | null;
  } = {
    data: { total_recipients: 50 },
    error: null,
  }
) {
  const maybeSingle = jest.fn().mockResolvedValue(result);
  const workspaceFilter = jest.fn().mockReturnValue({ maybeSingle });
  const campaignFilter = jest.fn().mockReturnValue({ eq: workspaceFilter });
  const select = jest.fn().mockReturnValue({ eq: campaignFilter });
  mockSupabaseFrom.mockReturnValue({ select });
}

describe("drainCampaignDeliveryTasks WhatsApp template category", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCampaignEmailBatchEnabled.mockReturnValue(false);
    mockConversationFindOne.mockReset();
    mockConnectDB.mockResolvedValue(undefined);
    mockCampaignDeliveryTaskUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({});
    mockCampaignDeliveryTaskCountDocuments.mockResolvedValue(0);
    mockCampaignDeliveryTaskFindOne.mockReturnValue(sortSelectLeanQuery(null));
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      messagingAccountId: "messaging-1",
    });
    mockResolveTelegramSendContext.mockResolvedValue({
      sourceId: "source-1",
      botToken: "bot-token",
    });
    mockMarkTelegramSubscriberSendResult.mockResolvedValue(undefined);
    mockSendCampaignTransportSingle.mockResolvedValue({
      success: true,
      provider: "meta",
      recipient: "+15550000001",
      messageId: "wamid.marketing",
    });
    mockPersistCampaignMessageSentWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockPersistCampaignMessageAttemptWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockClassifyCampaignTransportFailure.mockReturnValue({
      failureScope: "unknown",
    });
  });

  it("passes persisted MARKETING category into the WhatsApp campaign transport", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const taskId = new Types.ObjectId();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({
        _id: taskId,
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        campaignId: "campaign-1",
        channel: "whatsapp",
        provider: "meta",
        audienceSource: "dynamic",
        requiresRevalidation: false,
        recipientPhone: "+15550000001",
        templateName: "promo",
        templateLanguage: "en",
        templateCategory: "MARKETING",
        templateComponents: [],
        attempts: 1,
      })
    );
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        nodes: [{ id: "node-1", data: { templateCategory: "MARKETING" } }],
      })
    );

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.completed).toBe(1);
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        templateName: "promo",
        templateCategory: "MARKETING",
        messagingAccountId: "messaging-1",
      })
    );
    const transportArgs = mockSendCampaignTransportSingle.mock
      .calls[0]?.[0] as {
      bizOpaqueCallbackData?: string;
    };
    expect(transportArgs.bizOpaqueCallbackData).toContain("campaign-1");
  });

  // Builder campaigns keep Scenario.mode "conversation"; node-run writes
  // their tasks for the daily WhatsApp birthday root it scheduled.
  const builderBirthdayRoot = {
    id: "bulk-root",
    data: {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        channels: ["whatsapp"],
        recipientAudienceSource: "customer_birthdays",
        scheduleConfig: {
          version: 2,
          mode: "recurring",
          timezone: "UTC",
          recurrence: { kind: "daily", time: "09:00" },
        },
      },
    },
  };

  function arrangeBuilderBirthdayTask(
    status: "active" | "draft",
    node: { id: string; data: Record<string, unknown> } = builderBirthdayRoot
  ) {
    const scenarioId = new Types.ObjectId().toHexString();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({
        _id: new Types.ObjectId(),
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "bulk-root",
        campaignId: "campaign-1",
        channel: "whatsapp",
        provider: "meta",
        audienceSource: "birthday",
        requiresRevalidation: false,
        sourceId: "source-1",
        recipientPhone: "+15550000001",
        templateName: "birthday_offer",
        templateLanguage: "en",
        templateCategory: "MARKETING",
        templateComponents: [],
        attempts: 1,
      })
    );
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "conversation",
        status,
        nodes: [node],
      })
    );
    return scenarioId;
  }

  it("delivers a builder birthday task from an active conversation-mode scenario", async () => {
    const scenarioId = arrangeBuilderBirthdayTask("active");

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId: "workspace-1",
      deletedAt: null,
    });
    expect(result.completed).toBe(1);
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: "birthday_offer" })
    );
  });

  it("skips a conversation-mode task whose node is not a builder birthday root", async () => {
    // A legacy scenario that gained a trigger turns into a conversation; its
    // pending tasks must stop as they did under the old mode filter.
    arrangeBuilderBirthdayTask("active", {
      id: "bulk-root",
      data: { kind: "action", actionType: "whatsapp_template" },
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.skipped).toBe(1);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          skipReason: "dynamic_revalidation_scenario_missing",
        }),
      })
    );
  });

  it("skips a builder birthday task once its scenario is no longer active", async () => {
    arrangeBuilderBirthdayTask("draft");

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.skipped).toBe(1);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          skipReason: "dynamic_revalidation_scenario_inactive",
        }),
      })
    );
  });

  it("does not skip a revalidated WhatsApp marketing task only because opt-in is missing", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId().toHexString();
    const taskId = new Types.ObjectId();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({
        _id: taskId,
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        conversationId,
        campaignId: "campaign-1",
        recipientPhone: "15550000001",
        channel: "whatsapp",
        provider: "meta",
        audienceSource: "dynamic",
        requiresRevalidation: true,
        templateName: "promo",
        templateLanguage: "en",
        templateCategory: "MARKETING",
        templateComponents: [],
        attempts: 1,
      })
    );
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        nodes: [{ id: "node-1", data: { templateCategory: "MARKETING" } }],
      })
    );

    mockConversationFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(conversationId),
        workspaceId: "workspace-1",
        channel: "whatsapp",
        user: "wa_15550000001",
        whatsapp_opt_in: { status: false },
      })
    );

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.completed).toBe(1);
    expect(mockCampaignDeliveryTaskUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          skipReason: "dynamic_whatsapp_opt_out",
        }),
      })
    );
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        recipient: { phone: "15550000001" },
        templateCategory: "MARKETING",
      })
    );
  });

  it("sends direct Telegram birthday tasks with the selected bot token", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const taskId = new Types.ObjectId();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({
        _id: taskId,
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "bulk-root",
        campaignId: "campaign-1",
        channel: "telegram",
        provider: "telegram",
        audienceSource: "birthday",
        requiresRevalidation: false,
        sourceId: "source-1",
        recipientChatId: "123456",
        recipientName: "Aibek",
        messageText: "Happy birthday Aibek",
        attempts: 1,
      })
    );
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        nodes: [{ id: "bulk-root", data: { kind: "bulk" } }],
      })
    );
    mockSendCampaignTransportSingle.mockResolvedValueOnce({
      success: true,
      provider: "telegram",
      recipient: "123456",
      messageId: "telegram-message-1",
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.completed).toBe(1);
    expect(mockResolveTelegramSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledWith({
      channel: "telegram",
      recipient: { chatId: "123456" },
      messageText: "Happy birthday Aibek",
      botToken: "bot-token",
    });
    expect(mockMarkTelegramSubscriberSendResult).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      chatId: "123456",
      success: true,
      error: null,
    });
  });

  it("records Telegram provider failures against the subscriber", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({
        _id: new Types.ObjectId(),
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "bulk-root",
        campaignId: "campaign-1",
        channel: "telegram",
        provider: "telegram",
        audienceSource: "birthday",
        requiresRevalidation: false,
        sourceId: "source-1",
        recipientChatId: "123456",
        messageText: "Happy birthday",
        attempts: 1,
      })
    );
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        nodes: [{ id: "bulk-root", data: { kind: "bulk" } }],
      })
    );
    mockSendCampaignTransportSingle.mockResolvedValueOnce({
      success: false,
      provider: "telegram",
      recipient: "123456",
      error: "bot was blocked",
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.retried).toBe(1);
    expect(mockMarkTelegramSubscriberSendResult).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      chatId: "123456",
      success: false,
      error: "bot was blocked",
    });
  });
});

describe("drainCampaignDeliveryTasks classification freshness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCampaignEmailBatchEnabled.mockReturnValue(false);
    mockConnectDB.mockResolvedValue(undefined);
    mockCampaignDeliveryTaskUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({});
    mockCampaignDeliveryTaskCountDocuments.mockResolvedValue(0);
    mockCampaignDeliveryTaskFindOne.mockReturnValue(sortSelectLeanQuery(null));
    mockCampaignDeliveryTaskFind.mockReset();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReset();
    mockConversationFindOne.mockReset();
    mockScenarioFindOne.mockReset();
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      messagingAccountId: "messaging-1",
    });
    mockResolveTelegramSendContext.mockResolvedValue({
      sourceId: "source-1",
      botToken: "bot-token",
    });
    mockSendCampaignTransportSingle.mockResolvedValue({
      success: true,
      provider: "postmark",
      recipient: "person@example.com",
      messageId: "message-1",
    });
    mockSendCampaignTransportBatch.mockResolvedValue({
      success: true,
      results: [
        {
          success: true,
          provider: "postmark",
          recipient: "person@example.com",
          messageId: "message-1",
        },
      ],
    });
    mockPersistCampaignMessageSentWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockPersistCampaignMessageAttemptWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockClassifyCampaignTransportFailure.mockReturnValue({
      failureScope: "unknown",
    });
  });

  function mockActiveScenario(scenarioId: string, nodeData: object) {
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        nodes: [{ id: "node-1", data: nodeData }],
      })
    );
  }

  function categoryTask(params: {
    taskId: Types.ObjectId;
    scenarioId: string;
    conversationId: string;
    channel: "whatsapp" | "telegram" | "email";
    deliveryMode?: "single" | "batch";
  }) {
    return {
      _id: params.taskId,
      workspaceId: "workspace-1",
      scenarioId: params.scenarioId,
      nodeId: "node-1",
      conversationId: params.conversationId,
      campaignId: "campaign-1",
      channel: params.channel,
      provider:
        params.channel === "whatsapp"
          ? "meta"
          : params.channel === "telegram"
            ? "telegram"
            : "postmark",
      deliveryMode: params.deliveryMode || "single",
      audienceSource: "dynamic",
      requiresRevalidation: true,
      recipientPhone:
        params.channel === "whatsapp" ? "+15550000001" : undefined,
      recipientChatId: params.channel === "telegram" ? "123456" : undefined,
      recipientEmail:
        params.channel === "email" ? "person@example.com" : undefined,
      sourceId: params.channel === "telegram" ? "source-1" : undefined,
      templateName: params.channel === "whatsapp" ? "promo" : undefined,
      templateLanguage: "en",
      templateComponents: [],
      messageText: params.channel === "telegram" ? "Hello" : undefined,
      emailTemplateKey: params.channel === "email" ? "announcement" : undefined,
      emailTemplateModel: {},
      attempts: 1,
    };
  }

  it("rejects a stale category-targeted conversation at load", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId().toHexString();
    const task = categoryTask({
      taskId: new Types.ObjectId(),
      scenarioId,
      conversationId,
      channel: "email",
    });
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery(task)
    );
    mockActiveScenario(scenarioId, { category: "active" });
    const loadQuery = selectLeanQuery({
      _id: new Types.ObjectId(conversationId),
      classification: { category: "active" },
    });
    mockConversationFindOne.mockReturnValueOnce(loadQuery);

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({ completed: 0, skipped: 1 })
    );
    expect(loadQuery.select).toHaveBeenCalledWith(
      expect.stringContaining(CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT)
    );
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockSendCampaignTransportBatch).not.toHaveBeenCalled();
  });

  it.each(["whatsapp", "telegram", "email"] as const)(
    "rechecks captured identity after %s transport preparation and sends nothing on a miss",
    async channel => {
      const scenarioId = new Types.ObjectId().toHexString();
      const conversationId = new Types.ObjectId().toHexString();
      const task = categoryTask({
        taskId: new Types.ObjectId(),
        scenarioId,
        conversationId,
        channel,
      });
      mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
        leanQuery(task)
      );
      mockActiveScenario(scenarioId, { category: "active" });
      mockConversationFindOne
        .mockReturnValueOnce(
          selectLeanQuery({
            _id: new Types.ObjectId(conversationId),
            ...currentClassification("active"),
          })
        )
        .mockReturnValueOnce(selectLeanQuery(null));

      const result = await drainCampaignDeliveryTasks({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        batchLimit: 1,
      });

      expect(result).toEqual(
        expect.objectContaining({ completed: 0, skipped: 1 })
      );
      expect(mockConversationFindOne).toHaveBeenNthCalledWith(2, {
        ...capturedCurrentCategoryQuery({
          conversationId,
          category: "active",
          revision: 11,
        }),
      });
      expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
      expect(mockSendCampaignTransportBatch).not.toHaveBeenCalled();
    }
  );

  it("keeps manual-label-only dynamic delivery independent", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId().toHexString();
    const task = categoryTask({
      taskId: new Types.ObjectId(),
      scenarioId,
      conversationId,
      channel: "email",
    });
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery(task)
    );
    mockActiveScenario(scenarioId, { internalLabel: "vip" });
    mockConversationFindOne.mockReturnValueOnce(
      selectLeanQuery({
        _id: new Types.ObjectId(conversationId),
        internal_labels: ["vip"],
        classification: { category: "stale-value" },
      })
    );

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.completed).toBe(1);
    expect(mockConversationFindOne).toHaveBeenCalledTimes(1);
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledTimes(1);
  });

  it("rejects stale category data at email batch load", async () => {
    mockIsCampaignEmailBatchEnabled.mockReturnValue(true);
    const scenarioId = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId().toHexString();
    const task = categoryTask({
      taskId: new Types.ObjectId(),
      scenarioId,
      conversationId,
      channel: "email",
      deliveryMode: "batch",
    });
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery(task)
    );
    mockActiveScenario(scenarioId, { category: "active" });
    mockConversationFindOne.mockReturnValueOnce(
      selectLeanQuery({
        _id: new Types.ObjectId(conversationId),
        classification: { category: "active" },
      })
    );

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({ completed: 0, skipped: 1 })
    );
    expect(mockSendCampaignTransportBatch).not.toHaveBeenCalled();
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
  });

  it("keeps email batch request/result alignment after a final identity miss", async () => {
    mockIsCampaignEmailBatchEnabled.mockReturnValue(true);
    const scenarioId = new Types.ObjectId().toHexString();
    const firstConversationId = new Types.ObjectId().toHexString();
    const secondConversationId = new Types.ObjectId().toHexString();
    const firstTask = categoryTask({
      taskId: new Types.ObjectId(),
      scenarioId,
      conversationId: firstConversationId,
      channel: "email",
      deliveryMode: "batch",
    });
    firstTask.recipientEmail = "first@example.com";
    const secondTask = categoryTask({
      taskId: new Types.ObjectId(),
      scenarioId,
      conversationId: secondConversationId,
      channel: "email",
      deliveryMode: "batch",
    });
    secondTask.recipientEmail = "second@example.com";
    mockCampaignDeliveryTaskFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(firstTask))
      .mockReturnValueOnce(leanQuery(secondTask));
    mockCampaignDeliveryTaskFind.mockReturnValue(
      sortLimitSelectLeanQuery([{ _id: secondTask._id }])
    );
    mockActiveScenario(scenarioId, { category: "active" });
    mockConversationFindOne
      .mockReturnValueOnce(
        selectLeanQuery({
          _id: new Types.ObjectId(firstConversationId),
          ...currentClassification("active", 21),
        })
      )
      .mockReturnValueOnce(
        selectLeanQuery({
          _id: new Types.ObjectId(secondConversationId),
          ...currentClassification("active", 22),
        })
      )
      .mockReturnValueOnce(
        selectLeanQuery({ _id: new Types.ObjectId(firstConversationId) })
      )
      .mockReturnValueOnce(selectLeanQuery(null))
      .mockReturnValueOnce(
        selectLeanQuery({ _id: new Types.ObjectId(firstConversationId) })
      );
    mockSendCampaignTransportBatch.mockResolvedValueOnce({
      success: true,
      results: [
        {
          success: true,
          provider: "postmark",
          recipient: "first@example.com",
          messageId: "first-message",
        },
      ],
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 2,
    });

    expect(result).toEqual(
      expect.objectContaining({ completed: 1, skipped: 1 })
    );
    expect(mockSendCampaignTransportBatch).toHaveBeenCalledWith({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        expect.objectContaining({ recipient: { email: "first@example.com" } }),
      ],
    });
    const skippedUpdateIndex =
      mockCampaignDeliveryTaskUpdateOne.mock.calls.findIndex(
        ([, update]) =>
          (update as { $set?: { status?: string } }).$set?.status === "skipped"
      );
    expect(skippedUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(
      mockCampaignDeliveryTaskUpdateOne.mock.invocationCallOrder[
        skippedUpdateIndex
      ]
    ).toBeLessThan(mockConversationFindOne.mock.invocationCallOrder[4]);
    expect(mockConversationFindOne.mock.invocationCallOrder[4]).toBeLessThan(
      mockSendCampaignTransportBatch.mock.invocationCallOrder[0]
    );
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
  });

  it("persists successful batch results before a second-pass miss write can fail", async () => {
    mockIsCampaignEmailBatchEnabled.mockReturnValue(true);
    const scenarioId = new Types.ObjectId().toHexString();
    const firstConversationId = new Types.ObjectId().toHexString();
    const secondConversationId = new Types.ObjectId().toHexString();
    const firstTask = categoryTask({
      taskId: new Types.ObjectId(),
      scenarioId,
      conversationId: firstConversationId,
      channel: "email",
      deliveryMode: "batch",
    });
    firstTask.recipientEmail = "first@example.com";
    const secondTask = categoryTask({
      taskId: new Types.ObjectId(),
      scenarioId,
      conversationId: secondConversationId,
      channel: "email",
      deliveryMode: "batch",
    });
    secondTask.recipientEmail = "second@example.com";
    mockCampaignDeliveryTaskFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(firstTask))
      .mockReturnValueOnce(leanQuery(secondTask));
    mockCampaignDeliveryTaskFind.mockReturnValue(
      sortLimitSelectLeanQuery([{ _id: secondTask._id }])
    );
    mockActiveScenario(scenarioId, { category: "active" });
    mockConversationFindOne
      .mockReturnValueOnce(
        selectLeanQuery({
          _id: new Types.ObjectId(firstConversationId),
          ...currentClassification("active", 31),
        })
      )
      .mockReturnValueOnce(
        selectLeanQuery({
          _id: new Types.ObjectId(secondConversationId),
          ...currentClassification("active", 32),
        })
      )
      .mockReturnValueOnce(
        selectLeanQuery({ _id: new Types.ObjectId(firstConversationId) })
      )
      .mockReturnValueOnce(
        selectLeanQuery({ _id: new Types.ObjectId(secondConversationId) })
      )
      .mockReturnValueOnce(
        selectLeanQuery({ _id: new Types.ObjectId(firstConversationId) })
      )
      .mockReturnValueOnce(selectLeanQuery(null));
    mockSendCampaignTransportBatch.mockResolvedValueOnce({
      success: true,
      results: [
        {
          success: true,
          provider: "postmark",
          recipient: "first@example.com",
          messageId: "first-message",
        },
      ],
    });
    mockCampaignDeliveryTaskUpdateOne.mockImplementation((_, update) => {
      if (
        (update as { $set?: { status?: string } }).$set?.status === "skipped"
      ) {
        return Promise.reject(new Error("stale skip persistence failed"));
      }
      return Promise.resolve({});
    });

    await expect(
      drainCampaignDeliveryTasks({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        batchLimit: 2,
      })
    ).rejects.toThrow("stale skip persistence failed");

    expect(mockSendCampaignTransportBatch).toHaveBeenCalledWith({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        expect.objectContaining({ recipient: { email: "first@example.com" } }),
      ],
    });
    const skippedUpdateIndex =
      mockCampaignDeliveryTaskUpdateOne.mock.calls.findIndex(
        ([, update]) =>
          (update as { $set?: { status?: string } }).$set?.status === "skipped"
      );
    expect(mockConversationFindOne.mock.invocationCallOrder[5]).toBeLessThan(
      mockSendCampaignTransportBatch.mock.invocationCallOrder[0]
    );
    expect(
      mockSendCampaignTransportBatch.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockCampaignDeliveryTaskUpdateOne.mock.invocationCallOrder[
        skippedUpdateIndex
      ]
    );
    expect(mockPersistCampaignMessageSentWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "first-message" })
    );
    const completedUpdateIndex =
      mockCampaignDeliveryTaskUpdateOne.mock.calls.findIndex(
        ([, update]) =>
          (update as { $set?: { status?: string } }).$set?.status ===
          "completed"
      );
    expect(
      mockCampaignDeliveryTaskUpdateOne.mock.invocationCallOrder[
        completedUpdateIndex
      ]
    ).toBeLessThan(
      mockCampaignDeliveryTaskUpdateOne.mock.invocationCallOrder[
        skippedUpdateIndex
      ]
    );
  });
});

describe("drainCampaignDeliveryTasks dispatch expiry", () => {
  const now = new Date("2026-07-24T12:00:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    mockIsCampaignEmailBatchEnabled.mockReturnValue(false);
    mockConnectDB.mockResolvedValue(undefined);
    mockCampaignDeliveryTaskUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({});
    mockCampaignDeliveryTaskCountDocuments.mockResolvedValue(0);
    mockCampaignDeliveryTaskFindOne.mockReturnValue(sortSelectLeanQuery(null));
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValue(leanQuery(null));
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      messagingAccountId: "messaging-1",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not mark a merely due campaign started when the worker crashes before claiming", async () => {
    const pendingTaskId = new Types.ObjectId();
    mockCampaignDeliveryTaskFindOne.mockImplementation(
      (query: Record<string, unknown>) => {
        const queriesPendingTasks = JSON.stringify(query).includes('"pending"');
        return selectLeanQuery(
          queriesPendingTasks ? { _id: pendingTaskId } : null
        );
      }
    );
    mockCampaignDeliveryTaskFindOneAndUpdate.mockImplementationOnce(() => {
      throw new Error("simulated crash before atomic claim");
    });

    await expect(
      drainCampaignDeliveryTasks({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        batchLimit: 1,
      })
    ).rejects.toThrow("simulated crash before atomic claim");

    expect(mockCampaignDeliveryTaskUpdateMany).not.toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        campaignStartedAt: null,
      },
      {
        $set: {
          campaignStartedAt: now,
        },
      }
    );
  });

  it("establishes campaign start in the first atomic claim before propagating it", async () => {
    const taskId = new Types.ObjectId();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({ _id: taskId })
    );

    await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(mockCampaignDeliveryTaskFindOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "processing",
          campaignStartedAt: now,
        }),
      }),
      expect.anything()
    );
    const propagationCallIndex =
      mockCampaignDeliveryTaskUpdateMany.mock.calls.findIndex(
        ([query, update]) =>
          JSON.stringify(query) ===
            JSON.stringify({
              workspaceId: "workspace-1",
              campaignId: "campaign-1",
              campaignStartedAt: null,
            }) &&
          JSON.stringify(update) ===
            JSON.stringify({
              $set: {
                campaignStartedAt: now,
              },
            })
      );
    expect(propagationCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      mockCampaignDeliveryTaskFindOneAndUpdate.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockCampaignDeliveryTaskUpdateMany.mock.invocationCallOrder[
        propagationCallIndex
      ]
    );
  });

  it("continues a large campaign past its deadline after a real task start", async () => {
    const startEvidenceId = new Types.ObjectId();
    const campaignStartedAt = new Date("2026-07-24T11:45:00.000Z");
    const scenarioId = new Types.ObjectId().toHexString();
    const taskId = new Types.ObjectId();
    mockCampaignDeliveryTaskFindOne
      .mockReturnValueOnce(
        selectLeanQuery({ _id: startEvidenceId, campaignStartedAt })
      )
      .mockReturnValueOnce(sortSelectLeanQuery(null));
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({
        _id: taskId,
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        campaignId: "campaign-1",
        channel: "whatsapp",
        provider: "meta",
        audienceSource: "dynamic",
        requiresRevalidation: false,
        recipientPhone: "+15550000001",
        templateName: "promo",
        templateLanguage: "en",
        templateCategory: "MARKETING",
        templateComponents: [],
        dispatchAt: new Date("2026-07-24T11:40:00.000Z"),
        dispatchExpiresAt: new Date("2026-07-24T11:55:00.000Z"),
        campaignStartedAt,
        attempts: 1,
      })
    );
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        nodes: [{ id: "node-1", data: { templateCategory: "MARKETING" } }],
      })
    );
    mockSendCampaignTransportSingle.mockResolvedValue({
      success: true,
      provider: "meta",
      recipient: "+15550000001",
      messageId: "wamid.large-campaign-continuation",
    });
    mockPersistCampaignMessageSentWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockPersistCampaignMessageAttemptWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockClassifyCampaignTransportFailure.mockReturnValue({
      failureScope: "unknown",
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(mockCampaignDeliveryTaskUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        campaignStartedAt: null,
      },
      {
        $set: {
          campaignStartedAt,
        },
      }
    );
    expect(mockCampaignDeliveryTaskFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        $or: expect.arrayContaining([{ campaignStartedAt: { $ne: null } }]),
      }),
      expect.anything(),
      expect.anything()
    );
    expect(mockCampaignDeliveryTaskFindOne).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      $or: [
        { campaignStartedAt: { $ne: null } },
        {
          status: {
            $in: ["processing", "completed", "failed_terminal"],
          },
        },
        {
          status: { $in: ["retry", "skipped"] },
          attempts: { $gt: 0 },
        },
      ],
    });
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("atomically skips expired due tasks and excludes them from claims", async () => {
    mockCampaignDeliveryTaskUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    const legacyExpiryCutoff = new Date("2026-07-24T11:45:00.000Z");
    expect(mockCampaignDeliveryTaskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        status: { $in: ["pending", "retry"] },
        dispatchAt: { $lte: now },
        $and: [
          { campaignStartedAt: null },
          {
            $or: [
              { dispatchExpiresAt: { $lte: now } },
              {
                dispatchExpiresAt: null,
                dispatchAt: { $lte: legacyExpiryCutoff },
              },
            ],
          },
        ],
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          skipReason: "dispatch_expired",
          completedAt: now,
        }),
      })
    );
    expect(mockCampaignDeliveryTaskFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        status: { $in: ["pending", "retry"] },
        dispatchAt: { $lte: now },
        $or: [
          { campaignStartedAt: { $ne: null } },
          { dispatchExpiresAt: { $gt: now } },
          {
            dispatchExpiresAt: null,
            dispatchAt: { $gt: legacyExpiryCutoff },
          },
        ],
      }),
      expect.anything(),
      expect.anything()
    );
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("terminalizes expired stale processing leases instead of requeueing them", async () => {
    mockCampaignDeliveryTaskUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 0 });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    const staleLeaseCutoff = new Date("2026-07-24T11:40:00.000Z");
    const legacyExpiryCutoff = new Date("2026-07-24T11:45:00.000Z");
    expect(mockCampaignDeliveryTaskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        status: "processing",
        processingStartedAt: { $ne: null, $lte: staleLeaseCutoff },
        $and: [
          { campaignStartedAt: null },
          {
            $or: [
              { dispatchExpiresAt: { $lte: now } },
              {
                dispatchExpiresAt: null,
                dispatchAt: { $lte: legacyExpiryCutoff },
              },
            ],
          },
        ],
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          skipReason: "dispatch_expired",
          completedAt: now,
        }),
      })
    );
    expect(mockCampaignDeliveryTaskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        status: "processing",
        processingStartedAt: { $ne: null, $lte: staleLeaseCutoff },
        $or: [
          { campaignStartedAt: { $ne: null } },
          { dispatchExpiresAt: { $gt: now } },
          {
            dispatchExpiresAt: null,
            dispatchAt: { $gt: legacyExpiryCutoff },
          },
        ],
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "retry",
          dispatchAt: now,
        }),
      })
    );
    expect(result.recoveredStale).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("pins a legacy task expiry when scheduling a retry", async () => {
    const scenarioId = new Types.ObjectId().toHexString();
    const taskId = new Types.ObjectId();
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce(
      leanQuery({
        _id: taskId,
        workspaceId: "workspace-1",
        scenarioId,
        nodeId: "node-1",
        campaignId: "campaign-1",
        channel: "whatsapp",
        provider: "meta",
        audienceSource: "dynamic",
        requiresRevalidation: false,
        recipientPhone: "+15550000001",
        templateName: "promo",
        templateLanguage: "en",
        templateCategory: "MARKETING",
        templateComponents: [],
        dispatchAt: new Date("2026-07-24T11:55:00.000Z"),
        attempts: 1,
      })
    );
    mockScenarioFindOne.mockReturnValue(
      selectLeanQuery({
        _id: new Types.ObjectId(scenarioId),
        workspaceId: "workspace-1",
        mode: "bulk_campaign",
        status: "active",
        nodes: [{ id: "node-1", data: { templateCategory: "MARKETING" } }],
      })
    );
    mockSendCampaignTransportSingle.mockResolvedValue({
      success: false,
      provider: "meta",
      recipient: "+15550000001",
      error: "temporary provider failure",
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.retried).toBe(1);
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      {
        _id: taskId.toString(),
        status: "processing",
        processingLeaseId: expect.any(String),
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "retry",
          dispatchExpiresAt: new Date("2026-07-24T12:10:00.000Z"),
        }),
      })
    );
  });
});

describe("finalizeCampaignExecution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCampaignHistoryTotal();
    mockCampaignDeliveryTaskAggregate.mockResolvedValue([
      { _id: "completed", count: 41 },
      { _id: "failed_terminal", count: 3 },
      { _id: "skipped", count: 6 },
    ]);
    mockReconcileLegacyCampaignSendTotals.mockResolvedValue({ ok: true });
  });

  it("persists scheduled-engine totals from the durable task ledger", async () => {
    await expect(
      finalizeCampaignExecution({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
      })
    ).resolves.toBeUndefined();

    expect(mockCampaignDeliveryTaskAggregate).toHaveBeenCalledWith([
      {
        $match: {
          workspaceId: "workspace-1",
          campaignId: "campaign-1",
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          unresolvedProviderAcceptance: {
            $sum: {
              $cond: [
                { $eq: ["$skipReason", "provider_acceptance_unknown"] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    expect(mockReconcileLegacyCampaignSendTotals).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      totals: {
        successfulSends: 41,
        failedSends: 9,
      },
    });
  });

  it("rejects unknown task statuses instead of persisting false terminal totals", async () => {
    mockCampaignDeliveryTaskAggregate.mockResolvedValue([
      { _id: "completed", count: 41 },
      { _id: "failed_terminal", count: 3 },
      { _id: "skipped", count: 5 },
      { _id: "legacy_unknown", count: 1 },
    ]);

    await expect(
      finalizeCampaignExecution({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
      })
    ).rejects.toThrow("Campaign delivery task status is unknown");

    expect(mockReconcileLegacyCampaignSendTotals).not.toHaveBeenCalled();
  });

  it("requires the terminal task count to match the persisted audience", async () => {
    mockCampaignDeliveryTaskAggregate.mockResolvedValue([
      { _id: "completed", count: 41 },
      { _id: "failed_terminal", count: 3 },
      { _id: "skipped", count: 5 },
    ]);

    await expect(
      finalizeCampaignExecution({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
      })
    ).rejects.toThrow(
      "Campaign terminal task count does not match total recipients"
    );

    expect(mockReconcileLegacyCampaignSendTotals).not.toHaveBeenCalled();
  });

  it("does not turn unresolved provider acceptance into failed-send totals", async () => {
    mockCampaignDeliveryTaskAggregate.mockResolvedValue([
      { _id: "completed", count: 49, unresolvedProviderAcceptance: 0 },
      { _id: "failed_terminal", count: 1, unresolvedProviderAcceptance: 1 },
    ]);
    await expect(
      finalizeCampaignExecution({ workspaceId: "workspace-1", campaignId: "campaign-1" })
    ).rejects.toThrow("Campaign provider acceptance is unresolved");
    expect(mockReconcileLegacyCampaignSendTotals).not.toHaveBeenCalled();
  });
});

describe("drainCampaignDeliveryTasks canonical ledger finalization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCampaignEmailBatchEnabled.mockReturnValue(false);
    mockConnectDB.mockResolvedValue(undefined);
    mockCampaignDeliveryTaskUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({});
    mockCampaignDeliveryTaskCountDocuments.mockResolvedValue(0);
    mockConversationFindOne.mockReset();
    mockCampaignDeliveryTaskFindOne.mockReturnValue(sortSelectLeanQuery(null));
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      messagingAccountId: "messaging-1",
    });
    mockSendCampaignTransportSingle.mockResolvedValue({
      success: true,
      provider: "meta",
      recipient: "15550000001",
      messageId: "wamid.success",
    });
    mockPersistCampaignMessageSentWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockPersistCampaignMessageAttemptWithOutbox.mockResolvedValue({
      applied: true,
      queuedToOutbox: false,
    });
    mockClassifyCampaignTransportFailure.mockReturnValue({
      providerCode: "131026",
      failureScope: "recipient",
    });
  });

  function claimTask(overrides: Record<string, unknown> = {}) {
    const scenarioId = new Types.ObjectId().toHexString();
    const taskId = new Types.ObjectId();
    const task = {
      _id: taskId,
      workspaceId: "workspace-1",
      scenarioId,
      nodeId: "node-1",
      campaignId: "campaign-1",
      channel: "whatsapp",
      provider: "meta",
      executionSource: "scenario_schedule",
      audienceSource: "dynamic",
      requiresRevalidation: false,
      recipientPhone: "15550000001",
      recipientHash: "a".repeat(64),
      templateName: "promo",
      templateLanguage: "en",
      templateCategory: "MARKETING",
      templateComponents: [],
      attempts: 5,
      ...overrides,
    };
    mockCampaignDeliveryTaskFindOneAndUpdate.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue(task),
    });
    mockScenarioFindOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(scenarioId),
          workspaceId: "workspace-1",
          mode: "bulk_campaign",
          status: "active",
          nodes: [{ id: "node-1", data: { templateCategory: "MARKETING" } }],
        }),
      }),
    });
    return { taskId, scenarioId, task };
  }

  it("records a durable lease-owned intent immediately before provider dispatch", async () => {
    const { taskId } = claimTask({ attempts: 1 });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    let intentWrittenBeforeSend = false;
    mockSendCampaignTransportSingle.mockImplementationOnce(async request => {
      await request.beforeProviderSend?.();
      intentWrittenBeforeSend = mockCampaignDeliveryTaskUpdateOne.mock.calls.some(
        ([query, update, options]) =>
          query._id === taskId.toHexString() &&
          query.status === "processing" &&
          query.processingLeaseId &&
          query.providerAttemptStartedAt === null &&
          update.$set.providerAttemptStartedAt instanceof Date &&
          update.$set.providerAttemptSourceId === "source-1" &&
          update.$set.providerAttemptPhoneNumberId === "phone-number-id" &&
          update.$set.providerAttemptRecipient === "15550000001" &&
          options?.writeConcern?.w === "majority"
      );
      return { success: true, provider: "meta", recipient: "15550000001", messageId: "wamid.accepted" };
    });
    mockResolveWhatsAppSendContext.mockResolvedValueOnce({ sourceId: "source-1", phoneNumberId: "phone-number-id", accessToken: "access-token" });
    const result = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(intentWrittenBeforeSend).toBe(true);
    expect(result.completed).toBe(1);
  });

  it.each(["database error", "lease lost"])(
    "does not cross the provider boundary when recording intent fails: %s",
    async kind => {
      claimTask({ attempts: 1 });
      mockCampaignDeliveryTaskUpdateOne.mockImplementation(async (_query, update) => {
        if (update.$set.providerAttemptStartedAt instanceof Date) {
          if (kind === "database error") throw new Error("write unavailable");
          return { modifiedCount: 0 };
        }
        return { modifiedCount: 1 };
      });
      let providerPosts = 0;
      mockSendCampaignTransportSingle.mockImplementationOnce(async request => {
        await request.beforeProviderSend?.();
        providerPosts += 1;
        return { success: true, provider: "meta", recipient: "15550000001", messageId: "wamid.unexpected" };
      });
      const result = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
      expect(providerPosts).toBe(0);
      expect(result.retried).toBe(1);
    }
  );

  it("reconciles a reclaimed attempted task without making a second provider request", async () => {
    claimTask({ attempts: 2, providerAttemptStartedAt: new Date("2026-09-18T15:00:00Z") });
    const result = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(result.retried).toBe(1);
    expect(mockFindCampaignMessageAcceptance).toHaveBeenCalledTimes(1);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous provider attempt for acceptance-only reconciliation", async () => {
    const { task } = claimTask({ attempts: 1 });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockSendCampaignTransportSingle.mockImplementationOnce(async request => {
      await request.beforeProviderSend?.();
      return { success: false, provider: "meta", recipient: "15550000001", error: "response lost", providerRequestAttempted: true, providerAcceptanceUnknown: true };
    });
    const first = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(first.retried).toBe(1);
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ status: "retry", lastError: "provider_acceptance_unknown" }) })
    );
    expect(mockCampaignDeliveryTaskUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ $set: { providerAttemptStartedAt: null } }), expect.anything()
    );
    claimTask({ ...task, attempts: 2, providerAttemptStartedAt: new Date() });
    const next = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(next.retried).toBe(1);
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledTimes(1);
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("recovers a lost POST response through a real status handler and exact task receipt without another POST", async () => {
    const { task } = claimTask({ attempts: 1, sourceId: "source-1" });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockResolveWhatsAppSendContext.mockResolvedValueOnce({ sourceId: "source-1", phoneNumberId: "phone-1", accessToken: "token" });
    let callback: string | undefined;
    mockSendCampaignTransportSingle.mockImplementationOnce(async request => {
      await request.beforeProviderSend();
      callback = request.bizOpaqueCallbackData;
      return { success: false, provider: "meta", recipient: "15550000001", error: "connection reset after acceptance", providerRequestAttempted: true, providerAcceptanceUnknown: true };
    });
    const first = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(first.retried).toBe(1);
    expect(mockTaskSendReceipts.size).toBe(0);

    mockCampaignDeliveryTaskFindOne.mockReturnValueOnce(selectLeanQuery(task));
    const persistedStatuses: unknown[] = [];
    const statusHandler = createWhatsAppStatusWebhookHandler({
      buildWhatsAppWebhookSourceSkipPayload: () => ({}),
      findOpenWhatsAppConversationByChatId: async () => null,
      findOriginalMessageChatIdByMessageId: async () => null,
      getWhatsAppWebhookSourceSkip: () => null,
      persistCampaignMessageStatusWithOutbox: async status => { persistedStatuses.push(status); return { applied: true }; },
      recordCampaignTaskProviderAcceptance: createCampaignTaskProviderAcceptance({
        taskModel: { findOne: (...args: unknown[]) => mockCampaignDeliveryTaskFindOne(...args) },
        persistCampaignMessageSentWithOutbox: (...args: unknown[]) => mockPersistCampaignMessageSentWithOutbox(...args),
      }),
      realtimeTrigger: async () => undefined,
      recordWhatsAppMessageDeliveryStatus: async () => ({ recorded: true }),
      resolveWhatsAppSourceByAccountIdentifiers: async () => ({ id: "source-1", workspace_id: "workspace-1" }),
      trackScenarioFlowReadByMessageId: async () => undefined,
      updateChatWhatsAppUserId: async () => undefined,
      updateUserWhatsAppUserId: async () => undefined,
    });
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null }), single: async () => ({ data: null }) };
    const response = await statusHandler({
      providerSignatureVerified: true,
      requestLogger: { error: jest.fn(), info: jest.fn(), success: jest.fn(), warn: jest.fn() },
      supabase: { from: () => query },
      body: { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "phone-1" },
        statuses: [{ id: "wamid.late-status", status: "delivered", timestamp: "1789743600", recipient_id: "15550000001", biz_opaque_callback_data: callback }],
      } }] }] },
    });
    expect(response?.status).toBe(200);
    expect(mockTaskSendReceipts.size).toBe(1);
    expect(mockPersistCampaignMessageSentWithOutbox).toHaveBeenCalledWith(expect.objectContaining({ messageId: "wamid.late-status", recipient: "15550000001" }));
    expect(persistedStatuses).toEqual([expect.objectContaining({ messageId: "wamid.late-status", updateData: expect.objectContaining({ status: "delivered" }) })]);

    claimTask({ ...task, attempts: 2 });
    const recovered = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(recovered.completed).toBe(1);
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledTimes(1);
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("clears the intent only after a confirmed provider rejection", async () => {
    claimTask({ attempts: 1 });
    mockCampaignDeliveryTaskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockSendCampaignTransportSingle.mockImplementationOnce(async request => {
      await request.beforeProviderSend?.();
      return { success: false, provider: "meta", recipient: "15550000001", error: "rate limited", providerCode: "130429", failureScope: "provider", providerRequestAttempted: true };
    });
    const result = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(result.retried).toBe(1);
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", processingLeaseId: expect.any(String), providerAttemptStartedAt: expect.any(Date) }),
      { $set: { providerAttemptStartedAt: null } },
      { writeConcern: { w: "majority" } }
    );
  });

  it("retains an attempt after the acceptance reconciliation budget without writing a false rejection", async () => {
    claimTask({ attempts: 5, providerAttemptStartedAt: new Date() });
    const result = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(result.failedTerminal).toBe(1);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ status: "failed_terminal", skipReason: "provider_acceptance_unknown", lastError: "provider_acceptance_unknown" }) })
    );
  });

  it("does not resend a legacy attempted task without a campaign acceptance identity", async () => {
    claimTask({ attempts: 2, campaignId: null, providerAttemptStartedAt: new Date() });
    const result = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(result.retried).toBe(1);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
  });

  it("keeps a pre-provider preparation failure on its existing retry path without recording intent", async () => {
    claimTask({ attempts: 1 });
    mockSendCampaignTransportSingle.mockResolvedValueOnce({ success: false, provider: "meta", recipient: "15550000001", error: "media preparation unavailable", failureScope: "unknown" });
    const result = await drainCampaignDeliveryTasks({ workspaceId: "workspace-1", campaignId: "campaign-1", batchLimit: 1 });
    expect(result.retried).toBe(1);
    expect(mockCampaignDeliveryTaskUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ $set: { providerAttemptStartedAt: expect.any(Date) } }), expect.anything()
    );
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ lastError: "media preparation unavailable" }) })
    );
  });

  it("skips a recurring WhatsApp task before provider I/O when its campaign circuit is open", async () => {
    const { taskId } = claimTask({ audienceSource: "birthday" });
    mockGetCampaignDispatchProviderCircuit.mockResolvedValueOnce({
      state: "open",
      provider: "meta",
      code: "131048",
    });
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.skipped).toBe(1);
    expect(result.failedTerminal).toBe(0);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: taskId.toHexString(),
        status: "processing",
      }),
      {
        $set: expect.objectContaining({
          status: "skipped",
          skipReason: "provider_circuit_open",
        }),
      }
    );
  });

  it("repairs an accepted task from its receipt even when the campaign circuit opened before retry", async () => {
    const first = claimTask({ attempts: 1 });
    mockPersistCampaignMessageSentWithOutbox.mockResolvedValueOnce({
      applied: false,
      queuedToOutbox: false,
    });
    const initial = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(initial.retried).toBe(1);
    expect(mockTaskSendReceipts.size).toBe(1);
    mockGetCampaignDispatchProviderCircuit.mockResolvedValue({
      state: "open",
      provider: "meta",
      code: "131048",
    });
    claimTask({ ...first.task, attempts: 2, providerAttemptStartedAt: new Date() });
    const replay = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(replay.completed).toBe(1);
    expect(replay.skipped).toBe(0);
    expect(mockSendCampaignTransportSingle).toHaveBeenCalledTimes(1);
    expect(mockPersistCampaignMessageSentWithOutbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "wamid.success" })
    );
  });

  it("recovers canonical acceptance before a new provider block when the auxiliary receipt was lost", async () => {
    const { taskId } = claimTask({ attempts: 2, providerAttemptStartedAt: new Date() });
    const owners = {
      hint: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest
        .fn()
        .mockResolvedValue([
          {
            _id: taskId,
            workspaceId: "workspace-1",
            campaignId: "campaign-1",
            channel: "whatsapp",
            recipientPhone: "+1 (555) 000-00-01",
          },
        ]),
    };
    mockCampaignDeliveryTaskFind.mockReturnValue(owners);
    mockFindCampaignMessageAcceptance.mockResolvedValueOnce({
      messageId: "wamid.previously-accepted",
    });
    mockGetCampaignDispatchProviderCircuit.mockResolvedValue({
      state: "open",
      provider: "meta",
      code: "131048",
    });
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(owners.hint).toHaveBeenCalledWith("campaignId_1");
    expect(owners.maxTimeMS).toHaveBeenCalledWith(2_000);
    expect(owners.limit).toHaveBeenCalledWith(2);
    expect(mockFindCampaignMessageAcceptance).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      channel: "whatsapp",
      recipient: "15550000001",
      provider: "meta",
      pendingMessageId: "campaign-delivery-task:" + taskId.toHexString(),
    });
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockGetWABASendingReadiness).not.toHaveBeenCalled();
    expect(mockGetCampaignDispatchProviderCircuit).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageSentWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "wamid.previously-accepted" })
    );
  });
  it("retries uncertain canonical acceptance without sending or replacing it with failure", async () => {
    claimTask({ attempts: 5 });
    mockFindCampaignMessageAcceptance.mockRejectedValueOnce(
      new Error("acceptance store unavailable")
    );
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.retried).toBe(1);
    expect(result.failedTerminal).toBe(0);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });
  it.each([
    "77010000001",
    "+7 (701) 000-00-01",
    "wa_87010000001",
    null,
    "not-a-phone",
  ])(
    "does not attribute another task's acceptance to a shared or unknown recipient (%s)",
    async otherPhone => {
      const { taskId } = claimTask({
        attempts: 1,
        recipientPhone: "77010000001",
      });
      const siblingId = new Types.ObjectId();
      mockFindCampaignMessageAcceptance.mockResolvedValueOnce({
        messageId: "wamid.sibling-accepted",
      });
      mockCampaignDeliveryTaskFind.mockReturnValue({
        hint: jest.fn().mockReturnThis(),
        maxTimeMS: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { _id: taskId, recipientPhone: "77010000001" },
          { _id: siblingId, recipientPhone: otherPhone },
        ]),
      });
      const result = await drainCampaignDeliveryTasks({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        batchLimit: 1,
      });
      expect(result.retried).toBe(1);
      expect(result.completed).toBe(0);
      expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
      expect(mockPersistCampaignMessageSentWithOutbox).not.toHaveBeenCalled();
      const lookup = mockCampaignDeliveryTaskFind.mock.calls.at(-1)?.[0];
      expect(lookup).toMatchObject({
        workspaceId: "workspace-1",
        campaignId: "campaign-1",
        channel: "whatsapp",
      });
      expect(
        lookup.$or[0].recipientPhone.test(String(otherPhone || "")) ||
          !lookup.$or[1].recipientPhone.$not.test(String(otherPhone || ""))
      ).toBe(true);
    }
  );
  it("keeps task ownership uncertainty from completing or resending an accepted message", async () => {
    claimTask({ attempts: 2 });
    mockFindCampaignMessageAcceptance.mockResolvedValueOnce({
      messageId: "wamid.accepted",
    });
    mockCampaignDeliveryTaskFind.mockReturnValue({
      hint: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockRejectedValue(new Error("MaxTimeMSExpired")),
    });
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.retried).toBe(1);
    expect(result.completed).toBe(0);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageSentWithOutbox).not.toHaveBeenCalled();
  });
  it("does not infer a changed recipient when an old task lacks its acceptance identity", async () => {
    claimTask({ attempts: 2, recipientPhone: null });
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.retried).toBe(1);
    expect(mockFindCampaignMessageAcceptance).not.toHaveBeenCalled();
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("checks the task's selected source and skips new provider I/O while its business is blocked", async () => {
    claimTask({ sourceId: "selected-source" });
    mockGetWABASendingReadiness.mockResolvedValueOnce({
      state: "blocked",
      checkedAt: new Date().toISOString(),
      remainingCapacity: null,
      reasons: [{ code: "meta_business_limit", providerCode: "141015" }],
    });
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "selected-source",
    });
    expect(result.skipped).toBe(1);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("retries a health lookup outage without recording a recipient delivery failure", async () => {
    claimTask();
    mockGetWABASendingReadiness.mockResolvedValueOnce({
      state: "unavailable",
      checkedAt: new Date().toISOString(),
      remainingCapacity: null,
      reasons: [{ code: "meta_check_unavailable" }],
    });
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.retried).toBe(1);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("keeps accepted delivery bookkeeping when its auxiliary receipt write fails", async () => {
    claimTask({ attempts: 5 });
    mockRecordTaskSendReceipt.mockRejectedValueOnce(
      new Error("receipt store unavailable")
    );
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.completed).toBe(1);
    expect(result.failedTerminal).toBe(0);
    expect(mockPersistCampaignMessageSentWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "wamid.success" })
    );
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("does not label an unattempted task failed when receipt lookup is unavailable", async () => {
    claimTask({ attempts: 5 });
    mockFindTaskSendReceipt.mockRejectedValueOnce(
      new Error("receipt store unavailable")
    );
    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(result.retried).toBe(1);
    expect(result.failedTerminal).toBe(0);
    expect(mockSendCampaignTransportSingle).not.toHaveBeenCalled();
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
  });

  it("preserves structured transport failure codes and classifies thrown failures", async () => {
    const { taskId } = claimTask();
    mockSendCampaignTransportSingle.mockResolvedValueOnce({
      success: false,
      provider: "meta",
      recipient: "15550000001",
      error: "recipient unavailable",
      providerCode: "131026",
      failureScope: "recipient",
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.failedTerminal).toBe(1);
    expect(mockPersistCampaignMessageAttemptWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "15550000001",
        status: "failed",
        providerError: {
          code: "131026",
          scope: "recipient",
          message: expect.any(String),
        },
        insertIfMissing: expect.objectContaining({
          messageId: `campaign-delivery-task:${String(taskId)}`,
          workspaceId: "workspace-1",
          recipientHash: "a".repeat(64),
          scenarioNodeId: "node-1",
          executionSource: "scenario_schedule",
        }),
      })
    );
    expect(mockClassifyCampaignTransportFailure).not.toHaveBeenCalled();

    mockSendCampaignTransportSingle.mockRejectedValueOnce(new Error("boom"));
    claimTask({ attempts: 5 });
    await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(mockClassifyCampaignTransportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "meta" })
    );
  });

  it("does not persist a terminal failure row on retries", async () => {
    claimTask({ attempts: 1 });
    mockSendCampaignTransportSingle.mockResolvedValueOnce({
      success: false,
      provider: "meta",
      recipient: "15550000001",
      error: "temporary",
      providerCode: "131000",
      failureScope: "provider",
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.retried).toBe(1);
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "retry" }),
      })
    );
  });

  it("requires applied or queuedToOutbox before Mongo becomes failed_terminal", async () => {
    claimTask({ attempts: 5 });
    mockSendCampaignTransportSingle.mockResolvedValueOnce({
      success: false,
      provider: "meta",
      recipient: "15550000001",
      error: "terminal",
      providerCode: "131026",
      failureScope: "recipient",
    });
    mockPersistCampaignMessageAttemptWithOutbox.mockResolvedValueOnce({
      applied: false,
      queuedToOutbox: false,
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.failedTerminal).toBe(0);
    expect(result.retried).toBe(1);
    expect(mockCampaignDeliveryTaskUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "failed_terminal" }),
      })
    );
  });

  it("gates successful Mongo completion on sent ledger ownership", async () => {
    const { taskId, scenarioId } = claimTask({ attempts: 1 });
    mockPersistCampaignMessageSentWithOutbox.mockResolvedValueOnce({
      applied: false,
      queuedToOutbox: false,
    });

    const lost = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(lost.completed).toBe(0);
    expect(mockCampaignDeliveryTaskUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "completed" }),
      })
    );

    mockPersistCampaignMessageSentWithOutbox.mockResolvedValueOnce({
      applied: true,
      queuedToOutbox: false,
    });
    claimTask({
      _id: taskId,
      scenarioId,
      attempts: 1,
    });
    const succeeded = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });
    expect(succeeded.completed).toBe(1);
    expect(mockPersistCampaignMessageSentWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: "campaign-1",
        recipient: "15550000001",
        scenarioId,
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
      })
    );
  });

  it("does not write a terminal failure row without the task-stored recipient HMAC", async () => {
    claimTask({ attempts: 5, recipientHash: "" });
    mockSendCampaignTransportSingle.mockResolvedValueOnce({
      success: false,
      provider: "meta",
      recipient: "15550000001",
      error: "terminal",
      providerCode: "131026",
      failureScope: "recipient",
    });

    const result = await drainCampaignDeliveryTasks({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      batchLimit: 1,
    });

    expect(result.failedTerminal).toBe(0);
    expect(result.retried).toBe(1);
    expect(mockPersistCampaignMessageAttemptWithOutbox).not.toHaveBeenCalled();
    expect(mockCampaignDeliveryTaskUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "failed_terminal" }),
      })
    );
  });
});
