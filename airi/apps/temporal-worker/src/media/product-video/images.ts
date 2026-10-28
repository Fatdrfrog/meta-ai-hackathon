import sharp from "sharp";
import { labelPieces, type Box, type Mask } from "./masks";

/** Sharpness of one region of a frame, so a sharp background can't make a blurred product look good. */
export async function regionSharpness(
  framePath: string,
  region: Box,
): Promise<number> {
  const { width = 0, height = 0 } = await sharp(framePath).metadata();
  const box = clampBox(region, width, height);
  if (!box) return 0;
  const { sharpness } = await sharp(framePath)
    .extract({
      left: box.left,
      top: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
    })
    .stats();
  return sharpness;
}

/** An image as a JPEG data URL on white, the way SAM 3.1 takes images. */
export async function jpegDataUrl(image: Buffer | string): Promise<string> {
  const jpeg = await sharp(image)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

function clampBox(box: Box, width: number, height: number): Box | null {
  const left = Math.max(0, Math.min(width, Math.round(box.left)));
  const top = Math.max(0, Math.min(height, Math.round(box.top)));
  const right = Math.max(left, Math.min(width, Math.round(box.right)));
  const bottom = Math.max(top, Math.min(height, Math.round(box.bottom)));
  return right - left >= 1 && bottom - top >= 1
    ? { left, top, right, bottom }
    : null;
}

export type Rgb = { r: number; g: number; b: number };
export const WHITE: Rgb = { r: 255, g: 255, b: 255 };

const hex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

// How far from the backdrop still counts as backdrop (Muse's plain colour has
// some noise); a frosted white cup still stood out on white at this setting.
const BACKDROP_SLACK = 24;

/**
 * The plain colour Muse Image put behind a restored photo: the median of its
 * outermost pixels, which show the backdrop even where the product reaches
 * the edge.
 */
export async function backdropColor(image: Buffer): Promise<Rgb> {
  const { data, info } = await sharp(image)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const band = 4;
  const levels: number[][] = [[], [], []];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const edge =
        x < band ||
        y < band ||
        x >= info.width - band ||
        y >= info.height - band;
      if (!edge) continue;
      for (let c = 0; c < 3; c++)
        levels[c]!.push(data[(y * info.width + x) * 3 + c]!);
    }
  }
  const median = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 255;
  return {
    r: median(levels[0]!),
    g: median(levels[1]!),
    b: median(levels[2]!),
  };
}

/**
 * The box around everything that isn't the backdrop: on Muse Image's plain
 * backdrop, the whole product. Null for a blank image.
 */
export async function productBox(
  image: Buffer,
  backdrop: Rgb = WHITE,
): Promise<Box | null> {
  const flat = await sharp(image)
    .flatten({ background: hex(backdrop) })
    .toBuffer();
  const { channels } = await sharp(flat).stats();
  const levels = [backdrop.r, backdrop.g, backdrop.b];
  // Nothing but backdrop anywhere: no product.
  if (
    channels
      .slice(0, 3)
      .every(
        (channel, c) =>
          channel.min >= levels[c]! - BACKDROP_SLACK &&
          channel.max <= levels[c]! + BACKDROP_SLACK,
      )
  )
    return null;
  const { info } = await sharp(flat)
    .trim({ background: hex(backdrop), threshold: BACKDROP_SLACK })
    .toBuffer({ resolveWithObject: true });
  const left = Math.max(0, -(info.trimOffsetLeft ?? 0));
  const top = Math.max(0, -(info.trimOffsetTop ?? 0));
  return { left, top, right: left + info.width, bottom: top + info.height };
}

/**
 * How much of a cut-out is near-white and how much neutral mid-grey: the two
 * backdrops Muse Image restores on. A product restored on a colour it is made
 * of loses those parts to the backdrop when cut out.
 */
export async function backdropShares(
  cutout: Buffer,
): Promise<{ white: number; grey: number }> {
  const { data } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  let white = 0;
  let grey = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 200) continue;
    opaque++;
    const low = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
    const high = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
    if (low >= 200 && high - low <= 30) white++;
    else if (low >= 100 && high <= 180 && high - low <= 16) grey++;
  }
  return opaque > 0
    ? { white: white / opaque, grey: grey / opaque }
    : { white: 0, grey: 0 };
}

const GRID_TILE_LONG_SIDE = 640;

/**
 * Frames side by side with a big number in each corner, for Muse Spark to
 * choose from. Tiles take the frames' shape, so a landscape video isn't
 * cropped to its middle third.
 */
export async function numberedGrid(
  paths: string[],
  columns = 4,
): Promise<Buffer> {
  if (paths.length === 0) throw new Error("No frames for the grid");
  const { width = 1, height = 1 } = await sharp(paths[0]!).metadata();
  const scale = GRID_TILE_LONG_SIDE / Math.max(width, height);
  const tileWidth = Math.round(width * scale);
  const tileHeight = Math.round(height * scale);
  const tiles = await Promise.all(
    paths.map(async (path, i) => ({
      input: await sharp(path)
        .resize(tileWidth, tileHeight, {
          fit: "contain",
          background: "#ffffff",
        })
        .composite([
          {
            input: Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="56"><rect width="64" height="56" fill="#1b2440"/><text x="32" y="40" font-size="36" font-family="Arial" fill="#fff" text-anchor="middle">${i + 1}</text></svg>`,
            ),
            left: 0,
            top: 0,
          },
        ])
        .png()
        .toBuffer(),
      left: (i % columns) * tileWidth,
      top: Math.floor(i / columns) * tileHeight,
    })),
  );
  return sharp({
    create: {
      width: Math.min(columns, paths.length) * tileWidth,
      height: Math.ceil(paths.length / columns) * tileHeight,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(tiles)
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * How much each frame differs from the one before, 0 to 1: the mean change
 * of a 32×32 greyscale thumbnail. Entry i compares frame i with frame i - 1;
 * entry 0 is 0.
 */
export async function frameDifferences(paths: string[]): Promise<number[]> {
  const thumbs = await Promise.all(
    paths.map((path) =>
      sharp(path).resize(32, 32, { fit: "fill" }).greyscale().raw().toBuffer(),
    ),
  );
  return thumbs.map((thumb, i) => {
    if (i === 0) return 0;
    const previous = thumbs[i - 1]!;
    let sum = 0;
    for (let p = 0; p < thumb.length; p++)
      sum += Math.abs(thumb[p]! - previous[p]!);
    return sum / thumb.length / 255;
  });
}

// A cut is a jump at least this big that also towers over the change in the
// frames around it. On the test videos, hard cuts in an edited promo were
// 0.15-0.28 and 22-51 times their surroundings; a hand swinging a product
// in an unedited video reached 0.16 but only 2 times. A slow dissolve stays
// below the ratio and counts as one shot.
const CUT_MIN_DIFFERENCE = 0.1;
const CUT_MIN_RATIO = 5;
// Change in a still shot: compressed video never differs by less.
const STILL_DIFFERENCE = 0.004;

/** The frames, first and last inclusive, of the shot that frame `at` belongs to. */
export function shotAround(
  differences: number[],
  at: number,
): { first: number; last: number } {
  const isCut = (i: number) => {
    const difference = differences[i] ?? 0;
    if (i === 0 || difference < CUT_MIN_DIFFERENCE) return false;
    const around = differences
      .filter((_, j) => j > 0 && Math.abs(j - i) >= 2 && Math.abs(j - i) <= 6)
      .sort((a, b) => a - b);
    const typical = around[Math.floor(around.length / 2)] ?? 0;
    return difference >= CUT_MIN_RATIO * Math.max(typical, STILL_DIFFERENCE);
  };
  let first = at;
  while (first > 0 && !isCut(first)) first--;
  let last = at;
  while (last < differences.length - 1 && !isCut(last + 1)) last++;
  return { first, last };
}

/**
 * The product with room around it, cropped from its frame: what Muse Image
 * restores, and the "original" the owner compares the result with.
 */
export async function cropAroundProduct(
  framePath: string,
  bounds: Box,
  margin = 0.15,
): Promise<{ image: Buffer; box: Box }> {
  const { width = 0, height = 0 } = await sharp(framePath).metadata();
  const padX = Math.round((bounds.right - bounds.left) * margin);
  const padY = Math.round((bounds.bottom - bounds.top) * margin);
  const box = clampBox(
    {
      left: bounds.left - padX,
      top: bounds.top - padY,
      right: bounds.right + padX,
      bottom: bounds.bottom + padY,
    },
    width,
    height,
  );
  if (!box) throw new Error("The product's box is outside its frame");
  const image = await sharp(framePath)
    .extract({
      left: box.left,
      top: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
    })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { image, box };
}

const CUTOUT_MAX_SIDE = 1200;
const CUTOUT_PADDING = 4;
// Opacity below this, after softening, is the blur's spill onto background.
const RIM = 40;
// A piece of the joined mask smaller than this share of its biggest piece is
// a stray: a speck SAM added, or the edge of a neighbouring item Muse Image
// redrew next to the product. Both halves of a pair, like earrings, stay.
const MIN_PIECE_SHARE = 0.15;

/**
 * Clears the pieces of a 0-255 mask that are much smaller than its biggest,
 * in place, and returns the box around what is left; null when nothing is.
 */
function dropStrayPieces(mask: Buffer, width: number): Box | null {
  const { label, sizes } = labelPieces(mask, width, 128);
  let biggest = 0;
  for (const size of sizes) biggest = Math.max(biggest, size);
  if (biggest === 0) return null;
  const box = { left: width, top: Infinity, right: 0, bottom: 0 };
  for (let i = 0; i < mask.length; i++) {
    const piece = label[i]!;
    if (piece === 0) continue;
    if (sizes[piece]! < biggest * MIN_PIECE_SHARE) {
      mask[i] = 0;
      continue;
    }
    const x = i % width;
    const y = (i - x) / width;
    box.left = Math.min(box.left, x);
    box.top = Math.min(box.top, y);
    box.right = Math.max(box.right, x + 1);
    box.bottom = Math.max(box.bottom, y + 1);
  }
  return box;
}

// A patch of backdrop colour inside the mask is a hole the backdrop shows
// through, like the slots of a medal hanger or a carved table leg's openwork,
// when it is at least this share of the image (and HOLE_MIN_PIXELS), and
// sits on the backdrop's colour: its pixels within HOLE_TOLERANCE of it and
// within HOLE_MAX_MEAN_DIFFERENCE on average. On a restored medal hanger,
// holes averaged 0.9-2.4 from the grey; parts of its grey lettering and
// shading 5-21, which a looser test had cut away with the holes.
const HOLE_MIN_SHARE = 0.00003;
const HOLE_MIN_PIXELS = 16;
const HOLE_TOLERANCE = 12;
const HOLE_MAX_MEAN_DIFFERENCE = 4;

/**
 * Takes the backdrop showing through holes in the product out of the mask,
 * in place. SAM's mask covers a product's holes along with it; on Muse
 * Image's plain backdrop, the holes are exactly the backdrop's colour. Only
 * safe on a backdrop the product itself isn't coloured like.
 */
function punchBackdropHoles(
  mask: Buffer,
  rgb: Buffer,
  width: number,
  backdrop: Rgb,
): void {
  const levels = [backdrop.r, backdrop.g, backdrop.b];
  const difference = new Uint8Array(mask.length);
  const showsBackdrop = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]! < 128) continue;
    let largest = 0;
    for (let c = 0; c < 3; c++)
      largest = Math.max(largest, Math.abs(rgb[i * 3 + c]! - levels[c]!));
    difference[i] = largest;
    if (largest <= HOLE_TOLERANCE) showsBackdrop[i] = 1;
  }
  const { label, sizes } = labelPieces(showsBackdrop, width);
  const total = new Array<number>(sizes.length).fill(0);
  for (let i = 0; i < mask.length; i++) total[label[i]!]! += difference[i]!;
  const minimum = Math.max(HOLE_MIN_PIXELS, mask.length * HOLE_MIN_SHARE);
  for (let i = 0; i < mask.length; i++) {
    const piece = label[i]!;
    if (
      piece > 0 &&
      sizes[piece]! >= minimum &&
      total[piece]! / sizes[piece]! <= HOLE_MAX_MEAN_DIFFERENCE
    )
      mask[i] = 0;
  }
}

/**
 * The mask with its outermost pixels removed. SAM's edge is often a pixel
 * generous, and that pixel is background colour, which shows as a ring.
 */
function shrinkByOnePixel(mask: Buffer, width: number, height: number): Buffer {
  const out = Buffer.alloc(mask.length);
  const on = (i: number) => mask[i]! >= 128;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (on(i) && on(i - 1) && on(i + 1) && on(i - width) && on(i + width))
        out[i] = 255;
    }
  }
  return out;
}

/**
 * A transparent PNG of the masked product, trimmed to it. Several masks are
 * joined, for a product SAM found in parts, and stray pieces of the result
 * are dropped. Each mask is scaled up smoothly
 * (scaling it pixel by pixel gave staircase edges), then the whole is shrunk
 * by a pixel and softened. On Muse Image's plain backdrop, the backdrop
 * colour B blended into edge pixels is taken back out (C = aF + (1 - a)B, so
 * F = (C - (1 - a)B) / a), so no halo shows on any other background, and
 * with `holes` the backdrop showing through the product's holes goes too.
 */
export async function cutOutWithMask(
  image: Buffer | string,
  masks: Mask | Mask[],
  options: { backdrop?: Rgb; holes?: boolean } = {},
): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const all = Array.isArray(masks) ? masks : [masks];
  const rgb = await sharp(image)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const placed = Buffer.alloc(width * height);
  for (const mask of all) {
    const boundsWidth = mask.bounds.right - mask.bounds.left;
    const boundsHeight = mask.bounds.bottom - mask.bounds.top;
    if (boundsWidth < 1 || boundsHeight < 1) continue;
    const scaled = await sharp(
      Buffer.from(mask.raster.map((value) => (value ? 255 : 0))),
      { raw: { width: mask.width, height: mask.height, channels: 1 } },
    )
      .resize(boundsWidth, boundsHeight, { fit: "fill", kernel: "cubic" })
      .extractChannel(0)
      .raw()
      .toBuffer();
    for (let y = 0; y < boundsHeight; y++) {
      const row = mask.bounds.top + y;
      if (row < 0 || row >= height) continue;
      for (
        let x = Math.max(0, -mask.bounds.left);
        x < Math.min(boundsWidth, width - mask.bounds.left);
        x++
      ) {
        const at = row * width + mask.bounds.left + x;
        placed[at] = Math.max(placed[at]!, scaled[y * boundsWidth + x]!);
      }
    }
  }
  const { backdrop } = options;
  if (backdrop && options.holes)
    punchBackdropHoles(placed, rgb, width, backdrop);
  const bounds = dropStrayPieces(placed, width);
  if (!bounds) throw new Error("The mask is outside its image");
  const alpha = await sharp(shrinkByOnePixel(placed, width, height), {
    raw: { width, height, channels: 1 },
  })
    .blur(0.8)
    .extractChannel(0)
    .raw()
    .toBuffer();

  const backdropLevels = backdrop && [backdrop.r, backdrop.g, backdrop.b];
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // The faint rim the blur spreads past the edge is background: drop it.
    const opacity = Math.max(
      0,
      Math.min(255, Math.round(((alpha[i]! - RIM) * 255) / (255 - RIM))),
    );
    const a = opacity / 255;
    for (let c = 0; c < 3; c++) {
      const value = rgb[i * 3 + c]!;
      rgba[i * 4 + c] =
        backdropLevels && a > 0.04
          ? Math.max(
              0,
              Math.min(
                255,
                Math.round((value - (1 - a) * backdropLevels[c]!) / a),
              ),
            )
          : value;
    }
    rgba[i * 4 + 3] = opacity;
  }

  const left = Math.max(0, bounds.left - CUTOUT_PADDING);
  const top = Math.max(0, bounds.top - CUTOUT_PADDING);
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({
      left,
      top,
      width: Math.min(width, bounds.right + CUTOUT_PADDING) - left,
      height: Math.min(height, bounds.bottom + CUTOUT_PADDING) - top,
    })
    .resize(CUTOUT_MAX_SIDE, CUTOUT_MAX_SIDE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

// A box-like product is levelled only when its tightest rectangle sits at
// least TILT_MIN_DEGREES off level, is much smaller than its upright box (the
// turn is plain), and its outline fills that rectangle well (it is box-like:
// a figurine or a folded triangle has no level to find).
const TILT_MIN_DEGREES = 1.5;
const TILT_MAX_AREA_RATIO = 0.85;
const TILT_MIN_FILL = 0.7;
const TILT_SAMPLE_SIDE = 400;

type Point = { x: number; y: number };

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (ordered: Point[]) => {
    const chain: Point[] = [];
    for (const point of ordered) {
      while (
        chain.length >= 2 &&
        cross(chain[chain.length - 2]!, chain[chain.length - 1]!, point) <= 0
      )
        chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * How many degrees a cut-out is turned from level, clockwise positive, when
 * it is plainly a turned box-like shape, like a medal hanger held at a slant;
 * null otherwise. The angle is that of the tightest rectangle around its
 * outline (rotating calipers over the convex hull), folded to within 45° of
 * level, so levelling leaves it horizontal or vertical, whichever is nearer,
 * and turning it a quarter later needs no redrawing.
 */
export async function tiltOf(cutout: Buffer): Promise<number | null> {
  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .extractChannel(3)
    .resize(TILT_SAMPLE_SIDE, TILT_SAMPLE_SIDE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Each row's outermost opaque pixels outline the shape well enough.
  const points: Point[] = [];
  for (let y = 0; y < info.height; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x]! < 128) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    points.push(
      { x: first, y },
      { x: first, y: y + 1 },
      { x: last + 1, y },
      { x: last + 1, y: y + 1 },
    );
  }
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let doubledArea = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    doubledArea += a.x * b.y - b.x * a.y;
  }
  const hullArea = Math.abs(doubledArea) / 2;
  const boxArea = (degrees: number) => {
    const cos = Math.cos((degrees * Math.PI) / 180);
    const sin = Math.sin((degrees * Math.PI) / 180);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const { x, y } of hull) {
      const u = x * cos + y * sin;
      const v = y * cos - x * sin;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    return (maxU - minU) * (maxV - minV);
  };
  const candidates = hull.map((a, i) => {
    const b = hull[(i + 1) % hull.length]!;
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const folded = ((angle % 90) + 90) % 90;
    const degrees = folded > 45 ? folded - 90 : folded;
    return { degrees, area: boxArea(degrees) };
  });
  const smallest = Math.min(...candidates.map((candidate) => candidate.area));
  // Of near-equal fits, the least turn: a rectangle fits a triangle as well
  // along any of its sides.
  const best = candidates
    .filter((candidate) => candidate.area <= smallest * 1.03)
    .sort((a, b) => Math.abs(a.degrees) - Math.abs(b.degrees))[0]!;
  if (
    Math.abs(best.degrees) < TILT_MIN_DEGREES ||
    best.area > boxArea(0) * TILT_MAX_AREA_RATIO ||
    hullArea / best.area < TILT_MIN_FILL
  )
    return null;
  return Math.round(best.degrees * 10) / 10;
}

/** The cut-out turned `degrees` clockwise (negative: anticlockwise), trimmed to the product. */
export async function rotateCutout(
  cutout: Buffer,
  degrees: number,
): Promise<Buffer> {
  const { data, info } = await sharp(cutout)
    .rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! < 8) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  if (right <= left) return cutout;
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .extract({ left, top, width: right - left, height: bottom - top })
    .extend({
      top: CUTOUT_PADDING,
      bottom: CUTOUT_PADDING,
      left: CUTOUT_PADDING,
      right: CUTOUT_PADDING,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(CUTOUT_MAX_SIDE, CUTOUT_MAX_SIDE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}
