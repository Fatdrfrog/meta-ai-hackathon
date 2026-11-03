"use client";

import { useSyncExternalStore } from "react";

// Motion in Products follows the visitor's reduced-motion setting: CSS checks
// it on its own; these are for what scripts start, like playing a video.

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.(REDUCED_MOTION).matches === true;

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

/** Whether to keep still, kept current; still until the browser can say. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => true);
}

/** Products' ease-out (the theme's --p-ease-out). */
export const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * Products' spring (the theme's --p-ease-spring): damped at 0.75, about 2.8%
 * past its mark, settled within 240ms.
 */
export const EASE_SPRING =
  "linear(0, 0.09 6.3%, 0.281 12.5%, 0.489 18.8%, 0.673 25%, 0.815 31.3%, 0.914 37.5%, 0.976 43.8%, 1.01 50%, 1.025 56.3%, 1.028 62.5%, 1.025 68.8%, 1.02 75%, 1.014 81.3%, 1.009 87.5%, 1.005 93.8%, 1)";

/**
 * Plays keyframes on the spring, or on the ease-out where the browser can't
 * read a linear() curve; nothing where it can't animate. Returns the
 * animation, to cancel.
 */
export function animateOnSpring(
  element: Element,
  keyframes: Keyframe[],
  duration: number
): Animation | undefined {
  if (typeof element.animate !== "function") return undefined;
  try {
    return element.animate(keyframes, { duration, easing: EASE_SPRING });
  } catch {
    return element.animate(keyframes, { duration, easing: EASE_OUT });
  }
}
