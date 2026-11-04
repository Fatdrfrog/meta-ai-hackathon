import {
  PRODUCT_AD_STUDIO_COLOURWAYS,
  PRODUCT_AD_STUDIO_SWEEPS,
  productAdLines,
  productAdShopName,
  type ProductAdBox,
  type ProductAdStudioColourway,
  type ProductAdTextZone,
} from "@icecore/temporal";
import sharp, { type OverlayOptions } from "sharp";
import {
  AD_FONTS,
  adFontDescription,
  type AdFace,
  type AdWeight,
} from "./fonts";
import {
  AD_FEED_FRAME,
  AD_FRAME,
  coverCrop,
  FEED_SAFE,
  placeSceneText,
  REELS_SAFE,
  shelfRow,
  type CoverCrop,
  type Rect,
  type SceneTextLayout,
  type Size,
} from "./layout";

// Everything the ad draws, as one set of layers: sharp renders the words
// with the bundled fonts (Pango) and the paper, wall and plank from SVG. The
// video animates these layers (render.ts), and the stills compose the same
// ones, so a word looks the same in the video, the Status picture and the
// 4:5 ad picture. Prices are the shelf's own text, drawn here, never written
// by a model. The colours are the Products page's Paper tokens.

export const AD_COLORS = {
  ink: "#241e1a",
  ink2: "#5e5750",
  paper: "#fefdfa",
  wallTop: "#f4f0ea",
  wallLow: "#ede7df",
  floorTop: "#e9e2d8",
  floorLow: "#e2dacf",
  birchTop: "#f5ead8",
  birchLow: "#efe1cd",
  plyTop: "#e6d2ba",
  plyLow: "#d8bda3",
  sandTop: "#f6efe4",
  sandLow: "#ece1d2",
} as const;
/** The warm shade every shadow is drawn in. */
export const AD_SHADE = "35,25,15";
const SHADE = AD_SHADE;

export type Layer = { image: Buffer; width: number; height: number };

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

let fontsLoading: Promise<void> | null = null;

/**
 * Loads both bundled fonts into the process's font set. Words mixing the two
 * faces in one line (a price and its "from") need both loaded first.
 */
export function loadAdFonts(): Promise<void> {
  fontsLoading ??= (async () => {
    for (const face of ["display", "text"] as const) {
      await sharp({
        text: {
          text: "a",
          font: adFontDescription(face, "regular", 12),
          fontfile: AD_FONTS[face].file,
          rgba: true,
        },
      })
        .png()
        .toBuffer();
    }
  })().catch((error: unknown) => {
    fontsLoading = null;
    throw error;
  });
  return fontsLoading;
}

/** Text for Pango markup, which every text sharp draws is read as. */
export function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const span = (
  text: string,
  face: AdFace,
  weight: AdWeight,
  px: number,
  color: string,
) =>
  `<span font_desc="${adFontDescription(face, weight, px)}" foreground="${color}">${escapeMarkup(text)}</span>`;

/** Renders Pango markup with the ad's fonts; the image is cropped to the ink. */
async function markupLayer(
  markup: string,
  face: AdFace,
  options: { align?: "left" | "centre" | "right" } = {},
): Promise<Layer> {
  await loadAdFonts();
  const { data, info } = await sharp({
    text: {
      text: markup,
      font: adFontDescription(face, "regular", 32),
      fontfile: AD_FONTS[face].file,
      rgba: true,
      dpi: 72,
      align: options.align ?? "left",
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { image: data, width: info.width, height: info.height };
}

export type TextStyle = {
  face: AdFace;
  weight: AdWeight;
  px: number;
  color?: string;
  align?: "left" | "centre" | "right";
};

/** Lines of text in one style, as written ("\n" between lines). */
export function textLayer(lines: string[], style: TextStyle): Promise<Layer> {
  const markup = lines
    .map((line) =>
      span(
        line,
        style.face,
        style.weight,
        style.px,
        style.color ?? AD_COLORS.ink,
      ),
    )
    .join("\n");
  return markupLayer(markup, style.face, { align: style.align });
}

/**
 * Splits a text into at most `maxLines` lines between words, as evenly as
 * possible, so a two-line name doesn't end on one short word.
 */
export function balancedLines(text: string, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1 || maxLines <= 1) return [words.join(" ")];
  const length = (parts: string[]) => Array.from(parts.join(" ")).length;
  let best = [words.join(" ")];
  let bestLongest = length(words);
  if (maxLines >= 2) {
    for (let cut = 1; cut < words.length; cut++) {
      const lines = [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
      const longest = Math.max(...lines.map((line) => Array.from(line).length));
      if (longest < bestLongest) {
        best = lines;
        bestLongest = longest;
      }
    }
  }
  return best;
}

/**
 * Text in the largest size from `style.px` down to `minPx` whose widest line
 * fits `maxWidth`; `fits` is false when even `minPx` is too wide.
 */
async function sizeToFit(
  lines: string[],
  style: TextStyle,
  maxWidth: number,
  minPx: number,
): Promise<Layer & { px: number; fits: boolean }> {
  let px = style.px;
  let layer = await textLayer(lines, { ...style, px });
  for (
    let tries = 0;
    tries < 6 && layer.width > maxWidth && px > minPx;
    tries++
  ) {
    px = Math.max(minPx, Math.floor((px * maxWidth) / layer.width));
    layer = await textLayer(lines, { ...style, px });
  }
  return { ...layer, px, fits: layer.width <= maxWidth };
}

/**
 * Text in the largest size from `style.px` down to `minPx` whose widest line
 * fits `maxWidth`. At the smallest size, a line still too wide loses
 * characters from its end for an ellipsis.
 */
export async function fitTextLayer(
  lines: string[],
  style: TextStyle,
  maxWidth: number,
  minPx: number,
): Promise<Layer & { px: number }> {
  const sized = await sizeToFit(lines, style, maxWidth, minPx);
  if (sized.fits) return sized;
  const px = sized.px;
  // At the smallest size: shorten the lines that are still too wide. Lines
  // drawn together can ink a few pixels wider than each alone (their side
  // bearings differ), hence the margin.
  const lineWidth = maxWidth - 8;
  const fitted: string[] = [];
  for (const line of lines) {
    let text = line;
    for (;;) {
      const layer = await textLayer([text], { ...style, px });
      if (layer.width <= lineWidth || Array.from(text).length <= 2) break;
      const chars = Array.from(text.replace(/…$/, ""));
      text = `${chars.slice(0, -1).join("").trimEnd()}…`;
    }
    fitted.push(text);
  }
  return { ...(await textLayer(fitted, { ...style, px })), px };
}

/**
 * A price split around its amount: "15 500 ₸ бастап" is the amount "15 500
 * ₸" and the words after it; "от 15 500 ₸" has its words before. Prices from
 * the shelf join their digits and currency with no-break spaces, so the
 * amount is the one piece with digits.
 */
export function splitPrice(priceText: string): {
  before: string;
  amount: string;
  after: string;
} {
  const pieces = priceText.trim().split(" ").filter(Boolean);
  const first = pieces.findIndex((piece) => /\d/.test(piece));
  if (first < 0) return { before: "", amount: priceText.trim(), after: "" };
  let last = first;
  while (last + 1 < pieces.length && /\d/.test(pieces[last + 1]!)) last++;
  return {
    before: pieces.slice(0, first).join(" "),
    amount: pieces.slice(first, last + 1).join(" "),
    after: pieces.slice(last + 1).join(" "),
  };
}

/** The smallest a price's amount is drawn, to fit its tag. */
const AMOUNT_MIN_PX = 12;

/**
 * A price's amount in Geologica, as large as fits `maxWidth` from
 * `amountPx` down, and always whole: an amount too long even at the
 * smallest size is drawn a little wider than `maxWidth` rather than cut
 * with an ellipsis, as the shelf's price is drawn whole. With 3 products,
 * the price card's tags give it 213 px: «1 500 000 000 VND» needs 227 at 24.
 */
export function amountLayer(
  amount: string,
  amountPx: number,
  maxWidth: number,
  color?: string,
): Promise<Layer & { px: number }> {
  return sizeToFit(
    [amount],
    { face: "display", weight: "semibold", px: amountPx, color },
    maxWidth,
    Math.min(amountPx, AMOUNT_MIN_PX),
  );
}

/**
 * A price as the shelf's tag shows it: the amount large in Geologica, its
 * "from" words small in Inter on their own line above or below it, so the
 * tag stays narrow. The amount shrinks to fit `maxWidth`, and is never cut.
 */
export async function priceLayer(
  priceText: string,
  amountPx: number,
  maxWidth: number,
  colors: { ink?: string; ink2?: string } = {},
): Promise<Layer> {
  const { before, amount, after } = splitPrice(priceText);
  const drawn = await amountLayer(amount, amountPx, maxWidth, colors.ink);
  const wordsPx = Math.max(18, Math.round(drawn.px * 0.44));
  const wordsStyle: TextStyle = {
    face: "text",
    weight: "medium",
    px: wordsPx,
    color: colors.ink2 ?? AD_COLORS.ink2,
  };
  const above = before
    ? await fitTextLayer([before], wordsStyle, maxWidth, 16)
    : null;
  const below = after
    ? await fitTextLayer([after], wordsStyle, maxWidth, 16)
    : null;
  if (!above && !below) return drawn;
  const gap = Math.round(drawn.px * 0.14);
  const parts = [above, drawn, below].filter(
    (part): part is Layer & { px: number } => part !== null,
  );
  const width = Math.max(...parts.map((part) => part.width));
  const height =
    parts.reduce((sum, part) => sum + part.height, 0) +
    gap * (parts.length - 1);
  let top = 0;
  const composites = parts.map((part) => {
    const placed = { input: part.image, left: 0, top };
    top += part.height + gap;
    return placed;
  });
  const image = await sharp({
    create: { width, height, channels: 4, background: TRANSPARENT },
  })
    .composite(composites)
    .png()
    .toBuffer();
  return { image, width, height };
}

type Shadow = { dy: number; sigma: number; alpha: number };
/** The Paper "label" shadow, at the ad's scale. */
const LABEL_SHADOW: Shadow = { dy: 5, sigma: 6, alpha: 0.24 };

const roundedRect = (
  width: number,
  height: number,
  radius: number,
  fill: string,
  extra = "",
) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}"/>${extra}</svg>`,
  );

/**
 * A paper card holding `content`, with its warm shadow: the image is larger
 * than the card by the shadow's reach, and `card` says where the card is.
 */
export async function paperCard(
  size: Size,
  content: Array<{ layer: Layer; left: number; top: number }>,
  options: { radius?: number; shadow?: Shadow; hole?: boolean } = {},
): Promise<Layer & { card: Rect }> {
  const radius = options.radius ?? 6;
  const shadow = options.shadow ?? LABEL_SHADOW;
  // Past twice its blur, the shadow is too faint to see.
  const reach = Math.ceil(shadow.sigma * 2);
  const margin = { x: reach, top: reach, bottom: reach + shadow.dy };
  const width = Math.round(size.width + margin.x * 2);
  const height = Math.round(size.height + margin.top + margin.bottom);
  const shade = await sharp({
    create: { width, height, channels: 4, background: TRANSPARENT },
  })
    .composite([
      {
        input: roundedRect(
          Math.round(size.width),
          Math.round(size.height),
          radius,
          `rgba(${SHADE},${shadow.alpha})`,
        ),
        left: margin.x,
        top: margin.top + shadow.dy,
      },
    ])
    .png()
    .toBuffer();
  const hole = options.hole
    ? `<circle cx="24" cy="${size.height / 2}" r="9" fill="rgba(${SHADE},0.10)"/>` +
      `<circle cx="24" cy="${size.height / 2 + 1}" r="8" fill="none" stroke="rgba(${SHADE},0.16)" stroke-width="1.5"/>`
    : "";
  const image = await sharp(
    await sharp(shade).blur(shadow.sigma).png().toBuffer(),
  )
    .composite([
      {
        input: roundedRect(
          Math.round(size.width),
          Math.round(size.height),
          radius,
          AD_COLORS.paper,
          hole,
        ),
        left: margin.x,
        top: margin.top,
      },
      ...content.map(({ layer, left, top }) => ({
        input: layer.image,
        left: Math.round(margin.x + left),
        top: Math.round(margin.top + top),
      })),
    ])
    .png()
    .toBuffer();
  return {
    image,
    width,
    height,
    card: {
      x: margin.x,
      y: margin.top,
      w: Math.round(size.width),
      h: Math.round(size.height),
    },
  };
}

/** A layer turned by `degrees` (clockwise), its canvas grown to hold it. */
async function turned(layer: Layer, degrees: number): Promise<Layer> {
  const { data, info } = await sharp(layer.image)
    .rotate(degrees, { background: TRANSPARENT })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { image: data, width: info.width, height: info.height };
}

/**
 * The widest a product scene's label may be, shadow included, so a price
 * tag (about 400 px) stands beside it inside the safe band.
 */
export const LABEL_MAX_WIDTH = 500;

/**
 * A scene caption's lines: the checks' two lines of 26 characters, broken
 * where the two come out most even, so the paid gate's «Сары шашты қуыршақ
 * Көк көйлек киген» reads "Сары шашты қуыршақ / Көк көйлек киген", not
 * "…қуыршақ Көк / көйлек киген". Never longer than the checks' lines.
 */
export function captionLines(caption: string): string[] {
  const lines = productAdLines(caption, 26);
  return lines.length === 2 ? balancedLines(caption, 2) : lines.slice(0, 2);
}

/**
 * The paper label of a product's scene: its name in Geologica (up to two
 * lines) and the script's caption under it in Inter, as the checks broke it.
 */
export async function labelLayer(input: {
  name: string;
  caption: string;
}): Promise<Layer> {
  const pad = { x: 26, y: 22 };
  const textWidth = LABEL_MAX_WIDTH - pad.x * 2 - 24;
  const nameStyle: TextStyle = { face: "display", weight: "semibold", px: 72 };
  // One line while it stays large; a longer name takes two lines.
  const oneLine = await sizeToFit(
    [input.name.trim()],
    nameStyle,
    textWidth,
    58,
  );
  const name = oneLine.fits
    ? oneLine
    : await fitTextLayer(
        balancedLines(input.name, 2),
        nameStyle,
        textWidth,
        40,
      );
  const lines = captionLines(input.caption);
  const caption = lines.length
    ? await fitTextLayer(
        lines,
        { face: "text", weight: "medium", px: 34, color: AD_COLORS.ink2 },
        textWidth,
        24,
      )
    : null;
  const gap = 14;
  const width = Math.max(name.width, caption?.width ?? 0) + pad.x * 2;
  const height = name.height + (caption ? gap + caption.height : 0) + pad.y * 2;
  return paperCard({ width, height }, [
    { layer: name, left: pad.x, top: pad.y },
    ...(caption
      ? [{ layer: caption, left: pad.x, top: pad.y + name.height + gap }]
      : []),
  ]);
}

/** A product scene's price tag: the shelf's paper tag with a punched hole, turned a little. */
export async function tagLayer(priceText: string): Promise<Layer> {
  const price = await priceLayer(priceText, 66, 560);
  const pad = { left: 48, right: 28, top: 20, bottom: 22 };
  const card = await paperCard(
    {
      width: price.width + pad.left + pad.right,
      height: price.height + pad.top + pad.bottom,
    },
    [{ layer: price, left: pad.left, top: pad.top }],
    { hole: true },
  );
  return turned(card, -3);
}

/** The first scene's sticker: the script's hook on paper, turned the other way. */
export async function stickerLayer(text: string): Promise<Layer> {
  const words = await fitTextLayer(
    productAdLines(text, 26).slice(0, 1),
    { face: "display", weight: "semibold", px: 64 },
    760,
    40,
  );
  const pad = { x: 34, y: 26 };
  const card = await paperCard(
    { width: words.width + pad.x * 2, height: words.height + pad.y * 2 },
    [{ layer: words, left: pad.x, top: pad.y }],
    { radius: 10 },
  );
  return turned(card, 2);
}

/** A product's small tag on the price card: its name over its price. */
export async function shelfTagLayer(
  name: string,
  priceText: string,
  maxWidth: number,
  degrees: number,
): Promise<Layer> {
  const pad = { left: 44, right: 22, top: 14, bottom: 16 };
  const inner = Math.max(80, maxWidth - pad.left - pad.right - 24);
  const nameLayer = await fitTextLayer(
    [name],
    { face: "text", weight: "medium", px: 26, color: AD_COLORS.ink2 },
    inner,
    18,
  );
  const price = await priceLayer(priceText, 50, inner);
  const gap = 8;
  const card = await paperCard(
    {
      width: Math.max(nameLayer.width, price.width) + pad.left + pad.right,
      height: nameLayer.height + gap + price.height + pad.top + pad.bottom,
    },
    [
      { layer: nameLayer, left: pad.left, top: pad.top },
      { layer: price, left: pad.left, top: pad.top + nameLayer.height + gap },
    ],
    { hole: true },
  );
  return turned(card, degrees);
}

// ---------------------------------------------------------------------------
// Pictures: the wall and plank, a product on it, the price card and the end.

const PLANK_TOP_SCENE = 1200;
const PLANK_TOP_CARD = 1030;

/** The shelf's wall, with window light, and a birch plank whose top is at `plankTop`. */
export function wallSvg(
  size: Size,
  plankTop: number | null,
  extra = "",
): Buffer {
  const { width, height } = size;
  const plank =
    plankTop === null
      ? ""
      : `
    <rect y="${plankTop + 72}" width="${width}" height="${height - plankTop - 72}" fill="url(#floor)"/>
    <rect y="${plankTop}" width="${width}" height="30" fill="url(#birch)"/>
    <rect y="${plankTop}" width="${width}" height="2" fill="rgba(${SHADE},0.11)"/>
    <rect y="${plankTop + 30}" width="${width}" height="42" fill="url(#ply)"/>
    <rect y="${plankTop + 30}" width="${width}" height="2" fill="rgba(255,255,255,0.5)"/>
    <rect y="${plankTop + 70}" width="${width}" height="2" fill="rgba(${SHADE},0.18)"/>
    <rect y="${plankTop + 72}" width="${width}" height="66" fill="url(#under)"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AD_COLORS.wallTop}"/>
      <stop offset="1" stop-color="${AD_COLORS.wallLow}"/>
    </linearGradient>
    <radialGradient id="window" cx="0.18" cy="-0.1" r="0.95" gradientTransform="translate(0.18 -0.1) scale(1.37 1) translate(-0.18 0.1)">
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="0.62" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="birch" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AD_COLORS.birchTop}"/>
      <stop offset="1" stop-color="${AD_COLORS.birchLow}"/>
    </linearGradient>
    <linearGradient id="ply" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AD_COLORS.plyTop}"/>
      <stop offset="1" stop-color="${AD_COLORS.plyLow}"/>
    </linearGradient>
    <linearGradient id="under" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb(${SHADE})" stop-opacity="0.12"/>
      <stop offset="1" stop-color="rgb(${SHADE})" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AD_COLORS.floorTop}"/>
      <stop offset="1" stop-color="${AD_COLORS.floorLow}"/>
    </linearGradient>
    <radialGradient id="contact">
      <stop offset="0" stop-color="rgb(${SHADE})" stop-opacity="0.34"/>
      <stop offset="1" stop-color="rgb(${SHADE})" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ambient">
      <stop offset="0" stop-color="rgb(${SHADE})" stop-opacity="0.13"/>
      <stop offset="1" stop-color="rgb(${SHADE})" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wall)"/>
  <rect width="${width}" height="${height}" fill="url(#window)"/>
  ${plank}
  ${extra}
</svg>`);
}

/** The contact and ambient shadows under a product standing at `rect`. */
export const groundShadows = (rect: Rect) => {
  const cx = rect.x + rect.w / 2;
  const base = rect.y + rect.h;
  return (
    `<ellipse cx="${cx}" cy="${base + 21}" rx="${(rect.w * 1.04) / 2}" ry="33" fill="url(#ambient)"/>` +
    `<ellipse cx="${cx}" cy="${base}" rx="${(rect.w * 0.7) / 2}" ry="12" fill="url(#contact)"/>`
  );
};

/** The opaque part of a transparent cut-out; null when it is empty. */
export async function alphaBox(png: Buffer): Promise<{
  left: number;
  top: number;
  width: number;
  height: number;
} | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottomRow = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x]! > 24) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottomRow) bottomRow = y;
      }
    }
  }
  return right < 0
    ? null
    : { left, top, width: right - left + 1, height: bottomRow - top + 1 };
}

/** A cut-out trimmed to its opaque part. */
export async function trimmedCutout(
  png: Buffer,
): Promise<{ image: Buffer; size: Size }> {
  const box = await alphaBox(png);
  if (!box) throw new Error("The product's cut-out is empty");
  const image = await sharp(png).ensureAlpha().extract(box).png().toBuffer();
  return { image, size: { width: box.width, height: box.height } };
}

export async function placedCutout(
  image: Buffer,
  rect: Rect,
): Promise<OverlayOptions> {
  return {
    input: await sharp(image)
      .resize(rect.w, rect.h, { fit: "fill", kernel: "lanczos3" })
      .png()
      .toBuffer(),
    left: Math.round(rect.x),
    top: Math.round(rect.y),
  };
}

/**
 * The exact still of a product: its own cut-out, unchanged, standing on the
 * plank against the code-drawn wall with contact and ambient shadows, at
 * 1080x1920. The top of the safe band stays empty for the words. Also the
 * product's box, as fractions of the still.
 */
export async function exactScene(
  cutout: Buffer,
): Promise<{ image: Buffer; box: ProductAdBox }> {
  const product = await trimmedCutout(cutout);
  const rect = exactRect(product.size);
  const image = await sharp(
    wallSvg(AD_FRAME, PLANK_TOP_SCENE, groundShadows(rect)),
  )
    .composite([await placedCutout(product.image, rect)])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return { image, box: frameBox(rect) };
}

/** Where the exact still stands a product of `size` (its opaque part). */
export function exactRect(size: Size): Rect {
  return shelfRow([size], { x: 110, w: 860 }, PLANK_TOP_SCENE + 6, 640)[0]!;
}

const frameBox = (rect: Rect): ProductAdBox => ({
  x: rect.x / AD_FRAME.width,
  y: rect.y / AD_FRAME.height,
  w: rect.w / AD_FRAME.width,
  h: rect.h / AD_FRAME.height,
});

/**
 * The product's box in its exact still, as exactScene draws it, without
 * drawing it: for ads made before the box was kept beside the still. Null
 * for an empty cut-out. Code only, no model call.
 */
export async function exactSceneBox(
  cutout: Buffer,
): Promise<ProductAdBox | null> {
  const box = await alphaBox(cutout);
  return box
    ? frameBox(exactRect({ width: box.width, height: box.height }))
    : null;
}

/**
 * A scene's picture cut to `frame` around its product: a Muse Image scene,
 * or an exact still. Also where the product is in it and where the camera
 * pushes in. PNG, not JPEG: a JPEG's full-range colour would carry through
 * ffmpeg into the video, which then plays with the wrong contrast.
 */
export async function coverBackground(
  picture: Buffer,
  frame: Size,
  box: ProductAdBox | null,
): Promise<{ image: Buffer; crop: CoverCrop }> {
  const meta = await sharp(picture).metadata();
  const crop = coverCrop(
    { width: meta.width ?? frame.width, height: meta.height ?? frame.height },
    frame,
    box,
  );
  const image = await sharp(picture)
    .resize(crop.resize.width, crop.resize.height, { fit: "fill" })
    .extract({
      left: crop.left,
      top: crop.top,
      width: frame.width,
      height: frame.height,
    })
    .flatten({ background: AD_COLORS.wallTop })
    .png({ compressionLevel: 1 })
    .toBuffer();
  return { image, crop };
}

export type PlacedLayer = { layer: Layer; rect: Rect };

/** A product scene's words: the label, the tag and, on the first, the sticker; placed. */
export async function productSceneLayers(input: {
  frame: "reels" | "feed";
  product: Rect | null;
  name: string;
  caption: string;
  priceText: string;
  sticker: string | null;
  /** Where the words go: "auto" (the default) or the owner's top or bottom. */
  zone?: ProductAdTextZone;
}): Promise<{
  label: PlacedLayer;
  tag: PlacedLayer;
  sticker: PlacedLayer | null;
  layout: SceneTextLayout;
}> {
  const [label, tag, sticker] = await Promise.all([
    labelLayer({ name: input.name, caption: input.caption }),
    tagLayer(input.priceText),
    input.sticker ? stickerLayer(input.sticker) : null,
  ]);
  const layout = placeSceneText({
    safe: input.frame === "feed" ? FEED_SAFE : REELS_SAFE,
    product: input.product,
    label,
    tag,
    sticker,
    zone: input.zone,
  });
  return {
    label: { layer: label, rect: layout.label },
    tag: { layer: tag, rect: layout.tag },
    sticker:
      sticker && layout.sticker
        ? { layer: sticker, rect: layout.sticker }
        : null,
    layout,
  };
}

export type PriceCardProduct = {
  cutout: Buffer;
  name: string;
  priceText: string;
};

/** Where a shelf card is drawn: the frame, its safe band, the plank's top and the products' height. */
export type ShelfCardFrame = {
  size: Size;
  safe: Rect;
  plankTop: number;
  maxHeight: number;
};

/** The price card's frame: the 9:16 video and Status picture. */
export const PRICE_CARD_FRAME: ShelfCardFrame = {
  size: AD_FRAME,
  safe: REELS_SAFE,
  plankTop: PLANK_TOP_CARD,
  // As tall as the room under a one-line title allows (the paid gate found
  // 480 px left the Status picture's products small, the wall empty).
  maxHeight: 600,
};

/**
 * The price card: every product's exact cut-out on the plank, the title at
 * the top of the safe band, and each product's tag hanging from the plank's
 * lip, inside the band. The background, the title and the tags are separate
 * layers, for the video to animate. `frame` draws the same card in another
 * frame (the 4:5 Collection picture); the price card's by default.
 */
export async function priceCardLayers(input: {
  title: string;
  products: PriceCardProduct[];
  frame?: ShelfCardFrame;
}): Promise<{ background: Buffer; title: PlacedLayer; tags: PlacedLayer }> {
  const frame = input.frame ?? PRICE_CARD_FRAME;
  const safe = frame.safe;
  const products = await Promise.all(
    input.products.map((product) => trimmedCutout(product.cutout)),
  );
  const rects = shelfRow(
    products.map((product) => product.size),
    { x: 90, w: frame.size.width - 180 },
    frame.plankTop + 6,
    frame.maxHeight,
  );
  const background = await sharp(
    wallSvg(frame.size, frame.plankTop, rects.map(groundShadows).join("")),
  )
    .composite(
      await Promise.all(
        products.map((product, index) =>
          placedCutout(product.image, rects[index]!),
        ),
      ),
    )
    .png()
    .toBuffer();

  const title = await fitTextLayer(
    [input.title],
    { face: "display", weight: "semibold", px: 84, align: "centre" },
    safe.w - 40,
    48,
  );
  const titleRect = {
    x: Math.round(frame.size.width / 2 - title.width / 2),
    y: safe.y + 24,
    w: title.width,
    h: title.height,
  };

  // The tags hang under the lip, one under each product, in a row that
  // stays inside the safe band's sides and bottom.
  const slot = Math.floor(
    (safe.w - 20 * (input.products.length - 1)) / input.products.length,
  );
  const tags = await Promise.all(
    input.products.map((product, index) =>
      shelfTagLayer(
        product.name,
        product.priceText,
        Math.min(420, slot),
        index % 2 === 0 ? -2 : 1.5,
      ),
    ),
  );
  const tagTop = frame.plankTop + 72 + 6;
  const tagHeight = Math.max(...tags.map((tag) => tag.height));
  const lanes = tags.map((tag, index) => {
    const centre = rects[index]!.x + rects[index]!.w / 2;
    return Math.round(centre - tag.width / 2);
  });
  // Keep the row inside the band and the tags apart.
  for (let i = 0; i < lanes.length; i++) {
    const min = i === 0 ? safe.x : lanes[i - 1]! + tags[i - 1]!.width + 8;
    lanes[i] = Math.max(lanes[i]!, min);
  }
  for (let i = lanes.length - 1; i >= 0; i--) {
    const max =
      i === lanes.length - 1
        ? safe.x + safe.w - tags[i]!.width
        : lanes[i + 1]! - tags[i]!.width - 8;
    lanes[i] = Math.min(lanes[i]!, max);
  }
  const rowLeft = Math.min(...lanes);
  const rowRight = Math.max(...lanes.map((left, i) => left + tags[i]!.width));
  const row = await sharp({
    create: {
      width: rowRight - rowLeft,
      height: tagHeight,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite(
      tags.map((tag, index) => ({
        input: tag.image,
        left: lanes[index]! - rowLeft,
        top: 0,
      })),
    )
    .png()
    .toBuffer();
  const top = Math.min(tagTop, safe.y + safe.h - tagHeight);
  return {
    background,
    title: { layer: title, rect: titleRect },
    tags: {
      layer: { image: row, width: rowRight - rowLeft, height: tagHeight },
      rect: { x: rowLeft, y: top, w: rowRight - rowLeft, h: tagHeight },
    },
  };
}

const CHAT_ICON = (size: number, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>` +
  `<path d="M9.5 10.5c.5 1.5 1.6 2.6 3.1 3.1l1.2-1.2 2 .8-.4 1.8c-3.4.3-6.8-3.1-6.5-6.5l1.8-.4.8 2Z" stroke-width="1.5"/></svg>`;

/**
 * The person from the video, as a circle cut to head and shoulders (the top
 * 45% of the cut-out, which also leaves out subtitles burned in across a
 * promo presenter's chest), 300 px with a white ring.
 */
export async function presenterCircle(cutout: Buffer): Promise<Layer> {
  const box = await alphaBox(cutout);
  if (!box) throw new Error("The presenter's cut-out is empty");
  const side = Math.max(
    16,
    Math.round(Math.min(box.width, box.height * 0.45 * 1.15)),
  );
  const centre = box.left + box.width / 2;
  const meta = await sharp(cutout).metadata();
  const width = meta.width ?? box.width;
  const left = Math.round(
    Math.min(Math.max(0, centre - side / 2), Math.max(0, width - side)),
  );
  const top = Math.max(0, box.top - Math.round(side * 0.06));
  const height = Math.min(side, (meta.height ?? side) - top);
  const face = await sharp(cutout)
    .extract({ left, top, width: Math.min(side, width - left), height })
    .resize(280, 280, { fit: "cover", position: "top" })
    .flatten({ background: AD_COLORS.sandTop })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280"><circle cx="140" cy="140" r="140"/></svg>`,
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
  const ring = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="352">` +
      `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter></defs>` +
      `<circle cx="170" cy="178" r="150" fill="rgba(${SHADE},0.22)" filter="url(#s)"/>` +
      `<circle cx="170" cy="170" r="150" fill="#ffffff"/></svg>`,
  );
  const image = await sharp(ring)
    .composite([{ input: face, left: 30, top: 30 }])
    .png()
    .toBuffer();
  return { image, width: 340, height: 352 };
}

/**
 * The ending: the products small on a plank, the person from the video
 * when they agreed, the shop's name, the script's ending and a WhatsApp pill
 * with the connected number (or the shop's name without one). A shop's name
 * the fonts can't draw is left out: the pill then says "WhatsApp".
 */
export async function endingLayers(input: {
  cutouts: Buffer[];
  presenter: Buffer | null;
  shopName: string;
  ending: string;
  phone: string | null;
}): Promise<{ background: Buffer; words: PlacedLayer; pill: PlacedLayer }> {
  const products = await Promise.all(input.cutouts.map(trimmedCutout));
  const presenter = input.presenter
    ? await presenterCircle(input.presenter)
    : null;
  const shelf = presenter ? { x: 470, w: 470 } : { x: 290, w: 500 };
  const plankTop = 620;
  const rects = shelfRow(
    products.map((product) => product.size),
    shelf,
    plankTop + 3,
    230,
    24,
  );
  const plank =
    `<rect x="${shelf.x - 20}" y="${plankTop}" width="${shelf.w + 40}" height="14" rx="3" fill="url(#ply)"/>` +
    `<rect x="${shelf.x - 20}" y="${plankTop}" width="${shelf.w + 40}" height="2" fill="rgba(255,255,255,0.6)"/>` +
    `<rect x="${shelf.x - 20}" y="${plankTop + 14}" width="${shelf.w + 40}" height="26" fill="url(#under)"/>`;
  const sand =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${AD_FRAME.width}" height="${AD_FRAME.height}">
  <defs>
    <linearGradient id="sand" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AD_COLORS.sandTop}"/>
      <stop offset="1" stop-color="${AD_COLORS.sandLow}"/>
    </linearGradient>
    <linearGradient id="ply" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AD_COLORS.plyTop}"/>
      <stop offset="1" stop-color="${AD_COLORS.plyLow}"/>
    </linearGradient>
    <linearGradient id="under" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb(${SHADE})" stop-opacity="0.16"/>
      <stop offset="1" stop-color="rgb(${SHADE})" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="contact">
      <stop offset="0" stop-color="rgb(${SHADE})" stop-opacity="0.3"/>
      <stop offset="1" stop-color="rgb(${SHADE})" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${AD_FRAME.width}" height="${AD_FRAME.height}" fill="url(#sand)"/>
  ${plank}
  ${rects.map((rect) => `<ellipse cx="${rect.x + rect.w / 2}" cy="${rect.y + rect.h}" rx="${rect.w * 0.36}" ry="7" fill="url(#contact)"/>`).join("")}
</svg>`);
  const background = await sharp(sand)
    .composite([
      ...(presenter
        ? [{ input: presenter.image, left: 110, top: plankTop - 330 }]
        : []),
      ...(await Promise.all(
        products.map((product, index) =>
          placedCutout(product.image, rects[index]!),
        ),
      )),
    ])
    .png()
    .toBuffer();

  const maxWidth = REELS_SAFE.w - 60;
  // A name the fonts can't draw (an emoji, CJK) is left out, number or not:
  // the web's letters check doesn't refuse it, as the owner can't rename
  // the workspace from Products.
  const shopName = productAdShopName(input.shopName);
  const shop = shopName
    ? await fitTextLayer(
        [shopName],
        {
          face: "text",
          weight: "semibold",
          px: 40,
          color: AD_COLORS.ink2,
          align: "centre",
        },
        maxWidth,
        28,
      )
    : null;
  const sayStyle: TextStyle = {
    face: "display",
    weight: "semibold",
    px: 88,
    align: "centre",
  };
  // One line while it stays large; else two even lines.
  const sayOneLine = await sizeToFit(
    [input.ending.trim()],
    sayStyle,
    maxWidth,
    76,
  );
  const say = sayOneLine.fits
    ? sayOneLine
    : await fitTextLayer(
        balancedLines(input.ending, 2),
        sayStyle,
        maxWidth,
        52,
      );
  const gap = 28;
  const wordsWidth = Math.max(shop?.width ?? 0, say.width);
  const wordsHeight = (shop ? shop.height + gap : 0) + say.height;
  const words = await sharp({
    create: {
      width: wordsWidth,
      height: wordsHeight,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite([
      ...(shop
        ? [
            {
              input: shop.image,
              left: Math.round((wordsWidth - shop.width) / 2),
              top: 0,
            },
          ]
        : []),
      {
        input: say.image,
        left: Math.round((wordsWidth - say.width) / 2),
        top: shop ? shop.height + gap : 0,
      },
    ])
    .png()
    .toBuffer();
  const wordsRect = {
    x: Math.round(AD_FRAME.width / 2 - wordsWidth / 2),
    y: plankTop + 80,
    w: wordsWidth,
    h: wordsHeight,
  };

  const pillCard = await contactPill(
    { phone: input.phone, shopName: input.shopName },
    maxWidth,
  );
  const pillRect = {
    x: Math.round(AD_FRAME.width / 2 - pillCard.width / 2),
    y: Math.min(
      wordsRect.y + wordsRect.h + 44,
      REELS_SAFE.y + REELS_SAFE.h - pillCard.height,
    ),
    w: pillCard.width,
    h: pillCard.height,
  };
  return {
    background,
    words: {
      layer: { image: words, width: wordsWidth, height: wordsHeight },
      rect: wordsRect,
    },
    pill: { layer: pillCard, rect: pillRect },
  };
}

/**
 * The ending's WhatsApp pill: the chat icon and the connected number, or
 * the shop's name without one (left out when the fonts can't draw it: then
 * "WhatsApp"), on a paper pill at most `maxWidth` wide.
 */
export async function contactPill(
  input: { phone: string | null; shopName: string },
  maxWidth: number,
): Promise<Layer & { card: Rect }> {
  const shopName = productAdShopName(input.shopName);
  const contact = input.phone
    ? `WhatsApp · ${input.phone}`
    : shopName || "WhatsApp";
  const pillText = await fitTextLayer(
    [contact],
    { face: "text", weight: "semibold", px: 44 },
    maxWidth - 150,
    30,
  );
  const icon = await sharp(Buffer.from(CHAT_ICON(52, AD_COLORS.ink)))
    .png()
    .toBuffer();
  const pillHeight = 104;
  const pillWidth = pillText.width + 52 + 22 + 92;
  return paperCard(
    { width: pillWidth, height: pillHeight },
    [
      {
        layer: { image: icon, width: 52, height: 52 },
        left: 46,
        top: (pillHeight - 52) / 2,
      },
      {
        layer: pillText,
        left: 46 + 52 + 22,
        top: (pillHeight - pillText.height) / 2,
      },
    ],
    { radius: pillHeight / 2, shadow: { dy: 8, sigma: 9, alpha: 0.2 } },
  );
}

/** A picture with layers laid on it, as a JPEG the owner downloads. */
export async function composeStill(
  background: Buffer,
  layers: PlacedLayer[],
  size: Size,
): Promise<Buffer> {
  return sharp(background)
    .resize(size.width, size.height, { fit: "cover" })
    .composite(
      layers.map(({ layer, rect }) => ({
        input: layer.image,
        left: Math.round(rect.x),
        top: Math.round(rect.y),
      })),
    )
    .flatten({ background: AD_COLORS.wallTop })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/**
 * The 4:5 ad picture: the first scene's picture cut to 1080x1350 around its
 * product, with its label and tag.
 */
export async function feedStill(input: {
  picture: Buffer;
  box: ProductAdBox | null;
  name: string;
  caption: string;
  priceText: string;
  /** The owner's choice of where the words sit, as in the video. */
  zone?: ProductAdTextZone;
}): Promise<Buffer> {
  const { image, crop } = await coverBackground(
    input.picture,
    AD_FEED_FRAME,
    input.box,
  );
  const words = await productSceneLayers({
    frame: "feed",
    product: crop.product,
    name: input.name,
    caption: input.caption,
    priceText: input.priceText,
    sticker: null,
    zone: input.zone,
  });
  return composeStill(image, [words.label, words.tag], AD_FEED_FRAME);
}

// ---------------------------------------------------------------------------
// Studio v3: the studio sweep, and the cut-out as a layer of its own for the
// Float and Pop motions. Code only, like everything here.

/**
 * A studio sweep in one of the Paper colourways: the wall's colour easing
 * into the floor's like a photo cove, with a little window light (less on
 * "night", a warm evening shop that is never black), and `extra` SVG drawn
 * on it (ground shadows: the defs `ambient` and `contact` are here).
 */
export function studioSweepSvg(
  size: Size,
  colourway: ProductAdStudioColourway,
  extra = "",
): Buffer {
  const sweep = PRODUCT_AD_STUDIO_SWEEPS[colourway];
  const { width, height } = size;
  const light = colourway === "night" ? 0.07 : 0.4;
  const shade = colourway === "night" ? "10,6,3" : SHADE;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="sweep" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${sweep.top}"/>
      <stop offset="0.52" stop-color="${sweep.top}"/>
      <stop offset="0.82" stop-color="${sweep.bottom}"/>
      <stop offset="1" stop-color="${sweep.bottom}"/>
    </linearGradient>
    <radialGradient id="light" cx="0.2" cy="0" r="0.9">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${light}"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="contact">
      <stop offset="0" stop-color="rgb(${shade})" stop-opacity="0.34"/>
      <stop offset="1" stop-color="rgb(${shade})" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ambient">
      <stop offset="0" stop-color="rgb(${shade})" stop-opacity="0.13"/>
      <stop offset="1" stop-color="rgb(${shade})" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sweep)"/>
  <rect width="${width}" height="${height}" fill="url(#light)"/>
  ${extra}
</svg>`);
}

type Lab = [number, number, number];

/** sRGB (0-255) to CIE L*a*b* (D65). */
function labOfRgb([r, g, b]: [number, number, number]): Lab {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t: number) =>
    t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const labOfHex = (hex: string): Lab => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return labOfRgb([(value >> 16) & 255, (value >> 8) & 255, value & 255]);
};

/** "night" stands out from nearly anything: it wins only for a pale product. */
const NIGHT_WEIGHT = 0.7;

/**
 * The colourway a product stands out on best: the one whose sweep is
 * farthest from the product's own average colour (CIE76 ΔE), with "night"
 * held back so it's the pick for pale products only. "white" for an empty
 * cut-out.
 */
export async function studioColourwayFor(
  cutout: Buffer,
): Promise<ProductAdStudioColourway> {
  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .resize(64, 64, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3]! < 128) continue;
    sum[0]! += data[i * 4]!;
    sum[1]! += data[i * 4 + 1]!;
    sum[2]! += data[i * 4 + 2]!;
    count++;
  }
  if (count === 0) return "white";
  const product = labOfRgb([sum[0]! / count, sum[1]! / count, sum[2]! / count]);
  let best: ProductAdStudioColourway = "white";
  let bestScore = -1;
  for (const colourway of PRODUCT_AD_STUDIO_COLOURWAYS) {
    const sweep = PRODUCT_AD_STUDIO_SWEEPS[colourway];
    const top = labOfHex(sweep.top);
    const low = labOfHex(sweep.bottom);
    const distance = Math.hypot(
      ...top.map((value, i) => (value + low[i]!) / 2 - product[i]!),
    );
    const score = distance * (colourway === "night" ? NIGHT_WEIGHT : 1);
    if (score > bestScore) {
      best = colourway;
      bestScore = score;
    }
  }
  return best;
}

/**
 * A soft shadow cast by a cut-out: its own shape in the warm shade at
 * `alpha`, blurred by `sigma`, on a canvas grown by the blur's reach
 * (`margin` on each side).
 */
export async function silhouetteShadow(
  image: Buffer,
  options: { alpha: number; sigma: number },
): Promise<Layer & { margin: number }> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  const margin = Math.ceil(options.sigma * 2.5);
  const [r, g, b] = SHADE.split(",").map(Number) as [number, number, number];
  const shape = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r, g, b, alpha: options.alpha },
    },
  })
    .composite([{ input: image, blend: "dest-in" }])
    .png()
    .toBuffer();
  const grown = await sharp({
    create: {
      width: width + margin * 2,
      height: height + margin * 2,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite([{ input: shape, left: margin, top: margin }])
    .png()
    .toBuffer();
  return {
    image: await sharp(grown).blur(options.sigma).png().toBuffer(),
    width: width + margin * 2,
    height: height + margin * 2,
    margin,
  };
}

export type FrameLayer = Layer & { rect: Rect };

/** Float: how high above the plank the product hangs at the middle of its bob. */
const FLOAT_LIFT = 16;

/**
 * Float's scene: the wall and plank with the ambient shadow (the picture
 * under everything), the product's exact cut-out as a layer of its own,
 * hanging FLOAT_LIFT px above where the exact still stands it (render.ts
 * bobs it), and the contact shadow on the plank at its smallest, for the
 * render to breathe. `product` is where the product stands, for the words.
 */
export async function floatSceneLayers(cutout: Buffer): Promise<{
  background: Buffer;
  subject: FrameLayer;
  shadow: FrameLayer;
  product: Rect;
}> {
  const product = await trimmedCutout(cutout);
  const stand = exactRect(product.size);
  const cx = stand.x + stand.w / 2;
  const base = stand.y + stand.h;
  const ambient = `<ellipse cx="${cx}" cy="${base + 21}" rx="${(stand.w * 1.04) / 2}" ry="33" fill="url(#ambient)"/>`;
  const background = await sharp(wallSvg(AD_FRAME, PLANK_TOP_SCENE, ambient))
    .png({ compressionLevel: 1 })
    .toBuffer();
  const subject = await sharp(product.image)
    .resize(stand.w, stand.h, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  // The ellipse at its smallest fills 3/4 of its layer, so zooming in by
  // the swing never cuts it.
  const rx = Math.max(8, Math.round(stand.w * 0.33));
  const ry = 13;
  const shadowWidth = Math.round(rx * 2 * 1.34);
  const shadowHeight = Math.round(ry * 2 * 1.34) + 8;
  const shadow = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${shadowWidth}" height="${shadowHeight}">` +
        `<defs><radialGradient id="c"><stop offset="0" stop-color="rgb(${SHADE})" stop-opacity="0.36"/>` +
        `<stop offset="1" stop-color="rgb(${SHADE})" stop-opacity="0"/></radialGradient></defs>` +
        `<ellipse cx="${shadowWidth / 2}" cy="${shadowHeight / 2}" rx="${rx}" ry="${ry}" fill="url(#c)"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  return {
    background,
    subject: {
      image: subject,
      width: stand.w,
      height: stand.h,
      rect: { ...stand, y: stand.y - FLOAT_LIFT },
    },
    shadow: {
      image: shadow,
      width: shadowWidth,
      height: shadowHeight,
      rect: {
        x: Math.round(cx - shadowWidth / 2),
        y: Math.round(base - shadowHeight / 2),
        w: shadowWidth,
        h: shadowHeight,
      },
    },
    product: stand,
  };
}

/** Pop: the room around the cut-out, so growing by 8% never cuts it or its shadow. */
const POP_PAD = 0.1;

/**
 * Pop's cut-out: the product's exact cut-out fitted into `rect` (where SAM
 * found it in its scene, or where the exact still stands it), centred,
 * with a soft shadow under it, on a padded transparent layer centred on the
 * product: render.ts grows it from there. `product` is the fitted product,
 * for the words.
 */
export async function popSubjectLayer(
  cutout: Buffer,
  rect: Rect,
): Promise<{ subject: FrameLayer; product: Rect }> {
  const trimmed = await trimmedCutout(cutout);
  const fit = Math.min(
    rect.w / trimmed.size.width,
    rect.h / trimmed.size.height,
  );
  const w = Math.max(2, Math.round(trimmed.size.width * fit));
  const h = Math.max(2, Math.round(trimmed.size.height * fit));
  const product = {
    x: Math.round(rect.x + (rect.w - w) / 2),
    y: Math.round(rect.y + (rect.h - h) / 2),
    w,
    h,
  };
  const image = await sharp(trimmed.image)
    .resize(w, h, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const shadow = await silhouetteShadow(image, { alpha: 0.3, sigma: 12 });
  const pad = Math.max(
    shadow.margin + 18,
    Math.round(Math.max(w, h) * POP_PAD),
  );
  const width = w + pad * 2;
  const height = h + pad * 2;
  const layer = await sharp({
    create: { width, height, channels: 4, background: TRANSPARENT },
  })
    .composite([
      {
        input: shadow.image,
        left: pad - shadow.margin,
        top: pad - shadow.margin + 16,
      },
      { input: image, left: pad, top: pad },
    ])
    .png()
    .toBuffer();
  return {
    subject: {
      image: layer,
      width,
      height,
      rect: { x: product.x - pad, y: product.y - pad, w: width, h: height },
    },
    product,
  };
}
