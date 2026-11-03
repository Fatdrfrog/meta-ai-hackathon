import {
  formatProductPrice,
  type ProductShopWordsCode,
  type WorkspaceProductRecord,
} from "./types";

// The fixed words buyers read in what the owner makes from the shelf (the
// carousel's message and button, the order form) in the language the owner
// spoke. The server writes them to Meta and the page previews them, from this
// one copy, so the preview says exactly what buyers get.

export type ShopWords = {
  /** Meta's code for the language. */
  code: ProductShopWordsCode;
  from: (amount: string) => string;
  carouselBody: string;
  orderButton: string;
  form: {
    title: string;
    products: string;
    name: string;
    address: string;
    comment: string;
    submit: string;
    cta: string;
  };
};

export const SHOP_WORDS: Record<ProductShopWordsCode, ShopWords> = {
  kk: {
    code: "kk",
    from: amount => `${amount} бастап`,
    carouselBody: "Біздің тауарлар. Ұнағанын таңдап, тапсырыс беріңіз.",
    orderButton: "Тапсырыс беру",
    form: {
      title: "Тапсырыс",
      products: "Не алғыңыз келеді?",
      name: "Атыңыз",
      address: "Жеткізу мекенжайы",
      comment: "Түсініктеме",
      submit: "Тапсырысты жіберу",
      cta: "Тапсырыс беру",
    },
  },
  ru: {
    code: "ru",
    from: amount => `от ${amount}`,
    carouselBody: "Наши товары. Выберите, что понравится, и закажите.",
    orderButton: "Заказать",
    form: {
      title: "Заказ",
      products: "Что хотите заказать?",
      name: "Имя",
      address: "Адрес доставки",
      comment: "Комментарий",
      submit: "Отправить заказ",
      cta: "Заказать",
    },
  },
  en: {
    code: "en",
    from: amount => `from ${amount}`,
    carouselBody: "Our products. Pick the one you like and order it here.",
    orderButton: "Order",
    form: {
      title: "Order",
      products: "What would you like?",
      name: "Name",
      address: "Delivery address",
      comment: "Comment",
      submit: "Send order",
      cta: "Order",
    },
  },
};

/**
 * The words buyers see, in the language the owner spoke as Muse Spark named
 * it ("Kazakh", "Russian", "kk"…); English for any other.
 */
export function shopWords(language: string | null | undefined): ShopWords {
  if (/kaz|қаз|^kk\b/i.test(language ?? "")) return SHOP_WORDS.kk;
  if (/rus|рус|^ru\b/i.test(language ?? "")) return SHOP_WORDS.ru;
  return SHOP_WORDS.en;
}

/**
 * Whether the owner spoke the language shopWords writes in for them, so the
 * page may call it "the language you spoke". An owner who spoke Uzbek, or
 * whose language wasn't heard, gets English words too, but didn't speak
 * English.
 */
export function spokeShopWordsLanguage(
  language: string | null | undefined
): boolean {
  if (shopWords(language).code !== "en") return true;
  return /^(english|eng\b|en\b|англ|ағылшын)/i.test((language ?? "").trim());
}

/** What a price is read from: a shelf product, or one the server loaded. */
export type ShopPrice = Pick<
  WorkspaceProductRecord,
  "price" | "currency" | "priceIsFrom"
>;

/**
 * A price as buyers read it: "15 500 ₸", "10 USD", or a bare "15 500" when no
 * currency was said or shown; a starting price the shop's way, "15 500 ₸
 * бастап". Null for a product without a price.
 */
export function buyerPrice(
  product: ShopPrice,
  words: ShopWords
): string | null {
  if (product.price === null) return null;
  const amount = formatProductPrice(product.price, {
    currency: product.currency,
  });
  return product.priceIsFrom ? words.from(amount) : amount;
}
