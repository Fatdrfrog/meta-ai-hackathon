import {
  editMetaImage,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import { askMuseAboutImages, type AskMuseDeps } from "./ask-muse";

// The owner holds every product while filming, so the hand always hides part
// of it. Muse Image redraws the product whole, upright, on white; a second
// look by Muse Spark checks it is still the same product before it's used.

export type RestoreDeps = AskMuseDeps & {
  editMetaImage?: typeof editMetaImage;
};

// Without the last two sentences Muse left a cup tilted the way it was held
// and cleaned up a doll's paint marks; with them it stood the cup upright and
// kept the marks.
export function restorePrompt(product: string): string {
  return (
    `Product photo cleanup of a ${product}. Remove the person's hand and fingers completely. ` +
    `Where the hand covered the ${product}, restore the hidden part so the product is whole, ` +
    `continuing its exact shape, color, material and any print or logo. Do not change anything else ` +
    `about the product: same position, size, angle, colors, text and details. ` +
    `Replace everything around the product with a plain pure white background. No shadow, no new objects. ` +
    `Show the product standing upright and straight, seen from the front, centred. ` +
    `This is a real item for sale: do not retouch, beautify or idealise it; keep its real wear, scuffs, ` +
    `paint marks and imperfections exactly as they are.`
  );
}

/** Muse Image's size for a crop: the ratio closest to its shape. */
export function restoreSize(width: number, height: number): string {
  const ratio = width / Math.max(1, height);
  if (ratio < 0.8) return "1024x1536";
  if (ratio > 1.25) return "1536x1024";
  return "1024x1024";
}

/** The product redrawn whole, upright and on white, as an opaque PNG. */
export async function restoreProductPhoto(
  request: { crop: Buffer; width: number; height: number; product: string },
  deps: RestoreDeps = {},
  options?: MetaRequestOptions,
): Promise<Buffer> {
  const result = await (deps.editMetaImage ?? editMetaImage)(
    {
      prompt: restorePrompt(request.product),
      images: [{ data: request.crop, mimeType: "image/jpeg" }],
    },
    { ...options, size: restoreSize(request.width, request.height) },
  );
  deps.onCost?.(result.costUsd, "restore photo");
  return result.image;
}

export type SameProductAnswer = {
  same: boolean;
  /** What a buyer would see differently, when not the same. */
  difference: string | null;
};

/** Whether the restored photo still shows the product from the video. */
export async function checkSameProduct(
  request: { original: Buffer; restored: Buffer; product: string },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<SameProductAnswer> {
  const answer = await askMuseAboutImages<SameProductAnswer>(
    {
      images: [request.original, request.restored],
      question:
        `Image 1 is a frame from a shop owner's video showing a ${request.product}, possibly held in a hand. ` +
        `Image 2 is a cleaned-up product photo made from it: the hand removed, the hidden part restored, ` +
        `the background replaced with white, the product turned upright. Is image 2 the same product as image 1, ` +
        `with the same type, shape, colours, print and details? Answer same=false only if a buyer who received ` +
        `the item in image 1 would feel misled by image 2; then say what differs in one short English sentence ` +
        `as difference, otherwise difference=null.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["same", "difference"],
        properties: {
          same: { type: "boolean" },
          difference: { type: ["string", "null"] },
        },
      },
      purpose: "same product check",
    },
    deps,
    options,
  );
  return {
    same: answer.same === true,
    difference:
      typeof answer.difference === "string" && answer.difference.trim()
        ? answer.difference.trim().slice(0, 300)
        : null,
  };
}
