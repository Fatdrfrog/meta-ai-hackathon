import { createHash } from "node:crypto";

const MAX_DEPTH = 8;
const MAX_ENTRIES = 256;
const MAX_KEY_LENGTH = 64;
const MAX_STRING_LENGTH = 1_000;
const MAX_SERIALIZED_BYTES = 32 * 1024;
const REDACTED_KEY =
  /authorization|api[-_]?key|token|secret|video(bytes)?|inline(data)?/i;

type SanitizedValue =
  | null
  | boolean
  | number
  | string
  | SanitizedValue[]
  | { [key: string]: SanitizedValue };

function sanitizeString(value: string, budget: { truncated: boolean }): string {
  if (value.length > MAX_STRING_LENGTH) budget.truncated = true;
  const bounded = value.slice(0, MAX_STRING_LENGTH);
  const trimmed = bounded.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return bounded.replace(/https?:\/\/[^\s"'<>]+/gi, (match) =>
      sanitizeUrl(match),
    );
  }
  return sanitizeUrl(trimmed);
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, MAX_STRING_LENGTH);
  } catch {
    return value.slice(0, MAX_STRING_LENGTH);
  }
}

function walk(
  value: unknown,
  depth: number,
  budget: { entries: number; truncated: boolean },
): SanitizedValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeString(value, budget);
  if (typeof value === "bigint")
    return value.toString().slice(0, MAX_STRING_LENGTH);
  if (depth >= MAX_DEPTH || budget.entries >= MAX_ENTRIES) {
    budget.truncated = true;
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    const output: SanitizedValue[] = [];
    for (const item of value) {
      if (budget.entries >= MAX_ENTRIES) {
        budget.truncated = true;
        break;
      }
      budget.entries += 1;
      output.push(walk(item, depth + 1, budget));
    }
    return output;
  }

  if (value && typeof value === "object") {
    const output: { [key: string]: SanitizedValue } = {};
    for (const [unsafeKey, item] of Object.entries(value)) {
      if (budget.entries >= MAX_ENTRIES) {
        budget.truncated = true;
        break;
      }
      budget.entries += 1;
      if (REDACTED_KEY.test(unsafeKey)) continue;
      const key = unsafeKey.slice(0, MAX_KEY_LENGTH);
      if (!key) continue;
      if (unsafeKey.length > MAX_KEY_LENGTH) budget.truncated = true;
      if (typeof item === "string" && item.length > MAX_STRING_LENGTH)
        budget.truncated = true;
      output[key] = walk(item, depth + 1, budget);
    }
    return output;
  }

  return String(value).slice(0, MAX_STRING_LENGTH);
}

function rootKeys(value: SanitizedValue): string[] {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  return Object.keys(value).slice(0, 32);
}

/** Produces a JSON-safe, secret-free provider diagnostic bounded to 32 KiB. */
export function sanitizeVideoProviderPayload(value: unknown): SanitizedValue {
  const budget = { entries: 0, truncated: false };
  let sanitized = walk(value, 0, budget);
  if (budget.truncated) {
    if (
      sanitized &&
      !Array.isArray(sanitized) &&
      typeof sanitized === "object"
    ) {
      sanitized = { ...sanitized, truncated: true };
    } else {
      const truncatedJson = JSON.stringify(sanitized);
      sanitized = {
        truncated: true,
        sha256: createHash("sha256").update(truncatedJson).digest("hex"),
        keys: [],
      };
    }
  }
  const json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, "utf8") <= MAX_SERIALIZED_BYTES) return sanitized;

  return {
    truncated: true,
    sha256: createHash("sha256").update(json).digest("hex"),
    keys: rootKeys(sanitized),
  };
}
