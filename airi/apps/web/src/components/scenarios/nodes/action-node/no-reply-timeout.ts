import type { TranslateFn } from "../../types";

export type NoReplyTimeoutUnit = "minutes" | "hours" | "days";

export const NO_REPLY_TIMEOUT_UNITS: readonly NoReplyTimeoutUnit[] = [
  "minutes",
  "hours",
  "days",
] as const;

export const NO_REPLY_TIMEOUT_UNIT_MESSAGE_KEY: Record<
  NoReplyTimeoutUnit,
  | "noReplyTimeoutUnitMinutes"
  | "noReplyTimeoutUnitHours"
  | "noReplyTimeoutUnitDays"
> = {
  minutes: "noReplyTimeoutUnitMinutes",
  hours: "noReplyTimeoutUnitHours",
  days: "noReplyTimeoutUnitDays",
};

const UNIT_MINUTES: Record<NoReplyTimeoutUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

export function splitTimeoutMinutes(
  minutes: number,
  preferredUnit?: NoReplyTimeoutUnit
): {
  amount: number;
  unit: NoReplyTimeoutUnit;
} {
  const value = Math.max(1, Math.trunc(minutes));
  if (preferredUnit && value % UNIT_MINUTES[preferredUnit] === 0) {
    return { amount: value / UNIT_MINUTES[preferredUnit], unit: preferredUnit };
  }
  if (value % UNIT_MINUTES.days === 0) {
    return { amount: value / UNIT_MINUTES.days, unit: "days" };
  }
  if (value % UNIT_MINUTES.hours === 0) {
    return { amount: value / UNIT_MINUTES.hours, unit: "hours" };
  }
  return { amount: value, unit: "minutes" };
}

/** A quiet period in its largest whole unit, as "30 min", "2 h" or "3 days". */
export function formatNoReplyDuration(minutes: number, t: TranslateFn): string {
  const { amount, unit } = splitTimeoutMinutes(minutes);
  return t("noReplyDuration", { unit, count: amount });
}

export function combineTimeoutMinutes(
  amount: number,
  unit: NoReplyTimeoutUnit,
  maxMinutes: number
): number {
  const factor = UNIT_MINUTES[unit];
  const next = Math.trunc(amount) * factor;
  if (!Number.isFinite(next)) return 1;
  return Math.min(maxMinutes, Math.max(1, next));
}

export function maxAmountForUnit(
  unit: NoReplyTimeoutUnit,
  maxMinutes: number
): number {
  return Math.max(1, Math.floor(maxMinutes / UNIT_MINUTES[unit]));
}

export function isNoReplyTimeoutUnit(
  value: string
): value is NoReplyTimeoutUnit {
  return Object.hasOwn(UNIT_MINUTES, value);
}
