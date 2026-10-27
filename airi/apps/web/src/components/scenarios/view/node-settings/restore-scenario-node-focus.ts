/** Attribute on a card's Settings button; its value is the node id. */
export const SCENARIO_NODE_SETTINGS_BUTTON_ATTRIBUTE =
  "data-scenario-node-settings";
/** The docked settings panel; card Settings buttons reference it while open. */
export const SCENARIO_NODE_SETTINGS_PANEL_ID = "scenario-node-settings-panel";

function findByNodeId(
  root: ParentNode,
  selector: string,
  readNodeId: (element: HTMLElement) => string | null | undefined,
  nodeId: string
) {
  // Compare values instead of building a selector from arbitrary node ids.
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    element => readNodeId(element) === nodeId
  );
}

/**
 * Returns focus to the card that owns a node's settings: its Settings button,
 * or the canvas node when the card renders no such button.
 */
export function restoreScenarioNodeFocus(
  nodeId: string,
  root: ParentNode = document
): boolean {
  const target =
    findByNodeId(
      root,
      `[${SCENARIO_NODE_SETTINGS_BUTTON_ATTRIBUTE}]`,
      element => element.getAttribute(SCENARIO_NODE_SETTINGS_BUTTON_ATTRIBUTE),
      nodeId
    ) ??
    findByNodeId(
      root,
      ".react-flow__node",
      element => element.dataset.id,
      nodeId
    );
  target?.focus({ preventScroll: true });
  return Boolean(target);
}

/** Moves focus into the open docked settings panel. */
export function focusScenarioNodeSettingsPanel(): boolean {
  const panel = document.getElementById(SCENARIO_NODE_SETTINGS_PANEL_ID);
  panel?.focus({ preventScroll: true });
  return Boolean(panel);
}
