import { normalizeWhitespace } from "@icecore/shared/lib/value-utils";

export function previewText(
  value: unknown,
  maxLength: number = 240,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

export function previewStringArray(
  values: unknown,
  maxItems: number = 4,
  maxItemLength: number = 120,
): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => previewText(item, maxItemLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
}
