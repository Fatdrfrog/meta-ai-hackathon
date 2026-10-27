const grouped = new Intl.NumberFormat("ru-RU");

export function formatPrice(price: number | null, currency: string | null): string | null {
  if (price === null) return null;
  return `${grouped.format(price)} ${currency === null || currency === "KZT" ? "₸" : currency}`;
}

/** Keeps amounts like "10 000 ₸" in a chat message on one line, so they don't wrap as "10 / 000 ₸". */
export function keepAmountsTogether(text: string): string {
  return text.replaceAll(/(?<=\d) (?=\d{3}(?!\d))|(?<=\d) (?=₸|тг|тенге|теңге)/g, " ");
}

export function formatSeconds(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}
