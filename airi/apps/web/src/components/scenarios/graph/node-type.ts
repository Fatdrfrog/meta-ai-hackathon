import type { ScenarioNodeKind } from "@icecore/scenario-contracts";

const NODE_TYPE_BY_KIND = {
  bulk: "bulkNode",
  trigger: "triggerNode",
  action: "actionNode",
  scenario_link: "scenarioLinkNode",
  logic: "scenarioNode",
  context: "scenarioNode",
} as const satisfies Record<ScenarioNodeKind, string>;

export function resolveScenarioFlowNodeType<Kind extends ScenarioNodeKind>(
  kind: Kind
): (typeof NODE_TYPE_BY_KIND)[Kind];
export function resolveScenarioFlowNodeType(kind: ScenarioNodeKind) {
  return Object.prototype.hasOwnProperty.call(NODE_TYPE_BY_KIND, kind)
    ? NODE_TYPE_BY_KIND[kind]
    : "scenarioNode";
}
