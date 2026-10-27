"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Refreshes React Flow's measurement of the node when `layoutSignature`
 * changes, so edges follow handles that appear, go or move. Not on mount:
 * React Flow measures a new node and its handles itself, and a refresh per
 * node there would repeat that work once per node in the first frame.
 */
export function useNodeInternalsRefreshOnChange(
  layoutSignature: string,
  refreshNodeInternals: () => void
): void {
  const measuredSignatureRef = useRef(layoutSignature);
  useLayoutEffect(() => {
    if (measuredSignatureRef.current === layoutSignature) return;
    measuredSignatureRef.current = layoutSignature;
    refreshNodeInternals();
  }, [layoutSignature, refreshNodeInternals]);
}
