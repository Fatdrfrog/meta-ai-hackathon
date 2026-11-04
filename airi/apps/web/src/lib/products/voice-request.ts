import {
  isAdObjectId,
  parseProductAdUpdateRequest,
} from "@/lib/products/ad-request";
import {
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_AD_VOICE_MODES,
  PRODUCT_SHOP_WORDS_CODES,
  productAdStockVoice,
  type ProductAdVoiceMode,
  type ProductAdVoiceRequest,
  type ProductShopWordsCode,
  type ProductVoiceCreateRequest,
} from "@/lib/products/types";

// What the voice API takes (Part V), checked: the consent to clone, an ad's
// new voice, and a sample's language. Pure, so the routes and their tests
// share it.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * POST /products/voice: `consent` must be exactly true ("missing" without
 * it, so the route says the consent is needed); the video is an import id,
 * or 1 to PRODUCT_AD_MAX_PRODUCTS product ids. Null for any other body.
 */
export function parseProductVoiceCreateRequest(
  body: unknown
): ProductVoiceCreateRequest | "missing_consent" | null {
  if (!isObject(body)) return null;
  const known = new Set(["consent", "importId", "productIds"]);
  if (Object.keys(body).some(key => !known.has(key))) return null;
  if (body.consent !== true) return "missing_consent";
  const importId = body.importId;
  const productIds = body.productIds;
  if (importId !== undefined) {
    if (!isAdObjectId(importId) || productIds !== undefined) return null;
    return { consent: true, importId: importId.toLowerCase() };
  }
  if (
    !Array.isArray(productIds) ||
    productIds.length < 1 ||
    productIds.length > PRODUCT_AD_MAX_PRODUCTS ||
    !productIds.every(isAdObjectId)
  )
    return null;
  const ids = [...new Set(productIds.map(id => id.toLowerCase()))];
  return { consent: true, productIds: ids };
}

/**
 * GET /products/voice?productIds=a,b: the products a copy's video is looked
 * up for, 1 to PRODUCT_AD_MAX_PRODUCTS ids. Undefined without the
 * parameter; null for a bad one.
 */
export function parseProductVoiceSourceQuery(
  value: string | null
): string[] | null | undefined {
  if (value === null) return undefined;
  const ids = value.split(",").map(id => id.trim().toLowerCase());
  if (
    ids.length < 1 ||
    ids.length > PRODUCT_AD_MAX_PRODUCTS ||
    !ids.every(isAdObjectId)
  )
    return null;
  return [...new Set(ids)];
}

/**
 * POST /products/ads/[adId]/voice: a request id, a voice mode, an Airi voice
 * exactly with "stock", and any pending free changes as PATCH takes them.
 * Null for any other body.
 */
export function parseProductAdVoiceRequest(
  body: unknown
): ProductAdVoiceRequest | null {
  if (!isObject(body)) return null;
  const known = new Set(["requestId", "voice", "stockVoiceId", "changes"]);
  if (Object.keys(body).some(key => !known.has(key))) return null;
  const requestId =
    typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId || requestId.length > 64) return null;
  if (!(PRODUCT_AD_VOICE_MODES as readonly unknown[]).includes(body.voice))
    return null;
  const voice = body.voice as ProductAdVoiceMode;
  let request: ProductAdVoiceRequest;
  if (voice === "stock") {
    const stock = productAdStockVoice(body.stockVoiceId);
    if (!stock) return null;
    request = { requestId, voice, stockVoiceId: stock.id };
  } else {
    if (body.stockVoiceId !== undefined && body.stockVoiceId !== null)
      return null;
    request = { requestId, voice };
  }
  if (body.changes !== undefined) {
    const changes = parseProductAdUpdateRequest(body.changes);
    if (!changes) return null;
    request.changes = changes;
  }
  return request;
}

/** A sample's language, `?language=kk|ru|en`; English when it's missing. */
export function parseVoiceSampleLanguage(
  value: string | null
): ProductShopWordsCode | null {
  if (value === null || value === "") return "en";
  return (PRODUCT_SHOP_WORDS_CODES as readonly string[]).includes(value)
    ? (value as ProductShopWordsCode)
    : null;
}
