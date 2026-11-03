import {
  PRODUCT_AD_IDEA_KINDS,
  PRODUCT_AD_IDEA_MAX_LENGTH,
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_AD_MIN_PRODUCTS,
  PRODUCT_AD_TEXT_LIMITS,
  PRODUCT_AD_VOICES,
  productAdTextIssues,
  type ProductAdCreateRequest,
  type ProductAdIdeaKind,
  type ProductAdScript,
  type ProductAdUpdateRequest,
  type ProductAdVoice,
} from "@/lib/products/types";
import { isRecord } from "@icecore/shared/lib/value-utils";

// What the ad API takes, checked, and the owner's edits to the words on
// screen, checked like the script and applied to it. Pure, so the routes and
// their tests use it without the server's models.

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Whether a value is a product or ad id: 24 hex characters. */
export const isAdObjectId = (value: unknown): value is string =>
  typeof value === "string" && OBJECT_ID.test(value);

/** One line of text: whitespace collapsed, ends trimmed. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const length = (text: string) => Array.from(text).length;

/** The ids an ad is asked for: 1 to 3 distinct product ids; null otherwise. */
export function parseAdProductIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (
    value.length < PRODUCT_AD_MIN_PRODUCTS ||
    value.length > PRODUCT_AD_MAX_PRODUCTS
  )
    return null;
  if (!value.every(isAdObjectId)) return null;
  const ids = value.map(id => id.toLowerCase());
  return new Set(ids).size === ids.length ? ids : null;
}

/** The body of POST /products/ads, checked; null when it isn't one. */
export function parseProductAdCreateRequest(
  body: unknown
): ProductAdCreateRequest | null {
  if (!isRecord(body)) return null;
  const requestId =
    typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId || requestId.length > 64) return null;
  const productIds = parseAdProductIds(body.productIds);
  if (!productIds) return null;
  const idea = isRecord(body.idea) ? body.idea : null;
  if (
    !idea ||
    !(PRODUCT_AD_IDEA_KINDS as readonly unknown[]).includes(idea.kind)
  )
    return null;
  const kind = idea.kind as ProductAdIdeaKind;
  let text: string | undefined;
  if (kind === "own") {
    text = typeof idea.text === "string" ? oneLine(idea.text) : "";
    if (!text || length(text) > PRODUCT_AD_IDEA_MAX_LENGTH) return null;
  }
  if (!(PRODUCT_AD_VOICES as readonly unknown[]).includes(body.voice))
    return null;
  const presenter = isRecord(body.presenter) ? body.presenter : null;
  if (
    !presenter ||
    typeof presenter.use !== "boolean" ||
    typeof presenter.consent !== "boolean"
  )
    return null;
  // The person from the video appears only with the owner's word that they agreed.
  if (presenter.use && !presenter.consent) return null;
  return {
    requestId,
    productIds,
    idea: text === undefined ? { kind } : { kind, text },
    voice: body.voice as ProductAdVoice,
    presenter: { use: presenter.use, consent: presenter.consent },
  };
}

const WORD_FIELDS = ["sticker", "priceCardTitle", "ending"] as const;

/** The body of PATCH /products/ads/[adId], checked; null when it isn't one or changes nothing. */
export function parseProductAdUpdateRequest(
  body: unknown
): ProductAdUpdateRequest | null {
  if (!isRecord(body)) return null;
  const changes: ProductAdUpdateRequest = {};
  for (const field of WORD_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    changes[field] = oneLine(value);
  }
  if (body.captions !== undefined) {
    const captions = body.captions;
    if (
      !Array.isArray(captions) ||
      captions.length === 0 ||
      captions.length > PRODUCT_AD_MAX_PRODUCTS
    )
      return null;
    const parsed: Array<{ productId: string; caption: string }> = [];
    for (const entry of captions) {
      if (
        !isRecord(entry) ||
        !isAdObjectId(entry.productId) ||
        typeof entry.caption !== "string"
      )
        return null;
      parsed.push({
        productId: entry.productId.toLowerCase(),
        caption: oneLine(entry.caption),
      });
    }
    if (new Set(parsed.map(entry => entry.productId)).size !== parsed.length)
      return null;
    changes.captions = parsed;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * What's wrong with the owner's edits, by the script's own checks (no
 * digits or currency, the safe band's lines, letters the fonts draw), and a
 * caption for a product the ad doesn't show. Empty when they pass.
 */
export function adWordsIssues(
  changes: ProductAdUpdateRequest,
  productIds: readonly string[]
): string[] {
  const limits = PRODUCT_AD_TEXT_LIMITS;
  return [
    ...(changes.sticker === undefined
      ? []
      : productAdTextIssues("sticker", changes.sticker, limits.sticker)),
    ...(changes.captions ?? []).flatMap(({ productId, caption }) =>
      productIds.includes(productId)
        ? productAdTextIssues(
            `caption of ${productId}`,
            caption,
            limits.caption
          )
        : [`${productId} isn't one of the ad's products.`]
    ),
    ...(changes.priceCardTitle === undefined
      ? []
      : productAdTextIssues(
          "priceCardTitle",
          changes.priceCardTitle,
          limits.priceCardTitle
        )),
    ...(changes.ending === undefined
      ? []
      : productAdTextIssues("ending", changes.ending, limits.ending)),
  ];
}

/** The script with the owner's edits in, marked as edited. */
export function applyAdWords(
  script: ProductAdScript,
  changes: ProductAdUpdateRequest
): ProductAdScript {
  const captions = new Map(
    (changes.captions ?? []).map(entry => [entry.productId, entry.caption])
  );
  return {
    ...script,
    sticker: changes.sticker ?? script.sticker,
    scenes: script.scenes.map(scene => ({
      ...scene,
      caption: captions.get(scene.productId) ?? scene.caption,
    })),
    priceCardTitle: changes.priceCardTitle ?? script.priceCardTitle,
    ending: changes.ending ?? script.ending,
    edited: true,
  };
}

/** Whether two scripts put the same words on screen. */
export const sameAdWords = (a: ProductAdScript, b: ProductAdScript) =>
  a.sticker === b.sticker &&
  a.priceCardTitle === b.priceCardTitle &&
  a.ending === b.ending &&
  a.scenes.every((scene, index) => scene.caption === b.scenes[index]?.caption);
