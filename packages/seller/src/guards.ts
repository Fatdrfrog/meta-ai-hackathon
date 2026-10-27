// The seller model invented a price when it had no catalog (docs/findings.md), so its replies are
// checked in code before a buyer sees them.

const CURRENCY = String.raw`(?:₸|тг\.?|тенге|теңге|kzt|tenge)`;
const NUMBER = String.raw`\d{1,3}(?:[   .,]\d{3})+|\d+`;
const PRICE = new RegExp(`(${NUMBER})\\s*${CURRENCY}`, "giu");

// A number standing on its own: not part of a word or a ref ("p2"), and not a percentage.
const BARE = new RegExp(String.raw`(?<![\p{L}\d])(${NUMBER})(?![\p{L}\d]|\s*%)`, "gu");
// A phone number written with spaces, brackets or dashes: "+7 (701) 123-45-67".
const PHONE = /\+?\d[\d\s()-]{8,}\d/g;

const toNumber = (digits: string) => Number(digits.replaceAll(/[   .,]/g, ""));
const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every amount written as a number followed by a tenge sign or word, e.g. "5 000 ₸" or "300 тг". */
export function pricesInText(text: string): number[] {
  return [...text.matchAll(PRICE)].map((m) => toNumber(m[1]!));
}

/**
 * Every amount a reply states: prices with a tenge sign or word, and bare numbers from 100 up, since
 * "для вас 4000" names a price too. Phone numbers and the products' own names ("Lego 60321") are left out.
 */
export function amountsInText(text: string, names: readonly string[] = []): number[] {
  // Only runs of ten or more digits, so two prices in a row ("5 000 4 000") still count as prices.
  let rest = text.replaceAll(PHONE, (run) => (run.replaceAll(/\D/g, "").length >= 10 ? " " : run));
  for (const name of names.filter((n) => /\d/.test(n))) rest = rest.replaceAll(new RegExp(escaped(name), "giu"), " ");
  const bare = [...rest.matchAll(BARE)].map((m) => toNumber(m[1]!)).filter((n) => n >= 100);
  return [...new Set([...pricesInText(rest), ...bare])];
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

export function unbackedPrices(text: string, allowed: ReadonlySet<number>, names: readonly string[] = []): number[] {
  return amountsInText(text, names).filter((amount) => !allowed.has(amount));
}

// "товар 5", "product #2", "№ 3", "p4": labels and refs exist only for the model and the photo sheet.
export const LABEL_MENTION = /(товар|тауар|номер|label|product)\s*(№|#)?\s*\d|№\s*\d|#\d|\bp\d+\b/i;

/** Problems with a reply the buyer is about to see. */
export function checkReply(reply: string, allowed: ReadonlySet<number>, names: readonly string[] = []): string[] {
  const problems: string[] = [];
  if (reply.trim() === "") problems.push("the reply is empty");
  const unbacked = unbackedPrices(reply, allowed, names);
  if (unbacked.length > 0) problems.push(`the reply states prices that no tool returned: ${unbacked.join(", ")}`);
  if (LABEL_MENTION.test(reply)) problems.push("the reply mentions a product ref or label, which the buyer can't see");
  // "Вот что нашлось:" with nothing after it: the model meant to show cards and didn't.
  if (/:\s*$/.test(reply)) problems.push("the reply ends with a colon as if a list follows; show the products with show_products or finish the sentence");
  return problems;
}

/** Markdown the buyer's chat or WhatsApp would show as stray symbols. */
export function plainText(reply: string): string {
  return reply
    .replaceAll(/\*\*(.+?)\*\*/g, "$1")
    .replaceAll(/__(.+?)__/g, "$1")
    .replaceAll(/^#{1,6}\s+/gm, "")
    .replaceAll(/^[ \t]*[*-][ \t]+/gm, "• ")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
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
