"use client";

import { Input } from "@/components/ui/input";
import { useMemo, useRef, type ComponentProps } from "react";
import { useSyncedDraftValue } from "./draft-state";

type ScenarioIntegerInputProps = Omit<
  ComponentProps<typeof Input>,
  "type" | "value" | "defaultValue" | "onChange"
> & {
  value?: number | null;
  defaultValue: number;
  onValueCommit: (value: number) => void;
};

function clampInteger(value: number, min?: number, max?: number): number {
  let nextValue = Math.trunc(value);
  if (typeof min === "number") {
    nextValue = Math.max(min, nextValue);
  }
  if (typeof max === "number") {
    nextValue = Math.min(max, nextValue);
  }
  return nextValue;
}

function normalizeOptionalNumber(
  value: string | number | undefined
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function ScenarioIntegerInput({
  value,
  defaultValue,
  min,
  max,
  onValueCommit,
  onBlur,
  onKeyDown,
  ...props
}: ScenarioIntegerInputProps) {
  const normalizedMin = normalizeOptionalNumber(min);
  const normalizedMax = normalizeOptionalNumber(max);
  const committedValue = useMemo(() => {
    const baseValue =
      typeof value === "number" && Number.isFinite(value)
        ? value
        : defaultValue;
    return clampInteger(baseValue, normalizedMin, normalizedMax);
  }, [defaultValue, normalizedMax, normalizedMin, value]);
  const [draft, setDraft] = useSyncedDraftValue(String(committedValue));
  // Enter commits, so the blur that follows must not commit the same draft.
  const committedSinceEditRef = useRef(false);

  const commitDraft = (rawValue: string) => {
    if (committedSinceEditRef.current) return;
    committedSinceEditRef.current = true;
    const parsed = normalizeOptionalNumber(rawValue);
    if (parsed === undefined) {
      setDraft(String(committedValue));
      onValueCommit(committedValue);
      return;
    }

    const nextValue = clampInteger(parsed, normalizedMin, normalizedMax);
    setDraft(String(nextValue));
    onValueCommit(nextValue);
  };

  return (
    <Input
      {...props}
      type="number"
      min={normalizedMin}
      max={normalizedMax}
      value={draft}
      onChange={event => {
        committedSinceEditRef.current = false;
        setDraft(event.target.value);
      }}
      onBlur={event => {
        commitDraft(event.target.value.trim());
        onBlur?.(event);
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter") {
          commitDraft(draft.trim());
        }
        onKeyDown?.(event);
      }}
    />
  );
}
