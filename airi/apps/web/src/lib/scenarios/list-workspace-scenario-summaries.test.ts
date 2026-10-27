const mockConnectDB = jest.fn();
const mockAggregate = jest.fn();
const mockAttachLinkedParentScenarioIds = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    aggregate: (...args: unknown[]) => mockAggregate(...args),
    find: jest.fn(),
  },
}));

jest.mock("@/lib/scenarios/linked-parent-summaries", () => ({
  ...jest.requireActual("@/lib/scenarios/linked-parent-summaries"),
  attachLinkedParentScenarioIds: (...args: unknown[]) =>
    mockAttachLinkedParentScenarioIds(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { Types } from "mongoose";
import { Scenario } from "@/models/scenario";
import { listWorkspaceScenarioSummaries } from "./list-workspace-scenario-summaries";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("listWorkspaceScenarioSummaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockAttachLinkedParentScenarioIds.mockImplementation(
      async (items: unknown) => items
    );
  });

  it("projects summary fields and omits graph edges", async () => {
    const id = new Types.ObjectId();
    mockAggregate.mockResolvedValue([
      {
        _id: id,
        name: "Welcome",
        status: "draft",
        mode: "conversation",
        priority: 10,
        nodeCount: 2,
        edgeCount: 1,
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerConfig: { enabled: true },
            },
          },
        ],
      },
    ]);

    const result = await listWorkspaceScenarioSummaries({
      workspaceId,
      limit: 60,
    });

    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockAggregate).toHaveBeenCalledTimes(1);
    const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    const project = pipeline.find(stage => stage.$project) as {
      $project: Record<string, unknown>;
    };
    expect(project.$project.edges).toBeUndefined();
    expect(project.$project.edgeCount).toEqual({
      $cond: [{ $isArray: "$edges" }, { $size: "$edges" }, 0],
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        _id: String(id),
        name: "Welcome",
        nodeCount: 2,
        edgeCount: 1,
      }),
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("projects the bulk root workflow kind so builder campaigns are recognizable", async () => {
    const id = new Types.ObjectId();
    mockAggregate.mockResolvedValue([
      {
        _id: id,
        name: "Birthday greetings",
        status: "active",
        mode: "conversation",
        priority: 10,
        nodeCount: 2,
        edgeCount: 1,
        nodes: [
          {
            id: "bulk-1",
            data: {
              kind: "bulk",
              bulkRootConfig: { workflowKind: "bulk_campaign" },
            },
          },
          { id: "action-1", data: { kind: "action" } },
        ],
      },
    ]);

    const result = await listWorkspaceScenarioSummaries({
      workspaceId,
      mode: "all",
      limit: 60,
    });

    const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    const project = pipeline.find(stage => stage.$project) as {
      $project: {
        nodes: { $map: { in: { data: Record<string, unknown> } } };
      };
    };
    expect(project.$project.nodes.$map.in.data.bulkRootConfig).toEqual({
      $cond: [
        { $eq: ["$$node.data.kind", "bulk"] },
        { workflowKind: "$$node.data.bulkRootConfig.workflowKind" },
        "$$REMOVE",
      ],
    });
    expect(result.items[0]?.mode).toBe("conversation");
    expect(result.items[0]?.builderSummary?.bulkRoots).toEqual([
      { bulkNodeId: "bulk-1", workflowKind: "bulk_campaign" },
    ]);
  });

  it("pages with a cursor when extra rows exist", async () => {
    const firstId = new Types.ObjectId();
    const extraId = new Types.ObjectId();
    mockAggregate.mockResolvedValue([
      {
        _id: firstId,
        name: "First",
        status: "draft",
        priority: 8,
        nodeCount: 0,
        edgeCount: 0,
        nodes: [],
      },
      {
        _id: extraId,
        name: "Extra",
        status: "draft",
        priority: 7,
        nodeCount: 0,
        edgeCount: 0,
        nodes: [],
      },
    ]);

    const result = await listWorkspaceScenarioSummaries({
      workspaceId,
      limit: 1,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("First");
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("keeps edge counts when the aggregate fallback query runs", async () => {
    const id = new Types.ObjectId();
    mockAggregate.mockRejectedValue(new Error("aggregation failed"));
    const select = jest.fn().mockReturnThis();
    const sort = jest.fn().mockReturnThis();
    const limit = jest.fn().mockReturnThis();
    (Scenario.find as jest.Mock).mockReturnValue({
      select,
      sort,
      limit,
      lean: jest.fn().mockResolvedValue([
        {
          _id: id,
          name: "Fallback",
          status: "draft",
          nodes: [],
          edges: [{ id: "e1" }, { id: "e2" }],
        },
      ]),
    });

    const result = await listWorkspaceScenarioSummaries({
      workspaceId,
      limit: 60,
    });

    expect(select).toHaveBeenCalledWith(expect.stringContaining("edges.id"));
    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("nodes.data.bulkRootConfig.workflowKind")
    );
    // Without the aggregate, linked parents still come from their own query.
    expect(mockAttachLinkedParentScenarioIds).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([
      expect.objectContaining({
        _id: String(id),
        name: "Fallback",
        edgeCount: 2,
      }),
    ]);
  });

  it("does not filter mode when listing every workspace scenario", async () => {
    mockAggregate.mockResolvedValue([]);

    await listWorkspaceScenarioSummaries({
      workspaceId,
      mode: "all",
      limit: 60,
    });

    const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    const match = pipeline.find(stage => stage.$match) as {
      $match: Record<string, unknown>;
    };
    expect(match.$match).toEqual({
      $and: [{ workspaceId }, { deletedAt: null }],
    });
  });

  it.each([
    ["active", { status: "active" }],
    ["inactive", { status: { $ne: "active" } }],
  ] as const)(
    "filters %s scenarios when asked",
    async (status, expectedFilter) => {
      mockAggregate.mockResolvedValue([]);

      await listWorkspaceScenarioSummaries({
        workspaceId,
        mode: "all",
        status,
        limit: 10,
      });

      const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
        Record<string, unknown>
      >;
      const match = pipeline.find(stage => stage.$match) as {
        $match: Record<string, unknown>;
      };
      expect(match.$match).toEqual({
        $and: [{ workspaceId }, { deletedAt: null }, expectedFilter],
      });
    }
  );

  it("passes a time limit only when the caller sets one", async () => {
    mockAggregate.mockResolvedValue([]);

    await listWorkspaceScenarioSummaries({ workspaceId, limit: 10 });
    await listWorkspaceScenarioSummaries({
      workspaceId,
      status: "all",
      limit: 10,
      maxTimeMS: 5000,
    });

    expect(mockAggregate.mock.calls[0]?.[1]).toBeUndefined();
    expect(mockAggregate.mock.calls[1]?.[1]).toEqual({ maxTimeMS: 5000 });
    const match = (
      mockAggregate.mock.calls[1]?.[0] as Array<Record<string, unknown>>
    ).find(stage => stage.$match) as { $match: { $and: unknown[] } };
    expect(match.$match.$and).not.toContainEqual(
      expect.objectContaining({ status: expect.anything() })
    );
  });

  it("applies the time limit to the fallback query too", async () => {
    mockAggregate.mockRejectedValue(new Error("aggregation failed"));
    const chain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    (Scenario.find as jest.Mock).mockReturnValue(chain);

    await listWorkspaceScenarioSummaries({
      workspaceId,
      limit: 10,
      maxTimeMS: 5000,
    });

    expect(Scenario.find).toHaveBeenCalledWith(expect.any(Object), undefined, {
      maxTimeMS: 5000,
    });
  });

  it("reads linked parents in the same aggregate instead of a second query", async () => {
    const id = new Types.ObjectId();
    mockAggregate.mockResolvedValue([
      {
        _id: id,
        name: "Child",
        status: "draft",
        priority: 5,
        nodeCount: 0,
        edgeCount: 0,
        nodes: [],
        linkedParentConditionRecords: [
          {
            childScenarioId: String(id),
            parentRefs: [
              { parentScenarioId: "parent-1" },
              { parentScenarioId: String(id) },
              { parentScenarioId: " parent-1 " },
              { parentScenarioId: "parent-2" },
            ],
          },
        ],
      },
    ]);

    const result = await listWorkspaceScenarioSummaries({
      workspaceId,
      limit: 60,
    });

    expect(mockAggregate).toHaveBeenCalledTimes(1);
    expect(mockAttachLinkedParentScenarioIds).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.linkedParentScenarioIds).toEqual([
      "parent-1",
      "parent-2",
    ]);
    expect(result.items[0]).not.toHaveProperty("linkedParentConditionRecords");

    const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    const limitIndex = pipeline.findIndex(stage => "$limit" in stage);
    const lookupIndex = pipeline.findIndex(stage => "$lookup" in stage);
    expect(lookupIndex).toBeGreaterThan(limitIndex);
    expect(pipeline[lookupIndex]).toEqual({
      $lookup: {
        from: "scenariolinkedconditions",
        let: { childScenarioId: { $toString: "$_id" } },
        pipeline: [
          {
            $match: {
              workspaceId,
              $expr: { $eq: ["$childScenarioId", "$$childScenarioId"] },
            },
          },
          {
            $project: {
              _id: 0,
              childScenarioId: 1,
              "parentRefs.parentScenarioId": 1,
            },
          },
        ],
        as: "linkedParentConditionRecords",
      },
    });
  });
});
