import {
  PRODUCT_KIT_MAX_PRODUCTS,
  PRODUCT_KIT_PARTS,
  PRODUCT_SHOP_WORDS_CODES,
  type ProductKitDraftsRequest,
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

/**
 * The owner's edits as a request carries them: shaped like
 * ProductKitEdits, their content still unchecked (kits.ts checks it with
 * kit-carousel-edit.ts and order-form-config.ts).
 */
export type ProductKitRequestEdits = {
  carousel?: { name: string; components: unknown[] };
  orderForm?: { config: Record<string, unknown> };
};

/** A press of "Make", as the route checked it. */
export type ProductKitRequest = {
  requestId: string;
  productIds: string[];
  importId: string | null;
  make: { carousel: boolean; orderForm: boolean };
  language: ProductShopWordsCode | null;
  /** The owner's time zone; null for UTC, or for one this server doesn't know. */
  timeZone: string | null;
  /** "Edit cards" and "Edit questions" before the press; null without any. */
  edits: ProductKitRequestEdits | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isShopLanguage = (value: unknown): value is ProductShopWordsCode =>
  (PRODUCT_SHOP_WORDS_CODES as readonly unknown[]).includes(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every(key => keys.includes(key));

/** A carousel edit's shape: a name and the template's components. */
function carouselEditShape(
  value: unknown
): { name: string; components: unknown[] } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "components"]))
    return null;
  const { name, components } = value;
  if (typeof name !== "string" || !Array.isArray(components)) return null;
  return { name, components };
}

/** An order form edit's shape: a Flow config. */
function orderFormEditShape(
  value: unknown
): { config: Record<string, unknown> } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["config"])) return null;
  return isRecord(value.config) ? { config: value.config } : null;
}

/**
 * A press's edits: only for the parts it makes. Undefined when there are
 * none, null when they aren't edits.
 */
function parseEdits(
  value: unknown,
  make: { carousel: boolean; orderForm: boolean }
): ProductKitRequestEdits | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ["carousel", "orderForm"]))
    return null;
  const edits: ProductKitRequestEdits = {};
  if (value.carousel !== undefined) {
    const carousel = carouselEditShape(value.carousel);
    if (!carousel || !make.carousel) return null;
    edits.carousel = carousel;
  }
  if (value.orderForm !== undefined) {
    const orderForm = orderFormEditShape(value.orderForm);
    if (!orderForm || !make.orderForm) return null;
    edits.orderForm = orderForm;
  }
  return edits;
}

/** The body of POST /kits, or null when it isn't a valid press. */
export function parseProductKitRequest(
  body: unknown
): ProductKitRequest | null {
  if (!body || typeof body !== "object") return null;
  const { requestId, productIds, importId, make, language, timeZone, edits } =
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
  if (language !== undefined && !isShopLanguage(language)) return null;
  const parsedEdits = parseEdits(edits, { carousel, orderForm });
  if (parsedEdits === null) return null;
  return {
    requestId,
    productIds: ids,
    importId: typeof importId === "string" ? importId.toLowerCase() : null,
    make: { carousel, orderForm },
    language: (language as ProductShopWordsCode | undefined) ?? null,
    timeZone: knownTimeZone(timeZone),
    edits:
      parsedEdits && (parsedEdits.carousel || parsedEdits.orderForm)
        ? parsedEdits
        : null,
  };
}

/** POST /kits/drafts, as checked: the products and the buyers' language; null otherwise. */
export function parseProductKitDraftsRequest(
  body: unknown
): ProductKitDraftsRequest | null {
  if (!isRecord(body) || !hasOnlyKeys(body, ["productIds", "language"]))
    return null;
  const productIds = parseProductIds(body.productIds);
  if (!productIds || !isShopLanguage(body.language)) return null;
  return { productIds, language: body.language };
}

/** POST /kits/[kitId]/edit, by its shape: a part sent again with the owner's edit. */
export type ProductKitEditInput =
  | {
      requestId: string;
      part: "carousel";
      name: string;
      components: unknown[];
    }
  | { requestId: string; part: "orderForm"; config: Record<string, unknown> };

/** The body of POST /kits/[kitId]/edit, or null when it isn't an edit. */
export function parseProductKitEditRequest(
  body: unknown
): ProductKitEditInput | null {
  if (!isRecord(body)) return null;
  const { requestId, part, ...rest } = body;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  if (part === "carousel") {
    const carousel = carouselEditShape(rest);
    return carousel ? { requestId, part, ...carousel } : null;
  }
  if (part === "orderForm") {
    const orderForm = orderFormEditShape(rest);
    return orderForm ? { requestId, part, ...orderForm } : null;
  }
  return null;
}
