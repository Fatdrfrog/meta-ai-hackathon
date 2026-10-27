import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../../types";

const NODE_TYPE_BY_KIND: Partial<Record<ScenarioNodeData["kind"], string>> = {
  action: "actionNode",
  scenario_link: "scenarioLinkNode",
  trigger: "triggerNode",
};

export function createGraphTestNode(
  id: string,
  data: ScenarioNodeData,
  options: {
    position?: ScenarioFlowNode["position"];
    type?: ScenarioFlowNode["type"];
  } = {}
): ScenarioFlowNode {
  return {
    id,
    type: options.type ?? NODE_TYPE_BY_KIND[data.kind] ?? "scenarioNode",
    position: options.position ?? { x: 0, y: 0 },
    data,
  };
}

export function createGraphTestEdge(
  source: string,
  target: string,
  overrides: Partial<ScenarioFlowEdge> = {}
): ScenarioFlowEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    ...overrides,
  };
}
