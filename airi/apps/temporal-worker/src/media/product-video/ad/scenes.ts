import {
  editMetaImage,
  isMetaModelRefusal,
  MetaModelApiError,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import {
  bestMetaSamMask,
  segmentMetaImage as samImage,
} from "@icecore/airi-runtime/meta-sam";
import type {
  ProductAdBox,
  ProductAdFileRef,
  ProductAdSetting,
  ProductAdStoredScene,
} from "@icecore/temporal";
import sharp from "sharp";
import type { AskMuseDeps } from "../ask-muse";
import { jpegDataUrl } from "../images";
import { whilePulsing } from "../pulse";
import {
  checkSameProduct,
  cutoutForMuse,
  type SameProductAnswer,
} from "../restore";
import { settingWords } from "./script";
import { AdSpendRefusal, type PaidCall } from "./spend";

// Each product's scene: Muse Image 1.0 places the owner's real, restored
// product in a setting the script chose, then Muse Spark checks the scene
// still shows the same product. A mismatch gets one more try with the
// difference named; a refusal, a second mismatch or a spend refusal leaves
// the exact still (the cut-out on the code-drawn wall), so the price is never
// shown on a product that isn't the owner's. SAM 3.1 then boxes the product
// in the chosen scene, for the camera's push-in and the words' places.

/** Muse Image calls per product per ad: the first and one retry. */
export const MAX_SCENE_ATTEMPTS = 2;

// Reservations per call, in micro-dollars: Muse Image's list price, a Muse
// Spark look at two pictures, and SAM's list price for an image.
export const SCENE_MAX_COST_MICROS = 10_000;
export const CHECK_MAX_COST_MICROS = 10_000;
export const SAM_MAX_COST_MICROS = 2_500;

/** Muse Image's size for a scene: portrait 2:3, cut to 9:16 around the product. */
const SCENE_SIZE = "1024x1536";

export type SceneDeps = AskMuseDeps & {
  editMetaImage?: typeof editMetaImage;
  segmentMetaImage?: typeof samImage;
  checkSameProduct?: typeof checkSameProduct;
};

/**
 * Muse Image's instruction. The words came from the spec's tests on the toy
 * shelf: the product stays as photographed, the top third stays a calm wall
 * for the ad's words, and no text or price is painted in. The paid gate
 * (2026-11-02) found "half of its width" made tall and wide products fill the
 * picture up into the words and past the 9:16 cut's sides, and "medium-sized,
 * below the upper third" still let a figure standing on a table reach up to
 * 17%; asked for about half the picture's height, the whole product counted,
 * the orteke table's deer topped out at the upper third (the Shezhire panel
 * at 25%, from 19%).
 */
export function scenePrompt(
  setting: ProductAdSetting,
  product: string,
  difference: string | null,
): string {
  return (
    `Advertising photo of a shop's product. Place this exact ${product} unchanged on ${settingWords(setting)}, ` +
    `in soft daylight from the left. Show the whole product upright, including anything that stands on it, in the lower ` +
    `half of the picture: it takes up about half of the picture's height, its base about nine tenths of the way down, with ` +
    `empty space on its left and right, so nothing of it is cut off. Keep the upper part of the picture, above the product, ` +
    `a calm, out-of-focus wall with nothing on it, as space for words. ` +
    `Add no text, prices, labels, logos, people or hands. Keep the product's shape, proportions, colours, print and ` +
    `lettering exactly as in the photo; it is a real item for sale, so do not retouch, beautify or change it. ` +
    (difference
      ? `The last picture changed the product: ${difference} Keep that exactly as in the photo this time.`
      : "")
  ).trim();
}

export type SceneProduct = {
  productId: string;
  /** What the product is, in English, for the prompts. */
  description: string;
  samPhrase: string;
  /** The transparent cut-out on the shelf. */
  cutout: Buffer;
  /** The product as filmed, which the check compares the scene with; null to use the cut-out. */
  original: Buffer | null;
};

export type SceneJob = {
  paid: PaidCall;
  /** Saves the scene's state; called before each Muse Image call and after each change. */
  save(scene: ProductAdStoredScene): Promise<void>;
  /** Stores a scene picture that passed the check. */
  storeScene(
    productId: string,
    attempt: number,
    jpeg: Buffer,
  ): Promise<ProductAdFileRef>;
  deps?: SceneDeps;
  options?: MetaRequestOptions;
};

export type SceneOutcome = {
  scene: ProductAdStoredScene;
  /** The picture the scene uses, when it is Muse Image's (as JPEG). */
  picture: Buffer | null;
  /** The ledger refused a reservation: the other products should stop paying too. */
  refused: AdSpendRefusal | null;
};

const asJpeg = (image: Buffer) =>
  sharp(image)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

/**
 * Makes one product's Muse Image scene, from where its saved state left it:
 * a scene already checked is kept; otherwise up to the attempts left, each
 * counted (and saved) before its call so a retried run never reuses one.
 * Anything short of a checked scene leaves the exact still.
 */
export async function makeMuseScene(
  product: SceneProduct,
  setting: ProductAdSetting,
  saved: ProductAdStoredScene,
  job: SceneJob,
): Promise<SceneOutcome> {
  const scene: ProductAdStoredScene = { ...saved };
  if (scene.method === "muse" && scene.muse)
    return { scene, picture: null, refused: null };
  const photo = await cutoutForMuse(product.cutout);
  const original = product.original
    ? await sharp(product.original).jpeg({ quality: 90 }).toBuffer()
    : photo;
  const deps = job.deps ?? {};
  let difference =
    scene.check && !scene.check.same ? scene.check.difference : null;
  let refused: AdSpendRefusal | null = null;

  while (scene.attempts < MAX_SCENE_ATTEMPTS) {
    const attempt = scene.attempts + 1;
    scene.attempts = attempt;
    await job.save({ ...scene });
    let picture: Buffer;
    try {
      picture = await job.paid(
        `scene:${product.productId}:a${attempt}`,
        "meta",
        SCENE_MAX_COST_MICROS,
        async (onCost) => {
          const result = await whilePulsing(deps.pulse, () =>
            (deps.editMetaImage ?? editMetaImage)(
              {
                prompt: scenePrompt(setting, product.description, difference),
                images: [{ data: photo, mimeType: "image/jpeg" }],
              },
              { ...job.options, size: SCENE_SIZE },
            ),
          );
          onCost(result.costUsd, "ad scene");
          return { value: await asJpeg(result.image) };
        },
      );
    } catch (error) {
      if (error instanceof AdSpendRefusal) {
        refused = error;
        break;
      }
      // A refusal of the content is final for this product; an outage may
      // pass on the next try.
      if (isMetaModelRefusal(error)) break;
      if (error instanceof MetaModelApiError) continue;
      throw error;
    }

    let check: SameProductAnswer;
    try {
      check = await job.paid(
        `check:${product.productId}:a${attempt}`,
        "meta",
        CHECK_MAX_COST_MICROS,
        async (onCost) => ({
          value: await (deps.checkSameProduct ?? checkSameProduct)(
            { original, restored: picture, product: product.description },
            { ...deps, onCost },
            job.options,
          ),
        }),
      );
    } catch (error) {
      if (error instanceof AdSpendRefusal) {
        refused = error;
        break;
      }
      // An unchecked scene is never shown.
      if (error instanceof MetaModelApiError) continue;
      throw error;
    }
    scene.check = { same: check.same, difference: check.difference };
    if (check.same) {
      scene.muse = await job.storeScene(product.productId, attempt, picture);
      scene.method = "muse";
      // The exact still's box doesn't describe this picture: framing finds it.
      scene.box = null;
      await job.save({ ...scene });
      return { scene, picture, refused: null };
    }
    difference = check.difference;
    await job.save({ ...scene });
  }
  scene.method = "exact";
  await job.save({ ...scene });
  return { scene, picture: null, refused };
}

/** How much taller than SAM's box the product's own shape must be to grow it. */
const SHAPE_GROWS_AT = 1.15;

/**
 * SAM's box grown to the whole product. SAM can box part of one: on the
 * paid gate it boxed the orteke table's top, not the deer standing on it,
 * so the words went over the deer in the band that looked free above. The
 * cut-out has the product's whole shape (`shape`, its opaque size): a box
 * much flatter than that shape grows up, where things stand on a product,
 * to the shape's height at the box's width. Never smaller, never past the
 * picture's top.
 */
export function wholeProductBox(
  box: ProductAdBox,
  picture: { width: number; height: number },
  shape: { width: number; height: number } | null,
): ProductAdBox {
  if (!shape || shape.width <= 0 || shape.height <= 0) return box;
  const height = box.h * picture.height;
  const expected = box.w * picture.width * (shape.height / shape.width);
  if (expected <= height * SHAPE_GROWS_AT) return box;
  const bottom = box.y + box.h;
  const h = Math.min(bottom, expected / picture.height);
  return { ...box, y: bottom - h, h };
}

/**
 * SAM 3.1's box of the product in a scene, as fractions of the picture; null
 * when SAM finds nothing that size. One call: framing is a nicety, and a
 * scene without a box is cut around its centre. With the cut-out's `shape`,
 * a box of only part of the product grows to the whole (wholeProductBox).
 */
export async function frameScene(
  picture: Buffer,
  samPhrase: string,
  deps: SceneDeps & { onCost?: (usd: number, what: string) => void } = {},
  options?: MetaRequestOptions,
  shape: { width: number; height: number } | null = null,
): Promise<ProductAdBox | null> {
  const meta = await sharp(picture).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return null;
  const { result, costUsd } = await whilePulsing(deps.pulse, async () =>
    (deps.segmentMetaImage ?? samImage)(
      { imageUrl: await jpegDataUrl(picture), prompt: samPhrase },
      options,
    ),
  );
  deps.onCost?.(costUsd, "frame ad scene");
  const record = bestMetaSamMask(result.records);
  if (!record) return null;
  const box = {
    x: Math.max(0, record.bounds.left) / width,
    y: Math.max(0, record.bounds.top) / height,
    w:
      (Math.min(width, record.bounds.right) - Math.max(0, record.bounds.left)) /
      width,
    h:
      (Math.min(height, record.bounds.bottom) -
        Math.max(0, record.bounds.top)) /
      height,
  };
  // A sliver isn't the product.
  return box.w >= 0.05 && box.h >= 0.05
    ? wholeProductBox(box, { width, height }, shape)
    : null;
}
