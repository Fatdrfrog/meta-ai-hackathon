import {
  decodeMaskToRaster,
  type SegmentationMaskRecord,
} from "@icecore/airi-runtime/meta-sam";

export type Box = {
  left: number;
  top: number;
  /** Exclusive. */
  right: number;
  /** Exclusive. */
  bottom: number;
};

/**
 * A 0/1 raster covering `bounds` of an image, row-major. SAM sends masks
 * smaller than their bounds (about 70% in tests), so `width`/`height` may
 * differ from the bounds' size.
 */
export type Mask = {
  raster: Uint8Array;
  width: number;
  height: number;
  bounds: Box;
  confidence: number;
};

export function maskFromRecord(record: SegmentationMaskRecord): Mask {
  return {
    raster: decodeMaskToRaster(record.mask),
    width: record.mask.width,
    height: record.mask.height,
    bounds: {
      left: Math.round(record.bounds.left),
      top: Math.round(record.bounds.top),
      right: Math.round(record.bounds.right),
      bottom: Math.round(record.bounds.bottom),
    },
    // SAM may leave a record unscored; that says nothing, so it ranks neutral.
    confidence: record.confidence ?? 1,
  };
}

export const maskArea = (mask: Mask): number =>
  mask.raster.reduce((sum, value) => sum + value, 0);

/** The 0/1 raster grown by `radius` pixels in every direction (a square). */
export function grow(
  on: Uint8Array,
  width: number,
  radius: number,
): Uint8Array {
  const height = on.length / width;
  const across = new Uint8Array(on.length);
  for (let y = 0; y < height; y++) {
    let last = -Infinity;
    for (let x = 0; x < width; x++)
      if (on[y * width + x]) ((last = x), (across[y * width + x] = 1));
      else if (x - last <= radius) across[y * width + x] = 1;
    last = Infinity;
    for (let x = width - 1; x >= 0; x--)
      if (on[y * width + x]) last = x;
      else if (last - x <= radius) across[y * width + x] = 1;
  }
  const out = new Uint8Array(on.length);
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height; y++)
      if (across[y * width + x]) ((last = y), (out[y * width + x] = 1));
      else if (y - last <= radius) out[y * width + x] = 1;
    last = Infinity;
    for (let y = height - 1; y >= 0; y--)
      if (across[y * width + x]) last = y;
      else if (last - y <= radius) out[y * width + x] = 1;
  }
  return out;
}

/**
 * The 4-connected pieces of a row-major raster's "on" pixels: each pixel's
 * piece number (0 when off) and each piece's size, indexed by its number.
 */
export function labelPieces(
  raster: ArrayLike<number>,
  width: number,
  threshold = 1,
): { label: Int32Array; sizes: number[] } {
  const on = (i: number) => raster[i]! >= threshold;
  const label = new Int32Array(raster.length);
  const sizes = [0];
  const stack: number[] = [];
  for (let start = 0; start < raster.length; start++) {
    if (!on(start) || label[start]) continue;
    const piece = sizes.length;
    label[start] = piece;
    stack.push(start);
    let size = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p >= width ? p - width : -1,
        p + width < raster.length ? p + width : -1,
      ];
      for (const q of neighbours) {
        if (q >= 0 && on(q) && !label[q]) {
          label[q] = piece;
          stack.push(q);
        }
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

/** Keeps the largest 4-connected piece, dropping specks; `share` is that piece's part of the mask. */
export function largestComponent(mask: Mask): { mask: Mask; share: number } {
  const { label, sizes } = labelPieces(mask.raster, mask.width);
  let best = 0;
  for (let piece = 1; piece < sizes.length; piece++)
    if (sizes[piece]! > sizes[best]!) best = piece;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const kept = new Uint8Array(mask.raster.length);
  for (let i = 0; i < kept.length; i++)
    kept[i] = label[i] === best && best !== 0 ? 1 : 0;
  return {
    mask: { ...mask, raster: kept },
    share: total ? sizes[best]! / total : 0,
  };
}

export function touchesEdge(
  bounds: Box,
  imageWidth: number,
  imageHeight: number,
  margin = 2,
): boolean {
  return (
    bounds.left <= margin ||
    bounds.top <= margin ||
    bounds.right >= imageWidth - margin ||
    bounds.bottom >= imageHeight - margin
  );
}

export type FrameCandidate = {
  frameIndex: number;
  /** Largest piece of the tracked mask in this frame. */
  mask: Mask;
  /** How much of the mask that piece is: 1 when the product is in one piece. */
  share: number;
  area: number;
  touchesEdge: boolean;
  /** Sharpness of the product's own region, not the whole frame. */
  sharpness: number;
};

// Whole and unclipped first: a frame must show the product in one piece, away
// from the frame's edge, and at least 70% of the biggest such view, so a
// close-up of one sharp detail can't win. Among those, the sharpest and most
// confident. Choosing by the sharpness of the whole picture picked sharp
// backgrounds behind blurred products.
export function chooseFrame(
  candidates: FrameCandidate[],
): FrameCandidate | undefined {
  const whole = candidates.filter((c) => !c.touchesEdge && c.share >= 0.9);
  const pool = whole.length > 0 ? whole : candidates;
  const maxArea = Math.max(0, ...pool.map((c) => c.area));
  let best: FrameCandidate | undefined;
  for (const c of pool) {
    if (c.area <= 0 || c.area < 0.7 * maxArea) continue;
    if (
      !best ||
      c.mask.confidence * c.sharpness > best.mask.confidence * best.sharpness
    )
      best = c;
  }
  return best;
}

/** A mask drawn onto a full-size image: 1 where it covers, 0 elsewhere. */
function onImage(mask: Mask, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const boundsWidth = mask.bounds.right - mask.bounds.left;
  const boundsHeight = mask.bounds.bottom - mask.bounds.top;
  for (let y = 0; y < boundsHeight; y++) {
    const row = mask.bounds.top + y;
    if (row < 0 || row >= height) continue;
    const sourceRow = Math.floor((y * mask.height) / boundsHeight);
    for (let x = 0; x < boundsWidth; x++) {
      const column = mask.bounds.left + x;
      if (column < 0 || column >= width) continue;
      const sourceColumn = Math.floor((x * mask.width) / boundsWidth);
      if (mask.raster[sourceRow * mask.width + sourceColumn])
        out[row * width + column] = 1;
    }
  }
  return out;
}

// Pieces left smaller than this share of the biggest are scraps of what was
// taken out, outside the other masks.
const SCRAP_SHARE = 0.15;

/**
 * The product's mask without what the other masks cover, grown by `margin`
 * pixels, at full size, and the share of the product left; null when nothing
 * is. Takes a presenter standing behind a product out of its mask: SAM draws
 * the two outlines a few pixels apart, and the margin takes the strip of
 * presenter between them too.
 */
export function subtractMasks(
  product: Mask,
  others: Mask[],
  width: number,
  height: number,
  margin = 0,
): { mask: Mask; kept: number } | null {
  const covered = onImage(product, width, height);
  const before = covered.reduce((sum, value) => sum + value, 0);
  for (const other of others) {
    const drawn = onImage(other, width, height);
    const taken = margin > 0 ? grow(drawn, width, margin) : drawn;
    for (let i = 0; i < covered.length; i++) if (taken[i]) covered[i] = 0;
  }
  const { label, sizes } = labelPieces(covered, width);
  let biggest = 0;
  for (const size of sizes) biggest = Math.max(biggest, size);
  for (let i = 0; i < covered.length; i++)
    if (covered[i] && sizes[label[i]!]! < biggest * SCRAP_SHARE) covered[i] = 0;
  const bounds = { left: width, top: height, right: 0, bottom: 0 };
  let after = 0;
  for (let i = 0; i < covered.length; i++) {
    if (!covered[i]) continue;
    after++;
    const x = i % width;
    const y = (i - x) / width;
    bounds.left = Math.min(bounds.left, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x + 1);
    bounds.bottom = Math.max(bounds.bottom, y + 1);
  }
  if (after === 0) return null;
  const maskWidth = bounds.right - bounds.left;
  const maskHeight = bounds.bottom - bounds.top;
  const raster = new Uint8Array(maskWidth * maskHeight);
  for (let y = 0; y < maskHeight; y++)
    for (let x = 0; x < maskWidth; x++)
      raster[y * maskWidth + x] =
        covered[(bounds.top + y) * width + bounds.left + x]!;
  return {
    mask: {
      raster,
      width: maskWidth,
      height: maskHeight,
      bounds,
      confidence: product.confidence,
    },
    kept: after / before,
  };
}
