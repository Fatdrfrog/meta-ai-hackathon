import { decodeMaskToRaster, type SegmentationMaskRecord } from "@vitrina/meta";

export interface Box {
  readonly left: number;
  readonly top: number;
  /** Exclusive. */
  readonly right: number;
  /** Exclusive. */
  readonly bottom: number;
}

/** A 0/1 raster covering `bounds` of a frame, row-major. */
export interface Mask {
  readonly raster: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bounds: Box;
  readonly confidence: number;
}

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
    confidence: record.confidence ?? 0,
  };
}

export const maskArea = (mask: Mask) => mask.raster.reduce((sum, v) => sum + v, 0);

/** Keeps the largest 4-connected piece, dropping specks; `share` is that piece's part of the mask. */
export function largestComponent(mask: Mask): { mask: Mask; share: number } {
  const { raster, width, height } = mask;
  const label = new Int32Array(raster.length);
  const stack: number[] = [];
  let next = 0;
  let best = 0;
  let bestSize = 0;
  let total = 0;
  for (let start = 0; start < raster.length; start++) {
    if (!raster[start] || label[start]) continue;
    label[start] = ++next;
    stack.push(start);
    let size = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      const neighbours = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p >= width ? p - width : -1, p + width < raster.length ? p + width : -1];
      for (const q of neighbours) {
        if (q >= 0 && raster[q] && !label[q]) {
          label[q] = next;
          stack.push(q);
        }
      }
    }
    total += size;
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const kept = new Uint8Array(raster.length);
  for (let i = 0; i < raster.length; i++) kept[i] = label[i] === best && best !== 0 ? 1 : 0;
  return { mask: { ...mask, raster: kept }, share: total ? bestSize / total : 0 };
}

/** Clears the pixels of `mask` that `remove` covers; both are placed in frame coordinates by their bounds. */
export function subtractMask(mask: Mask, remove: Mask): Mask {
  const out = Uint8Array.from(mask.raster);
  for (let y = 0; y < mask.height; y++) {
    const ry = mask.bounds.top + y - remove.bounds.top;
    if (ry < 0 || ry >= remove.height) continue;
    for (let x = 0; x < mask.width; x++) {
      const rx = mask.bounds.left + x - remove.bounds.left;
      if (rx >= 0 && rx < remove.width && remove.raster[ry * remove.width + rx]) out[y * mask.width + x] = 0;
    }
  }
  return { ...mask, raster: out };
}

export function touchesEdge(bounds: Box, frameWidth: number, frameHeight: number, margin = 2): boolean {
  return bounds.left <= margin || bounds.top <= margin || bounds.right >= frameWidth - margin || bounds.bottom >= frameHeight - margin;
}

export interface FrameCandidate {
  readonly frameIndex: number;
  /** Largest piece of the tracked mask in this frame. */
  readonly mask: Mask;
  /** How much of the mask that piece is: 1 when the product is in one piece. */
  readonly share: number;
  readonly area: number;
  readonly touchesEdge: boolean;
  /** Sharpness of the product's own region, not the whole frame. */
  readonly sharpness: number;
}

// Whole and unclipped first: a frame must show the product in one piece, away from the frame's
// edge, and at least 70% of the biggest such view, so a close-up of one sharp detail can't win.
// Among those, the sharpest and most confident.
export function chooseFrame(candidates: readonly FrameCandidate[]): FrameCandidate | undefined {
  const whole = candidates.filter((c) => !c.touchesEdge && c.share >= 0.9);
  const pool = whole.length > 0 ? whole : candidates;
  const maxArea = Math.max(0, ...pool.map((c) => c.area));
  const bigEnough = pool.filter((c) => c.area > 0 && c.area >= 0.7 * maxArea);
  let best: FrameCandidate | undefined;
  for (const c of bigEnough) {
    if (!best || c.mask.confidence * c.sharpness > best.mask.confidence * best.sharpness) best = c;
  }
  return best;
}
