const mockScenarioFindOne = jest.fn();
const mockScenarioUpdateOne = jest.fn();

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
  },
}));

import { ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID } from "@icecore/scenario-contracts";

import { mutateScenarioGraphWithCas } from "./scenario-graph-mutation";

function selectedLeanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  return query;
}

function patchTargetReplyText(snapshot: {
  nodes: unknown[];
  edges: unknown[];
}) {
  const nodes = snapshot.nodes.map(node => {
    if (
      !node ||
      typeof node !== "object" ||
      !("id" in node) ||
      node.id !== "target"
    ) {
      return node;
    }
    const record = node as {
      id: string;
      data?: Record<string, unknown>;
    };
    return {
      ...record,
      data: {
        ...record.data,
        actionReplyText: "projected",
      },
    };
  });

  return {
    changed: true as const,
    nodes,
    edges: snapshot.edges,
    value: "patched",
  };
}

describe("mutateScenarioGraphWithCas", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([0, -1_000])(
    "returns the persisted revision and accepts it on the next edit when the clock offset is %i ms",
    async clockOffset => {
      const { Scenario } =
        jest.requireActual<typeof import("@/models/scenario")>(
          "@/models/scenario"
        );
      const initialRevision = new Date("2026-09-07T10:00:00.000Z");
      let stored = {
        _id: "65f000000000000000000002",
        status: "draft",
        nodes: [{ id: "target", data: { kind: "action" } }],
        edges: [],
        updatedAt: initialRevision,
      };
      jest
        .spyOn(Date, "now")
        .mockReturnValue(initialRevision.getTime() + clockOffset);
      jest
        .spyOn(Scenario.base, "now")
        .mockReturnValue(new Date("2026-09-07T10:00:00.015Z"));
      mockScenarioFindOne.mockImplementation(() => selectedLeanQuery(stored));
      mockScenarioUpdateOne.mockImplementation((filter, update, options) =>
        Scenario.updateOne(filter, update, options)
      );
      const write = jest
        .spyOn(Scenario.collection, "updateOne")
        .mockImplementation(async (filter, update) => {
          if (Array.isArray(update) || !update.$set) {
            throw new Error("Expected a Scenario revision update document");
          }
          const matches =
            filter.updatedAt.getTime() === stored.updatedAt.getTime();
          if (matches) stored = { ...stored, ...update.$set };
          return {
            acknowledged: true,
            matchedCount: Number(matches),
            modifiedCount: Number(matches),
            upsertedCount: 0,
            upsertedId: null,
          };
        });

      const first = await mutateScenarioGraphWithCas({
        workspaceId: "workspace-1",
        scenarioId: stored._id,
        expectedUpdatedAt: initialRevision,
        project: patchTargetReplyText,
      });
      expect(first.status).toBe("updated");
      const firstPersistedRevision = stored.updatedAt.toISOString();
      const second = await mutateScenarioGraphWithCas({
        workspaceId: "workspace-1",
        scenarioId: stored._id,
        expectedUpdatedAt: first.scenarioUpdatedAt,
        project: patchTargetReplyText,
      });

      expect(first.scenarioUpdatedAt).toBe(firstPersistedRevision);
      expect(second.status).toBe("updated");
      expect(second.scenarioUpdatedAt).toBe(stored.updatedAt.toISOString());
      expect(stored.updatedAt.getTime()).toBe(initialRevision.getTime() + 2);
      expect(write).toHaveBeenCalledTimes(2);
    }
  );

  it("recomputes from the latest revision and preserves unrelated concurrent graph edits", async () => {
    const initialRevision = new Date("2026-07-30T10:00:00.000Z");
    const concurrentRevision = new Date("2026-07-30T10:01:00.000Z");
    const initialNodes = [
      { id: "target", data: { kind: "action", actionReplyText: "old" } },
      { id: "other", data: { kind: "action", actionReplyText: "before" } },
    ];
    const concurrentNodes = [
      initialNodes[0],
      { id: "other", data: { kind: "action", actionReplyText: "concurrent" } },
    ];

    mockScenarioFindOne
      .mockReturnValueOnce(
        selectedLeanQuery({
          _id: "scenario-1",
          nodes: initialNodes,
          edges: [{ id: "edge-before", source: "target", target: "other" }],
          updatedAt: initialRevision,
        })
      )
      .mockReturnValueOnce(
        selectedLeanQuery({
          _id: "scenario-1",
          nodes: concurrentNodes,
          edges: [{ id: "edge-concurrent", source: "target", target: "other" }],
          updatedAt: concurrentRevision,
        })
      );
    mockScenarioUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });

    const result = await mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      updatedBy: "user-1",
      project: patchTargetReplyText,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "updated",
        value: "patched",
        previousScenarioUpdatedAt: concurrentRevision.toISOString(),
      })
    );
    expect(mockScenarioFindOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioUpdateOne).toHaveBeenNthCalledWith(
      2,
      {
        _id: "scenario-1",
        workspaceId: "workspace-1",
        deletedAt: null,
        status: "draft",
        updatedAt: concurrentRevision,
      },
      {
        $set: expect.objectContaining({
          graphSchemaVersion: 1,
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "target",
              data: expect.objectContaining({
                kind: "action",
                actionReplyText: "projected",
              }),
            }),
            expect.objectContaining({
              id: "other",
              data: expect.objectContaining({
                kind: "action",
                actionReplyText: "concurrent",
              }),
            }),
          ]),
          edges: [{ id: "edge-concurrent", source: "target", target: "other" }],
          updatedBy: "user-1",
          updatedAt: expect.any(Date),
        }),
      },
      { timestamps: false }
    );
  });

  it("fails closed after the bounded retries and never reads or writes another workspace", async () => {
    const firstRevision = new Date("2026-07-30T10:00:00.000Z");
    const secondRevision = new Date("2026-07-30T10:01:00.000Z");
    mockScenarioFindOne
      .mockReturnValueOnce(
        selectedLeanQuery({
          _id: "scenario-1",
          nodes: [{ id: "target", data: { kind: "action" } }],
          edges: [],
          updatedAt: firstRevision,
        })
      )
      .mockReturnValueOnce(
        selectedLeanQuery({
          _id: "scenario-1",
          nodes: [{ id: "target", data: { kind: "action" } }],
          edges: [],
          updatedAt: secondRevision,
        })
      );
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 0 });

    const result = await mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      project: patchTargetReplyText,
    });

    expect(result).toEqual({
      status: "conflict",
      previousScenarioUpdatedAt: secondRevision.toISOString(),
      scenarioUpdatedAt: secondRevision.toISOString(),
    });
    expect(mockScenarioFindOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(2);
    for (const [filter] of mockScenarioFindOne.mock.calls) {
      expect(filter).toEqual({
        _id: "scenario-1",
        workspaceId: "workspace-1",
        deletedAt: null,
      });
    }
    for (const [filter] of mockScenarioUpdateOne.mock.calls) {
      expect(filter).toEqual(
        expect.objectContaining({
          _id: "scenario-1",
          workspaceId: "workspace-1",
          deletedAt: null,
        })
      );
    }
  });

  it("does not write when the target disappeared from the latest graph", async () => {
    const revision = new Date("2026-07-30T10:00:00.000Z");
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "scenario-1",
        nodes: [{ id: "other", data: { kind: "action" } }],
        edges: [],
        updatedAt: revision,
      })
    );

    const result = await mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      project: snapshot => {
        if (
          !snapshot.nodes.some(
            node => (node as { id?: string }).id === "target"
          )
        ) {
          return {
            changed: false,
            value: "target_changed",
          };
        }
        return patchTargetReplyText(snapshot);
      },
    });

    expect(result).toEqual({
      status: "unchanged",
      value: "target_changed",
      previousScenarioUpdatedAt: revision.toISOString(),
      scenarioUpdatedAt: revision.toISOString(),
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("returns not_found without writing when the scoped scenario was deleted", async () => {
    mockScenarioFindOne.mockReturnValue(selectedLeanQuery(null));

    const result = await mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      project: patchTargetReplyText,
    });

    expect(result).toEqual({
      status: "not_found",
      previousScenarioUpdatedAt: null,
      scenarioUpdatedAt: null,
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("rejects a stale expected revision before projecting or writing", async () => {
    const currentRevision = new Date("2026-07-30T10:01:00.000Z");
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "scenario-1",
        nodes: [{ id: "target", data: { kind: "action" } }],
        edges: [],
        updatedAt: currentRevision,
      })
    );
    const project = jest.fn(patchTargetReplyText);

    const result = await mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-07-30T10:00:00.000Z",
      project,
    });

    expect(result).toEqual({
      status: "conflict",
      previousScenarioUpdatedAt: currentRevision.toISOString(),
      scenarioUpdatedAt: currentRevision.toISOString(),
    });
    expect(project).not.toHaveBeenCalled();
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("projects against the scenario lifecycle status read with the graph revision", async () => {
    const revision = new Date("2026-07-30T10:01:00.000Z");
    const query = selectedLeanQuery({
      _id: "scenario-1",
      status: "active",
      nodes: [{ id: "target", data: { kind: "action" } }],
      edges: [],
      updatedAt: revision,
    });
    mockScenarioFindOne.mockReturnValue(query);
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 1 });
    const project = jest.fn(
      (snapshot: { nodes: unknown[]; edges: unknown[] }) => ({
        changed: true as const,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        value: "status-checked",
      })
    );

    const result = await mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      project,
    });

    expect(query.select).toHaveBeenCalledWith(
      "graphSchemaVersion nodes edges status updatedAt"
    );
    expect(project).toHaveBeenCalledWith({
      status: "active",
      nodes: [{ id: "target", data: { kind: "action" } }],
      edges: [],
    });
    expect(result).toMatchObject({
      status: "updated",
      value: "status-checked",
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "scenario-1",
        workspaceId: "workspace-1",
        status: "active",
        updatedAt: revision,
      }),
      expect.any(Object),
      { timestamps: false }
    );
  });

  it("fails closed before writing when a projector introduces a legacy action-routing assignment", async () => {
    const revision = new Date("2026-07-30T10:01:00.000Z");
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "scenario-1",
        nodes: [{ id: "action-1", data: { kind: "action" } }],
        edges: [],
        updatedAt: revision,
      })
    );

    const mutation = mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      project: snapshot => ({
        changed: true,
        nodes: snapshot.nodes,
        edges: [
          {
            id: "new-legacy-edge",
            source: "action-1",
            target: "condition-1",
            sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
          },
        ],
        value: "forbidden",
      }),
    });

    await expect(mutation).rejects.toMatchObject({
      name: "LegacyActionRoutingAssignmentForbiddenError",
      code: "legacy_action_routing_new_assignment_forbidden",
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("preserves a preexisting legacy assignment when graph normalization changes only its edge id", async () => {
    const revision = new Date("2026-07-30T10:01:00.000Z");
    const legacyEdge = {
      id: "legacy-edge",
      source: "action-1",
      target: "condition-1",
      sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
    };
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "scenario-1",
        nodes: [{ id: "action-1", data: { kind: "action" } }],
        edges: [legacyEdge],
        updatedAt: revision,
      })
    );
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const result = await mutateScenarioGraphWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      project: snapshot => ({
        changed: true,
        nodes: snapshot.nodes,
        edges: [{ ...legacyEdge, id: "normalized-edge" }],
        value: "normalized",
      }),
    });

    expect(result).toMatchObject({
      status: "updated",
      value: "normalized",
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      expect.any(Object),
      {
        $set: expect.objectContaining({
          edges: [{ ...legacyEdge, id: "normalized-edge" }],
        }),
      },
      { timestamps: false }
    );
  });
});
