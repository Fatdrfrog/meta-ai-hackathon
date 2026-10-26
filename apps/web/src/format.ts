const grouped = new Intl.NumberFormat("ru-RU");

export function formatPrice(price: number | null, currency: string | null): string | null {
  if (price === null) return null;
  return `${grouped.format(price)} ${currency === null || currency === "KZT" ? "₸" : currency}`;
}

export function formatSeconds(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}
