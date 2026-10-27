"use client";

import { Switch } from "@/components/ui/switch";
import type { ScenarioStatus } from "../../types";

export function ScenarioStatusSwitch({
  scenarioId,
  status,
  activeLabel,
  draftLabel,
  disabled,
  compact = false,
  onStatusToggle,
}: {
  scenarioId: string;
  status: ScenarioStatus;
  activeLabel: string;
  draftLabel: string;
  disabled: boolean;
  compact?: boolean;
  onStatusToggle: (scenarioId: string, checked: boolean) => void;
}) {
  return (
    <Switch
      checked={status === "active"}
      onCheckedChange={checked => onStatusToggle(scenarioId, checked)}
      disabled={disabled}
      aria-label={`${activeLabel} / ${draftLabel}`}
      title={status === "active" ? activeLabel : draftLabel}
      className={
        compact
          ? "h-4 w-7 [&_[data-slot=switch-thumb]]:size-3 [&_[data-slot=switch-thumb][data-state=checked]]:translate-x-3"
          : "scale-[0.7]"
      }
    />
  );
}
