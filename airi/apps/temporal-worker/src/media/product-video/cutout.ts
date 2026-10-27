import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteMetaFile as defaultDeleteMetaFile,
  isMetaModelRefusal,
  uploadMetaFile as defaultUploadMetaFile,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import {
  bestMetaSamMask,
  buildObjectPrompt,
  frameIndexOf,
  recordsOfKind,
  segmentMetaImage as samImage,
  segmentMetaVideo as defaultSegmentMetaVideo,
} from "@icecore/airi-runtime/meta-sam";
import sharp from "sharp";
import {
  cropAroundProduct,
  cutOutWithMask,
  nonWhiteBox,
  numberedGrid,
  regionSharpness,
} from "./images";
import { boxProduct, pickProductFrame } from "./locate";
import {
  chooseFrame,
  largestComponent,
  maskArea,
  maskFromRecord,
  touchesEdge,
  type Box,
  type FrameCandidate,
  type Mask,
} from "./masks";
import {
  extractClipFrames,
  extractProductClip,
  ProductVideoError,
  type ProductVideoMediaDeps,
} from "./media";
import { whilePulsing } from "./pulse";
import {
  checkSameProduct,
  restoreProductPhoto,
  type RestoreDeps,
} from "./restore";

const CLIP_FPS = 10;
const GRID_FRAMES = 8;

/**
 * restored: Muse Image's whole, upright product, checked to be the same one.
 * tracked:  the product as filmed, from the best frame SAM tracked it in.
 * phrase:   as filmed, found by its name on one frame when tracking failed.
 * none:     nothing could be cut out; the frame stands in.
 */
export type ProductCutoutMethod = "restored" | "tracked" | "phrase" | "none";

export type ProductCutout = {
  method: ProductCutoutMethod;
  /** Seconds into the video of the frame the photo comes from. */
  frameTimeSeconds: number;
  /** JPEG of the product as filmed, with room around it; the owner compares with this. */
  originalPath: string;
  /** Transparent PNG of the product, or null with method "none". */
  cutoutPath: string | null;
  samConfidence: number | null;
  /** What the owner should know about this photo, in English. */
  notes: string[];
};

export type CutOutProductDeps = RestoreDeps &
  ProductVideoMediaDeps & {
    uploadMetaFile?: typeof defaultUploadMetaFile;
    deleteMetaFile?: typeof defaultDeleteMetaFile;
    segmentMetaVideo?: typeof defaultSegmentMetaVideo;
    segmentMetaImage?: typeof samImage;
  };

export type CutOutProductRequest = {
  /** The prepared, silent video. */
  videoPath: string;
  /** The stretch of the video in which the owner presents this product. */
  window: { fromSeconds: number; toSeconds: number };
  /** Short English name, e.g. "LOL doll". */
  name: string;
  /** Specific English noun phrase for SAM, e.g. "blonde doll in blue dress". */
  samPhrase: string;
  /** Where clips, frames and the results are written. */
  workDir: string;
};

const jpegDataUrl = async (image: Buffer | string) =>
  `data:image/jpeg;base64,${(
    await sharp(image)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toBuffer()
  ).toString("base64")}`;

// Muse Spark picks a frame and boxes the product once; SAM 3.1 follows that
// one object through the clip, and the frame is chosen by measuring its mask in
// every frame. Muse Image then restores what the hand hid, and SAM cuts the
// restored product out again.
export async function cutOutProduct(
  request: CutOutProductRequest,
  deps: CutOutProductDeps = {},
  options?: MetaRequestOptions,
): Promise<ProductCutout> {
  const { workDir } = request;
  const clipPath = join(workDir, "clip.mp4");
  await extractProductClip(
    request.videoPath,
    request.window,
    CLIP_FPS,
    clipPath,
    deps,
  );
  const frames = await extractClipFrames(
    clipPath,
    join(workDir, "frames"),
    deps,
  );
  if (frames.length === 0) {
    throw new ProductVideoError(
      "no_frames",
      `No frames between ${request.window.fromSeconds}s and ${request.window.toSeconds}s`,
    );
  }
  const { width = 0, height = 0 } = await sharp(frames[0]!).metadata();
  const timeOf = (frameIndex: number) =>
    Math.round((request.window.fromSeconds + frameIndex / CLIP_FPS) * 1000) /
    1000;

  const count = Math.min(GRID_FRAMES, frames.length);
  const spread = Array.from({ length: count }, (_, i) =>
    Math.round((i * (frames.length - 1)) / Math.max(1, count - 1)),
  );
  const seed =
    spread[
      await pickProductFrame(
        {
          grid: await numberedGrid(spread.map((i) => frames[i]!)),
          count,
          product: request.samPhrase,
        },
        deps,
        options,
      )
    ]!;
  const box = await boxProduct(
    {
      frame: await readFile(frames[seed]!),
      product: request.samPhrase,
      width,
      height,
    },
    deps,
    options,
  );

  let found: {
    frameIndex: number;
    mask: Mask;
    method: "tracked" | "phrase";
  } | null = null;
  if (box) {
    const best = await trackAndChoose(
      { clipPath, frames, seed, box, width, height },
      deps,
      options,
    );
    if (best) found = { ...best, method: "tracked" };
  }
  if (!found) {
    // Fallback: the product's phrase on the frame Muse picked.
    const imageUrl = await jpegDataUrl(frames[seed]!);
    const { result, costUsd } = await whilePulsing(deps.pulse, () =>
      (deps.segmentMetaImage ?? samImage)(
        { imageUrl, prompt: request.samPhrase },
        options,
      ),
    );
    deps.onCost?.(costUsd, "find product");
    const record = bestMetaSamMask(result.records);
    if (record) {
      const { mask } = largestComponent(maskFromRecord(record));
      if (maskArea(mask) > 0)
        found = { frameIndex: seed, mask, method: "phrase" };
    }
  }

  const originalPath = join(workDir, "original.jpg");
  if (!found) {
    await sharp(frames[seed]!).jpeg({ quality: 90 }).toFile(originalPath);
    return {
      method: "none",
      frameTimeSeconds: timeOf(seed),
      originalPath,
      cutoutPath: null,
      samConfidence: null,
      notes: [
        "The product couldn't be found in the video, so the whole frame is shown.",
      ],
    };
  }

  const framePath = frames[found.frameIndex]!;
  const crop = await cropAroundProduct(framePath, found.mask.bounds);
  await writeFile(originalPath, crop.image);
  const cutoutPath = join(workDir, "cutout.png");
  const base = {
    frameTimeSeconds: timeOf(found.frameIndex),
    originalPath,
    cutoutPath,
    samConfidence: found.mask.confidence,
  };

  const restored = await restoreAndCheck(
    { crop, name: request.name, samPhrase: request.samPhrase },
    deps,
    options,
  );
  if (restored.cutout) {
    await writeFile(cutoutPath, restored.cutout);
    return { ...base, method: "restored", notes: [] };
  }
  await writeFile(cutoutPath, await cutOutWithMask(framePath, found.mask));
  return { ...base, method: found.method, notes: [restored.note] };
}

async function trackAndChoose(
  request: {
    clipPath: string;
    frames: string[];
    seed: number;
    box: Box;
    width: number;
    height: number;
  },
  deps: CutOutProductDeps,
  options?: MetaRequestOptions,
): Promise<FrameCandidate | undefined> {
  const data = await readFile(request.clipPath);
  const { id } = await whilePulsing(deps.pulse, () =>
    (deps.uploadMetaFile ?? defaultUploadMetaFile)(
      { data, filename: "clip.mp4", mimeType: "video/mp4" },
      options,
    ),
  );
  let result: Awaited<ReturnType<typeof defaultSegmentMetaVideo>>["result"];
  try {
    const tracked = await whilePulsing(deps.pulse, () =>
      (deps.segmentMetaVideo ?? defaultSegmentMetaVideo)(
        {
          fileId: id,
          frameCount: request.frames.length,
          prompt: buildObjectPrompt({
            size: { width: request.width, height: request.height },
            objects: [
              { id: 0, prompts: [{ frame: request.seed, box: request.box }] },
            ],
          }),
        },
        options,
      ),
    );
    deps.onCost?.(tracked.costUsd, "track product");
    result = tracked.result;
  } finally {
    // The owner's footage shouldn't stay on Meta's servers; it also expires
    // by itself within a day if this fails.
    await (deps.deleteMetaFile ?? defaultDeleteMetaFile)(id).catch(
      () => undefined,
    );
  }

  const candidates: FrameCandidate[] = [];
  for (const record of recordsOfKind(result.records, "mask")) {
    const frameIndex = frameIndexOf(record) ?? 0;
    const frame = request.frames[frameIndex];
    if (!frame) continue;
    const { mask, share } = largestComponent(maskFromRecord(record));
    const area = maskArea(mask);
    if (area === 0) continue;
    candidates.push({
      frameIndex,
      mask,
      share,
      area,
      touchesEdge: touchesEdge(mask.bounds, request.width, request.height),
      sharpness: await regionSharpness(frame, mask.bounds),
    });
  }
  return chooseFrame(candidates);
}

/**
 * The restored product as a transparent PNG, or why the filmed one is used
 * instead. A provider failure that a retry could fix is thrown, so the
 * activity retries rather than settling for a worse photo.
 */
async function restoreAndCheck(
  request: {
    crop: { image: Buffer; box: Box };
    name: string;
    samPhrase: string;
  },
  deps: CutOutProductDeps,
  options?: MetaRequestOptions,
): Promise<
  { cutout: Buffer; note?: undefined } | { cutout: null; note: string }
> {
  const { crop } = request;
  let restored: Buffer;
  try {
    restored = await restoreProductPhoto(
      {
        crop: crop.image,
        width: crop.box.right - crop.box.left,
        height: crop.box.bottom - crop.box.top,
        product: request.name,
      },
      deps,
      options,
    );
  } catch (error) {
    // Refused by a safety filter: show the product as filmed. Anything else,
    // like a wrong model name, fails loudly instead of quietly downgrading
    // every photo.
    if (isMetaModelRefusal(error)) {
      return {
        cutout: null,
        note: "The photo couldn't be cleaned up, so the hand may still show.",
      };
    }
    throw error;
  }

  const masks = await segmentRestored(
    restored,
    request.samPhrase,
    deps,
    options,
  );
  if (masks.length === 0) {
    return {
      cutout: null,
      note: "The cleaned-up photo didn't show the product, so the original is used.",
    };
  }
  const cutout = await cutOutWithMask(restored, masks, {
    whiteBackground: true,
  });

  // The check sees the cut-out a buyer will see, so a part lost by the cut
  // counts as a difference too.
  const check = await checkSameProduct(
    {
      original: crop.image,
      restored: await sharp(cutout)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 88 })
        .toBuffer(),
      product: request.name,
    },
    deps,
    options,
  );
  if (!check.same) {
    return {
      cutout: null,
      note: `The cleaned-up photo looked different${check.difference ? ` (${check.difference.replace(/\.$/, "")})` : ""}, so the original is used.`,
    };
  }
  return { cutout };
}

/**
 * The restored product's masks, from two prompts joined: the box around
 * everything that isn't white (on Muse's white background, the product) and
 * the product's name. Each alone lost parts in tests: asked for "phone stand",
 * SAM cut out only the stand's base; shown the toy phone's box, only its
 * frame. Nothing else is in the picture, so joining them is safe.
 */
async function segmentRestored(
  image: Buffer,
  samPhrase: string,
  deps: CutOutProductDeps,
  options?: MetaRequestOptions,
): Promise<Mask[]> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const box = await nonWhiteBox(image);
  if (!box) return [];
  const imageUrl = await jpegDataUrl(image);
  const prompts = [
    buildObjectPrompt({
      size: { width, height },
      objects: [{ id: 0, prompts: [{ frame: 0, box }] }],
    }),
    samPhrase,
  ];
  const results = await whilePulsing(deps.pulse, () =>
    Promise.all(
      prompts.map((prompt) =>
        (deps.segmentMetaImage ?? samImage)({ imageUrl, prompt }, options),
      ),
    ),
  );
  const masks: Mask[] = [];
  for (const { result, costUsd } of results) {
    deps.onCost?.(costUsd, "cut out restored photo");
    const record = bestMetaSamMask(result.records);
    const mask = record ? maskFromRecord(record) : null;
    if (mask && maskArea(mask) > 0) masks.push(mask);
  }
  return masks;
}
