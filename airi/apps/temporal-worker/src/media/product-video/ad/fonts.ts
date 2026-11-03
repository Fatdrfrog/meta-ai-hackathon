import { fileURLToPath } from "node:url";

// The fonts the video ad draws its words in, bundled with the worker: the
// image has no fonts of its own, and the ad must draw Kazakh's letters and
// the tenge sign the same on every machine. Both are the official variable
// fonts from the google/fonts repository (commit 6c1dbe27dcf7, OFL, licences
// beside them in assets/fonts):
//   Geologica-Variable.ttf  ofl/geologica/Geologica[CRSV,SHRP,slnt,wght].ttf
//                           sha256 9124d9e88ac6c11d761f35241713a51d68e2c4ebedce0edaca834717a00959ec
//   Inter-Variable.ttf      ofl/inter/Inter[opsz,wght].ttf
//                           sha256 29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031
// google/fonts ships these two only as variable fonts; Pango (through sharp)
// picks a weight by its named instance, "Geologica SemiBold". The Products
// page uses the same Geologica for its display type.

const fontPath = (name: string) =>
  fileURLToPath(new URL(`../../../../assets/fonts/${name}`, import.meta.url));

export type AdFace = "display" | "text";
export type AdWeight = "regular" | "medium" | "semibold";

export const AD_FONTS: Record<AdFace, { family: string; file: string }> = {
  /** Names, prices, the sticker and titles. */
  display: { family: "Geologica", file: fontPath("Geologica-Variable.ttf") },
  /** Captions and small words. */
  text: { family: "Inter", file: fontPath("Inter-Variable.ttf") },
};

const WEIGHT_NAMES: Record<AdWeight, string> = {
  regular: "",
  medium: " Medium",
  semibold: " SemiBold",
};

/**
 * The Pango font description of a face at a weight and a size in pixels: at
 * the 72 dpi the ad renders at, a point is a pixel.
 */
export function adFontDescription(
  face: AdFace,
  weight: AdWeight,
  px: number,
): string {
  return `${AD_FONTS[face].family}${WEIGHT_NAMES[weight]} ${Math.max(1, Math.round(px))}`;
}

/**
 * The code points a TrueType font maps to a glyph, read from its cmap
 * (Windows Unicode subtables, formats 4 and 12). The glyph tests use it to
 * check the letters the ad allows against what the fonts really draw.
 */
export function fontCodePoints(font: Buffer): Set<number> {
  const tables = font.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (font.toString("latin1", record, record + 4) === "cmap")
      cmap = font.readUInt32BE(record + 8);
  }
  if (cmap < 0) throw new Error("The font has no cmap table");
  const codes = new Set<number>();
  const subtables = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const record = cmap + 4 + i * 8;
    const platform = font.readUInt16BE(record);
    const encoding = font.readUInt16BE(record + 2);
    const offset = cmap + font.readUInt32BE(record + 4);
    const format = font.readUInt16BE(offset);
    if (platform !== 3) continue;
    if (format === 12 && encoding === 10) {
      const groups = font.readUInt32BE(offset + 12);
      for (let g = 0; g < groups; g++) {
        const group = offset + 16 + g * 12;
        const start = font.readUInt32BE(group);
        const end = font.readUInt32BE(group + 4);
        const glyph = font.readUInt32BE(group + 8);
        for (let code = start; code <= end; code++)
          if (glyph + (code - start) !== 0) codes.add(code);
      }
    } else if (format === 4 && encoding === 1) {
      const segments = font.readUInt16BE(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const rangeOffsets = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const end = font.readUInt16BE(ends + s * 2);
        const start = font.readUInt16BE(starts + s * 2);
        const delta = font.readInt16BE(deltas + s * 2);
        const rangeOffset = font.readUInt16BE(rangeOffsets + s * 2);
        for (let code = start; code <= end && code !== 0xffff; code++) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            glyph = font.readUInt16BE(
              rangeOffsets + s * 2 + rangeOffset + (code - start) * 2,
            );
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) codes.add(code);
        }
      }
    }
  }
  return codes;
}
