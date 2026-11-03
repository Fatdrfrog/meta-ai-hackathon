import {
  PRODUCT_KIT_MAX_PRODUCTS,
  PRODUCT_KIT_PARTS,
  PRODUCT_SHOP_WORDS_CODES,
  type ProductKitPart,
  type ProductShopWordsCode,
} from "./types";

// What the kit routes accept, checked before anything is read or written.

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isObjectIdText = (value: unknown): value is string =>
  typeof value === "string" && OBJECT_ID.test(value);

/** 1 to 60 product ids, each once and in the order given; null when any isn't an id. */
export function parseProductIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > PRODUCT_KIT_MAX_PRODUCTS ||
    !value.every(isObjectIdText)
  )
    return null;
  return [...new Set(value.map(id => id.toLowerCase()))];
}

/** Checks that `value` is one of a kit's parts. */
export const isProductKitPart = (value: unknown): value is ProductKitPart =>
  (PRODUCT_KIT_PARTS as readonly unknown[]).includes(value);

/** An IANA time zone this server knows; null for any other. */
function knownTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** A press of "Make", as the route checked it. */
export type ProductKitRequest = {
  requestId: string;
  productIds: string[];
  importId: string | null;
  make: { carousel: boolean; orderForm: boolean };
  language: ProductShopWordsCode | null;
  /** The owner's time zone; null for UTC, or for one this server doesn't know. */
  timeZone: string | null;
};

/** The body of POST /kits, or null when it isn't a valid press. */
export function parseProductKitRequest(
  body: unknown
): ProductKitRequest | null {
  if (!body || typeof body !== "object") return null;
  const { requestId, productIds, importId, make, language, timeZone } =
    body as Record<string, unknown>;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  const ids = parseProductIds(productIds);
  if (!ids) return null;
  if (importId !== undefined && importId !== null && !isObjectIdText(importId))
    return null;
  if (!make || typeof make !== "object") return null;
  const { carousel, orderForm } = make as Record<string, unknown>;
  if (typeof carousel !== "boolean" || typeof orderForm !== "boolean")
    return null;
  if (!carousel && !orderForm) return null;
  if (
    language !== undefined &&
    !(PRODUCT_SHOP_WORDS_CODES as readonly unknown[]).includes(language)
  )
    return null;
  return {
    requestId,
    productIds: ids,
    importId: typeof importId === "string" ? importId.toLowerCase() : null,
    make: { carousel, orderForm },
    language: (language as ProductShopWordsCode | undefined) ?? null,
    timeZone: knownTimeZone(timeZone),
  };
}
