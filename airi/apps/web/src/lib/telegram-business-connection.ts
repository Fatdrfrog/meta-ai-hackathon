export function normalizeBusinessConnectionId(
  value?: string | null
): string | undefined {
  if (!value) return undefined;
  return value.trim() || undefined;
}

export function resolveBusinessConnectionId(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    const normalized = normalizeBusinessConnectionId(value);
    if (normalized) return normalized;
  }
  return undefined;
}
