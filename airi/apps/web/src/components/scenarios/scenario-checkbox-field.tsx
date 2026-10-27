"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useId } from "react";
import { ScenarioInfoHint } from "./scenario-info-hint";

/**
 * A checkbox with its label and an optional hint that describes it. With
 * `hintMode="info"` the hint sits behind an info button next to the label.
 */
export function ScenarioCheckboxField({
  label,
  hint,
  hintMode = "text",
  hintLabel,
  checked,
  onCheckedChange,
  labelClassName = "text-xs leading-5",
}: {
  label: string;
  hint?: string;
  hintMode?: "text" | "info";
  /** Names the info button, e.g. t("infoHintLabel", { topic: label }). */
  hintLabel?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  labelClassName?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-0.5">
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={checked}
          aria-describedby={hint ? hintId : undefined}
          onCheckedChange={next => onCheckedChange(next === true)}
          className="nodrag nopan nokey mt-0.5"
        />
        <label htmlFor={id} className={labelClassName}>
          {label}
        </label>
        {hint && hintMode === "info" ? (
          <ScenarioInfoHint
            label={hintLabel ?? label}
            describedById={hintId}
            className="-my-0.5"
          >
            {hint}
          </ScenarioInfoHint>
        ) : null}
      </div>
      {hint && hintMode === "text" ? (
        <p
          id={hintId}
          className="pl-6 text-[10px] leading-snug text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
