export {
  coerceNonEmptyString as normalizeOptionalString,
  coerceStringArray as normalizeStringArray,
} from "@icecore/shared/lib/value-utils";

export function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof String
  ) {
    const parsed = new Date(value.valueOf());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

export function normalizeDateIso(value: unknown): string | null {
  return parseDate(value)?.toISOString() || null;
}
