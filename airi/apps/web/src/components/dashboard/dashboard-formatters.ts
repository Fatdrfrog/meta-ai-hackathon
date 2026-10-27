import type { Month } from "date-fns";
import { kk } from "date-fns/locale/kk";

const MISSING_VALUE = "—";

interface DashboardTimeRangeValue {
  start: string;
  endExclusive: string;
}

interface DashboardDateRangeFormatterSet {
  date: Intl.DateTimeFormat;
  dateTime: Intl.DateTimeFormat;
  boundaryTime: Intl.DateTimeFormat;
}

interface KazakhCalendarParts {
  year: string;
  month: number;
  day: string;
  hour?: string;
  minute?: string;
}

function formatKazakhDate(
  formatter: Intl.DateTimeFormat,
  date: Date,
  parts: KazakhCalendarParts,
  includeYear: boolean,
  includeTime = false
): string {
  const month = kk.localize.month((parts.month - 1) as Month, {
    width: "abbreviated",
  });
  const nativeMonth = formatter
    .formatToParts(date)
    .find(part => part.type === "month")?.value;
  if (nativeMonth?.replace(/\.$/, "") === month) return formatter.format(date);

  // Some browsers omit Kazakh CLDR data, returning English or generic M09
  // months despite kk-KZ. Reuse the installed locale only for that presentation.
  // Numeric timezone parts must stay separate from a host-local Date: rebuilding
  // one can normalize a target-zone time through an unrelated local DST gap.
  const label = `${includeYear ? `${parts.year} ж. ` : ""}${Number(parts.day)} ${month}.`;
  return includeTime
    ? `${label}, ${Number(parts.hour)}:${parts.minute}`
    : label;
}

export interface DashboardFormatters {
  number: (value: number | null | undefined) => string;
  integer: (value: number | null | undefined) => string;
  signedInteger: (value: number | null | undefined) => string;
  percent: (
    value: number | null | undefined,
    maximumFractionDigits?: number
  ) => string;
  signedPercent: (
    value: number | null | undefined,
    maximumFractionDigits?: number
  ) => string;
  currency: (
    value: number | null | undefined,
    currency?: string | null
  ) => string;
  shortDate: (value?: string | Date | null) => string;
  dateRange: (range: DashboardTimeRangeValue, timeZone: string) => string;
}

const dashboardFormattersByLocale = new Map<string, DashboardFormatters>();

export function normalizeDashboardIntlLocale(locale: string): string {
  return locale === "kz" ? "kk-KZ" : locale;
}

function parseDashboardDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createDashboardFormatters(locale: string): DashboardFormatters {
  const intlLocale = normalizeDashboardIntlLocale(locale);
  const cached = dashboardFormattersByLocale.get(intlLocale);
  if (cached) return cached;
  const isKazakh = intlLocale.split("-")[0] === "kk";

  const numberFormatter = new Intl.NumberFormat(intlLocale, {
    maximumFractionDigits: 1,
  });
  const integerFormatter = new Intl.NumberFormat(intlLocale, {
    maximumFractionDigits: 0,
  });
  const signedIntegerFormatter = new Intl.NumberFormat(intlLocale, {
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  });
  const shortDateFormatter = new Intl.DateTimeFormat(intlLocale, {
    month: "short",
    day: "numeric",
  });
  const percentFormatters = new Map<number, Intl.NumberFormat>();
  const signedPercentFormatters = new Map<number, Intl.NumberFormat>();
  const currencyFormatters = new Map<string, Intl.NumberFormat>();
  const decimalFormatters = new Map<number, Intl.NumberFormat>();
  const dateRangeFormatters = new Map<
    string,
    DashboardDateRangeFormatterSet | null
  >();

  const formatters: DashboardFormatters = {
    number(value) {
      return value === null || value === undefined || !Number.isFinite(value)
        ? MISSING_VALUE
        : numberFormatter.format(value);
    },
    integer(value) {
      return value === null || value === undefined || !Number.isFinite(value)
        ? MISSING_VALUE
        : integerFormatter.format(value);
    },
    signedInteger(value) {
      return value === null || value === undefined || !Number.isFinite(value)
        ? MISSING_VALUE
        : signedIntegerFormatter.format(value);
    },
    percent(value, maximumFractionDigits = 0) {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        return MISSING_VALUE;
      }

      let formatter = percentFormatters.get(maximumFractionDigits);
      if (!formatter) {
        formatter = new Intl.NumberFormat(intlLocale, {
          style: "percent",
          maximumFractionDigits,
        });
        percentFormatters.set(maximumFractionDigits, formatter);
      }
      return formatter.format(value / 100);
    },
    signedPercent(value, maximumFractionDigits = 0) {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        return MISSING_VALUE;
      }

      let formatter = signedPercentFormatters.get(maximumFractionDigits);
      if (!formatter) {
        formatter = new Intl.NumberFormat(intlLocale, {
          style: "percent",
          maximumFractionDigits,
          signDisplay: "exceptZero",
        });
        signedPercentFormatters.set(maximumFractionDigits, formatter);
      }
      return formatter.format(value / 100);
    },
    currency(value, currency) {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        return MISSING_VALUE;
      }

      const fractionDigits = Math.abs(value) < 10 ? 2 : 0;
      if (currency && /^[A-Z]{3}$/.test(currency)) {
        const key = `${currency}:${fractionDigits}`;
        let formatter = currencyFormatters.get(key);
        if (!formatter) {
          formatter = new Intl.NumberFormat(intlLocale, {
            style: "currency",
            currency,
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
          });
          currencyFormatters.set(key, formatter);
        }
        return formatter.format(value);
      }

      let formatter = decimalFormatters.get(fractionDigits);
      if (!formatter) {
        formatter = new Intl.NumberFormat(intlLocale, {
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        });
        decimalFormatters.set(fractionDigits, formatter);
      }
      const formatted = formatter.format(value);
      return currency ? `${formatted} ${currency}` : formatted;
    },
    shortDate(value) {
      const date = parseDashboardDate(value);
      if (!date) return MISSING_VALUE;
      return isKazakh
        ? formatKazakhDate(
            shortDateFormatter,
            date,
            {
              year: String(date.getFullYear()),
              month: date.getMonth() + 1,
              day: String(date.getDate()),
            },
            false
          )
        : shortDateFormatter.format(date);
    },
    dateRange(range, timeZone) {
      const start = parseDashboardDate(range.start);
      const endExclusive = parseDashboardDate(range.endExclusive);
      if (!start || !endExclusive || endExclusive <= start) {
        return MISSING_VALUE;
      }

      let formatterSet = dateRangeFormatters.get(timeZone);
      if (formatterSet === undefined) {
        try {
          formatterSet = {
            date: new Intl.DateTimeFormat(intlLocale, {
              year: "numeric",
              month: "short",
              day: "numeric",
              timeZone,
            }),
            dateTime: new Intl.DateTimeFormat(intlLocale, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZone,
            }),
            boundaryTime: new Intl.DateTimeFormat("en-GB", {
              ...(isKazakh
                ? { year: "numeric", month: "numeric", day: "numeric" }
                : {}),
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hourCycle: "h23",
              timeZone,
            }),
          };
        } catch {
          dateRangeFormatters.set(timeZone, null);
          return MISSING_VALUE;
        }
        dateRangeFormatters.set(timeZone, formatterSet);
      }
      if (formatterSet === null) return MISSING_VALUE;

      const isLocalMidnight = (date: Date) => {
        if (date.getUTCMilliseconds() !== 0) return false;
        const parts = formatterSet.boundaryTime.formatToParts(date);
        const values = Object.fromEntries(
          parts.map(part => [part.type, part.value])
        );
        return (
          values.hour === "00" &&
          values.minute === "00" &&
          values.second === "00"
        );
      };

      const formatDate = (date: Date, includeTime = false) => {
        const formatter = includeTime
          ? formatterSet.dateTime
          : formatterSet.date;
        if (!isKazakh) return formatter.format(date);
        const values = Object.fromEntries(
          formatterSet.boundaryTime
            .formatToParts(date)
            .map(part => [part.type, part.value])
        );
        return formatKazakhDate(
          formatter,
          date,
          {
            year: values.year,
            month: Number(values.month),
            day: values.day,
            hour: values.hour,
            minute: values.minute,
          },
          true,
          includeTime
        );
      };

      if (!isLocalMidnight(start) || !isLocalMidnight(endExclusive)) {
        return `${formatDate(start, true)} – ${formatDate(endExclusive, true)}`;
      }

      return `${formatDate(start)} – ${formatDate(
        new Date(endExclusive.getTime() - 1)
      )}`;
    },
  };
  dashboardFormattersByLocale.set(intlLocale, formatters);
  return formatters;
}
