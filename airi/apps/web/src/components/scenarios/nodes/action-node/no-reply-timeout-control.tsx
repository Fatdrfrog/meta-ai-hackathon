"use client";

import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { MAX_SCENARIO_ACTION_NO_REPLY_MINUTES } from "@icecore/scenario-contracts";
import { useState, type SyntheticEvent } from "react";
import { cn } from "@/lib/utils";
import { useSyncedDraftValue } from "../draft-state";
import { ScenarioIntegerInput } from "../integer-input";
import type { TranslateFn } from "../../types";
import {
  combineTimeoutMinutes,
  isNoReplyTimeoutUnit,
  maxAmountForUnit,
  NO_REPLY_TIMEOUT_UNIT_MESSAGE_KEY,
  NO_REPLY_TIMEOUT_UNITS,
  splitTimeoutMinutes,
  type NoReplyTimeoutUnit,
} from "./no-reply-timeout";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

export function NoReplyTimeoutControl({
  minutes,
  disabled = false,
  t,
  onCommit,
  className,
}: {
  minutes: number;
  disabled?: boolean;
  t: TranslateFn;
  onCommit: (minutes: number) => void;
  className?: string;
}) {
  const [draftMinutes, setDraftMinutes] = useSyncedDraftValue(minutes);
  // A chosen unit only describes the value it produced; other values (undo,
  // conversion adoption) are shown in their exact unit.
  const [preferred, setPreferred] = useState<{
    minutes: number;
    unit: NoReplyTimeoutUnit;
  } | null>(null);
  const { amount, unit } = splitTimeoutMinutes(
    draftMinutes,
    preferred?.minutes === draftMinutes ? preferred.unit : undefined
  );
  const commit = (nextAmount: number, nextUnit: NoReplyTimeoutUnit = unit) => {
    const nextMinutes = combineTimeoutMinutes(
      nextAmount,
      nextUnit,
      MAX_SCENARIO_ACTION_NO_REPLY_MINUTES
    );
    setPreferred({ minutes: nextMinutes, unit: nextUnit });
    setDraftMinutes(nextMinutes);
    // A blur without edits must not patch: on legacy nodes it starts a conversion.
    if (nextMinutes !== minutes || nextMinutes !== draftMinutes) {
      onCommit(nextMinutes);
    }
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <ScenarioIntegerInput
        key={unit}
        aria-label={t("noReplyTimeoutAmount")}
        disabled={disabled}
        min={1}
        max={maxAmountForUnit(unit, MAX_SCENARIO_ACTION_NO_REPLY_MINUTES)}
        value={amount}
        defaultValue={amount}
        onValueCommit={nextAmount => commit(nextAmount)}
        className="nowheel nodrag nopan nokey h-8 w-14 px-1.5 text-[11px]"
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      />
      <div className="w-[5.25rem] shrink-0">
        <NativeSelect
          size="sm"
          aria-label={t("noReplyTimeoutUnit")}
          className="nowheel nodrag nopan nokey h-8 bg-background pl-2 pr-8 text-[11px] shadow-none"
          disabled={disabled}
          value={unit}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
          onChange={event => {
            const nextUnit = event.target.value;
            if (isNoReplyTimeoutUnit(nextUnit)) commit(amount, nextUnit);
          }}
        >
          {NO_REPLY_TIMEOUT_UNITS.map(item => (
            <NativeSelectOption key={item} value={item}>
              {t(NO_REPLY_TIMEOUT_UNIT_MESSAGE_KEY[item])}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
