import { decodeMaskToRaster, type SegmentationMaskRecord } from "@vitrina/meta";
import sharp, { type OverlayOptions } from "sharp";

/** Motion blur ruins product photos; sharp's Laplacian-based score picks the crispest frame. */
export async function sharpestImage(paths: readonly string[]): Promise<{ path: string; sharpness: number }> {
  if (paths.length === 0) throw new Error("No frames to choose from.");
  let best = { path: paths[0]!, sharpness: -1 };
  for (const path of paths) {
    const { sharpness } = await sharp(path).stats();
    if (sharpness > best.sharpness) best = { path, sharpness };
  }
  return best;
}

// SAM returns a 0/1 raster covering the mask's bounds; it becomes the alpha channel of that crop,
// so the product keeps its real pixels and everything around it turns transparent.
export async function cutOut(framePath: string, record: SegmentationMaskRecord, outPath: string): Promise<void> {
  const { width: frameWidth = 0, height: frameHeight = 0 } = await sharp(framePath).metadata();
  const left = Math.max(0, Math.round(record.bounds.left));
  const top = Math.max(0, Math.round(record.bounds.top));
  const width = Math.min(frameWidth, Math.round(record.bounds.right)) - left;
  const height = Math.min(frameHeight, Math.round(record.bounds.bottom)) - top;

  const raster = decodeMaskToRaster(record.mask);
  let alpha = Buffer.from(raster.map((v) => v * 255));
  if (record.mask.width !== width || record.mask.height !== height) {
    // sharp writes a resized single-channel image back out as three channels unless told otherwise.
    alpha = await sharp(alpha, { raw: { width: record.mask.width, height: record.mask.height, channels: 1 } })
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
