import type { ScenarioSummary } from "../../types";
import {
  ATTACHED_SCENARIO_GAP_PX,
  buildScenarioHierarchy,
  buildScenarioListLayout,
} from "./utils";

function createScenarioSummary(
  id: string,
  overrides: Partial<ScenarioSummary> = {}
): ScenarioSummary {
  return {
    _id: id,
    name: `Scenario ${id}`,
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: null,
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "once_per_conversation",
    linkedParentScenarioIds: [],
    nodeCount: 0,
    edgeCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("scenario hierarchy utils", () => {
  it("keeps attached children visually grouped in the layout", () => {
    const hierarchy = buildScenarioHierarchy([
      createScenarioSummary("parent"),
      createScenarioSummary("child", {
        linkedParentScenarioIds: ["parent"],
      }),
      createScenarioSummary("sibling"),
    ]);
    const layout = buildScenarioListLayout(hierarchy);

    expect(layout[1]?.marginTopPx).toBe(ATTACHED_SCENARIO_GAP_PX);
    expect(layout[1]?.item.directParentScenarioId).toBe("parent");
    expect(layout[1]?.item.depth).toBe(1);
  });

  it("keeps multi-parent linked scenarios at the root level", () => {
    const hierarchy = buildScenarioHierarchy([
      createScenarioSummary("parent-a"),
      createScenarioSummary("parent-b"),
      createScenarioSummary("shared-child", {
        linkedParentScenarioIds: ["parent-a", "parent-b"],
      }),
    ]);

    const sharedChild = hierarchy.find(
      item => item.scenario._id === "shared-child"
    );

    expect(sharedChild?.depth).toBe(0);
    expect(sharedChild?.directParentScenarioId).toBeNull();
  });
});
