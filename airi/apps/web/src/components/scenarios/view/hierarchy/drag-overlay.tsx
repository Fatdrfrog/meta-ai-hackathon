"use client";

import { Badge } from "@/components/ui/badge";
import { GripVertical } from "lucide-react";
import { memo } from "react";
import type { ScenarioSummary } from "../../types";

type ScenarioHierarchyDragOverlayProps = {
  scenario: ScenarioSummary | null;
  widthPx: number | null;
  activeLabel: string;
  draftLabel: string;
};

export const ScenarioHierarchyDragOverlay = memo(
  function ScenarioHierarchyDragOverlay({
    scenario,
    widthPx,
    activeLabel,
    draftLabel,
  }: ScenarioHierarchyDragOverlayProps) {
    if (!scenario) {
      return null;
    }

    return (
      <div
        className="pointer-events-none"
        style={{
          width: widthPx ? `${widthPx}px` : undefined,
        }}
      >
        <div className="flex min-h-9 overflow-hidden rounded-xl border border-primary/60 bg-background shadow-2xl">
          <div className="flex shrink-0 items-start border-r bg-muted/35 px-1 py-1">
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1 px-2 py-1.5 text-left">
            <div className="flex items-start justify-between gap-2">
              <span className="truncate text-[13px] font-medium">
                {scenario.name}
              </span>
              <Badge
                variant={scenario.status === "active" ? "default" : "secondary"}
                className="shrink-0 text-[10px] uppercase"
              >
                {scenario.status === "active" ? activeLabel : draftLabel}
              </Badge>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
