// Package-internal value guards. scenario-contracts does not depend on
// @icecore/shared, so these mirror its value-utils helpers of the same name.
// Not exported from index.ts.

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asNullableRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

export function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function cleanString(value: unknown, maxLength: number): string {
  return readTrimmedString(value).slice(0, maxLength);
}

export function readNonEmptyString(value: unknown): string | null {
  return readTrimmedString(value) || null;
}

export function readNonEmptyStringOrUndefined(
  value: unknown,
): string | undefined {
  return readTrimmedString(value) || undefined;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
