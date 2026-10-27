import { PRICING_AMOUNT_LINE_RE } from "@/lib/airi/grounding/pricing-amount-pattern";
import { stripAiriPrefix } from "@/lib/airi/reply/thread/reply-text-utils";

export type PriceQuote = {
  text: string;
  amount: number | null;
  currency: string | null;
} | null;

function trimForPriceScan(text: string): string {
  return stripAiriPrefix(text)
    .replace(/\s+/g, " ")
    .replace(/^[—–\-:\s]+/u, "")
    .replace(/[.?!,;:\s]+$/u, "")
    .trim();
}

function normalizeCurrency(value: string | null | undefined): string | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "₸" ||
    normalized === "тг" ||
    normalized === "тенге" ||
    normalized === "kzt"
  ) {
    return "KZT";
  }
  if (normalized === "$" || normalized === "usd") {
    return "USD";
  }
  if (normalized === "€" || normalized === "eur") {
    return "EUR";
  }
  if (normalized === "₽" || normalized.startsWith("руб")) {
    return "RUB";
  }
  if (normalized === "грн" || normalized === "uah") {
    return "UAH";
  }
  return normalized.toUpperCase();
}

/** First price-like amount + currency in the string (uses {@link PRICING_AMOUNT_LINE_RE}). */
export function extractQuotedPrice(text: string): PriceQuote {
  const normalized = trimForPriceScan(text);
  if (!normalized) return null;

  const match = normalized.match(PRICING_AMOUNT_LINE_RE);
  if (!match) return null;

  const amountDigits = match[1].replace(/[^\d]/g, "");
  return {
    text: match[0].trim(),
    amount: amountDigits ? Number(amountDigits) : null,
    currency: normalizeCurrency(match[2]),
  };
}

export { normalizeCurrency };
