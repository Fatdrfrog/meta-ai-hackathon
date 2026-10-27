"use client";

import { observeElementResize } from "@/lib/observe-element-resize";
import { useEffect, useState, type RefObject } from "react";

/**
 * Measures the resizable panel group that contains `anchorRef`, in pixels.
 * Panel sizes are percentages of this width.
 */
export function useResizablePanelGroupWidth(
  anchorRef: RefObject<HTMLElement | null>,
  enabled: boolean
): number | null {
  const [groupWidth, setGroupWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const group = anchorRef.current?.closest("[data-panel-group]");
    if (!group) return;
    return observeElementResize(group, () => {
      const width = group.getBoundingClientRect().width;
      if (width > 0) setGroupWidth(width);
    });
  }, [anchorRef, enabled]);

  return enabled ? groupWidth : null;
}
