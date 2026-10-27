import {
  isScenarioEditorFieldKey,
  stripScenarioEditorFields,
  stripScenarioEditorGraphNodes,
} from "./strip-editor-fields";

describe("isScenarioEditorFieldKey", () => {
  it("treats ui* overlay keys and derived preview/compile keys as editor-only", () => {
    expect(isScenarioEditorFieldKey("uiOnPatch")).toBe(true);
    expect(isScenarioEditorFieldKey("uiNodeLabel")).toBe(true);
    expect(isScenarioEditorFieldKey("actionPreviewText")).toBe(true);
    expect(isScenarioEditorFieldKey("actionPreviewImageUrl")).toBe(true);
    expect(isScenarioEditorFieldKey("compiledNodes")).toBe(true);
    expect(isScenarioEditorFieldKey("compiledEdges")).toBe(true);
    expect(isScenarioEditorFieldKey("actionReplyText")).toBe(false);
    expect(isScenarioEditorFieldKey("kind")).toBe(false);
  });
});

describe("stripScenarioEditorFields", () => {
  it("drops overlay keys, preview keys, and functions while keeping persisted data", () => {
    const cleaned = stripScenarioEditorFields({
      kind: "action",
      actionType: "reply",
      actionReplyText: "Hello",
      uiNodeLabel: "Rendered label",
      uiOnPatch: () => undefined,
      actionPreviewText: "Rendered preview",
      compiledNodes: [],
    });

    expect(cleaned).toEqual({
      kind: "action",
      actionType: "reply",
      actionReplyText: "Hello",
    });
  });

  it("returns an empty object for non-objects", () => {
    expect(stripScenarioEditorFields(null)).toEqual({});
    expect(stripScenarioEditorFields("action")).toEqual({});
  });
});

describe("stripScenarioEditorGraphNodes", () => {
  it("strips editor fields from each node data payload", () => {
    const [node] = stripScenarioEditorGraphNodes([
      {
        id: "action-1",
        data: {
          kind: "action",
          actionReplyText: "Hello",
          uiContextItems: [{ id: "snippet-1" }],
          actionPreviewImageUrl: "https://cdn.test/preview.png",
        },
      },
    ]);

    expect(node).toEqual({
      id: "action-1",
      data: {
        kind: "action",
        actionReplyText: "Hello",
      },
    });
  });

  it("returns stripped copies of readonly input without changing the authored graph", () => {
    const data = Object.freeze({ kind: "action", uiNodeLabel: "Preview" });
    const nodes = Object.freeze([Object.freeze({ id: "action", data })]);

    expect(stripScenarioEditorGraphNodes(nodes)).toEqual([
      { id: "action", data: { kind: "action" } },
    ]);
    expect(nodes[0].data).toEqual({ kind: "action", uiNodeLabel: "Preview" });
  });
});
