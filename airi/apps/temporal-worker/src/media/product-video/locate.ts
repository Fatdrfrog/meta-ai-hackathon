import type { MetaRequestOptions } from "@icecore/airi-runtime/meta-model-api";
import { askMuseAboutImages, type AskMuseDeps } from "./ask-muse";
import type { Box } from "./masks";

/** Muse Spark chooses which numbered frame of a grid shows the product best. Returns a 0-based index. */
export async function pickProductFrame(
  request: { grid: Buffer; count: number; product: string },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<number> {
  const answer = await askMuseAboutImages<{ best: number }>(
    {
      images: [request.grid],
      question: `These are ${request.count} numbered frames from a video in which a shop owner shows a ${request.product}. Which frame shows the whole ${request.product} most clearly: in view and not cut off, sharp, and least covered by the hand?`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["best"],
        properties: { best: { type: "integer" } },
      },
      purpose: "pick frame",
    },
    deps,
    options,
  );
  const best = Number.isFinite(answer.best) ? Math.round(answer.best) : 1;
  return Math.min(request.count - 1, Math.max(0, best - 1));
}

/**
 * Whether a crop shows the product itself as its main subject. Tracking can
 * end on the wrong thing: in an edited promo, SAM followed the product across
 * a cut onto a subtitle.
 */
export async function showsProduct(
  request: { image: Buffer; product: string },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<boolean> {
  const answer = await askMuseAboutImages<{ shows: boolean }>(
    {
      images: [request.image],
      question: `This crop from a shop's video should show a ${request.product}. Is that product its main subject, even if a hand, a person or a caption covers part of it, or it is cut off at an edge? Answer false if the crop mainly shows something else, like text, a person or a different item.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["shows"],
        properties: { shows: { type: "boolean" } },
      },
      purpose: "check crop",
    },
    deps,
    options,
  );
  return answer.shows === true;
}

export type NormalizedBox = {
  visible: boolean;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
};

/** A 0-1000 box from the model in pixels, or null when it is missing or too small to track. */
export function boxInPixels(
  box: NormalizedBox,
  width: number,
  height: number,
): Box | null {
  if (!box.visible) return null;
  const px = (value: number, size: number) =>
    Math.min(size, Math.max(0, Math.round((value / 1000) * size)));
  const result = {
    left: px(box.x_min, width),
    top: px(box.y_min, height),
    right: px(box.x_max, width),
    bottom: px(box.y_max, height),
  };
  return result.right - result.left >= 8 && result.bottom - result.top >= 8
    ? result
    : null;
}

// Asked on one full-size frame: inside a grid, the model answers in the grid's
// coordinates.
export async function boxProduct(
  request: { frame: Buffer; product: string; width: number; height: number },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<Box | null> {
  const answer = await askMuseAboutImages<NormalizedBox>(
    {
      images: [request.frame],
      question: `Give the bounding box of the ${request.product} in this photo, normalized to 0-1000 (x across, y down), tight around the object itself, not the hand holding it. visible=false if it is not in the photo.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["visible", "x_min", "y_min", "x_max", "y_max"],
        properties: {
          visible: { type: "boolean" },
          x_min: { type: "number" },
          y_min: { type: "number" },
          x_max: { type: "number" },
          y_max: { type: "number" },
        },
      },
      purpose: "box product",
    },
    deps,
    options,
  );
  return boxInPixels(answer, request.width, request.height);
}
