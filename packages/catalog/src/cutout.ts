import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bestMask,
  buildObjectPrompt,
  frameIndexOf,
  recordsOfKind,
  segmentImage,
  segmentVideo,
  type MetaClient,
} from "@vitrina/meta";
import sharp from "sharp";
import { cutOutMask, numberedGrid, regionSharpness } from "./images.ts";
import { boxProduct, pickFrame } from "./locate.ts";
import {
  chooseFrame,
  largestComponent,
  maskArea,
  maskFromRecord,
  subtractMask,
  touchesEdge,
  type Box,
  type FrameCandidate,
  type Mask,
} from "./masks.ts";
import { extractAllFrames, extractClip } from "./media.ts";

const CLIP_FPS = 10;
const GRID_FRAMES = 8;

export type CutoutMethod = "tracked" | "phrase" | "none";

export interface ProductCutout {
  readonly framePath: string;
  readonly frameTimeS: number;
  /** Transparent PNG of the product, or null when nothing could be cut out. */
  readonly cutoutPath: string | null;
  readonly confidence: number | null;
  readonly method: CutoutMethod;
}

export interface CutOutProductOptions {
  readonly meta: MetaClient;
  /** The muted, normalized video. */
  readonly videoPath: string;
  /** The stretch of the video in which the owner presents this product. */
  readonly fromS: number;
  readonly toS: number;
  /** Specific English noun phrase, e.g. "pink toy phone". */
  readonly product: string;
  readonly workDir: string;
  readonly outPath: string;
}

const dataUrl = (path: string) => `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`;

// Muse Spark locates the product once; SAM 3.1 follows that one object through the clip; the
// frame is chosen by measuring its mask in every frame, not by guessing. Choosing a frame by the
// sharpness of the whole picture picked sharp backgrounds behind blurred products, and phrase
// prompts alone missed some products entirely (docs/findings.md).
export async function cutOutProduct(options: CutOutProductOptions): Promise<ProductCutout> {
  const { meta, product, workDir } = options;
  const clip = join(workDir, "clip.mp4");
  await extractClip(options.videoPath, options.fromS, options.toS, CLIP_FPS, clip);
  const frames = await extractAllFrames(clip, join(workDir, "frames"));
  if (frames.length === 0) throw new Error(`No frames between ${options.fromS}s and ${options.toS}s.`);
  const { width = 0, height = 0 } = await sharp(frames[0]!).metadata();
  const at = (index: number) => options.fromS + index / CLIP_FPS;

  const count = Math.min(GRID_FRAMES, frames.length);
  const spread = Array.from({ length: count }, (_, i) => Math.round((i * (frames.length - 1)) / Math.max(1, count - 1)));
  const grid = join(workDir, "grid.jpg");
  await numberedGrid(spread.map((i) => frames[i]!), grid);
  const seed = spread[await pickFrame(meta, grid, spread.length, product)]!;
  const box = await boxProduct(meta, frames[seed]!, product, width, height);

  if (box) {
    const best = await trackAndChoose(meta, clip, frames, seed, box, width, height);
    if (best) {
      const mask = await withoutHands(meta, frames[best.frameIndex]!, best.mask);
      await cutOutMask(frames[best.frameIndex]!, mask, options.outPath);
      return { framePath: frames[best.frameIndex]!, frameTimeS: at(best.frameIndex), cutoutPath: options.outPath, confidence: best.mask.confidence, method: "tracked" };
    }
  }

  // Fallback: the product's phrase on the frame Muse picked.
  const record = bestMask((await segmentImage(meta, { imageUrl: dataUrl(frames[seed]!), concept: product })).records);
  if (record) {
    const { mask } = largestComponent(maskFromRecord(record));
    await cutOutMask(frames[seed]!, mask, options.outPath);
    return { framePath: frames[seed]!, frameTimeS: at(seed), cutoutPath: options.outPath, confidence: mask.confidence, method: "phrase" };
  }
  return { framePath: frames[seed]!, frameTimeS: at(seed), cutoutPath: null, confidence: null, method: "none" };
}

async function trackAndChoose(
  meta: MetaClient,
  clip: string,
  frames: readonly string[],
  seed: number,
  box: Box,
  width: number,
  height: number,
): Promise<FrameCandidate | undefined> {
  const { id } = await meta.uploadFile(clip, "video/mp4");
  const tracked = await segmentVideo(meta, {
    fileId: id,
    frameCount: frames.length,
    concept: buildObjectPrompt({ size: { width, height }, objects: [{ id: 0, prompts: [{ frame: seed, box }] }] }),
  });
  const candidates: FrameCandidate[] = [];
  for (const record of recordsOfKind(tracked.records, "mask")) {
    const frameIndex = frameIndexOf(record) ?? 0;
    const frame = frames[frameIndex];
    if (!frame) continue;
    const { mask, share } = largestComponent(maskFromRecord(record));
    const area = maskArea(mask);
    if (area === 0) continue;
    candidates.push({
      frameIndex,
      mask,
      share,
      area,
      touchesEdge: touchesEdge(mask.bounds, width, height),
      sharpness: await regionSharpness(frame, mask.bounds),
    });
  }
  return chooseFrame(candidates);
}

/** Removes hands SAM finds on the frame, unless that would remove most of the product. */
async function withoutHands(meta: MetaClient, framePath: string, mask: Mask): Promise<Mask> {
  const hands = recordsOfKind((await segmentImage(meta, { imageUrl: dataUrl(framePath), concept: "hand" })).records, "mask");
  let result = mask;
  for (const hand of hands) if ((hand.confidence ?? 0) >= 0.5) result = subtractMask(result, maskFromRecord(hand));
  const { mask: kept } = largestComponent(result);
  return maskArea(kept) >= 0.5 * maskArea(mask) ? kept : mask;
}
