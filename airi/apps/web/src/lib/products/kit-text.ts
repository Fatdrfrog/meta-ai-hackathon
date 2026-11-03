import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import { buyerPrice, type ShopPrice, type ShopWords } from "./shop-words";

// What buyers read on a kit's carousel cards and order form, written once:
// the server sends it to Meta and the make view's preview shows it, so the
// preview says exactly what buyers get.

/** A carousel holds 2 to 10 cards: the first 10 products with photos. */
export const KIT_CAROUSEL_MIN_CARDS =
  WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MIN;
export const KIT_CAROUSEL_MAX_CARDS =
  WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MAX;

/** A Flow's CheckboxGroup lists at most 20 items, each title at most 30 characters. */
export const ORDER_FORM_MAX_PRODUCTS = 20;
export const ORDER_FORM_TITLE_MAX = 30;

/** At most `max` characters, cut at the end with "…" and no dangling comma. */
export function clipText(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max - 1).replace(/[\s,.;:–-]+$/u, "")}…`
    : text;
}

/** A product as buyers read it: its name and its price. */
export type KitTextProduct = ShopPrice & { name: string };

/**
 * A carousel card's text: the name, clipped so it fits beside the price,
 * then the price on its own line (just the name without a price).
 */
export function carouselCardText(
  product: KitTextProduct,
  words: ShopWords
): { name: string; price: string | null; text: string } {
  const price = buyerPrice(product, words);
  const name = clipText(
    product.name,
    WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH -
      (price ? price.length + 1 : 0)
  );
  return { name, price, text: price ? `${name}\n${price}` : name };
}

/** A product as the order form lists it: its clipped name, and its price beneath. */
export function orderFormOption(
  product: KitTextProduct,
  words: ShopWords
): { title: string; description: string | null } {
  return {
    title: clipText(product.name, ORDER_FORM_TITLE_MAX),
    description: buyerPrice(product, words),
  };
}
