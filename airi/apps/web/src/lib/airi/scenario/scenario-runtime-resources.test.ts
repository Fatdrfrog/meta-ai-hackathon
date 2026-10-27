const mockSelect = jest.fn().mockReturnThis();
const mockLean = jest.fn();
const mockFind = jest.fn((..._args: unknown[]) => ({
  select: mockSelect,
  sort: jest.fn().mockReturnThis(),
  lean: mockLean,
}));
const mockFindOne = jest.fn((..._args: unknown[]) => ({
  select: mockSelect,
  lean: mockLean,
}));
jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockFind(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));
jest.mock("@/models/quick-reply", () => ({ QuickReply: {} }));
import {
  fetchActiveScenariosForWorkspace,
  fetchActiveScenarioById,
} from "./scenario-runtime-resources";

it("selects only trigger nodes for unpinned matching and fences graph hydration by revision", async () => {
  mockLean.mockResolvedValue([
    {
      _id: "507f191e810c19729de860fa",
      updatedAt: new Date("2026-10-10T00:00:00Z"),
      nodes: [],
    },
  ]);
  const rows = await fetchActiveScenariosForWorkspace({
    workspaceId: "workspace-1",
    triggerProjection: true,
  });
  expect(mockSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      nodes: {
        $filter: {
          input: "$nodes",
          as: "node",
          cond: { $eq: ["$$node.data.kind", "trigger"] },
        },
      },
    })
  );
  expect(rows[0].graphProjection).toBe("triggers");
  const revision = new Date("2026-10-10T00:00:00Z");
  await fetchActiveScenarioById({
    workspaceId: "workspace-1",
    scenarioId: "507f191e810c19729de860fa",
    expectedUpdatedAt: revision,
  });
  expect(mockFindOne).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-1",
      updatedAt: revision,
      status: "active",
    })
  );
});
