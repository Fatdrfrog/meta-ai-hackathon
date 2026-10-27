"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { CornerUpLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { resolveScenarioDestinationLabel } from "../../scenario-node-labels";
import type { ScenarioFlowNode } from "../../types";
import {
  getScenarioReturnEdgePath,
  type ScenarioReturnEdgeData,
} from "./return-edges";

export function ScenarioReturnEdge(
  props: EdgeProps<Edge<ScenarioReturnEdgeData>>
) {
  const source = useInternalNode<ScenarioFlowNode>(props.source);
  const target = useInternalNode<ScenarioFlowNode>(props.target);
  const { fitView } = useReactFlow();
  const { zoom } = useViewport();
  const t = useTranslations("Scenarios");
  if (!source || !target || !props.data?.scenarioReturn) return null;
  const { path, labelX, labelY } = getScenarioReturnEdgePath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourceRight:
      source.internals.positionAbsolute.x +
      (source.measured.width ?? source.width ?? 384),
    targetLeft: target.internals.positionAbsolute.x,
    routeY: Math.min(
      props.data.scenarioReturn.routeY,
      source.internals.positionAbsolute.y - 40,
      target.internals.positionAbsolute.y - 40
    ),
  });
  // Named like a route's next step, from the saved step: never empty-state copy.
  const destination = resolveScenarioDestinationLabel({
    nodeData: { ...target.data, actionPreviewText: undefined },
    t,
  });
  const label = t("canvasReturnTo", { destination });
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        interactionWidth={24}
        style={{
          ...props.style,
          stroke: "var(--primary)",
          strokeWidth: props.selected ? 2.5 : 1.5,
          strokeDasharray: "6 4",
          opacity: props.selected ? 1 : 0.65,
        }}
      />
      {(props.selected || props.data.scenarioReturn.showLabel) && (
        <EdgeLabelRenderer>
          <button
            type="button"
            title={label}
            aria-label={label}
            className="nodrag nopan pointer-events-auto absolute flex min-h-8 min-w-8 max-w-64 items-center justify-center gap-1.5 rounded-full border border-primary/25 bg-background px-2 py-1 text-xs font-medium text-primary shadow-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:min-h-11 max-sm:min-w-11"
            style={{
              transform: `translate(${labelX}px, ${labelY}px) scale(${1 / zoom}) translate(-50%, -50%)`,
            }}
            onClick={event => {
              event.stopPropagation();
              void fitView({
                nodes: [{ id: props.target }],
                padding: 0.35,
                minZoom: 0.6,
                maxZoom: 1,
                duration: 200,
              });
            }}
          >
            <CornerUpLeft className="size-3.5 shrink-0" aria-hidden />
            {zoom >= 0.5 && <span className="truncate">{label}</span>}
            {props.data.scenarioReturn.destinationReturnCount > 1 && (
              <span className="tabular-nums">
                {props.data.scenarioReturn.destinationReturnCount}
              </span>
            )}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
