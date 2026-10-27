import { useCallback, useRef } from "react";

const DRAG_THRESHOLD = 15;
const NON_EMPTY_FLOW_TARGET_SELECTOR = [
  ".react-flow__node",
  ".react-flow__handle",
  ".react-flow__edge",
  ".react-flow__nodesselection",
  ".react-flow__node-toolbar",
].join(", ");

type PaneDragState = {
  startX: number;
  startY: number;
  isNodeDrag: boolean;
};

export function isEmptyFlowPaneTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (!target.closest(".react-flow__pane")) return false;
  return !target.closest(NON_EMPTY_FLOW_TARGET_SELECTOR);
}

export function isEmptyFlowPaneReleasePoint(params: {
  clientX: number;
  clientY: number;
  fallbackTarget?: EventTarget | null;
}): boolean {
  const elementAtPoint =
    typeof document !== "undefined" &&
    typeof document.elementFromPoint === "function"
      ? document.elementFromPoint(params.clientX, params.clientY)
      : null;

  return isEmptyFlowPaneTarget(elementAtPoint ?? params.fallbackTarget ?? null);
}

/**
 * Tracks left-button drag gestures on the ReactFlow pane and determines
 * whether the user performed a meaningful drag (above a threshold).
 * Returns mouse-down / mouse-up handlers plus a wrapped node-drag handler when provided.
 */
export function usePaneDragGesture<TNodeDragArgs extends unknown[]>(
  onDragRelease: (clientX: number, clientY: number) => void,
  onNodeDrag?: (...args: TNodeDragArgs) => void,
  options: { enabled?: boolean } = {}
) {
  const paneDragRef = useRef<PaneDragState | null>(null);
  const enabled = options.enabled ?? true;

  const handlePaneMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!enabled || event.button !== 0) return;
      if (!isEmptyFlowPaneTarget(event.target)) {
        paneDragRef.current = null;
        return;
      }

      paneDragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        isNodeDrag: false,
      };
    },
    [enabled]
  );

  const handlePaneMouseUp = useCallback(
    (event: React.MouseEvent) => {
      if (!enabled || event.button !== 0) return;
      const drag = paneDragRef.current;
      paneDragRef.current = null;
      if (!drag || drag.isNodeDrag) return;
      if (
        !isEmptyFlowPaneReleasePoint({
          clientX: event.clientX,
          clientY: event.clientY,
          fallbackTarget: event.target,
        })
      ) {
        return;
      }

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < DRAG_THRESHOLD) return;

      onDragRelease(event.clientX, event.clientY);
    },
    [enabled, onDragRelease]
  );

  const markNodeDrag = useCallback(() => {
    if (paneDragRef.current) {
      paneDragRef.current.isNodeDrag = true;
    }
  }, []);

  const handleNodeDrag = useCallback(
    (...args: TNodeDragArgs) => {
      markNodeDrag();
      if (!enabled) return;
      onNodeDrag?.(...args);
    },
    [enabled, markNodeDrag, onNodeDrag]
  );

  return {
    handlePaneMouseDown,
    handlePaneMouseUp,
    handleNodeDrag,
  } as const;
}

/**
 * Extracts client coordinates from a mouse or touch event.
 */
export function getReleaseClientPoint(
  event: MouseEvent | TouchEvent
): { x: number; y: number } | null {
  if ("changedTouches" in event) {
    const touch = event.changedTouches?.[0] ?? event.touches?.[0];
    if (!touch) return null;
    return { x: touch.clientX, y: touch.clientY };
  }

  if ("clientX" in event && "clientY" in event) {
    return { x: event.clientX, y: event.clientY };
  }

  return null;
}
