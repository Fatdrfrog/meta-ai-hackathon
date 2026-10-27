import type { ScenarioSummary } from "../types";
import { patchScenarioSummaryFields } from "./scenario-summary-utils";

function summary(): ScenarioSummary {
  return {
    _id: "scenario-1",
    name: "Original",
    description: "Keep me",
    status: "draft",
    mode: "conversation",
    timezone: "UTC",
    priority: 3,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "repeatable",
    linkedParentScenarioIds: ["parent-1"],
    nodeCount: 7,
    edgeCount: 6,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("patchScenarioSummaryFields", () => {
  it("patches sparse sidebar fields without replacing graph-derived metadata", () => {
    expect(
      patchScenarioSummaryFields(summary(), {
        name: "Renamed",
        entryPolicy: "once_per_conversation",
      })
    ).toEqual({
      ...summary(),
      name: "Renamed",
      entryPolicy: "once_per_conversation",
    });
  });
});
