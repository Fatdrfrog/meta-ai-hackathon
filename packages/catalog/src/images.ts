import type { SegmentationMaskRecord } from "@vitrina/meta";
import sharp, { type OverlayOptions } from "sharp";
import { maskFromRecord, type Box, type Mask } from "./masks.ts";

// The mask becomes the alpha channel of its crop, so the product keeps its real pixels and
// everything around it turns transparent.
export async function cutOutMask(framePath: string, mask: Mask, outPath: string): Promise<void> {
  const { width: frameWidth = 0, height: frameHeight = 0 } = await sharp(framePath).metadata();
  const left = Math.max(0, mask.bounds.left);
  const top = Math.max(0, mask.bounds.top);
  const width = Math.min(frameWidth, mask.bounds.right) - left;
  const height = Math.min(frameHeight, mask.bounds.bottom) - top;

  let alpha = Buffer.from(mask.raster.map((v) => v * 255));
  if (mask.width !== width || mask.height !== height) {
    // sharp writes a resized single-channel image back out as three channels unless told otherwise.
    alpha = await sharp(alpha, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(width, height, { fit: "fill", kernel: "nearest" })
      .extractChannel(0)
      .raw()
      .toBuffer();
  }
  if (alpha.length !== width * height) {
    throw new Error(`Mask is ${alpha.length} bytes, expected ${width}x${height}.`);
  }
  const rgb = await sharp(framePath).extract({ left, top, width, height }).removeAlpha().raw().toBuffer();
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toFile(outPath);
}

export const cutOut = (framePath: string, record: SegmentationMaskRecord, outPath: string) =>
  cutOutMask(framePath, maskFromRecord(record), outPath);

/** Sharpness of one region of a frame, so a sharp background can't make a blurred product look good. */
export async function regionSharpness(framePath: string, region: Box): Promise<number> {
  const { width: frameWidth = 0, height: frameHeight = 0 } = await sharp(framePath).metadata();
  const left = Math.max(0, region.left);
  const top = Math.max(0, region.top);
  const width = Math.min(frameWidth, region.right) - left;
  const height = Math.min(frameHeight, region.bottom) - top;
  if (width < 1 || height < 1) return 0;
  const { sharpness } = await sharp(framePath).extract({ left, top, width, height }).stats();
  return sharpness;
}

export interface GridLayout {
  readonly columns?: number;
  readonly tileWidth?: number;
  readonly tileHeight?: number;
  /** "cover" fills each tile (video frames); "contain" shows the whole image on white (cut-outs). */
  readonly fit?: "cover" | "contain";
}

/** Images side by side with a big number in each corner, for a model to choose from or refer to. */
export async function numberedGrid(paths: readonly string[], outPath: string, layout: GridLayout = {}): Promise<void> {
  const { columns = 4, tileWidth = 360, tileHeight = 640, fit = "cover" } = layout;
  const tiles = await Promise.all(
    paths.map(async (path, i) => ({
      input: await sharp(path)
        .resize(tileWidth, tileHeight, { fit, background: "#ffffff" })
        .flatten({ background: "#ffffff" })
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
  if (tiles.length === 0) throw new Error("No images for the grid.");
  await sharp({
    create: {
      width: Math.min(columns, paths.length) * tileWidth,
      height: Math.ceil(paths.length / columns) * tileHeight,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(tiles)
    .jpeg({ quality: 85 })
    .toFile(outPath);
}

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Grey tiles so transparent edges show; up to two label lines under each image. */
export async function contactSheet(
  items: readonly { path: string; lines: readonly string[] }[],
  outPath: string,
  columns = 4,
): Promise<void> {
  const tile = 300;
  const labelHeight = 48;
  const composites: OverlayOptions[] = [];
  for (const [i, item] of items.entries()) {
    const x = (i % columns) * tile;
    const y = Math.floor(i / columns) * (tile + labelHeight);
    const image = await sharp(item.path).resize(tile - 20, tile - 20, { fit: "inside" }).png().toBuffer();
    const { width = 0, height = 0 } = await sharp(image).metadata();
    composites.push({ input: image, left: x + Math.round((tile - width) / 2), top: y + Math.round((tile - height) / 2) });
    const text = item.lines
      .slice(0, 2)
      .map((line, n) => `<text x="${tile / 2}" y="${18 + n * 20}" font-family="Arial" font-size="15" text-anchor="middle">${escapeXml(line)}</text>`)
      .join("");
    composites.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${labelHeight}">${text}</svg>`),
      left: x,
      top: y + tile,
    });
  }
  const rows = Math.ceil(items.length / columns);
  await sharp({
    create: { width: columns * tile, height: rows * (tile + labelHeight), channels: 4, background: "#e6e6e6" },
  })
    .composite(composites)
    .png()
    .toFile(outPath);
}
