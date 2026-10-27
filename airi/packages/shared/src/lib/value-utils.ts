export type UnknownRecord = Record<string, unknown>;

export type ReadStringOptions = {
  trim?: boolean;
  normalizeWhitespace?: boolean;
  coerce?: boolean;
  /** Applied after trimming or whitespace normalization. */
  maxLength?: number;
};

export type ReadStringArrayOptions = ReadStringOptions & {
  splitCommaSeparated?: boolean;
};

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

export function asNullableRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

/**
 * A record whose prototype is Object.prototype or null, so class instances,
 * Dates and Maps are rejected, and so is a Proxy whose prototype read throws.
 */
export function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** True when the record's own enumerable keys are exactly `keys`. */
export function hasExactKeys(
  record: UnknownRecord,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function normalizeStringValue(
  value: string,
  options: ReadStringOptions = {},
): string {
  const normalized = options.normalizeWhitespace
    ? normalizeWhitespace(value)
    : options.trim
      ? value.trim()
      : value;
  return options.maxLength === undefined
    ? normalized
    : normalized.slice(0, options.maxLength);
}

export function normalizeLooseString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = normalizeWhitespace(value);
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(value: string): string | null {
  const trimmed = normalizeWhitespace(String(value || ""));
  if (!trimmed) return null;
  if (trimmed.startsWith("wa_bsuid_")) return null;
  const withoutPrefix = trimmed.startsWith("wa_") ? trimmed.slice(3) : trimmed;
  if (/[A-Za-z]/.test(withoutPrefix)) return null;
  const digits = withoutPrefix.replace(/\D+/g, "");
  return digits.length >= 6 ? digits : null;
}

export function readString(
  value: unknown,
  options: ReadStringOptions = {},
): string | undefined {
  if (typeof value === "string") {
    return normalizeStringValue(value, options);
  }

  if (options.coerce && value !== null && value !== undefined) {
    return normalizeStringValue(String(value), options);
  }

  return undefined;
}

export function readStringOrEmpty(
  value: unknown,
  options: ReadStringOptions = {},
): string {
  return readString(value, options) ?? "";
}

export function readNonEmptyString(
  value: unknown,
  options: ReadStringOptions = { trim: true },
): string | null {
  const normalized = readString(value, options);
  return normalized && normalized.length > 0 ? normalized : null;
}

export function readNonEmptyStringOrUndefined(
  value: unknown,
  options: ReadStringOptions = { trim: true },
): string | undefined {
  return readNonEmptyString(value, options) ?? undefined;
}

/** `readStringOrEmpty(value, { trim: true })`: a trimmed string, or "". */
export function readTrimmedString(value: unknown): string {
  return readStringOrEmpty(value, { trim: true });
}

/** A trimmed string cut to `maxLength` characters, or "". */
export function cleanString(value: unknown, maxLength: number): string {
  return readStringOrEmpty(value, { trim: true, maxLength });
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the trimmed string or throws `${label} is required`. */
export function requireNonEmptyString(
  value: unknown,
  label: string,
  createError: (message: string) => Error = (message) => new Error(message),
): string {
  const normalized = readNonEmptyString(value);
  if (!normalized) throw createError(`${label} is required`);
  return normalized;
}

/**
 * A trimmed non-empty string, a number as String(n), or an object's
 * String() value (null for "[object Object]"). Used for provider call ids.
 */
export function readIdString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "toString" in value) {
    const normalized = String(value);
    return normalized && normalized !== "[object Object]" ? normalized : null;
  }
  return null;
}

export function coerceNonEmptyString(
  value: unknown,
  options: Omit<ReadStringOptions, "coerce"> = { trim: true },
): string | null {
  const normalized = readNonEmptyString(value, { ...options, coerce: true });
  return normalized === "[object Object]" ? null : normalized;
}

export function coerceCompactString(value: unknown): string | null {
  return coerceNonEmptyString(value, {
    normalizeWhitespace: true,
  });
}

export function coerceStringArray(
  value: unknown,
  options: Omit<ReadStringArrayOptions, "coerce"> = { trim: true },
): string[] {
  return readStringArray(value, { ...options, coerce: true });
}

export function booleanField(
  record: UnknownRecord | null | undefined,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

export function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }

  return null;
}

export function coerceBooleanField(
  record: UnknownRecord | null | undefined,
  key: string,
): boolean | null {
  return coerceBoolean(record?.[key]);
}

export function normalizeUrlBase(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim().replace(/\/+$/, "");
  return normalized || undefined;
}

export function readStringField(
  record: UnknownRecord | null | undefined,
  key: string,
  options: ReadStringOptions = {},
): string {
  return readStringOrEmpty(record?.[key], options);
}

export function readNonEmptyStringField(
  record: UnknownRecord | null | undefined,
  key: string,
  options: ReadStringOptions = { trim: true },
): string | null {
  return readNonEmptyString(record?.[key], options);
}

export function readFirstNonEmptyStringField(
  record: UnknownRecord | null | undefined,
  keys: readonly string[],
  options: ReadStringOptions = { trim: true },
): string | null {
  if (!record) return null;

  for (const key of keys) {
    const value = readNonEmptyString(record[key], options);
    if (value) return value;
  }

  return null;
}

export function readStringArray(
  value: unknown,
  options: ReadStringArrayOptions = { trim: true },
): string[] {
  const values =
    typeof value === "string" && options.splitCommaSeparated
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : [];

  return values
    .map((item) => readNonEmptyString(item, options))
    .filter((item): item is string => Boolean(item));
}

/** readStringArray with duplicates removed, in first-seen order. */
export function readUniqueStringArray(
  value: unknown,
  options: ReadStringArrayOptions = { trim: true },
): string[] {
  return Array.from(new Set(readStringArray(value, options)));
}

export function readOptionalStringArray(
  value: unknown,
  options: ReadStringArrayOptions = { trim: true },
): string[] | undefined {
  const hasReadableInput =
    Array.isArray(value) ||
    (typeof value === "string" && options.splitCommaSeparated === true);

  return hasReadableInput ? readStringArray(value, options) : undefined;
}

export function readStringArrayField(
  record: UnknownRecord | null | undefined,
  key: string,
  options: ReadStringArrayOptions = { trim: true },
): string[] {
  return readStringArray(record?.[key], options);
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** A valid Date from a Date or a date string; numbers are not accepted. */
export function readDate(value: unknown): Date | null {
  if (value instanceof Date) return isValidDate(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return isValidDate(parsed) ? parsed : null;
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A number or integer string floored to a count; negative or NaN gives 0. */
export function readNonNegativeCount(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/** The value itself when it is an array, otherwise []. Elements are not checked. */
export function readArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Wraps a single value in an array; null and undefined give []. */
export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Unwraps a joined relation that arrives as one row or an array of rows. */
export function firstOrSelf<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** The fulfilled value, or the rejection rethrown where the caller consults it. */
export function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
