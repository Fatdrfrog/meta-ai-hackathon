export const CUSTOMER_BIRTHDAY_SOURCE_VALUES = [
  "manual",
  "csv",
  "whatsapp_contact",
  "api",
] as const;

export type CustomerBirthdaySource =
  (typeof CUSTOMER_BIRTHDAY_SOURCE_VALUES)[number];

export type NormalizedCustomerBirthday = {
  month: number;
  day: number;
  year?: number | null;
  raw?: string | null;
  source: CustomerBirthdaySource;
  updatedAt: Date;
};

export type CustomerBirthdayParseResult =
  | {
      ok: true;
      birthday: Omit<NormalizedCustomerBirthday, "source" | "updatedAt">;
    }
  | {
      ok: false;
      reason: "empty" | "unsupported_format" | "invalid_date";
    };

const BIRTHDAY_FIELD_ALIASES = new Set([
  "birthday",
  "birth_date",
  "date_of_birth",
  "dob",
  "day_of_birth",
  "birthdate",
  "birth_day",
  "день_рождения",
  "дата_рождения",
  "туған_күн",
  "туган_кун",
  "tugan_kun",
  "tugilgan_kun",
]);

function normalizeFieldName(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[.\-]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isCustomerBirthdayFieldName(value: unknown): boolean {
  return BIRTHDAY_FIELD_ALIASES.has(normalizeFieldName(value));
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isValidBirthdayMonthDay(params: {
  month: number;
  day: number;
  year?: number | null;
}): boolean {
  if (
    !Number.isInteger(params.month) ||
    params.month < 1 ||
    params.month > 12
  ) {
    return false;
  }
  if (!Number.isInteger(params.day) || params.day < 1) {
    return false;
  }

  const daysInMonth = [
    31,
    params.year ? (isLeapYear(params.year) ? 29 : 28) : 29,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][params.month - 1];

  return params.day <= daysInMonth;
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

function buildResult(params: {
  raw: string;
  year?: number | null;
  month: number;
  day: number;
}): CustomerBirthdayParseResult {
  const year =
    typeof params.year === "number" && Number.isFinite(params.year)
      ? params.year
      : null;

  if (
    year !== null &&
    (!Number.isInteger(year) || year < 1900 || year > 2200)
  ) {
    return { ok: false, reason: "invalid_date" };
  }

  if (
    !isValidBirthdayMonthDay({
      month: params.month,
      day: params.day,
      year,
    })
  ) {
    return { ok: false, reason: "invalid_date" };
  }

  return {
    ok: true,
    birthday: {
      month: params.month,
      day: params.day,
      ...(year ? { year } : {}),
      raw: params.raw,
    },
  };
}

export function parseCustomerBirthday(
  value: unknown
): CustomerBirthdayParseResult {
  const raw = String(value || "").trim();
  if (!raw) return { ok: false, reason: "empty" };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) {
    return buildResult({
      raw,
      year: parseInteger(iso[1]),
      month: parseInteger(iso[2]),
      day: parseInteger(iso[3]),
    });
  }

  const dayMonthYearSlash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (dayMonthYearSlash) {
    return buildResult({
      raw,
      day: parseInteger(dayMonthYearSlash[1]),
      month: parseInteger(dayMonthYearSlash[2]),
      year: parseInteger(dayMonthYearSlash[3]),
    });
  }

  const dayMonthDot = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(raw);
  if (dayMonthDot) {
    return buildResult({
      raw,
      day: parseInteger(dayMonthDot[1]),
      month: parseInteger(dayMonthDot[2]),
      year: dayMonthDot[3] ? parseInteger(dayMonthDot[3]) : null,
    });
  }

  const monthDayDash = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (monthDayDash) {
    return buildResult({
      raw,
      month: parseInteger(monthDayDash[1]),
      day: parseInteger(monthDayDash[2]),
    });
  }

  return { ok: false, reason: "unsupported_format" };
}

export function buildCustomerBirthdayValue(params: {
  value: unknown;
  source: CustomerBirthdaySource;
  now?: Date;
}): NormalizedCustomerBirthday | null {
  const parsed = parseCustomerBirthday(params.value);
  if (!parsed.ok) return null;
  return {
    ...parsed.birthday,
    source: params.source,
    updatedAt: params.now || new Date(),
  };
}
