import type {
  DashboardCategoryComparison,
  DashboardComparisonDateRange,
  DashboardComparisonInput,
  DashboardComparisonPeriod,
  DashboardCountComparison,
} from "@/types/dashboard";

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_CUSTOM_RANGE_DAYS = 366;

function isCustomRange(
  period: DashboardComparisonInput
): period is DashboardComparisonDateRange {
  return typeof period === "object" && period !== null;
}

function toIsoRange(start: Date, endExclusive: Date) {
  return {
    start: start.toISOString(),
    endExclusive: endExclusive.toISOString(),
  };
}

function compareCategoryNames(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getLocalDateParts(date: Date, timeZone: string): LocalDateParts {
  const values = new Intl.DateTimeFormat("en-US", {
    calendar: "iso8601",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const parts = Object.fromEntries(
    values
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: date.getUTCMilliseconds(),
  };
}

function localDateTimeToUtc(parts: LocalDateParts, timeZone: string): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  );
  let timestamp = target;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = getLocalDateParts(new Date(timestamp), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      observed.millisecond
    );
    const adjustment = target - observedAsUtc;
    if (adjustment === 0) break;
    timestamp += adjustment;
  }

  return new Date(timestamp);
}

function shiftLocalCalendarDate(
  parts: LocalDateParts,
  days: number
): LocalDateParts {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days)
  );

  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function parseCalendarDate(value: string): LocalDateParts {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) throw new Error("Invalid dashboard date range");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid dashboard date range");
  }

  return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

export function normalizeDashboardCalendarDateStart(
  value: string,
  timeZone: string
): Date {
  return localDateTimeToUtc(parseCalendarDate(value), timeZone);
}

let supportedTimeZones: ReadonlySet<string> | null = null;

function isListedTimeZone(timeZone: string): boolean {
  if (timeZone === "UTC" || /^Etc\/GMT[+-]\d{1,2}$/.test(timeZone)) {
    return true;
  }
  if (typeof Intl.supportedValuesOf !== "function") return true;
  supportedTimeZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  return supportedTimeZones.has(timeZone);
}

/**
 * The canonical IANA name of a requested time zone, or null when unknown.
 * Intl accepts any letter case ("asia/almaty") that MongoDB date operators
 * reject, and one zone has many spellings; requests are answered and cached
 * under the canonical name. Bare UTC offsets ("+05:30") and legacy ids that
 * Intl resolves but does not list ("SystemV/AST4", which MongoDB rejects) are
 * refused.
 */
export function canonicalAnalyticsTimeZone(value: string): string | null {
  const raw = value.trim();
  if (!raw || /^[+-]/.test(raw)) return null;
  try {
    const canonical = new Intl.DateTimeFormat("en", {
      timeZone: raw,
    }).resolvedOptions().timeZone;
    return isListedTimeZone(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

/** Inclusive calendar labels, with an optional lag for completed cohort windows. */
export function resolveDashboardCalendarDays(
  days: number,
  timeZone: string,
  now = new Date(),
  endOffsetDays = 0
): { from: string; to: string } {
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_CUSTOM_RANGE_DAYS ||
    !Number.isInteger(endOffsetDays) ||
    endOffsetDays < 0 ||
    endOffsetDays > 90
  )
    throw new Error("Invalid dashboard calendar interval");
  const to = shiftLocalCalendarDate(
    getLocalDateParts(now, timeZone),
    -endOffsetDays
  );
  const from = shiftLocalCalendarDate(to, -(days - 1));
  const label = (parts: LocalDateParts) =>
    `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return { from: label(from), to: label(to) };
}

export function normalizeDashboardCustomCalendarRange(
  from: string,
  to: string,
  timeZone: string
): DashboardComparisonDateRange {
  const fromParts = parseCalendarDate(from);
  const toParts = parseCalendarDate(to);
  const fromDay = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  const toDay = Date.UTC(toParts.year, toParts.month - 1, toParts.day);
  const inclusiveDays = (toDay - fromDay) / DAY_MS + 1;

  if (inclusiveDays < 1 || inclusiveDays > MAX_CUSTOM_RANGE_DAYS) {
    throw new Error("Invalid dashboard date range");
  }

  return {
    start: localDateTimeToUtc(fromParts, timeZone),
    endExclusive: localDateTimeToUtc(
      shiftLocalCalendarDate(toParts, 1),
      timeZone
    ),
  };
}

function getThisWeekStart(now: Date, timeZone: string): Date {
  const localNow = getLocalDateParts(now, timeZone);
  const localMidnight = Date.UTC(
    localNow.year,
    localNow.month - 1,
    localNow.day
  );
  const dayOfWeek = new Date(localMidnight).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(localMidnight - daysSinceMonday * DAY_MS);

  return localDateTimeToUtc(
    {
      year: monday.getUTCFullYear(),
      month: monday.getUTCMonth() + 1,
      day: monday.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    timeZone
  );
}

export function buildDashboardCountComparison(
  current: number,
  previous: number
): DashboardCountComparison {
  const delta = current - previous;
  const percentChange = previous === 0 ? null : (delta / previous) * 100;
  const kind =
    previous === 0 && current > 0
      ? "new"
      : current === 0 && previous > 0
        ? "no_longer_active"
        : delta > 0
          ? "increase"
          : delta < 0
            ? "decrease"
            : "unchanged";

  return { current, previous, delta, percentChange, kind };
}

export function buildDashboardDurationComparison(
  current: number,
  previous: number
): DashboardCountComparison {
  const comparison = buildDashboardCountComparison(current, previous);
  const kind =
    comparison.delta > 0
      ? "increase"
      : comparison.delta < 0
        ? "decrease"
        : "unchanged";

  return { ...comparison, kind };
}

export function buildDashboardCategoryComparisons(
  currentCounts: Record<string, number>,
  previousCounts: Record<string, number>
): DashboardCategoryComparison[] {
  const categories = new Set([
    ...Object.keys(currentCounts),
    ...Object.keys(previousCounts),
  ]);

  return Array.from(categories)
    .map(category => ({
      category,
      ...buildDashboardCountComparison(
        currentCounts[category] ?? 0,
        previousCounts[category] ?? 0
      ),
    }))
    .sort(
      (left, right) =>
        Math.abs(right.delta) - Math.abs(left.delta) ||
        right.current - left.current ||
        compareCategoryNames(left.category, right.category)
    );
}

export function resolveDashboardComparisonWindow(
  period: DashboardComparisonInput,
  timeZone: string,
  now = new Date()
): DashboardComparisonPeriod {
  if (period === "this_week") {
    const currentStart = getThisWeekStart(now, timeZone);
    const previousStart = localDateTimeToUtc(
      shiftLocalCalendarDate(getLocalDateParts(currentStart, timeZone), -7),
      timeZone
    );
    const previousEndExclusive = localDateTimeToUtc(
      shiftLocalCalendarDate(getLocalDateParts(now, timeZone), -7),
      timeZone
    );

    return {
      preset: "this_week",
      strategy: "previous_week_same_elapsed",
      timeZone,
      current: toIsoRange(currentStart, now),
      previous: toIsoRange(previousStart, previousEndExclusive),
    };
  }

  if (period === "all") {
    return {
      preset: "last_12_months",
      strategy: "none",
      timeZone,
      current: toIsoRange(new Date(now.getTime() - 365 * DAY_MS), now),
      previous: null,
    };
  }

  if (
    !isCustomRange(period) &&
    period !== 7 &&
    period !== 30 &&
    period !== 90
  ) {
    throw new Error("Invalid dashboard comparison period");
  }

  const currentEndExclusive = isCustomRange(period)
    ? new Date(period.endExclusive)
    : now;
  const currentStart = isCustomRange(period)
    ? new Date(period.start)
    : new Date(currentEndExclusive.getTime() - period * DAY_MS);
  const durationMs = currentEndExclusive.getTime() - currentStart.getTime();
  const previousStart = new Date(currentStart.getTime() - durationMs);

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Invalid dashboard comparison period");
  }

  return {
    preset: isCustomRange(period)
      ? "custom"
      : (`${period}d` as "7d" | "30d" | "90d"),
    strategy: "adjacent_equal_duration",
    timeZone,
    current: toIsoRange(currentStart, currentEndExclusive),
    previous: toIsoRange(previousStart, currentStart),
  };
}
