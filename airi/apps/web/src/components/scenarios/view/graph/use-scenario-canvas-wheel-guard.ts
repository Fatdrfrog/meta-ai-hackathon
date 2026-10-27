"use client";

import { useEffect, type RefObject } from "react";

const SCENARIO_GRAPH_WHEEL_GUARD_SELECTOR = ".nowheel";
const SCENARIO_SCROLLABLE_OVERFLOW_VALUES = new Set([
  "auto",
  "scroll",
  "overlay",
]);

function stopGuardedWheelPropagation(event: WheelEvent) {
  const target = event.target;
  const boundary = event.currentTarget;

  if (
    target instanceof Element &&
    boundary instanceof HTMLElement &&
    target.closest(SCENARIO_GRAPH_WHEEL_GUARD_SELECTOR)
  ) {
    if (event.ctrlKey) {
      // A trackpad pinch arrives as Ctrl+wheel, and React Flow ignores wheels
      // over .nowheel. Left alone, the browser zooms the whole page and keeps
      // that zoom for every page of the site.
      event.preventDefault();
    } else if (scrollGuardedWheelTarget(event, target, boundary)) {
      event.preventDefault();
    }
    event.stopPropagation();
  }
}

function getScrollableOverflowValue(
  element: Element,
  property: "overflowX" | "overflowY"
) {
  if (typeof window === "undefined") return "";
  return window.getComputedStyle(element)[property];
}

function canScrollVertically(element: HTMLElement, deltaY: number) {
  if (deltaY === 0 || element.scrollHeight <= element.clientHeight) {
    return false;
  }

  const overflowY = getScrollableOverflowValue(element, "overflowY");
  if (!SCENARIO_SCROLLABLE_OVERFLOW_VALUES.has(overflowY)) {
    return false;
  }

  const maxScrollTop = element.scrollHeight - element.clientHeight;
  return deltaY > 0 ? element.scrollTop < maxScrollTop : element.scrollTop > 0;
}

function canScrollHorizontally(element: HTMLElement, deltaX: number) {
  if (deltaX === 0 || element.scrollWidth <= element.clientWidth) {
    return false;
  }

  const overflowX = getScrollableOverflowValue(element, "overflowX");
  if (!SCENARIO_SCROLLABLE_OVERFLOW_VALUES.has(overflowX)) {
    return false;
  }

  const maxScrollLeft = element.scrollWidth - element.clientWidth;
  return deltaX > 0
    ? element.scrollLeft < maxScrollLeft
    : element.scrollLeft > 0;
}

function clampWheelScroll(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function applyWheelScroll(element: HTMLElement, event: WheelEvent) {
  const nextScrollTop = canScrollVertically(element, event.deltaY)
    ? clampWheelScroll(
        element.scrollTop + event.deltaY,
        0,
        element.scrollHeight - element.clientHeight
      )
    : element.scrollTop;
  const nextScrollLeft = canScrollHorizontally(element, event.deltaX)
    ? clampWheelScroll(
        element.scrollLeft + event.deltaX,
        0,
        element.scrollWidth - element.clientWidth
      )
    : element.scrollLeft;
  const didScroll =
    nextScrollTop !== element.scrollTop ||
    nextScrollLeft !== element.scrollLeft;

  if (didScroll) {
    element.scrollTop = nextScrollTop;
    element.scrollLeft = nextScrollLeft;
  }

  return didScroll;
}

function findGuardedScrollableElement(
  target: Element,
  boundary: Element,
  event: WheelEvent
) {
  if (!target.closest(SCENARIO_GRAPH_WHEEL_GUARD_SELECTOR)) return null;

  let current: Element | null = target;
  while (current && boundary.contains(current)) {
    if (
      current instanceof HTMLElement &&
      (canScrollVertically(current, event.deltaY) ||
        canScrollHorizontally(current, event.deltaX))
    ) {
      return current;
    }

    if (current === boundary) break;
    current = current.parentElement;
  }

  return null;
}

function scrollGuardedWheelTarget(
  event: WheelEvent,
  target: Element,
  boundary: Element
) {
  const scrollTarget = findGuardedScrollableElement(target, boundary, event);
  return scrollTarget ? applyWheelScroll(scrollTarget, event) : false;
}

export function useScenarioCanvasWheelGuard(
  flowWrapperRef: RefObject<HTMLDivElement | null>
) {
  useEffect(() => {
    const wrapper = flowWrapperRef.current;
    // React's delegated wheel listener is passive. Use a native listener so
    // the existing nested-editor scroll guard can cancel the default scroll.
    wrapper?.addEventListener("wheel", stopGuardedWheelPropagation, {
      capture: true,
      passive: false,
    });
    return () =>
      wrapper?.removeEventListener("wheel", stopGuardedWheelPropagation, true);
  }, [flowWrapperRef]);
}
