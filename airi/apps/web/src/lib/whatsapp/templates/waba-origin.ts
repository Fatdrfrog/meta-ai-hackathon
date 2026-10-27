export type WhatsAppWabaHistoryEntry = {
  wabaId: string;
  recordedAt: string;
};

export function compactWhatsAppWabaId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function inferWhatsAppTemplateSourceWabaId(params: {
  storedWabaId?: string | number | null;
  currentWabaId?: string | number | null;
  templateCreatedAt?: string | null;
  wabaHistory?: WhatsAppWabaHistoryEntry[] | null;
  fallbackPreviousWabaId?: string | null;
}): string | undefined {
  const currentWabaId = compactWhatsAppWabaId(params.currentWabaId);
  const storedWabaId = compactWhatsAppWabaId(params.storedWabaId);
  if (storedWabaId && storedWabaId !== currentWabaId) {
    return storedWabaId;
  }

  const createdAtMs = params.templateCreatedAt
    ? Date.parse(params.templateCreatedAt)
    : Number.NaN;
  const history = [...(params.wabaHistory || [])]
    .map(entry => ({
      wabaId: compactWhatsAppWabaId(entry.wabaId),
      recordedAtMs: Date.parse(entry.recordedAt),
    }))
    .filter(
      (entry): entry is { wabaId: string; recordedAtMs: number } =>
        Boolean(entry.wabaId) && !Number.isNaN(entry.recordedAtMs)
    )
    .sort((left, right) => left.recordedAtMs - right.recordedAtMs);

  let inferred: string | undefined;
  for (const entry of history) {
    if (!Number.isNaN(createdAtMs) && entry.recordedAtMs > createdAtMs) {
      break;
    }
    if (entry.wabaId !== currentWabaId) {
      inferred = entry.wabaId;
    }
  }
  if (inferred) return inferred;

  const fallback = compactWhatsAppWabaId(params.fallbackPreviousWabaId);
  if (fallback && fallback !== currentWabaId) {
    return fallback;
  }
  return undefined;
}
