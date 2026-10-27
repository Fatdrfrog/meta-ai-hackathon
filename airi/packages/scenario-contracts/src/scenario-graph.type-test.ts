import type {
  ScenarioCanvasNode,
  ScenarioGraphEdge,
  ScenarioGraphNode,
  ScenarioRawGraphNode,
} from "./scenario-graph";

const canvasNode = {
  id: "node-1",
  type: "actionNode",
  position: { x: 10, y: 20 },
  measured: { width: 320, height: 180 },
  data: { kind: "action" },
} satisfies ScenarioCanvasNode;

const graphNode: ScenarioGraphNode = canvasNode;

const graphEdge = {
  id: "edge-1",
  source: "node-1",
  target: "node-2",
  sourceHandle: "right-source",
  targetHandle: "left-target",
} satisfies ScenarioGraphEdge;

// @ts-expect-error Persisted canvas nodes require a position.
const canvasNodeWithoutPosition: ScenarioCanvasNode = {
  id: "node-2",
  data: { kind: "action" },
};

void graphNode;
void graphEdge;
void canvasNodeWithoutPosition;

declare const rawNode: ScenarioRawGraphNode;
// @ts-expect-error A checked envelope does not validate nested action data.
const actionText: string | undefined = rawNode.data.actionReplyText;
// @ts-expect-error Legacy envelopes may omit canvas positions.
const rawCanvasNode: ScenarioCanvasNode = rawNode;
void actionText;
void rawCanvasNode;
