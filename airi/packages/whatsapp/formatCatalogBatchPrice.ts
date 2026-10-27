export function normalizeCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("currency must be a 3-letter ISO 4217 code");
  }
  return normalized;
}

export function parseCatalogAmount(value: string | number): number {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error("price must be a positive amount with up to 2 decimals");
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("price must be a positive amount");
  }
  return parsed;
}

export function formatCatalogBatchPrice(
  value: string | number,
  currency: string,
): string {
  return `${parseCatalogAmount(value).toFixed(2)} ${normalizeCurrency(currency)}`;
}

export function toMetaProductPriceCents(value: string | number): string {
  return String(Math.round(parseCatalogAmount(value) * 100));
}
