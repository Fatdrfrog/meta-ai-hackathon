"use client";

import { useLatestRef } from "./view/use-latest-ref";
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { ScenarioSourceHandleCreatePoint } from "./source-handle-types";

const CLICK_DRAG_TOLERANCE_PX = 4;

export function useSourceHandleCreate(params: {
  createNode?: (point: ScenarioSourceHandleCreatePoint) => void;
  onInteractionStart?: () => void;
}) {
  const createNodeRef = useLatestRef(params.createNode);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const removeDragReleaseListenersRef = useRef<(() => void) | null>(null);
  const scheduledReleaseFrameRef = useRef<number | null>(null);
  const interactionStartNotifiedRef = useRef(false);
  const suppressNextClickRef = useRef(false);

  const removeDragReleaseListeners = () => {
    removeDragReleaseListenersRef.current?.();
    removeDragReleaseListenersRef.current = null;
  };

  const cancelScheduledRelease = () => {
    if (
      scheduledReleaseFrameRef.current !== null &&
      typeof window !== "undefined"
    ) {
      window.cancelAnimationFrame(scheduledReleaseFrameRef.current);
    }
    scheduledReleaseFrameRef.current = null;
  };

  const notifyInteractionStart = () => {
    if (interactionStartNotifiedRef.current) return;
    interactionStartNotifiedRef.current = true;
    params.onInteractionStart?.();
  };

  const resetInteractionStartNotification = () => {
    interactionStartNotifiedRef.current = false;
  };

  const isCanvasReleaseTarget = (clientX: number, clientY: number) => {
    if (typeof document === "undefined") return false;
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof Element)) return false;
    if (target.closest(".react-flow__handle, .react-flow__node")) {
      return false;
    }
    return Boolean(
      target.closest(
        ".react-flow__pane, .react-flow__renderer, .react-flow__viewport"
      )
    );
  };

  const scheduleCreateFromDragRelease = (
    point: ScenarioSourceHandleCreatePoint
  ) => {
    cancelScheduledRelease();

    const openIfReleasedOnCanvas = () => {
      scheduledReleaseFrameRef.current = null;
      if (!createNodeRef.current) return;
      if (!isCanvasReleaseTarget(point.clientX, point.clientY)) return;
      createNodeRef.current(point);
    };

    if (
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      openIfReleasedOnCanvas();
      return;
    }

    scheduledReleaseFrameRef.current = window.requestAnimationFrame(
      openIfReleasedOnCanvas
    );
  };

  const handleDragRelease = (event: globalThis.MouseEvent) => {
    if (!params.createNode) return;
    const start = pointerStartRef.current;
    removeDragReleaseListeners();
    pointerStartRef.current = null;
    resetInteractionStartNotification();
    if (!start) return;

    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved <= CLICK_DRAG_TOLERANCE_PX) return;

    suppressNextClickRef.current = true;
    scheduleCreateFromDragRelease({
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  const trackDragStart = (clientX: number, clientY: number) => {
    notifyInteractionStart();
    if (!params.createNode || typeof window === "undefined") return;
    pointerStartRef.current = {
      x: clientX,
      y: clientY,
    };
    removeDragReleaseListeners();
    cancelScheduledRelease();
    const handleRelease = (event: globalThis.MouseEvent) =>
      handleDragRelease(event);
    window.addEventListener("mouseup", handleRelease);
    removeDragReleaseListenersRef.current = () => {
      window.removeEventListener("mouseup", handleRelease);
    };
  };

  useEffect(
    () => () => {
      removeDragReleaseListeners();
      cancelScheduledRelease();
    },
    []
  );

  return {
    handlePointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      trackDragStart(event.clientX, event.clientY);
    },
    handleMouseDownCapture: (event: MouseEvent<HTMLDivElement>) => {
      trackDragStart(event.clientX, event.clientY);
    },
    handleCreateClick: (event: MouseEvent<HTMLElement>) => {
      if (!params.createNode) {
        resetInteractionStartNotification();
        return;
      }
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        resetInteractionStartNotification();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const start = pointerStartRef.current;
      removeDragReleaseListeners();
      pointerStartRef.current = null;
      resetInteractionStartNotification();
      const moved = start
        ? Math.hypot(event.clientX - start.x, event.clientY - start.y)
        : 0;

      if (moved > CLICK_DRAG_TOLERANCE_PX) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      params.createNode({ clientX: event.clientX, clientY: event.clientY });
    },
    handleCreateKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (
        !params.createNode ||
        (event.key !== "Enter" && event.key !== " ")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      params.createNode({
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      });
    },
  };
}
