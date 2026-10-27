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

/** Keeps the largest 4-connected piece, dropping specks; `share` is that piece's part of the mask. */
export function largestComponent(mask: Mask): { mask: Mask; share: number } {
  const { raster, width } = mask;
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
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p >= width ? p - width : -1,
        p + width < raster.length ? p + width : -1,
      ];
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
  for (let i = 0; i < raster.length; i++)
    kept[i] = label[i] === best && best !== 0 ? 1 : 0;
  return {
    mask: { ...mask, raster: kept },
    share: total ? bestSize / total : 0,
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
