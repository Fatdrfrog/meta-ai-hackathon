"use client";

import {
  ViewportPortal,
  getBezierPath,
  type ConnectionLineComponentProps,
} from "@xyflow/react";
import type { ScenarioFlowNode } from "../../types";

const SCENARIO_GRAPH_STATIC_CSS = `
  .scenario-graph-flow .scenario-route-highlight {
    border-radius: 16px;
    outline: 3px solid var(--primary);
    outline-offset: 5px;
  }

  .scenario-graph-flow svg.react-flow__connectionline {
    z-index: 10000 !important;
    overflow: visible;
  }

  .scenario-graph-flow .react-flow__edges {
    /* Keep saved connections visible while cards are selected or dragged.
       The SVG remains transparent to pointer events outside edge strokes. */
    z-index: 30 !important;
  }

  .scenario-graph-flow .react-flow__nodes {
    z-index: 20 !important;
  }

  .scenario-graph-flow .react-flow__edgelabel-renderer {
    z-index: 35;
  }

  .scenario-graph-flow .react-flow__edge {
    pointer-events: visibleStroke;
  }

  .scenario-graph-flow .react-flow__viewport-portal {
    position: absolute;
    inset: 0;
    z-index: 10000;
    pointer-events: none;
  }

  .scenario-graph-flow .scenario-graph-connection-overlay {
    position: absolute;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
    z-index: 10000;
    overflow: visible;
    pointer-events: none;
  }

  .scenario-graph-flow .scenario-graph-connection-path {
    fill: none;
    stroke-linecap: round;
  }

  .scenario-graph-flow--pan .react-flow__pane {
    cursor: grab;
  }

  .scenario-graph-flow--pan .react-flow__pane:active {
    cursor: grabbing;
  }

  .scenario-graph-flow--select .react-flow__pane {
    cursor: default;
  }

  /*
   * Official xyflow handle math (reactflow.dev/learn/customization/handles):
   * Position.Right is already centered on that side via
   * transform: translate(50%, -50%). Tailwind v4 translate-* utilities set the
   * separate translate property and can zero the X shift. Kill that property
   * on scenario handles; inline style on Handle still owns transform.
   */
  .scenario-graph-flow .scenario-source-handle-button,
  .scenario-graph-flow .scenario-target-handle {
    translate: none;
  }
  .scenario-graph-flow .scenario-target-handle {
    z-index: 30;
  }
  .scenario-graph-flow .react-flow__handle-right {
    --translate: translate(50%, -50%);
  }
  .scenario-graph-flow .react-flow__handle-left {
    --translate: translate(-50%, -50%);
  }
  .scenario-graph-flow .react-flow__handle-top {
    --translate: translate(-50%, -50%);
  }
  .scenario-graph-flow .react-flow__handle-bottom {
    --translate: translate(-50%, 50%);
  }
`;

export function ScenarioGraphStaticStyles() {
  return <style>{SCENARIO_GRAPH_STATIC_CSS}</style>;
}

export function ScenarioConnectionLine({
  connectionLineStyle,
  fromPosition,
  fromX,
  fromY,
  toPosition,
  toX,
  toY,
}: ConnectionLineComponentProps<ScenarioFlowNode>) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });

  return (
    <ViewportPortal>
      <svg
        aria-hidden
        className="scenario-graph-connection-overlay"
        focusable="false"
      >
        <path
          className="react-flow__connection-path scenario-graph-connection-path"
          d={path}
          style={connectionLineStyle}
        />
      </svg>
    </ViewportPortal>
  );
}
