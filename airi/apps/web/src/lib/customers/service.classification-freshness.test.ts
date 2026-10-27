import mongoose from "mongoose";

const mockConnectDB = jest.fn();
const mockConversationFindById = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockCustomerFindById = jest.fn();
const mockCustomerFindOne = jest.fn();
const mockCustomerUpdateOne = jest.fn();
const mockCustomerCreate = jest.fn();
const mockCustomerEventFindOne = jest.fn();
const mockCustomerEventFindOneAndUpdate = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: jest.fn(),
  getHeavyTextModel: jest.fn(() => "test-model"),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    find: (...args: unknown[]) => mockConversationFind(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockCustomerFindById(...args),
    findOne: (...args: unknown[]) => mockCustomerFindOne(...args),
    updateOne: (...args: unknown[]) => mockCustomerUpdateOne(...args),
    create: (...args: unknown[]) => mockCustomerCreate(...args),
  },
}));

jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockCustomerEventFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockCustomerEventFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

import {
  ensureCustomerForConversation,
  getCustomerById,
  recordCustomerStageSnapshotForConversation,
} from "@/lib/customers/service";

const conversationId = new mongoose.Types.ObjectId("66b8db4b52ca2cbd68b79311");
const customerId = new mongoose.Types.ObjectId("66b8db4b52ca2cbd68b79312");

function buildCurrentConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: conversationId,
    workspaceId: "ws-1",
    customerId,
    channel: "whatsapp",
    chat: null,
    user: null,
    sourceId: "source-1",
    visitor_id: null,
    rename: "Ada",
    preferred_language: "en",
    internal_labels: [] as string[],
    classification: {
      category: "Complaint",
      sentiment: "negative",
      tags: ["classifier-only", "churn-risk"],
    },
    is_classified: true,
    classification_revision: 7,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 7,
      appliedRevision: 7,
    },
    classification_meta: {
      source_revision: 7,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-7",
    },
    churn_risk_level: "medium",
    estimated_customer_ltv: 125,
    lastMessageAt: new Date("2026-08-10T10:00:00.000Z"),
    updatedAt: new Date("2026-08-10T10:00:00.000Z"),
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    page_url: null,
    ...overrides,
  };
}

function buildCustomer() {
  return {
    _id: customerId,
    workspaceId: "ws-1",
    status: "active",
    conversationIds: [conversationId],
    seedKeys: ["whatsapp:66b8db4b52ca2cbd68b79311"],
    identities: [],
    currentFunnelStage: "registered_business",
    crm_stage_event: null as unknown,
    profileSummary: {
      tags: ["registered_business", "registration_follow_up"],
      conversationCount: 1,
    },
    behavioralProfile: null,
  };
}

function queryResolving<T>(value: T) {
  return {
    select: jest.fn(() => ({
      lean: jest.fn().mockResolvedValue(value),
    })),
  };
}

describe("customer classification freshness materialization", () => {
  let conversation: ReturnType<typeof buildCurrentConversation>;
  let customer: ReturnType<typeof buildCustomer>;

  beforeEach(() => {
    jest.clearAllMocks();
    conversation = buildCurrentConversation();
    customer = buildCustomer();

    mockConnectDB.mockResolvedValue(undefined);
    mockConversationFindById.mockImplementation(() =>
      queryResolving(conversation)
    );
    mockConversationFind.mockImplementation(() =>
      queryResolving([conversation])
    );
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });
    mockCustomerFindById.mockImplementation(() => ({
      lean: jest.fn().mockResolvedValue(customer),
    }));
    mockCustomerUpdateOne.mockResolvedValue({ acknowledged: true });
    mockCustomerCreate.mockResolvedValue({ _id: customerId });
    mockCustomerFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    mockCustomerEventFindOne.mockReturnValue({
      sort: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue(null),
      })),
    });
    mockCustomerEventFindOneAndUpdate.mockResolvedValue({ _id: "event-1" });
  });

  it("preserves Customer-owned stage and tags and copies current sentiment", async () => {
    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    const aggregateUpdate = mockCustomerUpdateOne.mock.calls.find(
      ([, update]) =>
        Boolean(
          (update as { $set?: { profileSummary?: unknown } }).$set
            ?.profileSummary
        )
    )?.[1] as {
      $set: {
        currentFunnelStage: string | null;
        profileSummary: {
          tags: string[];
          lastSentiment: string | null;
          churnRiskLevel: string | null;
          estimatedCustomerLtv: number | null;
        };
      };
    };

    // The retained stage is unchanged, so it stays out of $set: the Customer
    // stage hook then needs no pre-read, and the stored stage is kept.
    expect(aggregateUpdate.$set).not.toHaveProperty("currentFunnelStage");
    expect(aggregateUpdate.$set.profileSummary.tags).toEqual([
      "registered_business",
      "registration_follow_up",
    ]);
    expect(aggregateUpdate.$set.profileSummary.lastSentiment).toBe("negative");
    expect(aggregateUpdate.$set.profileSummary.churnRiskLevel).toBe("medium");
    expect(aggregateUpdate.$set.profileSummary.estimatedCustomerLtv).toBe(125);
  });

  it("lets a manual conversation stage replace the retained Customer stage", async () => {
    conversation = buildCurrentConversation({
      internal_labels: ["seg:retention", "stage:qualified"],
    });

    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    const aggregateUpdate = mockCustomerUpdateOne.mock.calls.find(
      ([, update]) =>
        Boolean(
          (update as { $set?: { profileSummary?: unknown } }).$set
            ?.profileSummary
        )
    )?.[1] as { $set: { currentFunnelStage: string | null } };

    expect(aggregateUpdate.$set.currentFunnelStage).toBe("qualified");
  });

  it("does not persist marketing segment labels as CRM funnel stage", async () => {
    conversation = buildCurrentConversation({
      internal_labels: ["seg:retention"],
    });

    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    const aggregateUpdate = mockCustomerUpdateOne.mock.calls.find(
      ([, update]) =>
        Boolean(
          (update as { $set?: { profileSummary?: unknown } }).$set
            ?.profileSummary
        )
    )?.[1] as { $set: { currentFunnelStage: string | null } };

    expect(aggregateUpdate.$set).not.toHaveProperty("currentFunnelStage");
  });

  it("creates a Customer without classifier-derived stage, tags, or sentiment", async () => {
    conversation = buildCurrentConversation({ customerId: null });

    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    expect(mockCustomerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentFunnelStage: null,
        profileSummary: expect.objectContaining({
          tags: [],
          lastSentiment: null,
        }),
      })
    );
  });

  it("retains Customer-owned stage and tags when the aggregate is archived", async () => {
    mockConversationFind.mockImplementation(() => queryResolving([]));

    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    const archiveUpdate = mockCustomerUpdateOne.mock.calls.find(
      ([, update]) =>
        (update as { $set?: { status?: unknown } }).$set?.status === "archived"
    )?.[1] as {
      $set: {
        currentFunnelStage?: unknown;
        profileSummary: { tags: string[] };
      };
    };

    expect(archiveUpdate.$set).not.toHaveProperty("currentFunnelStage");
    expect(archiveUpdate.$set.profileSummary.tags).toEqual([
      "registered_business",
      "registration_follow_up",
    ]);
  });

  it("retains birthday-import ownership after conversation-backed aggregate refresh", async () => {
    customer.seedKeys.push("birthday_import:15550000001");

    await ensureCustomerForConversation({ conversationId: conversationId.toString() });

    const aggregateUpdate = mockCustomerUpdateOne.mock.calls.find(
      ([, update]) => Boolean(update.$set?.seedKeys)
    )?.[1];
    expect(aggregateUpdate.$set.seedKeys).toContain("birthday_import:15550000001");
  });

  it("does not create a Customer stage event from classifier category", async () => {
    const result = await recordCustomerStageSnapshotForConversation({
      conversationId: conversationId.toString(),
    });

    expect(result).toBeNull();
    expect(mockCustomerEventFindOne).not.toHaveBeenCalled();
    expect(mockCustomerEventFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("materializes the canonical durable stage event instead of deriving history from a conversation timestamp", async () => {
    conversation.internal_labels = ["stage:qualified"];
    const occurredAt = new Date("2026-10-02T01:00:00Z");
    customer.crm_stage_event = JSON.stringify({ contractVersion: 1, eventId: "canonical-return-event", revision: 3, occurredAt, workspaceId: "ws-1", customerId: String(customerId), conversationId: String(conversationId), previousStage: "proposal", stage: "qualified", actor: { type: "manager", userId: "manager" }, source: "crm_board" });
    await recordCustomerStageSnapshotForConversation({ conversationId: conversationId.toString() });
    expect(mockCustomerEventFindOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: "ws-1", idempotencyKey: "customer-stage:canonical-return-event" },
      { $setOnInsert: expect.objectContaining({ occurredAt, type: "stage_changed", actor: { type: "manager", userId: "manager" }, payload: expect.objectContaining({ stage: "qualified", previousStage: "proposal", stageRevision: 3 }) }) },
      { upsert: true, new: true }
    );
    expect(mockCustomerEventFindOne).not.toHaveBeenCalled();
  });
});

describe("birthday-imported customer aggregate durability", () => {
  let stored: Record<string, unknown>;

  async function viewCustomer() {
    const customer = await getCustomerById({ customerId: customerId.toHexString() });
    if (!customer || Array.isArray(customer)) {
      throw new Error("Expected a single customer document after profile viewing");
    }
    return customer;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    stored = {
      _id: customerId,
      workspaceId: "ws-1",
      status: "active",
      displayName: "Birthday CSV customer",
      primaryConversationId: null,
      conversationIds: [],
      identities: [{ type: "phone", channel: "whatsapp", normalizedValue: "15550000001", value: "15550000001", linkMethod: "manual" }],
      seedKeys: ["birthday_import:15550000001"],
      lastInteractionAt: null,
      profileSummary: { channels: ["whatsapp"], contactPoints: { phones: ["15550000001"] }, tags: ["customer-tag"], conversationCount: 0 },
      profileDates: { birthday: { month: 7, day: 23, source: "csv" } },
    };
    mockConnectDB.mockResolvedValue(undefined);
    mockCustomerFindById.mockImplementation(() => ({ lean: jest.fn(async () => ({ ...stored })) }));
    mockConversationFind.mockReturnValue(queryResolving([]));
    mockCustomerUpdateOne.mockImplementation(async (_filter, update) => {
      stored = { ...stored, ...update.$set };
      return { matchedCount: 1, modifiedCount: 1 };
    });
  });

  it("keeps a birthday-only imported contact active when its profile is viewed", async () => {
    const customer = await viewCustomer();

    expect(customer).toEqual(expect.objectContaining({
      status: "active",
      displayName: "Birthday CSV customer",
      profileSummary: expect.objectContaining({ contactPoints: { phones: ["15550000001"] }, tags: ["customer-tag"] }),
      profileDates: { birthday: { month: 7, day: 23, source: "csv" } },
    }));
  });

  it("preserves older imported contacts whose seed was removed by an earlier aggregate refresh", async () => {
    stored.seedKeys = ["whatsapp:removed-conversation"];

    const customer = await viewCustomer();

    expect(customer.status).toBe("active");
    expect(customer.displayName).toBe("Birthday CSV customer");
  });

  it("still archives orphaned conversation-only customers", async () => {
    stored.seedKeys = ["whatsapp:removed-conversation"];
    stored.profileDates = null;
    stored.identities = [{ type: "phone", channel: "whatsapp", normalizedValue: "15550000001", value: "15550000001", linkMethod: "system" }];

    const customer = await viewCustomer();

    expect(customer.status).toBe("archived");
  });

  it("does not reactivate an archived imported contact during profile viewing", async () => {
    stored.status = "archived";

    const customer = await viewCustomer();

    expect(customer.status).toBe("archived");
  });
});
