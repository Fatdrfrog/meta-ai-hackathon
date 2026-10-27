import sharp from "sharp";
import type { Box, Mask } from "./masks";

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

function clampBox(box: Box, width: number, height: number): Box | null {
  const left = Math.max(0, Math.min(width, Math.round(box.left)));
  const top = Math.max(0, Math.min(height, Math.round(box.top)));
  const right = Math.max(left, Math.min(width, Math.round(box.right)));
  const bottom = Math.max(top, Math.min(height, Math.round(box.bottom)));
  return right - left >= 1 && bottom - top >= 1
    ? { left, top, right, bottom }
    : null;
}

/** Frames side by side with a big number in each corner, for Muse Spark to choose from. */
export async function numberedGrid(
  paths: string[],
  layout: { columns?: number; tileWidth?: number; tileHeight?: number } = {},
): Promise<Buffer> {
  const { columns = 4, tileWidth = 360, tileHeight = 640 } = layout;
  if (paths.length === 0) throw new Error("No frames for the grid");
  const tiles = await Promise.all(
    paths.map(async (path, i) => ({
      input: await sharp(path)
        .resize(tileWidth, tileHeight, { fit: "cover" })
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

/**
 * A transparent PNG of the masked product, trimmed to it. The mask is scaled
 * up smoothly (scaling it pixel by pixel gave staircase edges) and softened by
 * a pixel. On a white background, the white blended into edge pixels is taken
 * back out (C = aF + (1 - a)W, so F = (C - (1 - a)W) / a), so no halo shows
 * when the product is placed on a dark background.
 */
export async function cutOutWithMask(
  image: Buffer | string,
  mask: Mask,
  options: { whiteBackground?: boolean } = {},
): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const bounds = clampBox(mask.bounds, width, height);
  if (!bounds) throw new Error("The mask is outside its image");
  const boundsWidth = mask.bounds.right - mask.bounds.left;
  const boundsHeight = mask.bounds.bottom - mask.bounds.top;
  const scaled = await sharp(
    Buffer.from(mask.raster.map((value) => (value ? 255 : 0))),
    { raw: { width: mask.width, height: mask.height, channels: 1 } },
  )
    .resize(boundsWidth, boundsHeight, { fit: "fill", kernel: "cubic" })
    .extractChannel(0)
    .raw()
    .toBuffer();

  const placed = Buffer.alloc(width * height);
  for (let y = 0; y < boundsHeight; y++) {
    const row = mask.bounds.top + y;
    if (row < 0 || row >= height) continue;
    const fromX = Math.max(0, -mask.bounds.left);
    const toX = Math.min(boundsWidth, width - mask.bounds.left);
    if (toX <= fromX) continue;
    scaled.copy(
      placed,
      row * width + mask.bounds.left + fromX,
      y * boundsWidth + fromX,
      y * boundsWidth + toX,
    );
  }
  const alpha = await sharp(placed, { raw: { width, height, channels: 1 } })
    .blur(0.8)
    .extractChannel(0)
    .raw()
    .toBuffer();

  const rgb = await sharp(image)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = alpha[i]! / 255;
    for (let c = 0; c < 3; c++) {
      const value = rgb[i * 3 + c]!;
      rgba[i * 4 + c] =
        options.whiteBackground && a > 0.04
          ? Math.max(0, Math.min(255, Math.round((value - (1 - a) * 255) / a)))
          : value;
    }
    rgba[i * 4 + 3] = alpha[i]!;
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
