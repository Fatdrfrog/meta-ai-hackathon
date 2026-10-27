/** @jest-environment jsdom */

import {
  focusScenarioNodeSettingsPanel,
  restoreScenarioNodeFocus,
  SCENARIO_NODE_SETTINGS_PANEL_ID,
} from "./restore-scenario-node-focus";

function card(nodeId: string, { withButton }: { withButton: boolean }) {
  const node = document.createElement("div");
  node.className = "react-flow__node";
  node.dataset.id = nodeId;
  node.tabIndex = 0;
  if (withButton) {
    const button = document.createElement("button");
    button.setAttribute("data-scenario-node-settings", nodeId);
    node.append(button);
  }
  document.body.append(node);
  return node;
}

describe("restoreScenarioNodeFocus", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("focuses the card's Settings button before the card itself", () => {
    const node = card("trigger-1", { withButton: true });
    expect(restoreScenarioNodeFocus("trigger-1")).toBe(true);
    expect(document.activeElement).toBe(node.querySelector("button"));
  });

  it("falls back to the canvas node and matches ids by value", () => {
    // Ids are compared as values, never interpolated into a selector.
    card('a"], body, [x="', { withButton: false });
    const node = card('link "quoted" \\ id', { withButton: false });
    expect(restoreScenarioNodeFocus('link "quoted" \\ id')).toBe(true);
    expect(document.activeElement).toBe(node);
  });

  it("reports when the card is gone", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(restoreScenarioNodeFocus("removed")).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});

describe("focusScenarioNodeSettingsPanel", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("focuses the open settings panel and reports a closed one", () => {
    expect(focusScenarioNodeSettingsPanel()).toBe(false);
    const panel = document.createElement("div");
    panel.id = SCENARIO_NODE_SETTINGS_PANEL_ID;
    panel.tabIndex = -1;
    document.body.append(panel);
    expect(focusScenarioNodeSettingsPanel()).toBe(true);
    expect(document.activeElement).toBe(panel);
  });
});
