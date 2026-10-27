const mockEnrichStoredReferral = jest.fn();
jest.mock("./whatsapp/referral-enrichment-store", () => ({enrichStoredWhatsAppReferral: (...args: unknown[]) => mockEnrichStoredReferral(...args)}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

const mockPublishRemoteLlmAnalyticsEvents = jest.fn();
const mockTriggerRealtimeEvent = jest.fn();
jest.mock("@/lib/realtime/server", () => ({
  triggerRealtimeEvent: (...args: unknown[]) =>
    mockTriggerRealtimeEvent(...args),
}));
const mockResolveWhatsAppSendContext = jest.fn();
const mockSendWhatsAppLlmFeedbackReasonPrompt = jest.fn();
const mockSendWhatsAppLlmHelpfulnessPrompt = jest.fn();
const mockUpsertWhatsAppLlmAnswerReviewItem = jest.fn();
const mockDeliverMetaConversion = jest.fn();
const mockReconcileMetaConversions = jest.fn().mockResolvedValue(0);
const mockRecordMetaPreparationFailure = jest.fn();
const mockDispatchConfirmedPayment = jest.fn();
const mockReconcileConfirmedPayments = jest.fn().mockResolvedValue(0);
const mockDispatchCustomerWebhook = jest.fn().mockResolvedValue(undefined);
const mockSnapshotWebhookSubscriptionIds = jest
  .fn()
  .mockResolvedValue(["webhook-1"]);
const mockReconcileCustomerWebhookIntents = jest
  .fn()
  .mockResolvedValue({ admitted: 0, hasMore: false });
jest.mock("@/lib/webhooks", () => ({
  dispatchWebhookEvent: (...args: unknown[]) =>
    mockDispatchCustomerWebhook(...args),
  snapshotWebhookSubscriptionIds: (...args: unknown[]) =>
    mockSnapshotWebhookSubscriptionIds(...args),
}));
jest.mock("@/lib/customer-webhook-intents", () => ({
  reconcileCustomerWebhookIntents: (...args: unknown[]) =>
    mockReconcileCustomerWebhookIntents(...args),
}));
const mockRecordConfirmedPaymentFailure = jest.fn();
const mockBehaviorDispatch = jest.fn().mockResolvedValue(undefined);
const mockBehaviorProjection = jest.fn().mockResolvedValue(undefined);
const mockBehaviorAdmission = jest.fn().mockResolvedValue(undefined);
const mockWebsiteCartAdmission = jest.fn().mockResolvedValue(undefined);
const mockWebsiteStoreDrain = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/commerce/carts", () => ({
  admitWebsiteCarts: (...args: unknown[]) => mockWebsiteCartAdmission(...args),
}));
jest.mock("@/lib/commerce/store-events", () => ({
  drainWebsiteCommerceEvents: (...args: unknown[]) =>
    mockWebsiteStoreDrain(...args),
}));
jest.mock("@/lib/scenarios/behavior-runtime", () => ({
  dispatchDueBehaviorRuns: (...args: unknown[]) =>
    mockBehaviorDispatch(...args),
}));
jest.mock("@/lib/conversions/customer-event-reconciliation", () => ({
  reconcileConversionCustomerEvents: (...args: unknown[]) =>
    mockBehaviorProjection(...args),
}));
jest.mock("@/lib/scenarios/behavior-runs", () => ({
  admitCustomerBehaviorEvents: (...args: unknown[]) =>
    mockBehaviorAdmission(...args),
}));

jest.mock("@/lib/conversions/confirmed-payment-scenario", () => ({
  dispatchConfirmedPaymentScenario: (...args: unknown[]) =>
    mockDispatchConfirmedPayment(...args),
  reconcilePendingConfirmedPayments: (...args: unknown[]) =>
    mockReconcileConfirmedPayments(...args),
  recordConfirmedPaymentScenarioFailure: (...args: unknown[]) =>
    mockRecordConfirmedPaymentFailure(...args),
}));

jest.mock("@/lib/conversions/meta-conversion-delivery", () => ({
  deliverMetaConversion: (...args: unknown[]) =>
    mockDeliverMetaConversion(...args),
  reconcilePendingMetaConversions: (...args: unknown[]) =>
    mockReconcileMetaConversions(...args),
  recordMetaConversionPreparationFailure: (...args: unknown[]) =>
    mockRecordMetaPreparationFailure(...args),
}));

jest.mock("@/lib/ai/gcp-ai-gateway", () => ({
  GcpAiGatewayHttpError: class GcpAiGatewayHttpError extends Error {
    constructor(
      readonly status: number,
      message: string
    ) {
      super(message);
    }

    get permanent() {
      return this.status === 400 || this.status === 413;
    }
  },
  publishRemoteLlmAnalyticsEvents: (...args: unknown[]) =>
    mockPublishRemoteLlmAnalyticsEvents(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/lib/llm-analytics/whatsapp-feedback", () => ({
  sendWhatsAppLlmFeedbackReasonPrompt: (...args: unknown[]) =>
    mockSendWhatsAppLlmFeedbackReasonPrompt(...args),
  sendWhatsAppLlmHelpfulnessPrompt: (...args: unknown[]) =>
    mockSendWhatsAppLlmHelpfulnessPrompt(...args),
  upsertWhatsAppLlmAnswerReviewItem: (...args: unknown[]) =>
    mockUpsertWhatsAppLlmAnswerReviewItem(...args),
}));

jest.mock("@/models/cross-store-outbox", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn(),
    countDocuments: jest.fn(),
  },
}));

import { supabaseAdmin } from "@/lib/supabase/admin";
import { GcpAiGatewayHttpError } from "@/lib/ai/gcp-ai-gateway";
import CrossStoreOutbox from "@/models/cross-store-outbox";
import {
  findCampaignMessageAcceptance,
  enqueueWhatsAppLlmFeedbackReasonPromptWithOutbox,
  enqueueWhatsAppLlmHelpfulnessPromptWithOutbox,
  enqueueMetaConversionWithOutbox,
  enqueueConfirmedPaymentWithOutbox,
  enqueueCustomerWebhookWithOutbox,
  enqueueWhatsAppReferralEnrichmentWithOutbox,
  persistLlmAnalyticsEventsWithOutbox,
  persistCampaignMessageAttemptWithOutbox,
  persistCampaignMessageSentWithOutbox,
  persistCampaignMessageStatusWithOutbox,
  processCrossStoreOutboxBatch,
} from "./cross-store-outbox";
import type { LlmAnalyticsWarehouseEvent } from "@icecore/airi-runtime/llm-analytics";

type QueryResult = {
  data?: Record<string, unknown> | null;
  error: { code?: string; message: string } | null;
};

type StatefulStatusQuery = {
  eq: jest.Mock;
  in: jest.Mock;
  select: jest.Mock;
  maybeSingle: jest.Mock;
  then: (
    resolve: (result: QueryResult) => unknown,
    reject: (error: unknown) => unknown
  ) => Promise<unknown>;
};

function createQuery(result: QueryResult) {
  const equalityFilters = new Map<string, unknown>();
  const query: {
    eq: jest.Mock;
    in: jest.Mock;
    select: jest.Mock;
    maybeSingle: jest.Mock;
    limit: jest.Mock;
  } = {
    eq: jest.fn((field: string, value: unknown) => {
      equalityFilters.set(field, value);
      return query;
    }),
    in: jest.fn(),
    select: jest.fn(),
    maybeSingle: jest.fn(async () => result),
    limit: jest.fn(async (count: number) => {
      if (result.error || !result.data) {
        return { data: [], error: result.error };
      }
      return {
        data: [
          {
            channel: equalityFilters.get("channel"),
            recipient: equalityFilters.get("recipient"),
            ...result.data,
          },
        ].slice(0, count),
        error: null,
      };
    }),
  };
  query.in.mockReturnValue(query);
  query.select.mockReturnValue(query);
  return query;
}

function createPendingLifecycleLookup(overrides: Record<string, unknown> = {}) {
  return createQuery({
    data: {
      id: "ledger-row-1",
      status: "pending",
      message_id: null,
      provider: null,
      ...overrides,
    },
    error: null,
  });
}

function createListQuery(rows: Array<Record<string, unknown>>) {
  const query = {
    eq: jest.fn(),
    limit: jest.fn(async (count: number) => ({
      data: rows.slice(0, count),
      error: null,
    })),
  };
  query.eq.mockReturnValue(query);
  return query;
}

function createStatefulStatusTable(stored: Record<string, unknown>): {
  update: jest.Mock;
  select: jest.Mock;
} {
  const update = jest.fn((patch: Record<string, unknown>) => {
    let allowedStatuses: string[] | null = null;
    const execute = () => {
      if (
        allowedStatuses &&
        !allowedStatuses.includes(String(stored.status || ""))
      ) {
        return { data: null, error: null };
      }
      Object.assign(stored, patch);
      return { data: { id: stored.id, status: stored.status }, error: null };
    };
    const query: StatefulStatusQuery = {
      eq: jest.fn(),
      in: jest.fn((_field: string, statuses: string[]): StatefulStatusQuery => {
        allowedStatuses = statuses;
        return query;
      }),
      select: jest.fn((): StatefulStatusQuery => query),
      maybeSingle: jest.fn(async () => execute()),
      then: (
        resolve: (result: QueryResult) => unknown,
        reject: (error: unknown) => unknown
      ) => Promise.resolve(execute()).then(resolve, reject),
    };
    query.eq.mockReturnValue(query);
    return query;
  });
  const select = jest.fn(() =>
    createQuery({
      data: {
        id: String(stored.id || ""),
        status: String(stored.status || ""),
      },
      error: null,
    })
  );
  return { update, select };
}

describe("campaign acceptance recovery", () => {
  const from = supabaseAdmin.from as jest.Mock;
  const identity = {
    workspaceId: "workspace-1",
    campaignId: "campaign-1",
    channel: "whatsapp" as const,
    recipient: "77010000001",
    snapshotOrdinal: 4,
    provider: "meta" as const,
  };
  const placeholder = "campaign-1:snapshot:4";

  function installLookup(
    row: Record<string, unknown> | null,
    campaignOverrides: Record<string, unknown> = {}
  ) {
    const campaign = createQuery({
      data: {
        id: identity.campaignId,
        workspace_id: identity.workspaceId,
        channel: "whatsapp",
        audience_fingerprint: "admitted-audience",
        ...campaignOverrides,
      },
      error: null,
    });
    const message = createQuery({
      data: row && {
        id: "ledger-row-4",
        channel: identity.channel,
        recipient: identity.recipient,
        snapshot_ordinal: 4,
        provider: "meta",
        ...row,
      },
      error: null,
    });
    from.mockImplementation((table: string) => ({
      select: () => (table === "campaign_history" ? campaign : message),
    }));
    return { campaign, message };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      hint: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
  });

  it("does not mistake a scheduled task failure placeholder for provider acceptance", async () => {
    installLookup(
      {
        status: "failed",
        message_id: "campaign-delivery-task:task-1",
        snapshot_ordinal: null,
      },
      { audience_fingerprint: null }
    );
    await expect(
      findCampaignMessageAcceptance({
        ...identity,
        snapshotOrdinal: undefined,
        pendingMessageId: "campaign-delivery-task:task-1",
      })
    ).resolves.toBeNull();
  });
  it.each(["pending", "processing", "failed"])(
    "recovers durable sent-outbox acceptance before SQL replay (%s)",
    async status => {
      installLookup({ status: "attempted", message_id: placeholder });
      (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        hint: jest.fn().mockReturnThis(),
        maxTimeMS: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest
          .fn()
          .mockResolvedValue([
            {
              status,
              payload: {
                campaignId: identity.campaignId,
                channel: "whatsapp",
                recipient: identity.recipient,
                snapshotOrdinal: 4,
                provider: "meta",
                messageId: "wamid.outbox-accepted",
              },
            },
          ]),
      });
      await expect(findCampaignMessageAcceptance(identity)).resolves.toEqual({
        messageId: "wamid.outbox-accepted",
      });
      expect(CrossStoreOutbox.find).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "supabase",
          operation: "campaign_messages.upsert_sent",
          "payload.snapshotOrdinal": 4,
        })
      );
      const query = (CrossStoreOutbox.find as jest.Mock).mock.results.at(
        -1
      )?.value;
      expect(query.hint).toHaveBeenCalledWith(
        "target_1_operation_1_dedupeKey_1"
      );
      expect(query.maxTimeMS).toHaveBeenCalledWith(2_000);
      expect(query.limit).toHaveBeenCalledWith(2);
    }
  );
  it("scans the outbox while it reads the ledger row, after the workspace check", async () => {
    const { campaign, message } = installLookup({
      status: "pending",
      message_id: placeholder,
    });
    const events: string[] = [];
    const readCampaign = campaign.maybeSingle.getMockImplementation()!;
    campaign.maybeSingle.mockImplementation(async () => {
      events.push("campaign");
      return readCampaign();
    });
    let markOutboxStarted!: () => void;
    const outboxStarted = new Promise<void>(resolve => {
      markOutboxStarted = resolve;
    });
    const readLedger = message.limit.getMockImplementation()!;
    message.limit.mockImplementation(async (count: number) => {
      const overlapped = await Promise.race([
        outboxStarted.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200)),
      ]);
      events.push(overlapped ? "ledger-overlapped" : "ledger-alone");
      return readLedger(count);
    });
    (CrossStoreOutbox.find as jest.Mock).mockImplementation(() => {
      events.push("outbox");
      markOutboxStarted();
      return {
        select: jest.fn().mockReturnThis(),
        hint: jest.fn().mockReturnThis(),
        maxTimeMS: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          {
            payload: {
              campaignId: identity.campaignId,
              channel: "whatsapp",
              recipient: identity.recipient,
              snapshotOrdinal: 4,
              provider: "meta",
              messageId: "wamid.accepted",
            },
          },
        ]),
      };
    });

    await expect(findCampaignMessageAcceptance(identity)).resolves.toEqual({
      messageId: "wamid.accepted",
    });
    expect(events).toEqual(["campaign", "outbox", "ledger-overlapped"]);
  });

  it("ignores a failed outbox scan when the ledger row already proves acceptance", async () => {
    installLookup({ status: "sent", message_id: "wamid.accepted" });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      hint: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockRejectedValue(new Error("MaxTimeMSExpired")),
    });
    await expect(findCampaignMessageAcceptance(identity)).resolves.toEqual({
      messageId: "wamid.accepted",
    });
  });

  it("fails closed when the bounded outbox read times out", async () => {
    installLookup({ status: "pending", message_id: placeholder });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      hint: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockRejectedValue(new Error("MaxTimeMSExpired")),
    });
    await expect(findCampaignMessageAcceptance(identity)).rejects.toThrow(
      "MaxTimeMSExpired"
    );
  });
  it.each([
    [
      { payload: { messageId: "wamid.one" } },
      { payload: { messageId: "wamid.two" } },
    ],
    [
      {
        payload: {
          campaignId: "different-workspace-campaign",
          channel: "whatsapp",
          recipient: identity.recipient,
          snapshotOrdinal: 4,
          provider: "meta",
          messageId: "wamid.wrong",
        },
      },
    ],
  ])(
    "does not use ambiguous or conflicting outbox acceptance",
    async (...records) => {
      installLookup({ status: "pending", message_id: placeholder });
      (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        hint: jest.fn().mockReturnThis(),
        maxTimeMS: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(records),
      });
      await expect(findCampaignMessageAcceptance(identity)).rejects.toThrow(
        /acceptance outbox/
      );
    }
  );

  it.each(["sent", "accepted", "delivered", "read", "failed"])(
    "recovers the provider ID from %s without writing or treating delivery failure as a new send",
    async status => {
      const { campaign, message } = installLookup({
        status,
        message_id: "wamid.accepted",
      });

      await expect(findCampaignMessageAcceptance(identity)).resolves.toEqual({
        messageId: "wamid.accepted",
      });

      expect(campaign.eq).toHaveBeenCalledWith("id", identity.campaignId);
      expect(campaign.eq).toHaveBeenCalledWith(
        "workspace_id",
        identity.workspaceId
      );
      expect(message.eq).toHaveBeenCalledWith(
        "campaign_id",
        identity.campaignId
      );
      expect(message.eq).toHaveBeenCalledWith("snapshot_ordinal", 4);
      expect(message.limit).toHaveBeenCalledWith(1);
      expect(from).toHaveBeenCalledTimes(2);
      expect(CrossStoreOutbox.findOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it.each(["pending", "attempted", "failed"])(
    "does not mistake the admitted %s placeholder for provider acceptance",
    async status => {
      installLookup({ status, message_id: placeholder });
      await expect(findCampaignMessageAcceptance(identity)).resolves.toBeNull();
    }
  );

  it.each([
    { status: "sent", message_id: null },
    { status: "accepted", message_id: placeholder },
    { status: "unexpected", message_id: "wamid.accepted" },
    { status: "pending", message_id: "wamid.accepted" },
    { status: "attempted", message_id: "wamid.accepted" },
    { status: "sent", message_id: "wamid.accepted", provider: "postmark" },
    { status: "sent", message_id: "wamid.accepted", channel: "email" },
    {
      status: "sent",
      message_id: "wamid.accepted",
      recipient: "different-recipient",
    },
    { status: "sent", message_id: "wamid.accepted", snapshot_ordinal: 5 },
  ])("fails closed for malformed or conflicting acceptance %j", async row => {
    installLookup(row);
    await expect(findCampaignMessageAcceptance(identity)).rejects.toThrow();
    expect(CrossStoreOutbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("fails closed for a different workspace before reading the recipient ledger", async () => {
    installLookup(
      { status: "sent", message_id: "wamid.accepted" },
      {
        workspace_id: "workspace-other",
      }
    );
    await expect(findCampaignMessageAcceptance(identity)).rejects.toThrow(
      /workspace/
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("fails closed for campaign lookup failure", async () => {
    const { campaign } = installLookup(null);
    campaign.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });
    await expect(findCampaignMessageAcceptance(identity)).rejects.toThrow(
      /database unavailable/
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("fails closed for recipient lookup failure", async () => {
    const { message } = installLookup(null);
    message.limit.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });
    await expect(findCampaignMessageAcceptance(identity)).rejects.toThrow(
      /database unavailable/
    );
  });

  it("requires an existing recipient for an admitted ordinal", async () => {
    installLookup(null);
    await expect(findCampaignMessageAcceptance(identity)).rejects.toThrow(
      /not found/
    );
  });

  it("permits missing legacy rows only when the campaign has no admitted audience", async () => {
    installLookup(null, { audience_fingerprint: null });
    await expect(
      findCampaignMessageAcceptance({
        ...identity,
        snapshotOrdinal: undefined,
      })
    ).resolves.toBeNull();

    installLookup(null);
    await expect(
      findCampaignMessageAcceptance({
        ...identity,
        snapshotOrdinal: undefined,
      })
    ).rejects.toThrow(/not found/);
  });

  it("rejects an ambiguous legacy recipient instead of choosing an acceptance", async () => {
    const { message } = installLookup(null, { audience_fingerprint: null });
    message.limit.mockResolvedValue({
      data: [{ id: "row-1" }, { id: "row-2" }],
      error: null,
    });
    await expect(
      findCampaignMessageAcceptance({
        ...identity,
        snapshotOrdinal: undefined,
      })
    ).rejects.toThrow(/ambiguous/);
    expect(message.limit).toHaveBeenCalledWith(2);
  });
});

describe("cross-store campaign message persistence", () => {
  const from = supabaseAdmin.from as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTriggerRealtimeEvent.mockResolvedValue(undefined);
  });

  it("publishes after status persistence and recovers publication on an idempotent replay", async () => {
    const stored = { id: "row-1", status: "sent" };
    from.mockReturnValue(createStatefulStatusTable(stored));
    mockTriggerRealtimeEvent.mockImplementationOnce(async () => {
      expect(stored.status).toBe("failed");
      throw new Error("realtime unavailable");
    });
    const payload = {
      messageId: "wamid-1",
      updateData: {
        status: "failed",
        error_code: 131048,
        updated_at: "2026-09-15T10:00:00.000Z",
      },
      realtime: { workspaceId: "workspace_1", campaignId: "campaign_1" },
    };
    expect(await persistCampaignMessageStatusWithOutbox(payload)).toMatchObject(
      {
        applied: false,
        queuedToOutbox: true,
      }
    );
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ payload }),
      }),
      expect.anything()
    );
    expect(await persistCampaignMessageStatusWithOutbox(payload)).toEqual({
      applied: true,
      queuedToOutbox: false,
    });
    expect(mockTriggerRealtimeEvent).toHaveBeenCalledTimes(2);
    expect(mockTriggerRealtimeEvent).toHaveBeenLastCalledWith(
      "private-campaign-campaign_1",
      "message-status-update",
      {
        workspaceId: "workspace_1",
        messageId: "wamid-1",
        status: "failed",
        timestamp: "2026-09-15T10:00:00.000Z",
      }
    );
  });

  it.each(["lookup_error", "missing_workspace", "rejected_lookup"])(
    "retains callback-less realtime intent across %s and publishes after replay",
    async failure => {
      const stored = { id: "row-1", status: "sent" };
      const statusTable = createStatefulStatusTable(stored);
      const historyQuery = createQuery({
        data: { workspace_id: "workspace_1" },
        error: null,
      });
      if (failure === "rejected_lookup") {
        historyQuery.maybeSingle.mockRejectedValueOnce(
          new Error("lookup unavailable")
        );
      } else {
        historyQuery.maybeSingle.mockResolvedValueOnce({
          data: null,
          error:
            failure === "lookup_error"
              ? { message: "lookup unavailable" }
              : null,
        });
      }
      from.mockImplementation(table =>
        table === "campaign_history"
          ? { select: () => historyQuery }
          : statusTable
      );
      const payload = {
        messageId: "wamid-1",
        updateData: {
          status: "failed",
          updated_at: "2026-09-15T10:00:00.000Z",
        },
        realtime: { campaignId: "campaign_1" },
      };
      expect(
        await persistCampaignMessageStatusWithOutbox(payload)
      ).toMatchObject({ applied: false, queuedToOutbox: true });
      expect(stored.status).toBe("failed");
      expect(mockTriggerRealtimeEvent).not.toHaveBeenCalled();
      expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({ payload }),
        }),
        expect.anything()
      );
      expect(await persistCampaignMessageStatusWithOutbox(payload)).toEqual({
        applied: true,
        queuedToOutbox: false,
      });
      expect(historyQuery.eq).toHaveBeenCalledWith("id", "campaign_1");
      expect(mockTriggerRealtimeEvent).toHaveBeenCalledTimes(1);
      expect(mockTriggerRealtimeEvent).toHaveBeenCalledWith(
        "private-campaign-campaign_1",
        "message-status-update",
        {
          workspaceId: "workspace_1",
          messageId: "wamid-1",
          status: "failed",
          timestamp: "2026-09-15T10:00:00.000Z",
        }
      );
    }
  );

  it("updates the preseeded recipient row before considering a legacy insert", async () => {
    const updateQuery = createQuery({
      data: { id: "ledger-row-1" },
      error: null,
    });
    const update = jest.fn((_payload: Record<string, unknown>) => updateQuery);
    const insert = jest.fn();
    const select = jest.fn(() => createPendingLifecycleLookup());
    from.mockReturnValue({ update, insert, select });

    await expect(
      persistCampaignMessageSentWithOutbox({
        campaignId: "campaign-1",
        messageId: "wamid-1",
        channel: "whatsapp",
        recipient: "77000000001",
        provider: "meta",
        status: "sent",
        attemptedAt: "2026-07-24T08:00:00.000Z",
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(update).toHaveBeenCalledWith({
      message_id: "wamid-1",
      provider: "meta",
      status: "sent",
      attempted_at: "2026-07-24T08:00:00.000Z",
    });
    expect(updateQuery.eq.mock.calls).toEqual([["id", "ledger-row-1"]]);
    expect(updateQuery.in).toHaveBeenCalledWith("status", [
      "pending",
      "attempted",
    ]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("resolves an admitted sent transition by campaign ordinal before updating its row ID", async () => {
    const lookupQuery = createListQuery([
      {
        id: "ledger-row-ordinal-1",
        status: "pending",
        message_id: null,
        provider: null,
        channel: "whatsapp",
        recipient: "77000000001",
        snapshot_ordinal: 1,
      },
    ]);
    const updateQuery = createQuery({
      data: { id: "ledger-row-ordinal-1" },
      error: null,
    });
    const select = jest.fn(() => lookupQuery);
    const update = jest.fn(() => updateQuery);
    from.mockReturnValue({ select, update, insert: jest.fn() });
    const payload = {
      campaignId: "campaign-1",
      messageId: "wamid-ordinal-1",
      channel: "whatsapp" as const,
      recipient: "77000000001",
      snapshotOrdinal: 1,
      provider: "meta",
      status: "sent",
      attemptedAt: "2026-07-24T08:00:00.000Z",
    };

    await expect(
      persistCampaignMessageSentWithOutbox(payload)
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(select).toHaveBeenCalledWith(
      "id,status,message_id,provider,channel,recipient,snapshot_ordinal"
    );
    expect(lookupQuery.eq.mock.calls).toEqual([
      ["campaign_id", "campaign-1"],
      ["snapshot_ordinal", 1],
    ]);
    expect(updateQuery.eq).toHaveBeenCalledWith("id", "ledger-row-ordinal-1");
    expect(updateQuery.eq).not.toHaveBeenCalledWith("recipient", "77000000001");
  });

  it("never falls back when an ordinal resolves to a foreign channel or recipient", async () => {
    const lookupQuery = createListQuery([
      {
        id: "ledger-row-ordinal-1",
        status: "pending",
        channel: "email",
        recipient: "person@example.com",
        snapshot_ordinal: 1,
      },
    ]);
    const update = jest.fn(() =>
      createQuery({ data: { id: "must-not-update" }, error: null })
    );
    const campaignLookup = jest.fn();
    from.mockImplementation((table: string) =>
      table === "campaign_history"
        ? { select: campaignLookup }
        : { select: jest.fn(() => lookupQuery), update, insert: jest.fn() }
    );
    const payload = {
      campaignId: "campaign-1",
      messageId: "wamid-ordinal-1",
      channel: "whatsapp" as const,
      recipient: "77000000001",
      snapshotOrdinal: 1,
      provider: "meta",
    };

    await expect(
      persistCampaignMessageSentWithOutbox(payload)
    ).resolves.toEqual(
      expect.objectContaining({ applied: false, queuedToOutbox: true })
    );

    expect(update).not.toHaveBeenCalled();
    expect(campaignLookup).not.toHaveBeenCalled();
  });

  it("queues a legacy lifecycle transition without updating or inserting when two rows share its recipient identity", async () => {
    const lookupQuery = createListQuery([
      {
        id: "legacy-ledger-row-1",
        status: "pending",
        channel: "whatsapp",
        recipient: "77000000001",
        snapshot_ordinal: null,
      },
      {
        id: "legacy-ledger-row-2",
        status: "pending",
        channel: "whatsapp",
        recipient: "77000000001",
        snapshot_ordinal: null,
      },
    ]);
    const update = jest.fn();
    const insert = jest.fn();
    const campaignLookup = jest.fn();
    from.mockImplementation((table: string) =>
      table === "campaign_history"
        ? { select: campaignLookup }
        : { select: jest.fn(() => lookupQuery), update, insert }
    );
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockResolvedValueOnce({
      _id: "legacy-ambiguity-outbox",
      status: "pending",
    });

    await expect(
      persistCampaignMessageSentWithOutbox({
        campaignId: "legacy-campaign",
        messageId: "wamid-legacy-ambiguous",
        channel: "whatsapp",
        recipient: "77000000001",
        provider: "meta",
        status: "sent",
        attemptedAt: "2026-07-24T08:00:00.000Z",
      })
    ).resolves.toEqual({
      applied: false,
      queuedToOutbox: true,
      errorMessage: expect.stringContaining(
        "[campaign_messages.upsert_sent] legacy recipient identity is ambiguous"
      ),
    });

    expect(lookupQuery.eq.mock.calls).toEqual([
      ["campaign_id", "legacy-campaign"],
      ["channel", "whatsapp"],
      ["recipient", "77000000001"],
    ]);
    expect(lookupQuery.limit).toHaveBeenCalledWith(2);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(campaignLookup).not.toHaveBeenCalled();
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "campaign_messages.upsert_sent",
      }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          status: "pending",
          payload: expect.objectContaining({
            campaignId: "legacy-campaign",
            recipient: "77000000001",
          }),
        }),
      }),
      { upsert: true, new: true }
    );
  });

  it("falls back to a legacy insert only when no preseeded recipient row exists", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const legacyCampaignQuery = createQuery({
      data: { audience_fingerprint: null },
      error: null,
    });
    const existingQuery = createQuery({ data: null, error: null });
    const insert = jest.fn(async () => ({ error: null }));
    const select = jest.fn(() => existingQuery);
    from.mockImplementation((table: string) => {
      if (table === "campaign_history") {
        return { select: jest.fn(() => legacyCampaignQuery) };
      }
      return {
        update: jest.fn(() => updateQuery),
        select,
        insert,
      };
    });

    await expect(
      persistCampaignMessageSentWithOutbox({
        campaignId: "legacy-campaign",
        messageId: "wamid-legacy",
        channel: "whatsapp",
        recipient: "77000000002",
        provider: "meta",
        status: "sent",
        attemptedAt: "2026-07-24T08:00:00.000Z",
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        campaign_id: "legacy-campaign",
        message_id: "wamid-legacy",
        recipient: "77000000002",
      })
    );
    expect(existingQuery.eq.mock.calls).toEqual([
      ["campaign_id", "legacy-campaign"],
      ["channel", "whatsapp"],
      ["recipient", "77000000002"],
    ]);
  });

  it("never legacy-inserts when a modern admitted campaign has no recipient match", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const modernCampaignQuery = createQuery({
      data: {
        audience_fingerprint:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      error: null,
    });
    const currentQuery = createQuery({ data: null, error: null });
    const insert = jest.fn();
    from.mockImplementation((table: string) =>
      table === "campaign_history"
        ? { select: jest.fn(() => modernCampaignQuery) }
        : {
            update: jest.fn(() => updateQuery),
            select: jest.fn(() => currentQuery),
            insert,
          }
    );

    const result = await persistCampaignMessageSentWithOutbox({
      campaignId: "campaign-1",
      messageId: "wamid-1",
      channel: "whatsapp",
      recipient: "recipient-does-not-match-ledger",
      provider: "meta",
      attemptedAt: "2026-07-24T08:00:00.000Z",
    });

    expect(result.applied).toBe(false);
    expect(result.errorMessage).toContain("preseeded recipient row not found");
    expect(insert).not.toHaveBeenCalled();
  });

  it("resolves a legacy insert race only through the logical recipient key", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const legacyCampaignQuery = createQuery({
      data: { audience_fingerprint: null },
      error: null,
    });
    const beforeInsert = createQuery({ data: null, error: null });
    const afterDuplicate = createQuery({
      data: {
        id: "legacy-row",
        status: "sent",
        message_id: "telegram-message-42",
        provider: "telegram",
      },
      error: null,
    });
    const select = jest
      .fn()
      .mockReturnValueOnce(beforeInsert)
      .mockReturnValueOnce(afterDuplicate);
    const insert = jest.fn(async () => ({
      error: { message: "duplicate key violates unique constraint" },
    }));
    from.mockImplementation((table: string) =>
      table === "campaign_history"
        ? { select: jest.fn(() => legacyCampaignQuery) }
        : { update: jest.fn(() => updateQuery), select, insert }
    );

    await expect(
      persistCampaignMessageSentWithOutbox({
        campaignId: "legacy-campaign",
        messageId: "telegram-message-42",
        channel: "telegram",
        recipient: "chat-1",
        provider: "telegram",
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(afterDuplicate.eq.mock.calls).toEqual([
      ["campaign_id", "legacy-campaign"],
      ["channel", "telegram"],
      ["recipient", "chat-1"],
    ]);
  });

  it("persists recipient-scoped synchronous failures without a provider message ID", async () => {
    const updateQuery = createQuery({
      data: { id: "ledger-row-1" },
      error: null,
    });
    const update = jest.fn(() => updateQuery);
    from.mockReturnValue({
      update,
      select: jest.fn(() => createPendingLifecycleLookup()),
    });

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "77000000001",
        provider: "meta",
        status: "failed",
        attemptedAt: "2026-07-24T08:00:00.000Z",
        failedAt: "2026-07-24T08:00:01.000Z",
        providerError: {
          code: "131042",
          scope: "provider",
          message: "Business eligibility payment issue",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(update).toHaveBeenCalledWith({
      provider: "meta",
      status: "failed",
      attempted_at: "2026-07-24T08:00:00.000Z",
      failed_at: "2026-07-24T08:00:01.000Z",
      error_code: 131042,
      failure_scope: "provider",
      failure_reason: "provider",
      error_message: "Business eligibility payment issue",
    });
    expect(updateQuery.eq.mock.calls).toEqual([["id", "ledger-row-1"]]);
  });

  it("preserves nonnumeric provider codes without writing them to the integer error_code column", async () => {
    const updateQuery = createQuery({
      data: { id: "ledger-row-1" },
      error: null,
    });
    const update = jest.fn((_payload: Record<string, unknown>) => updateQuery);
    from.mockReturnValue({
      update,
      select: jest.fn(() => createPendingLifecycleLookup()),
    });

    await persistCampaignMessageAttemptWithOutbox({
      campaignId: "campaign-1",
      channel: "email",
      recipient: "person@example.com",
      provider: "postmark",
      status: "failed",
      attemptedAt: "2026-07-24T08:00:00.000Z",
      failedAt: "2026-07-24T08:00:01.000Z",
      providerError: {
        code: "SMTP_RATE_LIMIT",
        scope: "provider",
        message: "Provider throttled the send",
      },
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        failure_scope: "provider",
        failure_reason:
          '{"providerCode":"SMTP_RATE_LIMIT","providerScope":"provider"}',
      })
    );
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty("error_code");
  });

  it("routes provider codes outside PostgreSQL int32 through the structured fallback", async () => {
    const updateQuery = createQuery({
      data: { id: "ledger-row-1" },
      error: null,
    });
    const update = jest.fn((_payload: Record<string, unknown>) => updateQuery);
    from.mockReturnValue({
      update,
      select: jest.fn(() => createPendingLifecycleLookup()),
    });

    await persistCampaignMessageAttemptWithOutbox({
      campaignId: "campaign-1",
      channel: "whatsapp",
      recipient: "77000000001",
      provider: "meta",
      status: "failed",
      providerError: {
        code: 3_000_000_000,
        scope: "provider",
      },
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        failure_scope: "provider",
        failure_reason:
          '{"providerCode":"3000000000","providerScope":"provider"}',
      })
    );
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty("error_code");
  });

  it("stores signed PostgreSQL int32 boundary codes as integers", async () => {
    const updateQuery = createQuery({
      data: { id: "ledger-row-1" },
      error: null,
    });
    const update = jest.fn((_payload: Record<string, unknown>) => updateQuery);
    from.mockReturnValue({
      update,
      select: jest.fn(() => createPendingLifecycleLookup()),
    });

    await persistCampaignMessageAttemptWithOutbox({
      campaignId: "campaign-1",
      channel: "whatsapp",
      recipient: "77000000001",
      provider: "meta",
      status: "failed",
      providerError: {
        code: "-2147483648",
        scope: "provider",
      },
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: -2_147_483_648 })
    );
  });

  it("treats a delayed sent replay as idempotent after delivery without downgrading status", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const currentQuery = createQuery({
      data: {
        id: "ledger-row-1",
        status: "delivered",
        message_id: "wamid-1",
        provider: "meta",
      },
      error: null,
    });
    const update = jest.fn(() => updateQuery);
    const select = jest.fn(() => currentQuery);
    from.mockReturnValue({ update, select });

    await expect(
      persistCampaignMessageSentWithOutbox({
        campaignId: "campaign-1",
        messageId: "wamid-1",
        channel: "whatsapp",
        recipient: "77000000001",
        provider: "meta",
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(updateQuery.in).toHaveBeenCalledWith("status", [
      "pending",
      "attempted",
    ]);
    expect(select).toHaveBeenCalledWith(
      "id,status,message_id,provider,channel,recipient,snapshot_ordinal"
    );
  });

  it("fails closed when a delayed sent replay conflicts with provider message identity", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const currentQuery = createQuery({
      data: {
        id: "ledger-row-1",
        status: "delivered",
        message_id: "wamid-other",
        provider: "meta",
      },
      error: null,
    });
    from.mockReturnValue({
      update: jest.fn(() => updateQuery),
      select: jest.fn(() => currentQuery),
    });

    const result = await persistCampaignMessageSentWithOutbox({
      campaignId: "campaign-1",
      messageId: "wamid-1",
      channel: "whatsapp",
      recipient: "77000000001",
      provider: "meta",
    });

    expect(result.applied).toBe(false);
    expect(result.errorMessage).toContain("message identity conflict");
  });

  it("treats a delayed attempted replay after sent as idempotent", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const currentQuery = createQuery({
      data: {
        id: "ledger-row-1",
        status: "sent",
        message_id: "wamid-1",
        provider: "meta",
      },
      error: null,
    });
    from.mockReturnValue({
      update: jest.fn(() => updateQuery),
      select: jest.fn(() => currentQuery),
    });

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "77000000001",
        provider: "meta",
        status: "attempted",
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(updateQuery.eq).toHaveBeenCalledWith("status", "pending");
  });

  it("treats a delayed failed replay after a later successful send as a no-op", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const currentQuery = createQuery({
      data: {
        id: "ledger-row-1",
        status: "delivered",
        message_id: "wamid-later-success",
        provider: "legacy-provider",
      },
      error: null,
    });
    from.mockReturnValue({
      update: jest.fn(() => updateQuery),
      select: jest.fn(() => currentQuery),
    });

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "77000000001",
        provider: "meta",
        status: "failed",
        providerError: { code: 131000, scope: "provider" },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });
  });

  it("replays delivered after read as a successful no-op without changing status or timestamps", async () => {
    const stored = {
      id: "ledger-row-1",
      status: "read",
      delivered_at: "2026-07-24T08:01:00.000Z",
      read_at: "2026-07-24T08:02:00.000Z",
      updated_at: "2026-07-24T08:02:01.000Z",
    };
    const initial = { ...stored };
    from.mockReturnValue(createStatefulStatusTable(stored));

    await expect(
      persistCampaignMessageStatusWithOutbox({
        messageId: "wamid-1",
        updateData: {
          status: "delivered",
          delivered_at: "2026-07-24T08:01:00.000Z",
          updated_at: "2026-07-24T08:03:00.000Z",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(stored).toEqual(initial);
    expect(CrossStoreOutbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("applies a pricing-only correction without changing an advanced delivery status", async () => {
    const stored = {
      id: "ledger-row-1",
      status: "read",
      delivered_at: "2026-07-24T08:01:00.000Z",
      read_at: "2026-07-24T08:02:00.000Z",
      estimated_cost_usd: 0,
      updated_at: "2026-07-24T08:02:01.000Z",
    };
    const statusTable = createStatefulStatusTable(stored);
    from.mockReturnValue(statusTable);

    await expect(
      persistCampaignMessageStatusWithOutbox({
        messageId: "wamid-1",
        updateData: {
          estimated_cost_usd: 0.055,
          updated_at: "2026-07-24T08:03:00.000Z",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(stored).toEqual({
      id: "ledger-row-1",
      status: "read",
      delivered_at: "2026-07-24T08:01:00.000Z",
      read_at: "2026-07-24T08:02:00.000Z",
      estimated_cost_usd: 0.055,
      updated_at: "2026-07-24T08:03:00.000Z",
    });
    const updateQuery = statusTable.update.mock.results[0]?.value;
    expect(updateQuery.eq).toHaveBeenCalledWith("channel", "whatsapp");
  });

  it("preserves nullable cost and actual pricing metadata on a delayed callback after read", async () => {
    const stored = { id: "ledger-row-1", status: "read", read_at: "2026-10-02T01:00:01Z", estimated_cost_usd: 0 };
    from.mockReturnValue(createStatefulStatusTable(stored));
    const pricing = { estimated_cost_usd: null, cost_coverage: "unknown", pricing_type: "regular", pricing_billable: true, pricing_category: "service", pricing_event_at: "2026-10-02T01:00:00.000Z" };
    await expect(persistCampaignMessageStatusWithOutbox({ messageId: "wamid-1", updateData: { status: "delivered", delivered_at: "2026-10-02T01:00:00Z", ...pricing } })).resolves.toEqual({ applied: true, queuedToOutbox: false });
    expect(stored).toEqual({ id: "ledger-row-1", status: "read", read_at: "2026-10-02T01:00:01Z", ...pricing });
    expect(CrossStoreOutbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("queues an early delivery callback when its campaign message row does not exist yet", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    const lookupQuery = createQuery({ data: null, error: null });
    from.mockReturnValue({
      update: jest.fn(() => updateQuery),
      select: jest.fn(() => lookupQuery),
    });

    await expect(
      persistCampaignMessageStatusWithOutbox({
        messageId: "wamid-early",
        updateData: {
          status: "delivered",
          delivered_at: "2026-07-24T08:01:00.000Z",
          updated_at: "2026-07-24T08:01:01.000Z",
        },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        applied: false,
        queuedToOutbox: true,
      })
    );
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("queues early pricing when its campaign message row does not exist yet", async () => {
    const updateQuery = createQuery({ data: null, error: null });
    from.mockReturnValue({
      update: jest.fn(() => updateQuery),
    });

    await expect(
      persistCampaignMessageStatusWithOutbox({
        messageId: "wamid-early-pricing",
        updateData: {
          estimated_cost_usd: 0.055,
          updated_at: "2026-07-24T08:03:00.000Z",
        },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        applied: false,
        queuedToOutbox: true,
      })
    );
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("applies a valid forward delivery transition with its provider timestamp", async () => {
    const stored = {
      id: "ledger-row-1",
      status: "sent",
      delivered_at: null,
      read_at: null,
      updated_at: "2026-07-24T08:00:00.000Z",
    };
    const statusTable = createStatefulStatusTable(stored);
    from.mockReturnValue(statusTable);

    await expect(
      persistCampaignMessageStatusWithOutbox({
        messageId: "wamid-1",
        updateData: {
          status: "delivered",
          delivered_at: "2026-07-24T08:01:00.000Z",
          updated_at: "2026-07-24T08:01:01.000Z",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(stored).toEqual({
      id: "ledger-row-1",
      status: "delivered",
      delivered_at: "2026-07-24T08:01:00.000Z",
      read_at: null,
      updated_at: "2026-07-24T08:01:01.000Z",
    });
    const updateQuery = statusTable.update.mock.results[0]?.value;
    expect(updateQuery.eq).toHaveBeenCalledWith("channel", "whatsapp");
  });

  it("writes the canonical status after classifying a normalized provider value", async () => {
    const stored = {
      id: "ledger-row-1",
      status: "sent",
      delivered_at: null,
    };
    from.mockReturnValue(createStatefulStatusTable(stored));

    await expect(
      persistCampaignMessageStatusWithOutbox({
        messageId: "wamid-normalized",
        updateData: {
          status: " DELIVERED ",
          delivered_at: "2026-07-24T08:01:00.000Z",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(stored.status).toBe("delivered");
  });

  it("keeps an exact same-state delivery replay idempotent", async () => {
    const stored = {
      id: "ledger-row-1",
      status: "read",
      delivered_at: "2026-07-24T08:01:00.000Z",
      read_at: "2026-07-24T08:02:00.000Z",
      updated_at: "2026-07-24T08:02:01.000Z",
    };
    const initial = { ...stored };
    from.mockReturnValue(createStatefulStatusTable(stored));

    await expect(
      persistCampaignMessageStatusWithOutbox({
        messageId: "wamid-1",
        updateData: {
          status: "read",
          delivered_at: "2026-07-24T07:01:00.000Z",
          read_at: "2026-07-24T07:02:00.000Z",
          updated_at: "2026-07-24T09:00:00.000Z",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(stored).toEqual(initial);
  });

  it.each([
    {
      currentStatus: "delivered",
      incomingStatus: "failed",
      timestampField: "failed_at",
    },
    {
      currentStatus: "read",
      incomingStatus: "failed",
      timestampField: "failed_at",
    },
    {
      currentStatus: "failed",
      incomingStatus: "read",
      timestampField: "read_at",
    },
  ])(
    "treats $incomingStatus after $currentStatus as an incompatible terminal no-op",
    async ({ currentStatus, incomingStatus, timestampField }) => {
      const stored = {
        id: "ledger-row-1",
        status: currentStatus,
        delivered_at:
          currentStatus === "delivered" || currentStatus === "read"
            ? "2026-07-24T08:01:00.000Z"
            : null,
        read_at: currentStatus === "read" ? "2026-07-24T08:02:00.000Z" : null,
        failed_at:
          currentStatus === "failed" ? "2026-07-24T08:01:00.000Z" : null,
        updated_at: "2026-07-24T08:02:01.000Z",
      };
      const initial = { ...stored };
      from.mockReturnValue(createStatefulStatusTable(stored));

      await expect(
        persistCampaignMessageStatusWithOutbox({
          messageId: "wamid-1",
          updateData: {
            status: incomingStatus,
            [timestampField]: "2026-07-24T08:03:00.000Z",
            updated_at: "2026-07-24T08:03:01.000Z",
          },
        })
      ).resolves.toEqual({ applied: true, queuedToOutbox: false });

      expect(stored).toEqual(initial);
    }
  );

  it("keeps provider message identity in outbox dedupe for later resends", async () => {
    const failedUpdate = createQuery({
      data: null,
      error: { message: "temporary Supabase outage" },
    });
    from.mockReturnValue({ update: jest.fn(() => failedUpdate) });
    const base = {
      campaignId: "campaign-1",
      channel: "whatsapp" as const,
      recipient: "77000000001",
      provider: "meta",
    };

    await persistCampaignMessageSentWithOutbox({
      ...base,
      messageId: "wamid-first",
    });
    await persistCampaignMessageSentWithOutbox({
      ...base,
      messageId: "wamid-second",
    });

    const findOneAndUpdate = CrossStoreOutbox.findOneAndUpdate as jest.Mock;
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    const firstKey = findOneAndUpdate.mock.calls[0]?.[0]?.dedupeKey;
    const secondKey = findOneAndUpdate.mock.calls[1]?.[0]?.dedupeKey;
    expect(firstKey).toContain("wamid-first");
    expect(secondKey).toContain("wamid-second");
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps same-recipient attempt outbox entries distinct by snapshot ordinal", async () => {
    const failedUpdate = createQuery({
      data: null,
      error: { message: "temporary Supabase outage" },
    });
    const lookupQuery = createListQuery([
      {
        id: "ledger-row",
        status: "pending",
        channel: "whatsapp",
        recipient: "77000000001",
      },
    ]);
    from.mockReturnValue({
      select: jest.fn(() => lookupQuery),
      update: jest.fn(() => failedUpdate),
    });
    const base = {
      campaignId: "campaign-1",
      channel: "whatsapp" as const,
      recipient: "77000000001",
      provider: "meta",
      status: "attempted" as const,
      attemptedAt: "2026-07-24T08:00:00.000Z",
    };

    await persistCampaignMessageAttemptWithOutbox({
      ...base,
      snapshotOrdinal: 0,
    });
    await persistCampaignMessageAttemptWithOutbox({
      ...base,
      snapshotOrdinal: 1,
    });

    const findOneAndUpdate = CrossStoreOutbox.findOneAndUpdate as jest.Mock;
    const firstKey = findOneAndUpdate.mock.calls[0]?.[0]?.dedupeKey;
    const secondKey = findOneAndUpdate.mock.calls[1]?.[0]?.dedupeKey;
    expect(firstKey).toContain("snapshot:0");
    expect(secondKey).toContain("snapshot:1");
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps repeated sent replays idempotent against the same preseeded row", async () => {
    const first = createQuery({ data: { id: "ledger-row-1" }, error: null });
    const replay = createQuery({ data: { id: "ledger-row-1" }, error: null });
    const update = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(replay);
    const insert = jest.fn();
    from.mockReturnValue({
      update,
      insert,
      select: jest.fn(() => createPendingLifecycleLookup()),
    });
    const payload = {
      campaignId: "campaign-1",
      messageId: "wamid-1",
      channel: "whatsapp" as const,
      recipient: "77000000001",
      provider: "meta",
      status: "sent",
      attemptedAt: "2026-07-24T08:00:00.000Z",
    };

    await persistCampaignMessageSentWithOutbox(payload);
    await persistCampaignMessageSentWithOutbox(payload);

    expect(update).toHaveBeenCalledTimes(2);
    expect(insert).not.toHaveBeenCalled();
  });

  it("fails closed and queues the operation when the required safety schema is missing", async () => {
    const updateQuery = createQuery({
      data: null,
      error: {
        code: "PGRST204",
        message:
          "Could not find the 'attempted_at' column of 'campaign_messages' in the schema cache",
      },
    });
    const insert = jest.fn();
    from.mockReturnValue({
      update: jest.fn(() => updateQuery),
      insert,
    });

    const result = await persistCampaignMessageSentWithOutbox({
      campaignId: "campaign-1",
      messageId: "wamid-1",
      channel: "whatsapp",
      recipient: "77000000001",
      provider: "meta",
      attemptedAt: "2026-07-24T08:00:00.000Z",
    });

    expect(result.applied).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("inserts only a missing-ordinal dynamic first attempt with structured insertIfMissing identity", async () => {
    const historyQuery = createQuery({
      data: {
        audience_fingerprint: null,
        workspace_id: "workspace-1",
        channel: "whatsapp",
        scenario_id: "scenario-1",
        scenario_node_id: "node-1",
        execution_source: "scenario_schedule",
      },
      error: null,
    });
    const insert = jest
      .fn()
      .mockResolvedValue({ data: { id: "new-row" }, error: null });
    from.mockImplementation((table: string) => {
      if (table === "campaign_history") {
        return { select: jest.fn(() => historyQuery) };
      }
      return {
        select: jest.fn(() => createQuery({ data: null, error: null })),
        insert,
      };
    });

    const result = await persistCampaignMessageAttemptWithOutbox({
      campaignId: "campaign-1",
      channel: "whatsapp",
      recipient: "15550000001",
      phone: "15550000001",
      provider: "meta",
      status: "failed",
      attemptedAt: "2026-08-24T12:00:00.000Z",
      failedAt: "2026-08-24T12:00:01.000Z",
      providerError: {
        code: "131026",
        scope: "recipient",
        message: "recipient unavailable",
      },
      insertIfMissing: {
        messageId: "campaign-delivery-task:task-1",
        workspaceId: "workspace-1",
        recipientHash: "a".repeat(64),
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
      },
    });

    expect(result).toEqual({ applied: true, queuedToOutbox: false });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        campaign_id: "campaign-1",
        message_id: "campaign-delivery-task:task-1",
        workspace_id: "workspace-1",
        recipient_hash: "a".repeat(64),
        recipient: "15550000001",
        scenario_id: "scenario-1",
        scenario_node_id: "node-1",
        execution_source: "scenario_schedule",
        status: "failed",
      })
    );
    expect(JSON.stringify(insert.mock.calls[0]?.[0])).not.toContain(
      "15550000001secret"
    );
  });

  it("hard-fails a missing ordinal insert against a fingerprinted admitted campaign", async () => {
    const historyQuery = createQuery({
      data: {
        audience_fingerprint: "b".repeat(64),
        workspace_id: "workspace-1",
        channel: "whatsapp",
        scenario_id: "scenario-1",
        scenario_node_id: "node-1",
        execution_source: "scenario_schedule",
      },
      error: null,
    });
    const insert = jest.fn();
    from.mockImplementation((table: string) =>
      table === "campaign_history"
        ? { select: jest.fn(() => historyQuery) }
        : {
            select: jest.fn(() => createQuery({ data: null, error: null })),
            insert,
          }
    );

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "15550000001",
        status: "failed",
        insertIfMissing: {
          messageId: "campaign-delivery-task:task-1",
          workspaceId: "workspace-1",
          recipientHash: "a".repeat(64),
          scenarioId: "scenario-1",
          scenarioNodeId: "node-1",
          executionSource: "scenario_schedule",
        },
      })
    ).rejects.toThrow(/fingerprinted|admitted/i);
    expect(insert).not.toHaveBeenCalled();
  });

  it("never inserts when a snapshot ordinal miss occurs", async () => {
    const insert = jest.fn();
    from.mockReturnValue({
      select: jest.fn(() => createQuery({ data: null, error: null })),
      insert,
    });

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        snapshotOrdinal: 0,
        channel: "whatsapp",
        recipient: "15550000001",
        status: "failed",
        insertIfMissing: {
          messageId: "campaign-delivery-task:task-1",
          workspaceId: "workspace-1",
          recipientHash: "a".repeat(64),
          scenarioId: "scenario-1",
          scenarioNodeId: "node-1",
          executionSource: "scenario_schedule",
        },
      })
    ).rejects.toThrow(/admitted dispatch item row not found/);
    expect(insert).not.toHaveBeenCalled();
  });

  it("treats an exact insertIfMissing race as idempotent and fails closed on conflicting identity", async () => {
    const historyQuery = createQuery({
      data: {
        audience_fingerprint: null,
        workspace_id: "workspace-1",
        channel: "whatsapp",
        scenario_id: "scenario-1",
        scenario_node_id: "node-1",
        execution_source: "scenario_schedule",
      },
      error: null,
    });
    const insert = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    const emptyLookup = createQuery({ data: null, error: null });
    const racedLookup = createQuery({
      data: {
        id: "raced-row",
        status: "failed",
        message_id: "campaign-delivery-task:task-1",
        provider: "meta",
        channel: "whatsapp",
        recipient: "15550000001",
      },
      error: null,
    });
    const conflictingLookup = createQuery({
      data: {
        id: "conflict-row",
        status: "failed",
        message_id: "campaign-delivery-task:other",
        provider: "meta",
        channel: "whatsapp",
        recipient: "15550000001",
      },
      error: null,
    });
    const selectResults = [
      emptyLookup,
      racedLookup,
      emptyLookup,
      conflictingLookup,
    ];
    from.mockImplementation((table: string) => {
      if (table === "campaign_history") {
        return { select: jest.fn(() => historyQuery) };
      }
      return {
        select: jest.fn(() => selectResults.shift() || conflictingLookup),
        insert,
        update: jest.fn(() =>
          createQuery({ data: { id: "existing-row" }, error: null })
        ),
      };
    });

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "15550000001",
        provider: "meta",
        status: "failed",
        insertIfMissing: {
          messageId: "campaign-delivery-task:task-1",
          workspaceId: "workspace-1",
          recipientHash: "a".repeat(64),
          scenarioId: "scenario-1",
          scenarioNodeId: "node-1",
          executionSource: "scenario_schedule",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "15550000001",
        provider: "meta",
        status: "failed",
        insertIfMissing: {
          messageId: "campaign-delivery-task:task-1",
          workspaceId: "workspace-1",
          recipientHash: "a".repeat(64),
          scenarioId: "scenario-1",
          scenarioNodeId: "node-1",
          executionSource: "scenario_schedule",
        },
      })
    ).rejects.toThrow(/conflicting identity/);

    await expect(
      persistCampaignMessageAttemptWithOutbox({
        campaignId: "campaign-1",
        channel: "whatsapp",
        recipient: "15550000001",
        provider: "meta",
        status: "failed",
        insertIfMissing: {
          messageId: "campaign-delivery-task:task-1",
          workspaceId: "workspace-1",
          recipientHash: "a".repeat(64),
          scenarioId: "scenario-1",
          scenarioNodeId: "node-1",
          executionSource: "scenario_schedule",
        },
      })
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });
  });

  it("uses a stable campaign-delivery-task dedupe key that omits raw recipient identity", async () => {
    const enqueue = CrossStoreOutbox.findOneAndUpdate as jest.Mock;
    from.mockImplementation(() => {
      throw new Error("supabase unavailable");
    });
    enqueue.mockResolvedValue({ _id: "outbox-1" });

    const result = await persistCampaignMessageAttemptWithOutbox({
      campaignId: "campaign-1",
      channel: "whatsapp",
      recipient: "15550000001",
      status: "failed",
      insertIfMissing: {
        messageId: "campaign-delivery-task:task-99",
        workspaceId: "workspace-1",
        recipientHash: "a".repeat(64),
        scenarioId: "scenario-1",
        scenarioNodeId: "node-1",
        executionSource: "scenario_schedule",
      },
    });

    expect(result.queuedToOutbox).toBe(true);
    const findOneAndUpdate = CrossStoreOutbox.findOneAndUpdate as jest.Mock;
    const dedupeKey = findOneAndUpdate.mock.calls[0]?.[0]?.dedupeKey;
    expect(String(dedupeKey)).toContain("campaign-delivery-task:task-99");
    expect(String(dedupeKey)).not.toContain("15550000001");
  });
});

describe("durable LLM product analytics persistence", () => {
  const productEvent = {
    event_id: "trace-1",
    event_kind: "llm_trace",
    event_ts: "2026-08-13T12:00:00.000Z",
    schema_version: 2,
    workspace_id: "workspace-1",
    conversation_id: "conversation-1",
    operation: "airi.reply.generate",
    provider: "vertex",
    model: "gemini",
    status: "ok",
    input_excerpt: "private prompt",
    metadata: { private: "value" },
  } satisfies LlmAnalyticsWarehouseEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPublishRemoteLlmAnalyticsEvents.mockResolvedValue({
      accepted: 1,
      published: 1,
      skipped: false,
      topics: ["icecore-llm-product-events"],
    });
    (CrossStoreOutbox.countDocuments as jest.Mock).mockResolvedValue(0);
  });

  it("awaits a complete gateway publish without creating an outbox row", async () => {
    await expect(
      persistLlmAnalyticsEventsWithOutbox([productEvent])
    ).resolves.toEqual({ applied: true, queuedToOutbox: false });

    expect(mockPublishRemoteLlmAnalyticsEvents).toHaveBeenCalledWith([
      expect.objectContaining({ event_id: "trace-1" }),
    ]);
    expect(CrossStoreOutbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("publishes product analytics in gateway-sized batches", async () => {
    const events = Array.from({ length: 201 }, (_, index) => ({
      ...productEvent,
      event_id: `trace-${String(201 - index).padStart(3, "0")}`,
    }));
    mockPublishRemoteLlmAnalyticsEvents.mockImplementation(
      async (batch: LlmAnalyticsWarehouseEvent[]) => ({
        accepted: batch.length,
        published: batch.length,
        skipped: false,
        topics: ["icecore-llm-product-events"],
      })
    );

    await expect(persistLlmAnalyticsEventsWithOutbox(events)).resolves.toEqual({
      applied: true,
      queuedToOutbox: false,
    });

    expect(mockPublishRemoteLlmAnalyticsEvents).toHaveBeenCalledTimes(3);
    expect(
      mockPublishRemoteLlmAnalyticsEvents.mock.calls.map(([batch]) =>
        batch.map((event: LlmAnalyticsWarehouseEvent) => event.event_id)
      )
    ).toEqual([
      events.slice(0, 100).map(event => event.event_id),
      events.slice(100, 200).map(event => event.event_id),
      [events[200].event_id],
    ]);
    expect(CrossStoreOutbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("queues gateway-sized analytics batches when direct publishing fails", async () => {
    const events = Array.from({ length: 201 }, (_, index) => ({
      ...productEvent,
      event_id: `trace-${String(index + 1).padStart(3, "0")}`,
    }));
    mockPublishRemoteLlmAnalyticsEvents.mockRejectedValue(
      new Error("gateway unavailable")
    );

    await expect(
      persistLlmAnalyticsEventsWithOutbox(events)
    ).resolves.toMatchObject({ applied: false, queuedToOutbox: true });

    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledTimes(3);
    expect(
      (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mock.calls.map(
        ([, update]) => update.$setOnInsert.payload.events.length
      )
    ).toEqual([100, 100, 1]);
  });

  it("queues a sanitized, deduplicated batch when the gateway fails", async () => {
    mockPublishRemoteLlmAnalyticsEvents.mockRejectedValueOnce(
      new Error("gateway unavailable")
    );

    await expect(
      persistLlmAnalyticsEventsWithOutbox([productEvent])
    ).resolves.toMatchObject({ applied: false, queuedToOutbox: true });

    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = (CrossStoreOutbox.findOneAndUpdate as jest.Mock)
      .mock.calls[0];
    expect(filter).toMatchObject({
      target: "gcp_ai_gateway",
      operation: "llm_analytics.publish_events",
    });
    expect(filter).not.toHaveProperty("status");
    expect(filter.dedupeKey).toMatch(
      /^llm_analytics\.publish_events:[a-f0-9]{64}$/
    );
    expect(update.$setOnInsert.payload.events).toEqual([
      expect.objectContaining({ event_id: "trace-1" }),
    ]);
    expect(JSON.stringify(update.$setOnInsert.payload)).not.toMatch(
      /private prompt|\"private\":\"value\"/
    );
  });

  it("rearms the one logical analytics row after an operator-visible terminal failure", async () => {
    mockPublishRemoteLlmAnalyticsEvents.mockRejectedValueOnce(
      new Error("gateway unavailable")
    );
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockResolvedValueOnce({
      _id: "outbox-failed-1",
      status: "failed",
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValueOnce({
      modifiedCount: 1,
    });

    await expect(
      persistLlmAnalyticsEventsWithOutbox([productEvent])
    ).resolves.toMatchObject({ applied: false, queuedToOutbox: true });

    expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
      { _id: "outbox-failed-1", status: "failed" },
      {
        $set: expect.objectContaining({
          attempts: 0,
          completedAt: null,
          lastError: null,
          status: "pending",
        }),
      }
    );
  });

  it("does not retry or enqueue a permanent gateway contract rejection", async () => {
    mockPublishRemoteLlmAnalyticsEvents.mockRejectedValueOnce(
      new GcpAiGatewayHttpError(400, "invalid analytics batch")
    );

    await expect(
      persistLlmAnalyticsEventsWithOutbox([productEvent])
    ).resolves.toMatchObject({
      applied: false,
      queuedToOutbox: false,
      errorMessage: expect.stringContaining("invalid analytics batch"),
    });
    expect(CrossStoreOutbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("retains authentication failures for replay instead of dropping facts", async () => {
    mockPublishRemoteLlmAnalyticsEvents.mockRejectedValueOnce(
      new GcpAiGatewayHttpError(401, "token temporarily rejected")
    );

    await expect(
      persistLlmAnalyticsEventsWithOutbox([productEvent])
    ).resolves.toMatchObject({ applied: false, queuedToOutbox: true });
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("surfaces the dual failure when neither publish nor durable queue succeeds", async () => {
    mockPublishRemoteLlmAnalyticsEvents.mockRejectedValueOnce(
      new Error("gateway unavailable")
    );
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockRejectedValueOnce(
      new Error("mongo unavailable")
    );

    await expect(
      persistLlmAnalyticsEventsWithOutbox([productEvent])
    ).resolves.toMatchObject({
      applied: false,
      queuedToOutbox: false,
      errorMessage: expect.stringContaining("outbox enqueue failed"),
    });
  });

  it.each([
    { providerSucceeds: true, expectedStatus: "completed" },
    { providerSucceeds: false, expectedStatus: "pending" },
  ])(
    "replays queued analytics with provider success=$providerSucceeds",
    async ({ providerSucceeds, expectedStatus }) => {
      (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
        modifiedCount: 0,
      });
      (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
        sort: () => ({
          limit: () => ({
            select: () => ({
              lean: async () => [{ _id: "outbox-1" }],
            }),
          }),
        }),
      });
      (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
        lean: async () => ({
          _id: "outbox-1",
          operation: "llm_analytics.publish_events",
          payload: { events: [productEvent] },
          attempts: 1,
          maxAttempts: 12,
        }),
      });
      (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
        modifiedCount: 1,
      });
      if (!providerSucceeds) {
        mockPublishRemoteLlmAnalyticsEvents.mockRejectedValueOnce(
          new Error("temporary gateway outage")
        );
      }

      const result = await processCrossStoreOutboxBatch({ limit: 1 });

      expect(result).toMatchObject(
        providerSucceeds
          ? { claimed: 1, completed: 1, retried: 0 }
          : { claimed: 1, completed: 0, retried: 1 }
      );
      expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
        { _id: "outbox-1", status: "processing" },
        expect.objectContaining({
          $set: expect.objectContaining({ status: expectedStatus }),
        })
      );
    }
  );

  it("fails a queued analytics contract rejection without retrying it", async () => {
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: async () => [{ _id: "outbox-poison" }] }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "outbox-poison",
        operation: "llm_analytics.publish_events",
        payload: { events: [productEvent] },
        attempts: 1,
        maxAttempts: 12,
      }),
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    mockPublishRemoteLlmAnalyticsEvents.mockRejectedValueOnce(
      new GcpAiGatewayHttpError(400, "invalid analytics batch")
    );

    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({
      claimed: 1,
      failed: 1,
      retried: 0,
    });
    expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
      { _id: "outbox-poison", status: "processing" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "failed" }),
      })
    );
  });

  it("drains analytics concurrently and reports the remaining Mongo backlog", async () => {
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: (value: number) => ({
          select: () => ({
            lean: async () =>
              Array.from({ length: value }, (_, index) => ({
                _id: `outbox-${index + 1}`,
              })),
          }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockImplementation(
      (filter: { _id: string }) => ({
        lean: async () => ({
          _id: filter._id,
          operation: "llm_analytics.publish_events",
          payload: { events: [productEvent] },
          attempts: 1,
          maxAttempts: 12,
        }),
      })
    );
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    (CrossStoreOutbox.countDocuments as jest.Mock)
      .mockResolvedValueOnce(37)
      .mockResolvedValueOnce(2);
    let active = 0;
    let maximumActive = 0;
    mockPublishRemoteLlmAnalyticsEvents.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        accepted: 1,
        published: 1,
        skipped: false,
        topics: ["icecore-llm-product-events"],
      };
    });

    await expect(processCrossStoreOutboxBatch()).resolves.toMatchObject({
      claimed: 200,
      completed: 200,
      analyticsBacklog: 37,
      analyticsFailed: 2,
    });
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(10);
  });
});

describe("durable WhatsApp LLM feedback prompt delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (CrossStoreOutbox.countDocuments as jest.Mock).mockResolvedValue(0);
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-number-id",
      accessToken: "secret-access-token",
    });
    mockSendWhatsAppLlmHelpfulnessPrompt.mockResolvedValue({
      messageId: "wamid.feedback-prompt",
    });
    mockSendWhatsAppLlmFeedbackReasonPrompt.mockResolvedValue({
      messageId: "wamid.feedback-reason-prompt",
    });
    mockUpsertWhatsAppLlmAnswerReviewItem.mockResolvedValue({
      item: { _id: "review-item-1" },
      inserted: false,
    });
  });

  it("queues one secret-free prompt identity across every durable status", async () => {
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockResolvedValue({
      _id: "outbox-prompt-1",
    });

    await expect(
      enqueueWhatsAppLlmHelpfulnessPromptWithOutbox({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        sourceId: "source-1",
        recipient: { kind: "phone", value: "77000000001" },
        sourceMessageId: "wamid.answer-1",
      })
    ).resolves.toEqual({ queuedToOutbox: true });

    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = (CrossStoreOutbox.findOneAndUpdate as jest.Mock)
      .mock.calls[0];
    expect(filter).toMatchObject({
      target: "whatsapp_cloud_api",
      operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
      dedupeKey: expect.stringMatching(
        /^whatsapp_llm_feedback\.send_helpfulness_prompt:[a-f0-9]{64}$/
      ),
    });
    expect(filter).not.toHaveProperty("status");
    expect(update.$setOnInsert).toMatchObject({
      target: "whatsapp_cloud_api",
      operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
      payload: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        sourceId: "source-1",
        recipient: { kind: "phone", value: "77000000001" },
        sourceMessageId: "wamid.answer-1",
      },
      status: "pending",
      maxAttempts: 12,
    });
    expect(JSON.stringify(update.$setOnInsert)).not.toContain(
      "secret-access-token"
    );
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });

  it("queues a secret-free negative-feedback reason prompt with its own durable identity", async () => {
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockResolvedValue({
      _id: "outbox-reason-prompt-1",
    });

    await expect(
      enqueueWhatsAppLlmFeedbackReasonPromptWithOutbox({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        sourceId: "source-1",
        recipient: "77000000001",
        sourceMessageId: "wamid.answer-1",
      })
    ).resolves.toEqual({ queuedToOutbox: true });

    const [filter, update] = (CrossStoreOutbox.findOneAndUpdate as jest.Mock)
      .mock.calls[0];
    expect(filter).toMatchObject({
      target: "whatsapp_cloud_api",
      operation: "whatsapp_llm_feedback.send_reason_prompt",
      dedupeKey: expect.stringMatching(
        /^whatsapp_llm_feedback\.send_reason_prompt:[a-f0-9]{64}$/
      ),
    });
    expect(update.$setOnInsert.payload).toEqual({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceId: "source-1",
      recipient: { kind: "phone", value: "77000000001" },
      sourceMessageId: "wamid.answer-1",
    });
    expect(JSON.stringify(update.$setOnInsert)).not.toContain(
      "secret-access-token"
    );
  });

  it("queues a negative-feedback reason prompt without an answer message id", async () => {
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockResolvedValue({
      _id: "outbox-reason-prompt-without-answer",
    });

    await expect(
      enqueueWhatsAppLlmFeedbackReasonPromptWithOutbox({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        sourceId: "source-1",
        recipient: { kind: "phone", value: "77000000001" },
        sourceMessageId: null,
      })
    ).resolves.toEqual({ queuedToOutbox: true });

    const [, update] = (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mock
      .calls[0];
    expect(update.$setOnInsert.payload).toEqual({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceId: "source-1",
      recipient: { kind: "phone", value: "77000000001" },
      sourceMessageId: null,
    });
  });

  it("delivers a queued reason prompt through the same at-most-once boundary", async () => {
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [{ _id: "outbox-reason-prompt-1" }],
          }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "outbox-reason-prompt-1",
        operation: "whatsapp_llm_feedback.send_reason_prompt",
        payload: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          sourceId: "source-1",
          recipient: { kind: "phone", value: "77000000001" },
          sourceMessageId: null,
        },
        attempts: 1,
        maxAttempts: 12,
      }),
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });

    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ claimed: 1, completed: 1, retried: 0 });

    expect(mockSendWhatsAppLlmFeedbackReasonPrompt).toHaveBeenCalledWith({
      phoneNumberId: "phone-number-id",
      accessToken: "secret-access-token",
      recipient: { kind: "phone", value: "77000000001" },
      sourceMessageId: null,
    });
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });

  it("resolves current credentials only when the queued prompt is delivered", async () => {
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [{ _id: "outbox-prompt-1" }],
          }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "outbox-prompt-1",
        operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
        payload: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          sourceId: "source-1",
          recipient: { kind: "phone", value: "77000000001" },
          sourceMessageId: "wamid.answer-1",
        },
        attempts: 1,
        maxAttempts: 12,
      }),
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });

    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ claimed: 1, completed: 1, retried: 0 });

    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).toHaveBeenCalledWith({
      phoneNumberId: "phone-number-id",
      accessToken: "secret-access-token",
      recipient: { kind: "phone", value: "77000000001" },
      sourceMessageId: "wamid.answer-1",
    });
    expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
      { _id: "outbox-prompt-1", status: "delivery_unknown" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "completed" }),
      })
    );
  });

  it("keeps an accepted-or-unknown provider failure terminal instead of risking a duplicate prompt", async () => {
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [{ _id: "outbox-prompt-1" }],
          }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "outbox-prompt-1",
        operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
        payload: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          sourceId: "source-1",
          recipient: { kind: "phone", value: "77000000001" },
          sourceMessageId: "wamid.answer-1",
        },
        attempts: 1,
        maxAttempts: 12,
      }),
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    mockSendWhatsAppLlmHelpfulnessPrompt.mockRejectedValueOnce(
      new Error("temporary Meta outage")
    );

    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 1,
      retried: 0,
    });
    expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
      { _id: "outbox-prompt-1", status: "delivery_unknown" },
      expect.objectContaining({
        $set: expect.objectContaining({
          lastError: expect.stringContaining("temporary Meta outage"),
        }),
      })
    );
  });

  it("retries safely when delivery ownership cannot be persisted before the provider call", async () => {
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [{ _id: "outbox-prompt-1" }],
          }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "outbox-prompt-1",
        operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
        payload: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          sourceId: "source-1",
          recipient: { kind: "phone", value: "77000000001" },
          sourceMessageId: "wamid.answer-1",
        },
        attempts: 1,
        maxAttempts: 12,
      }),
    });
    (CrossStoreOutbox.updateOne as jest.Mock)
      .mockRejectedValueOnce(new Error("Mongo transition unavailable"))
      .mockResolvedValueOnce({ modifiedCount: 1 });

    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 0,
      retried: 1,
    });
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
    expect(CrossStoreOutbox.updateOne).toHaveBeenLastCalledWith(
      { _id: "outbox-prompt-1", status: "processing" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "pending" }),
      })
    );
  });

  it("retains delivery_unknown when completion persistence fails after the provider call", async () => {
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [{ _id: "outbox-prompt-1" }],
          }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "outbox-prompt-1",
        operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
        payload: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          sourceId: "source-1",
          recipient: { kind: "phone", value: "77000000001" },
          sourceMessageId: "wamid.answer-1",
        },
        attempts: 1,
        maxAttempts: 12,
      }),
    });
    (CrossStoreOutbox.updateOne as jest.Mock)
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });

    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 1,
      retried: 0,
    });
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).toHaveBeenCalledTimes(1);
    expect(CrossStoreOutbox.updateOne).toHaveBeenLastCalledWith(
      { _id: "outbox-prompt-1", status: "delivery_unknown" },
      expect.objectContaining({
        $set: expect.objectContaining({
          lastError: expect.stringContaining(
            "completion ownership was lost after provider send"
          ),
        }),
      })
    );
  });
});

describe("Meta conversion outbox delivery", () => {
  const payload = {
    workspaceId: "22222222-2222-4222-8222-222222222222",
    conversionId: "11111111-1111-4111-8111-111111111111",
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcileMetaConversions.mockResolvedValue(0);
    (CrossStoreOutbox.countDocuments as jest.Mock).mockResolvedValue(0);
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: async () => [{ _id: "meta-row" }] }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "meta-row",
        operation: "meta_conversions.publish_event",
        payload,
        attempts: 1,
        maxAttempts: 8,
      }),
    });
  });

  it("enqueues only the stable ledger identity in the existing queue", async () => {
    await enqueueMetaConversionWithOutbox(payload);
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      {
        target: "whatsapp_cloud_api",
        operation: "meta_conversions.publish_event",
        dedupeKey: `meta_conversions:${payload.workspaceId}:${payload.conversionId}`,
      },
      { $setOnInsert: expect.objectContaining({ payload, status: "pending" }) },
      { upsert: true, new: true }
    );
  });

  it.each(["sent", "delivery_unknown", "rejected"] as const)(
    "preserves the canonical %s result in the outbox",
    async status => {
      mockDeliverMetaConversion.mockResolvedValue({ status });
      await processCrossStoreOutboxBatch({ limit: 1 });
      expect(mockReconcileMetaConversions).toHaveBeenCalledWith(
        expect.objectContaining({
          enqueue: enqueueMetaConversionWithOutbox,
          limit: 1,
        })
      );
      expect(mockDeliverMetaConversion).toHaveBeenCalledWith(payload);
      expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
        { _id: "meta-row", status: "processing" },
        {
          $set: expect.objectContaining({
            status:
              status === "sent"
                ? "completed"
                : status === "rejected"
                  ? "failed"
                  : "delivery_unknown",
          }),
        }
      );
    }
  );

  it("still drains existing jobs when SQL reconciliation is unavailable", async () => {
    mockReconcileMetaConversions.mockRejectedValueOnce(
      new Error("unavailable")
    );
    mockDeliverMetaConversion.mockResolvedValue({ status: "sent" });
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ completed: 1 });
  });
});

describe("confirmed payment outbox delivery", () => {
  const payload = {
    workspaceId: "22222222-2222-4222-8222-222222222222",
    conversionId: "11111111-1111-4111-8111-111111111111",
  };
  let attempts: number;
  beforeEach(() => {
    jest.clearAllMocks();
    attempts = 1;
    mockDispatchConfirmedPayment
      .mockReset()
      .mockResolvedValue({ status: "queued" });
    mockReconcileConfirmedPayments.mockResolvedValue(0);
    (CrossStoreOutbox.countDocuments as jest.Mock).mockResolvedValue(0);
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: async () => [{ _id: "payment-row" }] }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "payment-row",
        operation: "conversion.confirmed_payment",
        payload,
        attempts,
        maxAttempts: 8,
      }),
    });
  });
  it("queues only stable ledger identity in the existing Temporal target", async () => {
    await enqueueConfirmedPaymentWithOutbox(payload);
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      {
        target: "temporal",
        operation: "conversion.confirmed_payment",
        dedupeKey: `confirmed-payment:${payload.workspaceId}:${payload.conversionId}`,
      },
      { $setOnInsert: expect.objectContaining({ payload, status: "pending" }) },
      { upsert: true, new: true }
    );
  });
  it("reconciles pending SQL intent and completes after a retryable internal signal", async () => {
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(mockDispatchConfirmedPayment).toHaveBeenCalledWith(payload);
    expect(mockReconcileConfirmedPayments).toHaveBeenCalledWith(
      expect.objectContaining({
        enqueue: enqueueConfirmedPaymentWithOutbox,
        limit: 1,
      })
    );
    expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
      { _id: "payment-row", status: "processing" },
      { $set: expect.objectContaining({ status: "completed" }) }
    );
  });
  it("retries unavailable Temporal and records final exhaustion in SQL", async () => {
    mockDispatchConfirmedPayment.mockRejectedValue(new Error("unavailable"));
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ retried: 1 });
    expect(mockRecordConfirmedPaymentFailure).not.toHaveBeenCalled();
    attempts = 8;
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ failed: 1 });
    expect(mockRecordConfirmedPaymentFailure).toHaveBeenCalledWith({
      ...payload,
      reason: "dispatch_retries_exhausted",
    });
  });
  it("does not terminalize an accepted payment when Mongo completion fails", async () => {
    attempts = 8;
    (CrossStoreOutbox.updateOne as jest.Mock)
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValue({ modifiedCount: 1 });
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ failed: 1 });
    expect(mockRecordConfirmedPaymentFailure).not.toHaveBeenCalled();
  });
});

describe("customer webhook outbox delivery", () => {
  let attempts: number;
  let payload: {
    workspaceId: string;
    eventType: "message.received";
    resourceId: string;
    timestamp: string;
    data: Record<string, unknown>;
    subscriptionIds?: string[];
  };
  beforeEach(() => {
    jest.clearAllMocks();
    attempts = 1;
    payload = {
      workspaceId: "workspace-1",
      eventType: "message.received",
      resourceId: "wamid.incoming",
      timestamp: "2026-10-03T04:00:00Z",
      data: { text: "Hello" },
    };
    mockDispatchCustomerWebhook.mockReset().mockResolvedValue(undefined);
    mockSnapshotWebhookSubscriptionIds
      .mockReset()
      .mockResolvedValue(["webhook-1"]);
    mockReconcileCustomerWebhookIntents
      .mockReset()
      .mockResolvedValue({ admitted: 0, hasMore: false });
    (CrossStoreOutbox.countDocuments as jest.Mock).mockResolvedValue(0);
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [{ _id: "customer-webhook-row" }],
          }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "customer-webhook-row",
        operation: "customer_webhooks.dispatch",
        payload,
        attempts,
        maxAttempts: 8,
      }),
    });
  });
  it("uses the existing queue and retains the original envelope on repeated admission", async () => {
    await enqueueCustomerWebhookWithOutbox(payload);
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "supabase",
        operation: "customer_webhooks.dispatch",
        dedupeKey: expect.stringMatching(/^customer-webhook:/),
      }),
      {
        $setOnInsert: expect.objectContaining({
          payload,
          maxAttempts: 8,
          attempts: 0,
        }),
      },
      { upsert: true, new: true }
    );
    expect(mockDispatchCustomerWebhook).not.toHaveBeenCalled();
  });
  it("freezes tenant subscriptions before HTTP and completes after delivery", async () => {
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ completed: 1 });
    expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
      { _id: "customer-webhook-row", status: "processing" },
      { $set: { "payload.subscriptionIds": ["webhook-1"] } }
    );
    expect(mockDispatchCustomerWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionIds: ["webhook-1"],
        workspaceId: "workspace-1",
      })
    );
    const snapshotOrder = (CrossStoreOutbox.updateOne as jest.Mock).mock
      .invocationCallOrder[0]!;
    expect(snapshotOrder).toBeLessThan(
      mockDispatchCustomerWebhook.mock.invocationCallOrder[0]!
    );
  });
  it("claims facts admitted during reconciliation in the same batch", async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-10-07T12:00:00Z"));
      let admittedAt: Date;
      mockReconcileCustomerWebhookIntents.mockImplementationOnce(async () => {
        jest.setSystemTime(new Date("2026-10-07T12:00:01Z"));
        admittedAt = new Date();
        return { admitted: 1, hasMore: false };
      });
      (CrossStoreOutbox.find as jest.Mock).mockImplementation(filter => ({
        sort: () => ({
          limit: () => ({
            select: () => ({
              lean: async () =>
                filter.nextRetryAt.$lte >= admittedAt
                  ? [{ _id: "customer-webhook-row" }]
                  : [],
            }),
          }),
        }),
      }));

      await expect(
        processCrossStoreOutboxBatch({ limit: 1 })
      ).resolves.toMatchObject({
        completed: 1,
        customerWebhookIntentsAdmitted: 1,
        customerWebhookIntentsHasMore: false,
      });
      expect(mockDispatchCustomerWebhook).toHaveBeenCalledTimes(1);
      expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "pending",
          nextRetryAt: { $lte: new Date("2026-10-07T12:00:01Z") },
        }),
        expect.anything(),
        { new: true }
      );
    } finally {
      jest.useRealTimers();
    }
  });
  it("returns unfinished admission progress to the bounded worker catch-up loop", async () => {
    mockReconcileCustomerWebhookIntents.mockResolvedValueOnce({
      admitted: 3,
      hasMore: true,
    });

    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({
      completed: 1,
      customerWebhookIntentsAdmitted: 3,
      customerWebhookIntentsHasMore: true,
    });
  });
  it("retries with the frozen subscriber set and terminalizes after eight attempts", async () => {
    payload.subscriptionIds = ["webhook-1"];
    mockDispatchCustomerWebhook.mockRejectedValue(new Error("HTTP 503"));
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ retried: 1, failed: 0 });
    expect(mockSnapshotWebhookSubscriptionIds).not.toHaveBeenCalled();
    expect(CrossStoreOutbox.updateOne).toHaveBeenLastCalledWith(
      { _id: "customer-webhook-row", status: "processing" },
      {
        $set: expect.objectContaining({
          status: "pending",
          nextRetryAt: expect.any(Date),
        }),
      }
    );
    attempts = 8;
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ failed: 1, retried: 0 });
    expect(CrossStoreOutbox.updateOne).toHaveBeenLastCalledWith(
      { _id: "customer-webhook-row", status: "processing" },
      { $set: expect.objectContaining({ status: "failed" }) }
    );
  });
  it("never sends HTTP when subscription snapshot persistence loses its lease", async () => {
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValueOnce({
      modifiedCount: 0,
    });
    await expect(
      processCrossStoreOutboxBatch({ limit: 1 })
    ).resolves.toMatchObject({ retried: 1 });
    expect(mockDispatchCustomerWebhook).not.toHaveBeenCalled();
  });
});


describe("deferred WhatsApp referral outbox", () => {
  const payload = {
    workspaceId: "workspace",
    conversationId: "conversation",
    messageId: "message",
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnrichStoredReferral.mockReset().mockResolvedValue(undefined);
    (CrossStoreOutbox.countDocuments as jest.Mock).mockResolvedValue(0);
    (CrossStoreOutbox.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 0,
    });
    (CrossStoreOutbox.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    (CrossStoreOutbox.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: async () => [{ _id: "referral-row" }] }),
        }),
      }),
    });
    (CrossStoreOutbox.findOneAndUpdate as jest.Mock).mockReturnValue({
      lean: async () => ({
        _id: "referral-row",
        operation: "whatsapp_referral.enrich",
        payload,
        attempts: 1,
        maxAttempts: 8,
      }),
    });
  });
  it("idempotently persists a stable scoped intent without metadata I/O", async () => {
    await enqueueWhatsAppReferralEnrichmentWithOutbox(payload);
    await enqueueWhatsAppReferralEnrichmentWithOutbox(payload);
    expect(CrossStoreOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      {
        target: "whatsapp_cloud_api",
        operation: "whatsapp_referral.enrich",
        dedupeKey: "whatsapp-referral:workspace:conversation:message",
      },
      { $setOnInsert: expect.objectContaining({ payload, status: "pending" }) },
      { upsert: true, new: true },
    );
    expect(mockEnrichStoredReferral).not.toHaveBeenCalled();
  });
  it("retains failure for the existing drain and completes a later retry", async () => {
    mockEnrichStoredReferral.mockRejectedValueOnce(
      new Error("metadata unavailable"),
    );
    expect(await processCrossStoreOutboxBatch({ limit: 1 })).toMatchObject({
      retried: 1,
    });
    expect(CrossStoreOutbox.updateOne).toHaveBeenCalledWith(
      { _id: "referral-row", status: "processing" },
      {
        $set: expect.objectContaining({
          status: "pending",
          lastError: expect.stringContaining("unavailable"),
        }),
      },
    );
    expect(await processCrossStoreOutboxBatch({ limit: 1 })).toMatchObject({
      completed: 1,
    });
    expect(mockEnrichStoredReferral).toHaveBeenCalledWith(payload);
  });
});
