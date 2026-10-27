import { coerceBoolean, coerceNonEmptyString } from "./value-utils";

/** Trimmed `process.env[name]`, or null when it is unset or blank. */
export function readEnv(name: string): string | null {
  return coerceNonEmptyString(process.env[name]);
}

/** Trimmed `process.env[name]`, or "" when it is unset or blank. */
export function readEnvOrEmpty(name: string): string {
  return readEnv(name) ?? "";
}

/** The first of `names` whose env value is set and not blank. */
export function firstEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = readEnv(name);
    if (value) return value;
  }
  return null;
}

/**
 * 1/true/yes/on → true, 0/false/no/off → false (trimmed, any case);
 * unset, blank or anything else → fallback.
 */
export function parseEnvFlag(
  value: string | undefined,
  fallback = false,
): boolean {
  return coerceBoolean(value) ?? fallback;
}

/** {@link parseEnvFlag} applied to `process.env[name]`. */
export function readEnvFlag(name: string, fallback = false): boolean {
  return parseEnvFlag(process.env[name], fallback);
}

/**
 * Integer `process.env[name]`, clamped to `limits`. Unset, blank, unparsable or
 * negative values give `fallback`.
 */
export function readIntegerEnv(
  name: string,
  fallback: number,
  limits?: { min?: number; max?: number },
): number {
  const rawValue = readEnv(name);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  if (limits?.min !== undefined && parsed < limits.min) {
    return limits.min;
  }
  if (limits?.max !== undefined && parsed > limits.max) {
    return limits.max;
  }

  return parsed;
}
