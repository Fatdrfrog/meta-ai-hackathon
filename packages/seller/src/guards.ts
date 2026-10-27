// The seller model invented a price when it had no catalog (docs/findings.md), so its replies are
// checked in code before a buyer sees them.

const CURRENCY = String.raw`(?:₸|тг\.?|тенге|теңге|kzt|tenge)`;
const NUMBER = String.raw`\d{1,3}(?:[   .,]\d{3})+|\d+`;
const PRICE = new RegExp(`(${NUMBER})\\s*${CURRENCY}`, "giu");

/** Every amount written as a number followed by a tenge sign or word, e.g. "5 000 ₸" or "300 тг". */
export function pricesInText(text: string): number[] {
  return [...text.matchAll(PRICE)].map((m) => Number(m[1]!.replaceAll(/[   .,]/g, "")));
}

/**
 * Amounts a reply may state: any product's own price, several of a product the reply shows or
 * orders, and the order's total. Multiples of every product would let a made-up discount slip
 * through as, say, fifteen of the cheapest item.
 */
export function allowedAmounts(
  catalogPrices: readonly number[],
  referencedPrices: readonly number[],
  orderTotal: number | null,
): Set<number> {
  const allowed = new Set<number>(catalogPrices);
  for (const price of referencedPrices) for (let n = 2; n <= 20; n++) allowed.add(price * n);
  if (orderTotal !== null) allowed.add(orderTotal);
  return allowed;
}

export function unbackedPrices(text: string, allowed: ReadonlySet<number>): number[] {
  return pricesInText(text).filter((amount) => !allowed.has(amount));
}

/**
 * A phone number a shop can call back, in international form. Kazakh numbers come as
 * +7 701…, 8 701… (8 is the domestic prefix) or just 701….
 */
export function normalizePhone(raw: string | null): string | null {
  let digits = (raw ?? "").replaceAll(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? `+${digits}` : null;
}
