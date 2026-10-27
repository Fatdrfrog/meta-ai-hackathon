const mockLoadLinkedConditionParentSummaryRecords = jest.fn();
const mockScenarioLinkedConditionFind = jest.fn();

jest.mock("@/lib/scenarios/linked-condition-repository", () => ({
  loadLinkedConditionParentSummaryRecords: (...args: unknown[]) =>
    mockLoadLinkedConditionParentSummaryRecords(...args),
}));

jest.mock("@/models/scenario-linked-condition", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockScenarioLinkedConditionFind(...args),
    collection: { name: "scenariolinkedconditions" },
  },
}));

import {
  applyLookedUpLinkedParentScenarioIds,
  attachLinkedParentScenarioIds,
  buildLinkedParentScenarioIdsLookupStage,
  extractLinkedParentScenarioIds,
} from "../linked-parent-summaries";

describe("linked parent summaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScenarioLinkedConditionFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
  });

  it("projects normalized unique parent IDs without self-links", () => {
    const result = extractLinkedParentScenarioIds([
      {
        childScenarioId: " child-1 ",
        parentRefs: [
          { parentScenarioId: "parent-1" },
          { parentScenarioId: " parent-1 " },
          { parentScenarioId: "child-1" },
          { parentScenarioId: "" },
        ],
      },
      {
        childScenarioId: "child-1",
        parentRefs: [{ parentScenarioId: "parent-2" }],
      },
    ]);

    expect(result.get("child-1")).toEqual(["parent-1", "parent-2"]);
  });

  it("composes the repository read with parent-ID projection", async () => {
    mockLoadLinkedConditionParentSummaryRecords.mockResolvedValue([
      {
        childScenarioId: "child-1",
        parentRefs: [{ parentScenarioId: "parent-1" }],
      },
    ]);

    const result = await attachLinkedParentScenarioIds(
      [{ _id: "child-1" }, { _id: "child-2" }, { _id: "child-1" }],
      " workspace-1 "
    );

    expect(mockLoadLinkedConditionParentSummaryRecords).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      childScenarioIds: ["child-1", "child-2"],
    });
    expect(mockScenarioLinkedConditionFind).not.toHaveBeenCalled();
    expect(result).toEqual([
      { _id: "child-1", linkedParentScenarioIds: ["parent-1"] },
      { _id: "child-2", linkedParentScenarioIds: [] },
      { _id: "child-1", linkedParentScenarioIds: ["parent-1"] },
    ]);
  });

  it("gives looked-up list rows the same parent IDs as the separate query", async () => {
    const records = [
      {
        childScenarioId: "child-1",
        parentRefs: [
          { parentScenarioId: "parent-1" },
          { parentScenarioId: "child-1" },
          { parentScenarioId: " parent-1 " },
          { parentScenarioId: "" },
          { parentScenarioId: "parent-2" },
        ],
      },
    ];
    mockLoadLinkedConditionParentSummaryRecords.mockResolvedValue(records);

    const rows: Array<{ _id: string; linkedParentScenarioIds?: string[] }> = [
      { _id: "child-1" },
    ];
    const [queried] = await attachLinkedParentScenarioIds(rows, "workspace-1");
    const lookedUp = applyLookedUpLinkedParentScenarioIds({
      _id: "child-1",
      name: "Child",
      linkedParentConditionRecords: records,
    });

    expect(lookedUp).toEqual({
      _id: "child-1",
      name: "Child",
      linkedParentScenarioIds: queried?.linkedParentScenarioIds,
    });
    expect(lookedUp.linkedParentScenarioIds).toEqual(["parent-1", "parent-2"]);
    expect(applyLookedUpLinkedParentScenarioIds({ _id: "child-2" })).toEqual({
      _id: "child-2",
      linkedParentScenarioIds: [],
    });
  });

  it("looks up only the trimmed workspace's records for the row id", () => {
    expect(buildLinkedParentScenarioIdsLookupStage(" workspace-1 ")).toEqual({
      $lookup: expect.objectContaining({
        from: "scenariolinkedconditions",
        let: { childScenarioId: { $toString: "$_id" } },
        pipeline: [
          expect.objectContaining({
            $match: expect.objectContaining({ workspaceId: "workspace-1" }),
          }),
          expect.anything(),
        ],
      }),
    });
  });
});
