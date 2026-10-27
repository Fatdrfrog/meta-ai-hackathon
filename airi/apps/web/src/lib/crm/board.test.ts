const mockConnectDB = jest.fn();
const mockEnsureCustomerCrmIndexes = jest.fn();
const mockEnsureCustomerOwnerIndexes = jest.fn();
const mockCustomerFind = jest.fn();
const mockCustomerCountDocuments = jest.fn();
const mockCustomerAggregate = jest.fn();
const mockRequestListFind = jest.fn();
const mockConversationFind = jest.fn();
const mockCustomerEventAggregate = jest.fn();
const mockListWorkspaceMemberLabels = jest.fn();
const mockCustomerFindById = jest.fn();
const mockCustomerUpdateOne = jest.fn();
const mockMaterializeCustomerStageEvent = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/customers/service", () => ({
  recordCustomerEvent: jest.fn(),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: jest.fn(),
    find: (...args: unknown[]) => mockConversationFind(...args),
    updateOne: jest.fn(),
  },
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockCustomerFind(...args),
    countDocuments: (...args: unknown[]) => mockCustomerCountDocuments(...args),
    aggregate: (...args: unknown[]) => mockCustomerAggregate(...args),
    findById: (...args: unknown[]) => mockCustomerFindById(...args),
    updateOne: (...args: unknown[]) => mockCustomerUpdateOne(...args),
  },
  ensureCustomerCrmIndexes: (...args: unknown[]) =>
    mockEnsureCustomerCrmIndexes(...args),
  ensureCustomerOwnerIndexes: (...args: unknown[]) =>
    mockEnsureCustomerOwnerIndexes(...args),
}));

jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => mockCustomerEventAggregate(...args),
  },
}));

jest.mock("@/lib/supabase/company-users", () => ({
  listWorkspaceMemberLabels: (...args: unknown[]) =>
    mockListWorkspaceMemberLabels(...args),
}));

jest.mock("@/models/request-list-item", () => ({
  RequestListItem: {
    find: (...args: unknown[]) => mockRequestListFind(...args),
  },
}));

jest.mock("./board-realtime", () => ({
  notifyCrmBoardChanged: jest.fn(),
}));

jest.mock("@/lib/analytics/customer-stage-consumer", () => ({
  materializeCustomerStageEvent: (...args: unknown[]) =>
    mockMaterializeCustomerStageEvent(...args),
}));

import mongoose from "mongoose";
import {
  extractLastInboundSnippet,
  getCrmBoard,
  loadStageEnteredAtByCustomer,
  moveCustomerToCrmStage,
  resolveCrmOwnerFilter,
} from "./board";

function createSupabaseWithStages(data: unknown[] = []) {
  type SupabaseQueryMock = {
    select: jest.Mock<SupabaseQueryMock, unknown[]>;
    eq: jest.Mock<SupabaseQueryMock, unknown[]>;
    order: jest.Mock<SupabaseQueryMock, unknown[]>;
    then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
  };

  const query = {} as SupabaseQueryMock;
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve);

  return {
    from: jest.fn(() => query),
  };
}

function mockCustomerFindChain(cards: unknown[] = []) {
  type CustomerFindChainMock = {
    select: jest.Mock<CustomerFindChainMock, unknown[]>;
    sort: jest.Mock<CustomerFindChainMock, unknown[]>;
    limit: jest.Mock<CustomerFindChainMock, unknown[]>;
    lean: jest.Mock<Promise<unknown[]>, unknown[]>;
  };

  const chain = {} as CustomerFindChainMock;
  chain.select = jest.fn(() => chain);
  chain.sort = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.lean = jest.fn(async () => cards);
  mockCustomerFind.mockReturnValue(chain);
  return chain;
}

function mockSelectLean<T>(value: T) {
  type SelectLeanMock = {
    select: jest.Mock<SelectLeanMock, unknown[]>;
    lean: jest.Mock<Promise<T>, unknown[]>;
  };
  const chain = {} as SelectLeanMock;
  chain.select = jest.fn(() => chain);
  chain.lean = jest.fn(async () => value);
  return chain;
}

describe("CRM board data access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue({});
    mockEnsureCustomerCrmIndexes.mockResolvedValue(undefined);
    mockEnsureCustomerOwnerIndexes.mockResolvedValue(undefined);
    mockCustomerFindChain([]);
    mockCustomerCountDocuments.mockResolvedValue(0);
    mockCustomerAggregate.mockResolvedValue([]);
    mockRequestListFind.mockReturnValue(mockSelectLean([]));
    mockConversationFind.mockReturnValue(mockSelectLean([]));
    mockCustomerEventAggregate.mockResolvedValue([]);
    mockListWorkspaceMemberLabels.mockResolvedValue([]);
  });

  it("ensures the CRM customer index before reading board columns", async () => {
    await getCrmBoard({
      supabase: createSupabaseWithStages() as never,
      workspaceId: "workspace-1",
    });

    expect(mockConnectDB).toHaveBeenCalled();
    expect(mockEnsureCustomerCrmIndexes).toHaveBeenCalledTimes(1);
    expect(mockEnsureCustomerOwnerIndexes).toHaveBeenCalledTimes(1);
    expect(mockCustomerFind).toHaveBeenCalled();
  });

  it("defaults to the needs-attention scan when no attention param is set", async () => {
    const findChain = mockCustomerFindChain([]);

    await getCrmBoard({
      supabase: createSupabaseWithStages() as never,
      workspaceId: "workspace-1",
    });

    expect(findChain.limit).toHaveBeenCalledWith(200);
  });

  it("uses the page size when the filter is all leads", async () => {
    const findChain = mockCustomerFindChain([]);

    await getCrmBoard({
      supabase: createSupabaseWithStages() as never,
      workspaceId: "workspace-1",
      attention: "all",
      hideSupportSpam: false,
    });

    expect(findChain.limit).toHaveBeenCalledWith(10);
  });

  it("enriches cards from request_list_items and flags needs_reply", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const now = new Date();

    mockCustomerFindChain([
      {
        _id: customerId,
        displayName: "Acme buyer",
        status: "active",
        currentFunnelStage: "qualified",
        primaryConversationId: conversationId,
        lastInteractionAt: now,
        createdAt: now,
        profileSummary: {
          lastSentiment: "negative",
          churnRiskLevel: "high",
          conversationCount: 2,
        },
      },
    ]);
    mockCustomerCountDocuments.mockResolvedValue(1);
    mockRequestListFind.mockReturnValue(
      mockSelectLean([
        {
          _id: conversationId,
          lastInboundAt: now,
          slaDueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          unreadGeneration: 3,
          category: "Sales",
          status: "open",
          classification: { action: "Follow up on pricing" },
          recentMessages: [
            {
              direction: "outbound",
              text: "Quote sent",
            },
            {
              direction: "inbound",
              text: "Need the quote today",
            },
          ],
        },
      ])
    );
    mockConversationFind.mockReturnValue(
      mockSelectLean([
        {
          _id: conversationId,
          last_inbound_at: now,
          last_outbound_at: new Date(now.getTime() - 60 * 60 * 1000),
          is_read_by_manager: false,
          status: "open",
          airi_handoff_active: true,
          classification: { category: "Sales", action: "Follow up on pricing" },
        },
      ])
    );

    const board = await getCrmBoard({
      supabase: createSupabaseWithStages([
        {
          id: "stage-qualified",
          stage_key: "qualified",
          name: "Qualified",
          color: "#7c3aed",
          sort_order: 1,
          is_active: true,
        },
      ]) as never,
      workspaceId: "workspace-1",
      attention: "needs_reply",
    });

    const qualified = board.columns.find(
      column => column.stageKey === "qualified"
    );
    expect(qualified?.cards[0]).toEqual(
      expect.objectContaining({
        id: customerId.toString(),
        attention: ["needs_reply"],
        category: "Sales",
        nextAction: "Follow up on pricing",
        sentiment: "negative",
        churnRiskLevel: "high",
        followUpKind: "take_over",
        warnings: [],
        ownerUserId: null,
        ownerLabel: null,
        lastInboundSnippet: "Need the quote today",
      })
    );
    expect(qualified?.cards[0]?.lastInboundAt).toBe(now.toISOString());
    expect(qualified?.cards[0]?.lastOutboundAt).toBe(
      new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    );
  });

  it("filters by owner and labels the assignee", async () => {
    const findChain = mockCustomerFindChain([
      {
        _id: new mongoose.Types.ObjectId(),
        displayName: "Owned lead",
        status: "active",
        currentFunnelStage: "qualified",
        ownerUserId: "user-9",
        lastInteractionAt: new Date(),
        createdAt: new Date(),
        profileSummary: {
          estimatedCustomerLtv: 400,
          lastSentiment: "positive",
        },
      },
    ]);
    mockCustomerCountDocuments.mockResolvedValue(1);
    mockListWorkspaceMemberLabels.mockResolvedValue([
      { userId: "user-9", label: "Dana" },
    ]);

    const board = await getCrmBoard({
      supabase: createSupabaseWithStages([
        {
          id: "stage-qualified",
          stage_key: "qualified",
          name: "Qualified",
          color: "#7c3aed",
          sort_order: 1,
          is_active: true,
        },
      ]) as never,
      workspaceId: "workspace-1",
      attention: "all",
      hideSupportSpam: false,
      ownerUserId: "user-9",
    });

    expect(mockCustomerFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        ownerUserId: "user-9",
      })
    );
    expect(findChain.limit).toHaveBeenCalledWith(10);
    const qualified = board.columns.find(
      column => column.stageKey === "qualified"
    );
    expect(qualified?.ltvSum).toBe(400);
    expect(qualified?.cards[0]).toEqual(
      expect.objectContaining({
        ownerUserId: "user-9",
        ownerLabel: "Dana",
        sentiment: "positive",
      })
    );
  });

  it("aggregates LTV from the full stage filter when the page is truncated", async () => {
    mockCustomerFindChain([
      {
        _id: new mongoose.Types.ObjectId(),
        displayName: "Paged lead",
        status: "active",
        currentFunnelStage: "qualified",
        lastInteractionAt: new Date(),
        createdAt: new Date(),
        profileSummary: { estimatedCustomerLtv: 100 },
      },
    ]);
    mockCustomerCountDocuments.mockResolvedValue(25);
    mockCustomerAggregate.mockResolvedValue([{ sum: 2500, count: 25 }]);

    const board = await getCrmBoard({
      supabase: createSupabaseWithStages([
        {
          id: "stage-qualified",
          stage_key: "qualified",
          name: "Qualified",
          color: "#7c3aed",
          sort_order: 1,
          is_active: true,
        },
      ]) as never,
      workspaceId: "workspace-1",
      attention: "all",
      hideSupportSpam: false,
    });

    const qualified = board.columns.find(
      column => column.stageKey === "qualified"
    );
    expect(qualified?.totalCount).toBe(25);
    expect(qualified?.ltvSum).toBe(2500);
    expect(mockCustomerAggregate).toHaveBeenCalled();
  });

  it("resolves owner=me to the viewer id", () => {
    expect(resolveCrmOwnerFilter("me", "user-1")).toBe("user-1");
    expect(resolveCrmOwnerFilter("user-9", "user-1")).toBe("user-9");
    expect(resolveCrmOwnerFilter(null, "user-1")).toBeUndefined();
  });

  it("queries unknown funnel values as Unassigned", async () => {
    mockCustomerFindChain([]);

    await getCrmBoard({
      supabase: createSupabaseWithStages([
        {
          id: "stage-qualified",
          stage_key: "qualified",
          name: "Qualified",
          color: "#7c3aed",
          sort_order: 1,
          is_active: true,
        },
      ]) as never,
      workspaceId: "workspace-1",
      attention: "all",
      hideSupportSpam: false,
    });

    expect(mockCustomerFind).toHaveBeenCalledWith(
      expect.objectContaining({
        currentFunnelStage: {
          $nin: expect.arrayContaining(["qualified", "stage:qualified", "Qualified"]),
        },
      })
    );
    expect(mockCustomerFind).toHaveBeenCalledWith(
      expect.objectContaining({
        currentFunnelStage: {
          $in: expect.arrayContaining(["qualified", "stage:qualified", "Qualified"]),
        },
      })
    );
  });

  it("parks classifier funnel values on Unassigned cards", async () => {
    mockCustomerFindChain([
      {
        _id: new mongoose.Types.ObjectId(),
        displayName: "Segmented lead",
        status: "active",
        currentFunnelStage: "Sales",
        lastInteractionAt: new Date(),
        createdAt: new Date(),
        profileSummary: {},
      },
    ]);
    mockCustomerCountDocuments.mockResolvedValue(1);

    const board = await getCrmBoard({
      supabase: createSupabaseWithStages([
        {
          id: "stage-qualified",
          stage_key: "qualified",
          name: "Qualified",
          color: "#7c3aed",
          sort_order: 1,
          is_active: true,
        },
      ]) as never,
      workspaceId: "workspace-1",
      attention: "all",
      hideSupportSpam: false,
    });

    const unassigned = board.columns.find(
      column => column.stageKey === "unassigned"
    );
    expect(unassigned?.cards[0]?.stageKey).toBe("unassigned");
  });

  it("prefers the newest inbound message for the card snippet", () => {
    expect(
      extractLastInboundSnippet([
        { direction: "outbound", text: "Quote sent" },
        { direction: "inbound", text: "Need the quote today" },
      ])
    ).toBe("Need the quote today");
    expect(extractLastInboundSnippet([{ direction: "outbound", text: "Hi" }])).toBe(
      null
    );
  });

  it("returns archived stages separately from the active board columns", async () => {
    mockCustomerFindChain([]);

    const board = await getCrmBoard({
      supabase: createSupabaseWithStages([
        {
          id: "stage-qualified",
          stage_key: "qualified",
          name: "Qualified",
          color: "#7c3aed",
          sort_order: 1,
          is_active: true,
        },
        {
          id: "stage-lost",
          stage_key: "lost",
          name: "Lost",
          color: "#dc2626",
          sort_order: 2,
          is_active: false,
        },
      ]) as never,
      workspaceId: "workspace-1",
      attention: "all",
      hideSupportSpam: false,
    });

    expect(board.stages.map(stage => stage.key)).toEqual([
      "unassigned",
      "qualified",
    ]);
    expect(board.archivedStages).toEqual([
      expect.objectContaining({ key: "lost", isActive: false, name: "Lost" }),
    ]);
    expect(board.columns.map(column => column.stageKey)).toEqual([
      "unassigned",
      "qualified",
    ]);
  });

  it("ages a first placement out of no stage from its envelope-backed snapshot", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const movedAt = new Date("2026-10-04T09:30:00.000Z");
    mockCustomerEventAggregate.mockResolvedValue([
      { _id: customerId, occurredAt: movedAt },
    ]);

    const enteredAt = await loadStageEnteredAtByCustomer("workspace-1", [
      customerId.toString(),
    ]);

    expect(enteredAt.get(customerId.toString())).toEqual(movedAt);
    const [pipeline] = mockCustomerEventAggregate.mock.calls[0] as [
      Array<{ $match?: Record<string, unknown> }>,
    ];
    expect(pipeline[0].$match).toEqual({
      workspaceId: "workspace-1",
      customerId: { $in: [customerId] },
      $or: [
        { type: "stage_changed" },
        { type: "stage_snapshot", "payload.stageEventId": { $exists: true } },
      ],
    });
  });

  it("records a board move's stage history without waiting for the collector", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const envelope = {
      contractVersion: 1,
      eventId: "stage-event-1",
      revision: 1,
      occurredAt: "2026-10-05T08:00:00.000Z",
      workspaceId: "workspace-1",
      customerId: customerId.toString(),
      conversationId: null,
      previousStage: null,
      stage: "qualified",
      actor: { type: "manager", userId: "manager-1", label: null },
      source: "crm_board",
    };
    mockCustomerFindById
      .mockReturnValueOnce(
        mockSelectLean({
          _id: customerId,
          workspaceId: "workspace-1",
          currentFunnelStage: null,
          primaryConversationId: null,
          conversationIds: [],
        })
      )
      .mockReturnValueOnce(
        mockSelectLean({ crm_stage_event: JSON.stringify(envelope) })
      );
    mockCustomerUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockMaterializeCustomerStageEvent.mockResolvedValue({});

    await expect(
      moveCustomerToCrmStage({
        supabase: createSupabaseWithStages([]) as never,
        workspaceId: "workspace-1",
        customerId: customerId.toString(),
        stageKey: "qualified",
        expectedStageKey: null,
        actor: { type: "manager", userId: "manager-1" },
      })
    ).resolves.toEqual({
      customer: { id: customerId.toString(), stageKey: "qualified" },
    });

    expect(mockMaterializeCustomerStageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "stage-event-1",
        previousStage: null,
        stage: "qualified",
        occurredAt: new Date("2026-10-05T08:00:00.000Z"),
      }),
      "source_write"
    );
  });

  it("keeps a committed board move when the immediate history write fails", async () => {
    const customerId = new mongoose.Types.ObjectId();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockCustomerFindById
      .mockReturnValueOnce(
        mockSelectLean({
          _id: customerId,
          workspaceId: "workspace-1",
          currentFunnelStage: null,
        })
      )
      .mockReturnValueOnce(
        mockSelectLean({
          crm_stage_event: {
            contractVersion: 1,
            eventId: "stage-event-2",
            revision: 1,
            occurredAt: "2026-10-05T08:00:00.000Z",
            workspaceId: "workspace-1",
            customerId: customerId.toString(),
            conversationId: null,
            previousStage: null,
            stage: "qualified",
            actor: { type: "manager", userId: "manager-1", label: null },
            source: "crm_board",
          },
        })
      );
    mockCustomerUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockMaterializeCustomerStageEvent.mockRejectedValue(new Error("down"));

    await expect(
      moveCustomerToCrmStage({
        supabase: createSupabaseWithStages([]) as never,
        workspaceId: "workspace-1",
        customerId: customerId.toString(),
        stageKey: "qualified",
        actor: { type: "manager", userId: "manager-1" },
      })
    ).resolves.toEqual({
      customer: { id: customerId.toString(), stageKey: "qualified" },
    });
    expect(mockMaterializeCustomerStageEvent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[CRM board] Stage history write deferred to the collector",
      expect.objectContaining({ error: "down" })
    );
    warn.mockRestore();
  });
});
