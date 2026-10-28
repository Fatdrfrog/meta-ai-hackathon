import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  editMetaImage,
  isMetaModelRefusal,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import {
  bestMetaSamMask,
  segmentMetaImage as samImage,
} from "@icecore/airi-runtime/meta-sam";
import sharp from "sharp";
import { askMuseAboutImages } from "./ask-muse";
import { segmentRestored, type CutOutProductDeps } from "./cutout";
import {
  backdropColor,
  cropAroundProduct,
  cutOutWithMask,
  isMostlyLight,
  jpegDataUrl,
  numberedGrid,
} from "./images";
import { largestComponent, maskArea, maskFromRecord, type Box } from "./masks";
import { extractClipFrames, extractProductClip } from "./media";
import { whilePulsing } from "./pulse";
import { backdropWords, restoreSize, type RestoreBackdrop } from "./restore";

// Shops often film a person presenting the products: the owner, or someone
// presenting for them. Their cut-out is kept with the import as an asset to
// place beside the products later, for example as an avatar on carousel
// cards. An edited promo lays subtitles over them in almost every frame, so
// Muse Image removes those, keeping the person exactly as filmed; when Muse
// Spark sees anything about the person changed, the filmed cut-out is kept.

const FPS = 5;
const WINDOW_SECONDS = 4;
const GRID_FRAMES = 8;

export type PresenterCutoutDeps = CutOutProductDeps;

export type PresenterCutout = {
  /** Seconds into the video of the frame the cut-out comes from. */
  frameTimeSeconds: number;
  /** JPEG of the person as filmed, with room around them. */
  originalPath: string;
  /** Transparent PNG of the person. */
  cutoutPath: string;
  /** Whether the overlays were removed; false when the filmed cut-out is kept. */
  cleaned: boolean;
};

export function presenterPrompt(backdrop: RestoreBackdrop): string {
  return (
    `Photo cleanup of this person, who presents a shop's products. Remove every caption, subtitle, logo, ` +
    `price sticker and graphic laid over the video, and anything the person holds up, restoring what they ` +
    `covered. Keep the person exactly as they are: the same face and expression, headscarf or hair, clothes, ` +
    `jewellery, hands and pose. Do not retouch, beautify or change them. Replace everything around the ` +
    `person with ${backdropWords(backdrop)}. No shadow, no new objects.`
  );
}

/**
 * The person presenting the products, from the clearest of a few frames
 * around the moment Muse Spark named; null when no one can be cut out.
 */
export async function cutOutPresenter(
  request: {
    videoPath: string;
    momentSeconds: number;
    durationSeconds: number;
    workDir: string;
  },
  deps: PresenterCutoutDeps = {},
  options?: MetaRequestOptions,
): Promise<PresenterCutout | null> {
  const fromSeconds = Math.max(
    0,
    Math.min(
      request.momentSeconds - WINDOW_SECONDS / 2,
      request.durationSeconds - WINDOW_SECONDS,
    ),
  );
  const window = {
    fromSeconds,
    toSeconds: Math.min(request.durationSeconds, fromSeconds + WINDOW_SECONDS),
  };
  const clipPath = join(request.workDir, "clip.mp4");
  await extractProductClip(request.videoPath, window, FPS, clipPath, deps);
  const frames = await extractClipFrames(
    clipPath,
    join(request.workDir, "frames"),
    deps,
  );
  if (frames.length === 0) return null;

  const count = Math.min(GRID_FRAMES, frames.length);
  const spread = Array.from({ length: count }, (_, i) =>
    Math.round((i * (frames.length - 1)) / Math.max(1, count - 1)),
  );
  const answer = await askMuseAboutImages<{ best: number }>(
    {
      images: [await numberedGrid(spread.map((i) => frames[i]!))],
      question: `These are ${count} numbered frames from a shop's video in which a person presents products. Which frame shows that person most clearly: facing the camera, head and upper body fully in view, and least covered by products, hands, captions or graphics?`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["best"],
        properties: { best: { type: "integer" } },
      },
      purpose: "pick presenter frame",
    },
    deps,
    options,
  );
  const pick = Number.isFinite(answer.best) ? Math.round(answer.best) : 1;
  const frameIndex = spread[Math.min(count - 1, Math.max(0, pick - 1))]!;
  const framePath = frames[frameIndex]!;

  const { result, costUsd } = await whilePulsing(deps.pulse, async () =>
    (deps.segmentMetaImage ?? samImage)(
      { imageUrl: await jpegDataUrl(framePath), prompt: "person" },
      options,
    ),
  );
  deps.onCost?.(costUsd, "find presenter");
  const record = bestMetaSamMask(result.records);
  if (!record) return null;
  const { mask } = largestComponent(maskFromRecord(record));
  if (maskArea(mask) === 0) return null;

  const originalPath = join(request.workDir, "original.jpg");
  const cutoutPath = join(request.workDir, "cutout.png");
  const crop = await cropAroundProduct(framePath, mask.bounds, 0.1);
  const filmed = await cutOutWithMask(framePath, mask);
  const cleaned = await cleanUpPresenter({ crop, filmed }, deps, options);
  await writeFile(originalPath, crop.image);
  await writeFile(cutoutPath, cleaned ?? filmed);
  return {
    frameTimeSeconds:
      Math.round((window.fromSeconds + frameIndex / FPS) * 1000) / 1000,
    originalPath,
    cutoutPath,
    cleaned: cleaned !== null,
  };
}

/** The presenter without the video's overlays, cut out; null to keep the filmed cut-out. */
async function cleanUpPresenter(
  request: {
    crop: { image: Buffer; box: Box };
    filmed: Buffer;
  },
  deps: PresenterCutoutDeps,
  options?: MetaRequestOptions,
): Promise<Buffer | null> {
  const { crop } = request;
  const backdrop = (await isMostlyLight(request.filmed)) ? "grey" : "white";
  let restored: Buffer;
  try {
    const result = await whilePulsing(deps.pulse, () =>
      (deps.editMetaImage ?? editMetaImage)(
        {
          prompt: presenterPrompt(backdrop),
          images: [{ data: crop.image, mimeType: "image/jpeg" }],
        },
        {
          ...options,
          size: restoreSize(
            crop.box.right - crop.box.left,
            crop.box.bottom - crop.box.top,
          ),
        },
      ),
    );
    deps.onCost?.(result.costUsd, "clean up presenter");
    restored = result.image;
  } catch (error) {
    if (isMetaModelRefusal(error)) return null;
    throw error;
  }

  const color = await backdropColor(restored);
  const masks = await segmentRestored(restored, "person", color, deps, options);
  if (masks.length === 0) return null;
  const cutout = await cutOutWithMask(restored, masks, { backdrop: color });
  const answer = await askMuseAboutImages<{ same: boolean }>(
    {
      images: [
        crop.image,
        await sharp(cutout)
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 88 })
          .toBuffer(),
      ],
      question:
        `Image 1 is a frame from a shop's video showing a person, possibly with captions or graphics over it. ` +
        `Image 2 is a cleaned-up photo made from it: overlaid captions and graphics removed and the background replaced. ` +
        `Is image 2 the same person exactly as in image 1: the same face, expression, headscarf or hair, clothes, ` +
        `jewellery and pose? Removed captions, graphics, held items and background are not differences. ` +
        `Answer same=false if anything about the person themselves was changed or lost.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["same"],
        properties: { same: { type: "boolean" } },
      },
      purpose: "same presenter check",
    },
    deps,
    options,
  );
  return answer.same === true ? cutout : null;
}
