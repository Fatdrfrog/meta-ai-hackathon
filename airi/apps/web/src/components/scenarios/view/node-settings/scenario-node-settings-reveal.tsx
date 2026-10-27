"use client";

import { useReactFlow, useStore } from "@xyflow/react";
import { useEffect, useRef } from "react";

const REVEAL_WINDOW_MS = 600;

type FlowRect = { x: number; y: number; width: number; height: number };
type FlowViewport = { x: number; y: number; zoom: number };

/** Whether a flow-space rectangle lies fully inside the visible canvas. */
export function isFlowRectVisible(
  rect: FlowRect,
  viewport: FlowViewport,
  canvas: { width: number; height: number }
): boolean {
  const left = rect.x * viewport.zoom + viewport.x;
  const top = rect.y * viewport.zoom + viewport.y;
  return (
    left >= 0 &&
    top >= 0 &&
    left + rect.width * viewport.zoom <= canvas.width &&
    top + rect.height * viewport.zoom <= canvas.height
  );
}

/**
 * Opening the docked settings narrows the canvas. Shortly after a node's
 * settings open, centre its card at the current zoom if it no longer fits.
 * Rendered inside React Flow; later panning is left to the user.
 */
export function ScenarioNodeSettingsReveal({ nodeId }: { nodeId: string }) {
  const { getInternalNode, getViewport, setCenter } = useReactFlow();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const pendingNodeIdRef = useRef<string | null>(null);

  useEffect(() => {
    pendingNodeIdRef.current = nodeId;
    const timer = window.setTimeout(() => {
      if (pendingNodeIdRef.current === nodeId) {
        pendingNodeIdRef.current = null;
      }
    }, REVEAL_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [nodeId]);

  useEffect(() => {
    if (pendingNodeIdRef.current !== nodeId || !width || !height) return;
    const node = getInternalNode(nodeId);
    const nodeWidth = node?.measured.width;
    const nodeHeight = node?.measured.height;
    if (!node || !nodeWidth || !nodeHeight) return;
    const viewport = getViewport();
    const { x, y } = node.internals.positionAbsolute;
    if (
      isFlowRectVisible(
        { x, y, width: nodeWidth, height: nodeHeight },
        viewport,
        {
          width,
          height,
        }
      )
    ) {
      return;
    }
    pendingNodeIdRef.current = null;
    void setCenter(x + nodeWidth / 2, y + nodeHeight / 2, {
      zoom: viewport.zoom,
      duration: 200,
    });
  }, [getInternalNode, getViewport, height, nodeId, setCenter, width]);

  return null;
}
