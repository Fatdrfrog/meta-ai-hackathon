/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import type { ScenarioNodeData } from "../../types";

const mockNodes = new Map<string, { data: ScenarioNodeData }>();

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
jest.mock("@xyflow/react", () => ({
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  useInternalNode: (id: string) => {
    const node = mockNodes.get(id);
    return node
      ? {
          id,
          data: node.data,
          measured: { width: 300 },
          internals: { positionAbsolute: { x: 0, y: 0 } },
        }
      : undefined;
  },
  useReactFlow: () => ({ fitView: jest.fn() }),
  useViewport: () => ({ zoom: 1 }),
}));

import { render, screen } from "@testing-library/react";
import type { EdgeProps, Edge } from "@xyflow/react";
import { ScenarioReturnEdge } from "./scenario-return-edge";
import type { ScenarioReturnEdgeData } from "./return-edges";

function renderReturnEdge(target: ScenarioNodeData) {
  mockNodes.clear();
  mockNodes.set("source", { data: { kind: "action", actionType: "reply" } });
  mockNodes.set("target", { data: target });
  const props = {
    id: "return",
    source: "source",
    target: "target",
    sourceX: 300,
    sourceY: 100,
    targetX: 0,
    targetY: 0,
    selected: true,
    data: {
      scenarioReturn: {
        lane: 0,
        routeY: -60,
        destinationReturnCount: 1,
        showLabel: true,
      },
    },
  } as unknown as EdgeProps<Edge<ScenarioReturnEdgeData>>;
  render(<ScenarioReturnEdge {...props} />);
  return screen.getByRole("button");
}

describe("ScenarioReturnEdge", () => {
  it.each<[string, ScenarioNodeData, string]>([
    [
      "a step with text",
      {
        kind: "action",
        actionType: "reply",
        actionReplyText: "Choose a size",
      },
      "Choose a size",
    ],
    [
      "an empty step",
      { kind: "action", actionType: "reply", actionReplyMode: "fixed" },
      "presetActionReply",
    ],
    [
      "a handoff with no message",
      { kind: "action", actionType: "assign_human" },
      "presetActionAssignHuman",
    ],
    [
      "a filter",
      { kind: "logic", logicType: "audience_filter" },
      "scenarioGate",
    ],
  ])("names %s like a route's next step", (_label, target, destination) => {
    const button = renderReturnEdge(target);
    const label = `canvasReturnTo:${JSON.stringify({ destination })}`;
    expect(button).toHaveAccessibleName(label);
    expect(button).toHaveTextContent(label);
    expect(button).not.toHaveTextContent("actionPreviewEmpty");
  });
});
