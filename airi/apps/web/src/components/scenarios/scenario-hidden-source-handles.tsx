"use client";

import { cn } from "@/lib/utils";
import { Handle, Position } from "@xyflow/react";
import {
  getXyflowHandleSideStyle,
  SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
} from "./source-handle-button";

/**
 * Invisible anchors on the right edge for routes whose dot isn't shown, so
 * their edges neither dangle nor jump to another dot.
 */
export function ScenarioHiddenSourceHandles({
  handleIds,
}: {
  handleIds: readonly string[];
}) {
  return handleIds.map(handleId => (
    <Handle
      key={handleId}
      id={handleId}
      type="source"
      position={Position.Right}
      aria-hidden
      className={cn(
        SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
        "!pointer-events-none !h-px !w-px !border-0 !bg-transparent !opacity-0"
      )}
      style={{ ...getXyflowHandleSideStyle(Position.Right), top: "50%" }}
    />
  ));
}
