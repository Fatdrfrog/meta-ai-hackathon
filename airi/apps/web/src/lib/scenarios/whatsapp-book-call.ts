import type { CalendarAvailabilityWindow } from "@/lib/google-calendar/availability-context";
import type {
  ScenarioWhatsAppBookCallDateRangeMode,
  ScenarioWhatsAppBookCallConfig,
  ScenarioWhatsAppSessionChoice,
} from "@icecore/scenario-contracts";
import { buildWhatsAppBookCallPayload } from "@icecore/scenario-contracts";

const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_MAX_SLOTS = 5;
const MAX_SLOTS = 10;
type PresetDateRangeMode = Exclude<
  ScenarioWhatsAppBookCallDateRangeMode,
  "custom_days"
>;
const DEFAULT_DATE_RANGE_MODE: PresetDateRangeMode = "next_7_days";
const MAX_HORIZON_DAYS = 30;
const MINUTE_MS = 60 * 1000;

const DATE_RANGE_DAYS_BY_MODE: Record<PresetDateRangeMode, number> = {
  today: 1,
  tomorrow: 1,
  next_3_days: 3,
  next_7_days: 7,
};

export type WhatsAppBookCallDateRange = {
  rangeStart: Date;
  rangeEnd: Date;
};

function cleanTimeZone(value: unknown): string {
  const timeZone =
    typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "UTC";
  }
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function clampPositiveInteger(params: {
  value: unknown;
  fallback: number;
  min?: number;
  max?: number;
}): number {
  const min = params.min ?? 1;
  const max = params.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(
    max,
    Math.max(min, parsePositiveInteger(params.value, params.fallback))
  );
}

function isDateRangeMode(
  value: unknown
): value is ScenarioWhatsAppBookCallDateRangeMode {
  return (
    value === "today" ||
    value === "tomorrow" ||
    value === "next_3_days" ||
    value === "next_7_days" ||
    value === "custom_days"
  );
}

function resolveDateRangeMode(
  raw: Record<string, unknown>
): ScenarioWhatsAppBookCallDateRangeMode {
  if (isDateRangeMode(raw.dateRangeMode)) return raw.dateRangeMode;
  if (raw.horizonDays !== undefined) {
    const horizonDays = clampPositiveInteger({
      value: raw.horizonDays,
      fallback: DATE_RANGE_DAYS_BY_MODE[DEFAULT_DATE_RANGE_MODE],
      max: MAX_HORIZON_DAYS,
    });
    if (horizonDays !== DATE_RANGE_DAYS_BY_MODE[DEFAULT_DATE_RANGE_MODE]) {
      return "custom_days";
    }
  }
  return DEFAULT_DATE_RANGE_MODE;
}

export function normalizeWhatsAppBookCallConfig(
  value: unknown
): ScenarioWhatsAppBookCallConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.enabled === false) return undefined;

  const eventTitle =
    typeof raw.eventTitle === "string" && raw.eventTitle.trim()
      ? raw.eventTitle.trim().slice(0, 120)
      : "Call";
  const dateRangeMode = resolveDateRangeMode(raw);
  const horizonDays =
    dateRangeMode === "custom_days"
      ? clampPositiveInteger({
          value: raw.horizonDays,
          fallback: DATE_RANGE_DAYS_BY_MODE[DEFAULT_DATE_RANGE_MODE],
          max: MAX_HORIZON_DAYS,
        })
      : DATE_RANGE_DAYS_BY_MODE[dateRangeMode];

  return {
    enabled: true,
    dateRangeMode,
    durationMinutes: parsePositiveInteger(
      raw.durationMinutes,
      DEFAULT_DURATION_MINUTES
    ),
    minNoticeMinutes: parsePositiveInteger(raw.minNoticeMinutes, 120),
    horizonDays,
    maxSlots: clampPositiveInteger({
      value: raw.maxSlots,
      fallback: DEFAULT_MAX_SLOTS,
      max: MAX_SLOTS,
    }),
    timeZone: cleanTimeZone(raw.timeZone),
    eventTitle,
    createMeetLink: raw.createMeetLink !== false,
  };
}

function getZonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return {
    year: Number(parts.find(part => part.type === "year")?.value),
    month: Number(parts.find(part => part.type === "month")?.value),
    day: Number(parts.find(part => part.type === "day")?.value),
  };
}

function addDaysToDateParts(
  parts: ReturnType<typeof getZonedDateParts>,
  days: number
) {
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days)
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: string) =>
    Number(parts.find(part => part.type === type)?.value);
  const asUtcMs = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second")
  );
  return asUtcMs - date.getTime();
}

function zonedStartOfDayUtc(
  parts: ReturnType<typeof getZonedDateParts>,
  timeZone: string
): Date {
  const utcGuessMs = Date.UTC(parts.year, parts.month - 1, parts.day);
  const firstPass = new Date(
    utcGuessMs - getTimeZoneOffsetMs(new Date(utcGuessMs), timeZone)
  );
  return new Date(utcGuessMs - getTimeZoneOffsetMs(firstPass, timeZone));
}

function getZonedDayStart(
  date: Date,
  timeZone: string,
  offsetDays: number
): Date {
  const todayParts = getZonedDateParts(date, timeZone);
  return zonedStartOfDayUtc(
    addDaysToDateParts(todayParts, offsetDays),
    timeZone
  );
}

export function buildWhatsAppBookCallDateRange(params: {
  config: ScenarioWhatsAppBookCallConfig;
  now?: Date;
}): WhatsAppBookCallDateRange | null {
  const config = normalizeWhatsAppBookCallConfig(params.config);
  if (!config) return null;
  const now =
    params.now && Number.isFinite(params.now.getTime())
      ? params.now
      : new Date();
  const timeZone = cleanTimeZone(config.timeZone);
  const todayStart = getZonedDayStart(now, timeZone, 0);
  const noticeStart = new Date(
    now.getTime() + (config.minNoticeMinutes ?? 120) * MINUTE_MS
  );
  const mode = config.dateRangeMode ?? DEFAULT_DATE_RANGE_MODE;
  const startBoundary =
    mode === "tomorrow" ? getZonedDayStart(now, timeZone, 1) : todayStart;
  const endBoundary =
    mode === "today"
      ? getZonedDayStart(now, timeZone, 1)
      : mode === "tomorrow"
        ? getZonedDayStart(now, timeZone, 2)
        : getZonedDayStart(
            now,
            timeZone,
            mode === "custom_days"
              ? (config.horizonDays ?? DATE_RANGE_DAYS_BY_MODE.next_7_days)
              : DATE_RANGE_DAYS_BY_MODE[mode]
          );
  const rangeStart = new Date(
    Math.max(startBoundary.getTime(), noticeStart.getTime())
  );
  if (endBoundary.getTime() <= rangeStart.getTime()) return null;
  return {
    rangeStart,
    rangeEnd: endBoundary,
  };
}

function formatSlotText(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const month = parts.find(part => part.type === "month")?.value || "";
  const day = parts.find(part => part.type === "day")?.value || "";
  const hour = parts.find(part => part.type === "hour")?.value || "00";
  const minute = parts.find(part => part.type === "minute")?.value || "00";
  return `${month} ${day} ${hour}:${minute}`.trim().slice(0, 20);
}

function formatSlotDescription(
  start: Date,
  end: Date,
  timeZone: string
): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const startText = formatter.format(start);
  const endText = formatter.format(end);
  const zone = startText.split(" ").slice(1).join(" ");
  const startTime = startText.split(" ")[0] || "";
  const endTime = endText.split(" ")[0] || "";
  return `${startTime}-${endTime}${zone ? ` ${zone}` : ""}`.slice(0, 72);
}

export function buildWhatsAppBookCallChoices(params: {
  actionNodeId: string;
  windows: CalendarAvailabilityWindow[];
  timeZone?: string;
  durationMinutes?: number;
  maxSlots?: number;
}): ScenarioWhatsAppSessionChoice[] {
  const actionNodeId = params.actionNodeId.trim();
  if (!actionNodeId) return [];

  const timeZone = cleanTimeZone(params.timeZone);
  const durationMs =
    parsePositiveInteger(params.durationMinutes, DEFAULT_DURATION_MINUTES) *
    MINUTE_MS;
  const maxSlots = Math.max(
    1,
    Math.min(
      MAX_SLOTS,
      parsePositiveInteger(params.maxSlots, DEFAULT_MAX_SLOTS)
    )
  );
  const choices: ScenarioWhatsAppSessionChoice[] = [];

  for (const window of params.windows) {
    const windowStart = new Date(window.start).getTime();
    const windowEnd = new Date(window.end).getTime();
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) continue;

    for (
      let startMs = windowStart;
      choices.length < maxSlots && startMs + durationMs <= windowEnd;
      startMs += durationMs
    ) {
      const endMs = startMs + durationMs;
      const start = new Date(startMs);
      const end = new Date(endMs);
      choices.push({
        id: `slot-${choices.length}`,
        text: formatSlotText(start, timeZone),
        payload: buildWhatsAppBookCallPayload({
          actionNodeId,
          startMs,
          endMs,
        }),
        description: formatSlotDescription(start, end, timeZone),
      });
    }

    if (choices.length >= maxSlots) break;
  }

  return choices;
}
