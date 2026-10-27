import { enrichScenarioLinkNodeData } from "./link";

describe("enrichScenarioLinkNodeData", () => {
  it("projects scenario choices and keeps link patches persisted-only", () => {
    const updateNodeById = jest.fn();
    const removeNodeById = jest.fn();
    const scenarioLinkOptions = [
      { id: "scenario-2", name: "Renewal follow-up" },
    ];
    const enriched = enrichScenarioLinkNodeData(
      "link-1",
      { kind: "scenario_link", linkedScenarioId: "scenario-2" },
      {
        callbacksRef: {
          current: { updateNodeById, removeNodeById },
        },
        scenarioLinkOptions,
      } as never
    );

    enriched.uiOnPatch?.({ linkedScenarioId: "scenario-3" });
    enriched.uiOnRemove?.();

    expect(enriched.uiScenarioOptions).toBe(scenarioLinkOptions);
    expect(updateNodeById).toHaveBeenCalledWith("link-1", {
      linkedScenarioId: "scenario-3",
    });
    expect(removeNodeById).toHaveBeenCalledWith("link-1");
    expect(enriched).not.toHaveProperty("uiOnCreateNodeFromSourceHandle");
  });

  it("reports whether the selected node's settings are open", () => {
    const enrichFor = (selectedNodeId: string | null) =>
      enrichScenarioLinkNodeData("link-1", { kind: "scenario_link" }, {
        callbacksRef: { current: {} },
        scenarioLinkOptions: [],
        selectedNodeId,
      } as never);

    expect(enrichFor("link-1").uiIsEditorExpanded).toBe(true);
    expect(enrichFor("other-node").uiIsEditorExpanded).toBe(false);
    expect(enrichFor(null).uiIsEditorExpanded).toBe(false);
  });
});
