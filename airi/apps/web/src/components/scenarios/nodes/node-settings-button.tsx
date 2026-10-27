"use client";

import { Settings2 } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  focusScenarioNodeSettingsPanel,
  SCENARIO_NODE_SETTINGS_PANEL_ID,
} from "../view/node-settings/restore-scenario-node-focus";

/**
 * Card control that opens a node's settings. The panel restores focus here
 * when it closes, so every card uses this button for that purpose.
 */
export function ScenarioNodeSettingsButton({
  nodeId,
  label,
  accessibleLabel,
  expanded,
  onOpen,
  iconOnly = false,
  className,
  testId,
}: {
  nodeId: string;
  label: string;
  accessibleLabel?: string;
  /**
   * Whether the settings panel shows this node. Omit it when the settings open
   * in the legacy modal editor, which does not report its state here.
   */
  expanded?: boolean;
  onOpen: (options: { moveFocus: boolean }) => void;
  /** A small icon button for a card header; `label` becomes its tooltip. */
  iconOnly?: boolean;
  className?: string;
  testId?: string;
}) {
  const button = (
    <Button
      type="button"
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon" : "sm"}
      className={cn(
        iconOnly
          ? "nodrag nopan nokey size-7 shrink-0 text-muted-foreground hover:text-foreground max-sm:size-9"
          : "nodrag w-full",
        className
      )}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? SCENARIO_NODE_SETTINGS_PANEL_ID : undefined}
      aria-label={accessibleLabel ?? (iconOnly ? label : undefined)}
      // SCENARIO_NODE_SETTINGS_BUTTON_ATTRIBUTE: the panel returns focus here.
      data-scenario-node-settings={nodeId}
      data-testid={testId}
      onPointerDown={
        iconOnly
          ? (event: PointerEvent<HTMLButtonElement>) => event.stopPropagation()
          : undefined
      }
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        // Keyboard and assistive-technology activation report no pointer
        // clicks; only those move focus into the settings.
        const moveFocus = event.detail === 0;
        if (moveFocus && expanded && focusScenarioNodeSettingsPanel()) return;
        onOpen({ moveFocus });
      }}
    >
      <Settings2
        data-icon={iconOnly ? undefined : "inline-start"}
        className={iconOnly ? "size-4" : undefined}
        aria-hidden
      />
      {iconOnly ? null : label}
    </Button>
  );
  if (!iconOnly) return button;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
