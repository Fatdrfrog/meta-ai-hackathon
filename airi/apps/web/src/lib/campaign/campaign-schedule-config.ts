import type {
  CampaignScheduleConfig,
  CampaignScheduleOrdinal,
  CampaignScheduleRecurrence,
  CampaignScheduleWeekday,
} from "@icecore/scenario-contracts";
import {
  CAMPAIGN_SCHEDULE_CONFIG_VERSION,
  normalizeScenarioTimezone,
} from "@icecore/scenario-contracts";
import type {
  TemporalDayOfWeek as DayOfWeek,
  TemporalMonth as Month,
  TemporalScheduleSpec as ScheduleSpec,
} from "@/lib/temporal/sdk-types";
import { isRecord } from "@icecore/shared/lib/value-utils";

type LegacyCampaignScheduleFields = {
  scheduleType?: unknown;
  day?: unknown;
  time?: unknown;
  delayDays?: unknown;
};

type NormalizeCampaignScheduleConfigParams = {
  config?: unknown;
  timezone?: unknown;
  legacy?: LegacyCampaignScheduleFields;
};

const WEEKDAY_TO_TEMPORAL: Record<CampaignScheduleWeekday, DayOfWeek> = {
  sunday: "SUNDAY",
  monday: "MONDAY",
  tuesday: "TUESDAY",
  wednesday: "WEDNESDAY",
  thursday: "THURSDAY",
  friday: "FRIDAY",
  saturday: "SATURDAY",
};

const WEEKDAYS = Object.keys(WEEKDAY_TO_TEMPORAL) as CampaignScheduleWeekday[];
const MONTHS: Month[] = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
];

const ORDINAL_LABELS: Record<CampaignScheduleOrdinal, string> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  "-1": "last",
};

export function normalizeCampaignTimezone(value: unknown): string {
  return normalizeScenarioTimezone(value);
}

function normalizeTimezone(value: unknown): string {
  return normalizeCampaignTimezone(value);
}

function normalizeTime(value: unknown, fallback = "09:00"): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (!match) return fallback;

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTime(value: string): { hour: number; minute: number } {
  const normalized = normalizeTime(value);
  const [hour, minute] = normalized.split(":").map(part => Number(part));
  return { hour, minute };
}

function normalizeWeekday(value: unknown): CampaignScheduleWeekday {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return WEEKDAYS.includes(normalized as CampaignScheduleWeekday)
    ? (normalized as CampaignScheduleWeekday)
    : "monday";
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeRecurrence(
  value: unknown
): CampaignScheduleRecurrence | null {
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";

  if (kind === "interval") {
    const rawUnit = typeof value.unit === "string" ? value.unit.trim() : "";
    const unit =
      rawUnit === "minutes" || rawUnit === "hours" || rawUnit === "days"
        ? rawUnit
        : "hours";
    return {
      kind: "interval",
      every: normalizePositiveInteger(value.every, 24, 1, 365),
      unit,
    };
  }

  if (kind === "daily") {
    return {
      kind: "daily",
      time: normalizeTime(value.time),
    };
  }

  if (kind === "weekly") {
    const weekdays = Array.isArray(value.weekdays)
      ? value.weekdays.map(normalizeWeekday)
      : [normalizeWeekday(value.weekday)];
    const uniqueWeekdays = Array.from(new Set(weekdays));
    return {
      kind: "weekly",
      weekdays: uniqueWeekdays.length > 0 ? uniqueWeekdays : ["monday"],
      time: normalizeTime(value.time),
    };
  }

  if (kind === "monthly_day") {
    return {
      kind: "monthly_day",
      dayOfMonth: normalizePositiveInteger(value.dayOfMonth, 1, 1, 31),
      time: normalizeTime(value.time),
    };
  }

  if (kind === "monthly_weekday") {
    const ordinal = [1, 2, 3, 4, -1].includes(Number(value.ordinal))
      ? (Number(value.ordinal) as CampaignScheduleOrdinal)
      : 1;
    return {
      kind: "monthly_weekday",
      ordinal,
      weekday: normalizeWeekday(value.weekday),
      time: normalizeTime(value.time),
    };
  }

  return null;
}

/** Strict v2 parse: null for a missing or legacy config, never a fallback. */
export function parseCampaignScheduleConfigV2(
  config: unknown,
  fallbackTimezone: unknown
): CampaignScheduleConfig | null {
  if (
    !isRecord(config) ||
    config.version !== CAMPAIGN_SCHEDULE_CONFIG_VERSION
  ) {
    return null;
  }

  const timezone = normalizeTimezone(config.timezone || fallbackTimezone);
  const startAt = normalizeIsoDate(config.startAt);
  const endAt = normalizeIsoDate(config.endAt);
  const common = {
    version: CAMPAIGN_SCHEDULE_CONFIG_VERSION,
    timezone,
    ...(startAt ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
  };

  if (config.mode === "once") {
    return {
      ...common,
      mode: "once",
    };
  }

  const recurrence = normalizeRecurrence(config.recurrence);
  if (!recurrence) return null;
  return {
    ...common,
    mode: "recurring",
    recurrence,
  };
}

function normalizeLegacySchedule(
  legacy: LegacyCampaignScheduleFields | undefined,
  timezone: string
): CampaignScheduleConfig {
  const scheduleType =
    typeof legacy?.scheduleType === "string"
      ? legacy.scheduleType.trim().toLowerCase()
      : "";

  if (scheduleType === "relative") {
    return {
      version: CAMPAIGN_SCHEDULE_CONFIG_VERSION,
      mode: "recurring",
      timezone,
      recurrence: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    };
  }

  return {
    version: CAMPAIGN_SCHEDULE_CONFIG_VERSION,
    mode: "recurring",
    timezone,
    recurrence: {
      kind: "weekly",
      weekdays: [normalizeWeekday(legacy?.day)],
      time: normalizeTime(legacy?.time),
    },
  };
}

export function normalizeCampaignScheduleConfig(
  params: NormalizeCampaignScheduleConfigParams
): CampaignScheduleConfig {
  const timezone = normalizeTimezone(params.timezone);
  return (
    parseCampaignScheduleConfigV2(params.config, timezone) ||
    normalizeLegacySchedule(params.legacy, timezone)
  );
}

function withDateBounds(
  spec: Omit<ScheduleSpec, "startAt" | "endAt">,
  config: CampaignScheduleConfig
): ScheduleSpec {
  const startAt = normalizeIsoDate(config.startAt);
  const endAt = normalizeIsoDate(config.endAt);
  return {
    ...spec,
    ...(startAt ? { startAt: new Date(startAt) } : {}),
    ...(endAt ? { endAt: new Date(endAt) } : {}),
  };
}

function durationForInterval(
  recurrence: Extract<CampaignScheduleRecurrence, { kind: "interval" }>
): number {
  const multiplier =
    recurrence.unit === "days"
      ? 24 * 60 * 60 * 1000
      : recurrence.unit === "minutes"
        ? 60 * 1000
        : 60 * 60 * 1000;
  return Math.max(1, Math.trunc(recurrence.every)) * multiplier;
}

function compileRecurringSpec(
  config: Extract<CampaignScheduleConfig, { mode: "recurring" }>
): ScheduleSpec {
  const recurrence = config.recurrence;

  if (recurrence.kind === "interval") {
    return withDateBounds(
      {
        intervals: [{ every: durationForInterval(recurrence) }],
        timezone: config.timezone,
      },
      config
    );
  }

  const { hour, minute } = parseTime(recurrence.time);
  const atTime = { hour, minute, second: 0 };

  if (recurrence.kind === "daily") {
    return withDateBounds(
      {
        calendars: [atTime],
        timezone: config.timezone,
      },
      config
    );
  }

  if (recurrence.kind === "weekly") {
    return withDateBounds(
      {
        calendars: [
          {
            ...atTime,
            dayOfWeek: recurrence.weekdays.map(
              weekday => WEEKDAY_TO_TEMPORAL[weekday]
            ),
          },
        ],
        timezone: config.timezone,
      },
      config
    );
  }

  if (recurrence.kind === "monthly_day") {
    return withDateBounds(
      {
        calendars: [
          {
            ...atTime,
            dayOfMonth: recurrence.dayOfMonth,
          },
        ],
        timezone: config.timezone,
      },
      config
    );
  }

  const ordinalStart =
    recurrence.ordinal === -1 ? 22 : (recurrence.ordinal - 1) * 7 + 1;
  const ordinalEnd = recurrence.ordinal === -1 ? 31 : recurrence.ordinal * 7;
  return withDateBounds(
    {
      calendars: [
        {
          ...atTime,
          dayOfMonth: { start: ordinalStart, end: ordinalEnd },
          dayOfWeek: WEEKDAY_TO_TEMPORAL[recurrence.weekday],
        },
      ],
      timezone: config.timezone,
    },
    config
  );
}

function compileOnceSpec(
  config: Extract<CampaignScheduleConfig, { mode: "once" }>
): ScheduleSpec {
  const startAt = normalizeIsoDate(config.startAt);
  if (!startAt) {
    throw new Error("One-time campaign schedules require startAt");
  }
  const date = new Date(startAt);
  return {
    calendars: [
      {
        year: date.getUTCFullYear(),
        month: MONTHS[date.getUTCMonth()] || "JANUARY",
        dayOfMonth: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
      },
    ],
    startAt: date,
    endAt: new Date(date.getTime() + 1_000),
    timezone: "UTC",
  };
}

export function compileCampaignScheduleSpec(
  config: CampaignScheduleConfig
): ScheduleSpec {
  return config.mode === "once"
    ? compileOnceSpec(config)
    : compileRecurringSpec(config);
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function joinWeekdays(weekdays: CampaignScheduleWeekday[]): string {
  return weekdays.map(titleCase).join(", ");
}

export function buildCampaignScheduleSummary(
  config: CampaignScheduleConfig
): string {
  if (config.mode === "once") {
    return config.startAt
      ? `Once at ${config.startAt} (${config.timezone})`
      : `Once (${config.timezone})`;
  }

  const recurrence = config.recurrence;
  if (recurrence.kind === "interval") {
    const unit =
      recurrence.every === 1 ? recurrence.unit.slice(0, -1) : recurrence.unit;
    return `Every ${recurrence.every} ${unit} (${config.timezone})`;
  }

  if (recurrence.kind === "daily") {
    return `Every day at ${recurrence.time} (${config.timezone})`;
  }

  if (recurrence.kind === "weekly") {
    return `Every ${joinWeekdays(recurrence.weekdays)} at ${recurrence.time} (${config.timezone})`;
  }

  if (recurrence.kind === "monthly_day") {
    return `Every month on day ${recurrence.dayOfMonth} at ${recurrence.time} (${config.timezone})`;
  }

  return `Every ${ORDINAL_LABELS[recurrence.ordinal]} ${titleCase(
    recurrence.weekday
  )} at ${recurrence.time} (${config.timezone})`;
}
