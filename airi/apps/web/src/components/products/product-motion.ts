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
