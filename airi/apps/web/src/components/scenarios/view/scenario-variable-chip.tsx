"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { SCENARIO_VARIABLE_CHIP_CLASSNAME } from "./scenario-template-utils";

export { SCENARIO_VARIABLE_CHIP_CLASSNAME };

type ScenarioVariableChipRemoveProps =
  | {
      onRemove: () => void;
      /** Accessible name of the X, e.g. t("variableRemove", { label }). */
      removeLabel: string;
    }
  | { onRemove?: undefined; removeLabel?: undefined };

export function ScenarioVariableChip({
  label,
  onRemove,
  removeLabel,
  className,
}: {
  label: string;
  className?: string;
} & ScenarioVariableChipRemoveProps) {
  return (
    <span
      className={cn(SCENARIO_VARIABLE_CHIP_CLASSNAME, className)}
      contentEditable={false}
    >
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          className="nodrag inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-rose-800/80 transition-colors hover:bg-rose-200/80 hover:text-rose-950 dark:text-rose-100/80 dark:hover:bg-rose-900/80"
          aria-label={removeLabel}
          onMouseDown={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
