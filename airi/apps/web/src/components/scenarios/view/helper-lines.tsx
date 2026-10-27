"use client";

import {
  useStore,
  type OnNodeDrag,
  type ReactFlowState,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ScenarioFlowNode } from "../types";
import type { ScenarioGraphEditor } from "./graph/controller-utils";
import { useLatestRef } from "./use-latest-ref";

const SNAP_THRESHOLD = 5;

export interface HelperLinePositions {
  horizontal: number | null;
  vertical: number | null;
}

interface AlignmentResult {
  horizontal: number | null;
  vertical: number | null;
  snapX: number | null;
  snapY: number | null;
}

type PendingDragAlignment = {
  draggedNode: ScenarioFlowNode;
  allNodes: ScenarioFlowNode[];
};

type PendingSnap = {
  nodeId: string;
  x: number | null;
  y: number | null;
};

function helperLinesEqual(
  left: HelperLinePositions,
  right: HelperLinePositions
): boolean {
  return (
    left.horizontal === right.horizontal && left.vertical === right.vertical
  );
}

function getAlignmentLines(
  draggingNode: ScenarioFlowNode,
  allNodes: ScenarioFlowNode[]
): AlignmentResult {
  const result: AlignmentResult = {
    horizontal: null,
    vertical: null,
    snapX: null,
    snapY: null,
  };

  const dW = draggingNode.measured?.width ?? 280;
  const dH = draggingNode.measured?.height ?? 100;
  const dX = draggingNode.position.x;
  const dY = draggingNode.position.y;

  const dCenterX = dX + dW / 2;
  const dCenterY = dY + dH / 2;
  const dRight = dX + dW;
  const dBottom = dY + dH;

  let closestDeltaX = SNAP_THRESHOLD + 1;
  let closestDeltaY = SNAP_THRESHOLD + 1;

  const checkVerticalAlignment = (dragVal: number, nodeVal: number) => {
    const delta = Math.abs(dragVal - nodeVal);
    if (delta < SNAP_THRESHOLD && delta < closestDeltaX) {
      closestDeltaX = delta;
      result.vertical = nodeVal;
      result.snapX = dX + (nodeVal - dragVal);
    }
  };

  const checkHorizontalAlignment = (dragVal: number, nodeVal: number) => {
    const delta = Math.abs(dragVal - nodeVal);
    if (delta < SNAP_THRESHOLD && delta < closestDeltaY) {
      closestDeltaY = delta;
      result.horizontal = nodeVal;
      result.snapY = dY + (nodeVal - dragVal);
    }
  };

  for (const node of allNodes) {
    if (node.id === draggingNode.id) continue;

    const nW = node.measured?.width ?? 280;
    const nH = node.measured?.height ?? 100;
    const nX = node.position.x;
    const nY = node.position.y;
    const nCenterX = nX + nW / 2;
    const nCenterY = nY + nH / 2;
    const nRight = nX + nW;
    const nBottom = nY + nH;

    checkVerticalAlignment(dX, nX);
    checkVerticalAlignment(dCenterX, nCenterX);
    checkVerticalAlignment(dRight, nRight);
    checkVerticalAlignment(dX, nCenterX);
    checkVerticalAlignment(dX, nRight);
    checkVerticalAlignment(dCenterX, nX);
    checkVerticalAlignment(dCenterX, nRight);
    checkVerticalAlignment(dRight, nX);
    checkVerticalAlignment(dRight, nCenterX);

    checkHorizontalAlignment(dY, nY);
    checkHorizontalAlignment(dCenterY, nCenterY);
    checkHorizontalAlignment(dBottom, nBottom);
    checkHorizontalAlignment(dY, nCenterY);
    checkHorizontalAlignment(dY, nBottom);
    checkHorizontalAlignment(dCenterY, nY);
    checkHorizontalAlignment(dCenterY, nBottom);
    checkHorizontalAlignment(dBottom, nY);
    checkHorizontalAlignment(dBottom, nCenterY);
  }

  return result;
}

const transformSelector = (state: ReactFlowState) => state.transform;

export function HelperLinesRenderer({
  horizontal,
  vertical,
}: {
  horizontal: number | null;
  vertical: number | null;
}) {
  const transform = useStore(transformSelector);
  const [tx, ty, zoom] = transform;

  if (horizontal === null && vertical === null) return null;

  const lineStyle: CSSProperties = {
    position: "absolute",
    pointerEvents: "none",
    zIndex: 5,
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {horizontal !== null && (
        <div
          style={{
            ...lineStyle,
            left: 0,
            right: 0,
            top: horizontal * zoom + ty,
            height: 0,
            borderTop: "1px dashed rgba(99, 102, 241, 0.6)",
          }}
        />
      )}
      {vertical !== null && (
        <div
          style={{
            ...lineStyle,
            top: 0,
            bottom: 0,
            left: vertical * zoom + tx,
            width: 0,
            borderLeft: "1px dashed rgba(99, 102, 241, 0.6)",
          }}
        />
      )}
    </div>
  );
}

export function useHelperLines({
  enabled = true,
  graphEditor,
  finishNodeDrag,
}: {
  enabled?: boolean;
  graphEditor: Pick<ScenarioGraphEditor, "read">;
  finishNodeDrag: (snap: PendingSnap | null) => void;
}) {
  const [helperLineState, setHelperLines] = useState({
    graphEditor,
    positions: { horizontal: null, vertical: null } as HelperLinePositions,
  });
  const helperLines =
    helperLineState.graphEditor === graphEditor
      ? helperLineState.positions
      : { horizontal: null, vertical: null };
  const graphEditorRef = useLatestRef(graphEditor);
  const mountedRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const helperLinesRef = useRef(helperLineState);
  const pendingDragRef = useRef<PendingDragAlignment | null>(null);
  const pendingSnapRef = useRef<PendingSnap | null>(null);

  const updateHelperLines = useCallback(
    (positions: HelperLinePositions) => {
      if (
        helperLinesRef.current.graphEditor === graphEditor &&
        helperLinesEqual(helperLinesRef.current.positions, positions)
      )
        return;
      const next = { graphEditor, positions };
      helperLinesRef.current = next;
      setHelperLines(next);
    },
    [graphEditor]
  );

  const resolvePendingAlignment = useCallback(
    ({ draggedNode, allNodes }: PendingDragAlignment): HelperLinePositions => {
      const alignment = getAlignmentLines(draggedNode, allNodes);
      pendingSnapRef.current =
        alignment.snapX !== null || alignment.snapY !== null
          ? {
              nodeId: draggedNode.id,
              x: alignment.snapX,
              y: alignment.snapY,
            }
          : null;

      return {
        horizontal: alignment.horizontal,
        vertical: alignment.vertical,
      };
    },
    []
  );

  const cancelPendingDrag = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingDragRef.current = null;
    pendingSnapRef.current = null;
  }, []);

  const clearHelperLines = useCallback(() => {
    cancelPendingDrag();
    updateHelperLines({ horizontal: null, vertical: null });
  }, [cancelPendingDrag, updateHelperLines]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingDrag();
    };
  }, [cancelPendingDrag, graphEditor]);

  const onNodeDrag = useCallback<OnNodeDrag<ScenarioFlowNode>>(
    (_event, draggedNode, draggedNodes) => {
      if (!mountedRef.current || graphEditorRef.current !== graphEditor) return;
      if (!enabled || draggedNodes.length > 1) {
        pendingSnapRef.current = null;
        clearHelperLines();
        return;
      }

      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      pendingDragRef.current = {
        draggedNode,
        allNodes: graphEditor.read().nodes,
      };

      rafRef.current = requestAnimationFrame(() => {
        if (!mountedRef.current || graphEditorRef.current !== graphEditor)
          return;
        const pendingDrag = pendingDragRef.current;
        if (pendingDrag) {
          updateHelperLines(resolvePendingAlignment(pendingDrag));
        }

        rafRef.current = null;
      });
    },
    [
      clearHelperLines,
      enabled,
      graphEditor,
      graphEditorRef,
      resolvePendingAlignment,
      updateHelperLines,
    ]
  );

  const handleNodeDragStop = useCallback(() => {
    if (!mountedRef.current || graphEditorRef.current !== graphEditor) return;
    if (enabled && pendingDragRef.current) {
      resolvePendingAlignment(pendingDragRef.current);
    }
    const snap = enabled ? pendingSnapRef.current : null;
    clearHelperLines();
    finishNodeDrag(snap);
  }, [
    clearHelperLines,
    enabled,
    finishNodeDrag,
    graphEditor,
    graphEditorRef,
    resolvePendingAlignment,
  ]);

  return { helperLines, onNodeDrag, handleNodeDragStop };
}
