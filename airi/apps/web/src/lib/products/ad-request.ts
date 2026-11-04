import {
  PRODUCT_AD_IDEA_KINDS,
  PRODUCT_AD_IDEA_MAX_LENGTH,
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_AD_MIN_PRODUCTS,
  PRODUCT_AD_PICTURES_KEPT,
  PRODUCT_AD_PLACE_WORDS_MAX,
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_TEXT_LIMITS,
  PRODUCT_AD_TEXT_ZONES,
  PRODUCT_AD_VOICE_MODES,
  productAdStockVoice,
  productAdTextIssues,
  type ProductAdCreateRequest,
  type ProductAdIdeaKind,
  type ProductAdSceneChange,
  type ProductAdSceneRequest,
  type ProductAdScript,
  type ProductAdSetting,
  type ProductAdTextZone,
  type ProductAdUpdateRequest,
  type ProductAdVoiceMode,
} from "@/lib/products/types";
import { isRecord } from "@icecore/shared/lib/value-utils";
import type { ProductAdBox, ProductAdStoredScene } from "@icecore/temporal";

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
  if (!(PRODUCT_AD_VOICE_MODES as readonly unknown[]).includes(body.voice))
    return null;
  const voice = body.voice as ProductAdVoiceMode;
  // An Airi voice is one of the curated ones, named only with "stock".
  if (
    voice === "stock"
      ? !productAdStockVoice(body.stockVoiceId)
      : body.stockVoiceId !== undefined && body.stockVoiceId !== null
  )
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
    voice,
    ...(voice === "stock" ? { stockVoiceId: body.stockVoiceId as string } : {}),
    presenter: { use: presenter.use, consent: presenter.consent },
  };
}

const WORD_FIELDS = ["sticker", "priceCardTitle", "ending"] as const;

const UPDATE_KEYS: ReadonlySet<string> = new Set([
  ...WORD_FIELDS,
  "captions",
  "scenes",
]);

const SCENE_CHANGE_KEYS: ReadonlySet<string> = new Set([
  "productId",
  "textZone",
  "useExact",
  "pictureIndex",
]);

const onlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>) =>
  Object.keys(value).every(key => keys.has(key));

/**
 * One scene's free changes, checked: a known product id, a word zone, the
 * exact photo, a kept picture's index (0 to PRODUCT_AD_PICTURES_KEPT - 1);
 * at least one, and no other keys. Picking a kept picture shows it, so it
 * can't come with the exact photo turned on. Null when it isn't one.
 */
function parseSceneChange(value: unknown): ProductAdSceneChange | null {
  if (!isRecord(value) || !onlyKeys(value, SCENE_CHANGE_KEYS)) return null;
  if (!isAdObjectId(value.productId)) return null;
  const change: ProductAdSceneChange = {
    productId: value.productId.toLowerCase(),
  };
  if (value.textZone !== undefined) {
    if (!(PRODUCT_AD_TEXT_ZONES as readonly unknown[]).includes(value.textZone))
      return null;
    change.textZone = value.textZone as ProductAdTextZone;
  }
  if (value.useExact !== undefined) {
    if (typeof value.useExact !== "boolean") return null;
    change.useExact = value.useExact;
  }
  if (value.pictureIndex !== undefined) {
    const index = value.pictureIndex;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= PRODUCT_AD_PICTURES_KEPT
    )
      return null;
    if (change.useExact === true) return null;
    change.pictureIndex = index;
  }
  return Object.keys(change).length > 1 ? change : null;
}

/** The body of PATCH /products/ads/[adId], checked; null when it isn't one or changes nothing. */
export function parseProductAdUpdateRequest(
  body: unknown
): ProductAdUpdateRequest | null {
  if (!isRecord(body) || !onlyKeys(body, UPDATE_KEYS)) return null;
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
  if (body.scenes !== undefined) {
    const scenes = body.scenes;
    if (
      !Array.isArray(scenes) ||
      scenes.length === 0 ||
      scenes.length > PRODUCT_AD_MAX_PRODUCTS
    )
      return null;
    const parsed: ProductAdSceneChange[] = [];
    for (const entry of scenes) {
      const change = parseSceneChange(entry);
      if (!change) return null;
      parsed.push(change);
    }
    if (new Set(parsed.map(entry => entry.productId)).size !== parsed.length)
      return null;
    changes.scenes = parsed;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

const SCENE_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "requestId",
  "setting",
  "words",
  "changes",
]);

/**
 * The body of POST /products/ads/[adId]/scenes/[productId] ("New picture"),
 * checked: the press's id, exactly one of a tested setting or the owner's
 * place in 1 to PRODUCT_AD_PLACE_WORDS_MAX characters (one line, trimmed),
 * and any pending free changes as PATCH takes them. Null when it isn't one.
 */
export function parseProductAdSceneRequest(
  body: unknown
): ProductAdSceneRequest | null {
  if (!isRecord(body) || !onlyKeys(body, SCENE_REQUEST_KEYS)) return null;
  const requestId =
    typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId || requestId.length > 64) return null;
  const hasSetting = body.setting !== undefined;
  const hasWords = body.words !== undefined;
  if (hasSetting === hasWords) return null;
  const request: ProductAdSceneRequest = { requestId };
  if (hasSetting) {
    if (!(PRODUCT_AD_SETTINGS as readonly unknown[]).includes(body.setting))
      return null;
    request.setting = body.setting as ProductAdSetting;
  } else {
    if (typeof body.words !== "string") return null;
    const words = oneLine(body.words);
    if (!words || length(words) > PRODUCT_AD_PLACE_WORDS_MAX) return null;
    request.words = words;
  }
  if (body.changes !== undefined) {
    const changes = parseProductAdUpdateRequest(body.changes);
    if (!changes) return null;
    request.changes = changes;
  }
  return request;
}

// ---------------------------------------------------------------------------
// The scenes' free changes: a word zone, the exact photo, a kept picture.

const zoneOf = (scene: Pick<ProductAdStoredScene, "textZone">) =>
  scene.textZone ?? "auto";

const sameRef = (
  a: ProductAdStoredScene["muse"] | undefined,
  b: ProductAdStoredScene["muse"] | undefined
) =>
  (a ?? null) === (b ?? null) ||
  (a?.bucket === b?.bucket && a?.path === b?.path);

const sameBox = (a: ProductAdBox | null, b: ProductAdBox | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h);

/**
 * What's wrong with scene changes for these scenes: a product the ad doesn't
 * show, or a kept picture it doesn't have. Empty when they pass.
 */
export function adSceneChangeIssues(
  changes: readonly ProductAdSceneChange[] | undefined,
  scenes: readonly Pick<ProductAdStoredScene, "productId" | "pictures">[]
): string[] {
  return (changes ?? []).flatMap(change => {
    const scene = scenes.find(entry => entry.productId === change.productId);
    if (!scene) return [`${change.productId} isn't one of the ad's scenes.`];
    if (
      change.pictureIndex !== undefined &&
      !scene.pictures?.[change.pictureIndex]
    )
      return [
        `${change.productId} has no kept picture ${change.pictureIndex}.`,
      ];
    return [];
  });
}

/**
 * The scenes with the owner's free changes in: a kept picture becomes the
 * scene's Muse Image picture again (it passed Muse Spark's check when it was
 * made) and turns the exact photo off; the zone and the exact photo are set.
 * Call after adSceneChangeIssues found none.
 */
export function applyAdSceneChanges<Scene extends ProductAdStoredScene>(
  scenes: readonly Scene[],
  changes: readonly ProductAdSceneChange[] | undefined
): Scene[] {
  const byProduct = new Map(
    (changes ?? []).map(entry => [entry.productId, entry])
  );
  return scenes.map(scene => {
    const change = byProduct.get(scene.productId);
    if (!change) return scene;
    const next: Scene = { ...scene };
    const picture =
      change.pictureIndex === undefined
        ? undefined
        : scene.pictures?.[change.pictureIndex];
    if (picture) {
      next.muse = picture.ref;
      next.box = picture.box ?? null;
      next.method = "muse";
      next.check = { same: true, difference: null };
      next.useExact = false;
    }
    if (change.useExact !== undefined) next.useExact = change.useExact;
    if (change.textZone !== undefined) next.textZone = change.textZone;
    return next;
  });
}

/** Whether two versions of the scenes render the same: picture, its box, zone and exact photo. */
export function sameAdScenes(
  a: readonly ProductAdStoredScene[],
  b: readonly ProductAdStoredScene[]
): boolean {
  return (
    a.length === b.length &&
    a.every((scene, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        scene.productId === other.productId &&
        scene.method === other.method &&
        sameRef(scene.muse, other.muse) &&
        sameBox(scene.box ?? null, other.box ?? null) &&
        zoneOf(scene) === zoneOf(other) &&
        (scene.useExact === true) === (other.useExact === true)
      );
    })
  );
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
