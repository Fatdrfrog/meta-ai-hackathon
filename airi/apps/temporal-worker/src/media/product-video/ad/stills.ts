import {
  PRODUCT_AD_STILL_KINDS,
  PRODUCT_AD_STUDIO_COLOURWAYS,
  PRODUCT_AD_STUDIO_SWEEPS,
  productAdShopName,
  type ProductAdBox,
  type ProductAdStillFormat,
  type ProductAdStillKind,
  type ProductAdStudioColourway,
  type ProductAdTextZone,
} from "@icecore/temporal";
import sharp, { type OverlayOptions } from "sharp";
import {
  AD_COLORS,
  AD_SHADE,
  alphaBox,
  amountLayer,
  balancedLines,
  captionLines,
  contactPill,
  coverBackground,
  feedStill,
  fitTextLayer,
  groundShadows,
  paperCard,
  priceCardLayers,
  priceLayer,
  shelfTagLayer,
  silhouetteShadow,
  splitPrice,
  studioColourwayFor,
  studioSweepSvg,
  tagLayer,
  textLayer,
  trimmedCutout,
  type Layer,
} from "./layers";
import {
  AD_FEED_FRAME,
  AD_FRAME,
  FEED_SAFE,
  shelfRow,
  type Rect,
  type Size,
} from "./layout";

// The pictures a render draws besides the video (studio v3's picture
// templates), all code over what the ad already made: no model call, no AI
// action. Every still is a JPEG q90 in sRGB, 1080x1350 (feed, 4:5) or
// 1080x1920 (story, 9:16), and the shelf's prices are drawn here, as text,
// never by a model:
// - room (feed, per product): v2's 4:5 ad picture of that product's scene;
// - studio (feed, per product and colourway): the exact cut-out on a code
//   sweep, its shadow from its own shape, its paper tag; the colourway it
//   stands out on best comes first (studioColourwayFor);
// - big_price (feed and story, per product): the price huge, the product
//   standing in front of it;
// - collection (feed): every product on one plank with its tag, titled by
//   the opening (the price card, at 4:5);
// - price_list (story): every product with a dotted leader to its price,
//   the shop's name, the ending and its WhatsApp line;
// - spotlight (story, per product): one product large on its studio sweep
//   under its name and caption, with its paper price tag at the foot;
// - print (feed, per product): the product's scene framed as a photo print
//   on paper, with its name, caption and price in the bottom mat;
// - grid (feed and story): every product in a catalog grid of paper cards
//   under the opening, with the shop's WhatsApp pill at the foot.

/**
 * Where a Story's words stay: Meta asks for the top and bottom 14% (about
 * 250 px) to be left to the app's own header and reply bar.
 */
export const STORY_SAFE: Rect = { x: 65, y: 250, w: 950, h: 1420 };

export type StillsProduct = {
  productId: string;
  name: string;
  priceText: string;
  caption: string;
  cutout: Buffer;
  /** The scene's picture (Muse Image's, or the exact still) and the product in it. */
  picture: Buffer;
  box: ProductAdBox | null;
  textZone?: ProductAdTextZone;
};

export type StillsInput = {
  products: StillsProduct[];
  /** The opening on the video: Collection's title (else the price card's). */
  sticker: string;
  priceCardTitle: string;
  ending: string;
  shopName: string;
  phone: string | null;
  /** Which kinds to draw; every kind when absent. */
  kinds?: readonly ProductAdStillKind[];
  /** "default": one studio still per product (its best colourway), not all five. */
  studio?: "all" | "default";
};

export type DrawnStill = {
  kind: ProductAdStillKind;
  format: ProductAdStillFormat;
  productId: string | null;
  colourway: ProductAdStudioColourway | null;
  image: Buffer;
};

/** The file a still is saved as (the contract's name). */
export function stillFileName(
  renderNo: number,
  still: Pick<DrawnStill, "kind" | "format" | "productId" | "colourway">,
): string {
  return `${renderNo}-${still.kind}-${still.format}-${still.productId ?? "all"}-${still.colourway ?? "x"}.jpg`;
}

const jpeg = (image: sharp.Sharp) =>
  image
    .flatten({ background: AD_COLORS.wallTop })
    .toColourspace("srgb")
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

/** A product's pieces every still of it shares, drawn once. */
type Shared = {
  product: StillsProduct;
  cutout: { image: Buffer; size: Size };
  colourway: ProductAdStudioColourway;
  tag: Promise<Layer>;
};

/** A cut-out resized to `rect`, with its soft shadow (drop) laid under it. */
async function standing(
  cutout: { image: Buffer },
  rect: Rect,
  shadow: { alpha: number; sigma: number; dy: number },
): Promise<OverlayOptions[]> {
  const image = await sharp(cutout.image)
    .resize(rect.w, rect.h, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const cast = await silhouetteShadow(image, shadow);
  return [
    {
      input: cast.image,
      left: Math.round(rect.x - cast.margin + 6),
      top: Math.round(rect.y - cast.margin + shadow.dy),
    },
    { input: image, left: Math.round(rect.x), top: Math.round(rect.y) },
  ];
}

/** The shop's name, small with a dot, for a corner of a picture; null when the fonts can't draw it. */
async function shopMark(shopName: string, ink: string): Promise<Layer | null> {
  const name = productAdShopName(shopName);
  if (!name) return null;
  const words = await fitTextLayer(
    [name],
    { face: "text", weight: "semibold", px: 30, color: ink },
    360,
    20,
  );
  const dot = 14;
  const gap = 12;
  const width = dot + gap + words.width;
  const height = Math.max(dot, words.height);
  const image = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${dot}" height="${dot}"><circle cx="${dot / 2}" cy="${dot / 2}" r="${dot / 2}" fill="#3f9d6b"/></svg>`,
        ),
        left: 0,
        top: Math.round((height - dot) / 2),
      },
      {
        input: words.image,
        left: dot + gap,
        top: Math.round((height - words.height) / 2),
      },
    ])
    .png()
    .toBuffer();
  return { image, width, height };
}

/** The studio still: the cut-out on the colourway's sweep, its tag and the shop's mark. */
async function studioStill(
  shared: Shared,
  colourway: ProductAdStudioColourway,
  shopName: string,
): Promise<Buffer> {
  const frame = AD_FEED_FRAME;
  const sweep = PRODUCT_AD_STUDIO_SWEEPS[colourway];
  const floor = 1060;
  const rect = shelfRow(
    [shared.cutout.size],
    { x: 150, w: 780 },
    floor,
    780,
  )[0]!;
  const [product, tag, mark] = await Promise.all([
    standing(shared.cutout, rect, { alpha: 0.2, sigma: 16, dy: 20 }),
    shared.tag,
    shopMark(shopName, sweep.ink),
  ]);
  const safeBottom = FEED_SAFE.y + FEED_SAFE.h;
  return jpeg(
    sharp(studioSweepSvg(frame, colourway, groundShadows(rect))).composite([
      ...product,
      { input: tag.image, left: FEED_SAFE.x, top: safeBottom - tag.height },
      ...(mark
        ? [
            {
              input: mark.image,
              left: FEED_SAFE.x + FEED_SAFE.w - mark.width,
              top: FEED_SAFE.y,
            },
          ]
        : []),
    ]),
  );
}

export type BigPriceLayout = {
  frame: Size;
  /** The price's words ("from"), small above the amount; null without. */
  small: { layer: Layer; top: number } | null;
  amount: { layer: Layer; left: number; top: number };
  /** The amount's digits as drawn, in the frame. */
  digits: Rect;
  name: { layer: Layer; left: number; top: number };
  /** Where the product stands. */
  product: Rect;
};

/**
 * Where Big price draws its pieces: the amount huge at the top (its "from"
 * words small above it), the name at the foot of the safe band, and the
 * product on the floor between them, reaching up in front of the digits'
 * foot only (86% down their ink), so even a wide product never hides them.
 */
export async function bigPriceLayout(
  product: Pick<StillsProduct, "name" | "priceText">,
  cutout: Size,
  format: ProductAdStillFormat,
  ink: string,
): Promise<BigPriceLayout> {
  const frame = format === "feed" ? AD_FEED_FRAME : AD_FRAME;
  const safe = format === "feed" ? FEED_SAFE : STORY_SAFE;
  const { before, amount: amountText, after } = splitPrice(product.priceText);
  const words = [before, after].filter(Boolean).join(" ");
  const [amount, small, name] = await Promise.all([
    priceLayer(amountText, 300, frame.width * 0.86, { ink }),
    words
      ? fitTextLayer(
          [words],
          { face: "text", weight: "medium", px: 40, color: ink },
          safe.w - 40,
          24,
        )
      : null,
    fitTextLayer(
      balancedLines(product.name, 2),
      {
        face: "display",
        weight: "semibold",
        px: format === "feed" ? 58 : 66,
        color: ink,
        align: "centre",
      },
      safe.w - 40,
      34,
    ),
  ]);
  const centre = (layer: Layer) => Math.round((frame.width - layer.width) / 2);
  const smallTop = safe.y + (format === "feed" ? 8 : 24);
  const amountTop = small ? smallTop + small.height + 8 : smallTop;
  const nameTop = safe.y + safe.h - name.height;
  const floor = nameTop - 34;
  const digitsInk = (await alphaBox(amount.image)) ?? {
    left: 0,
    top: 0,
    width: amount.width,
    height: amount.height,
  };
  const digits = {
    x: centre(amount) + digitsInk.left,
    y: amountTop + digitsInk.top,
    w: digitsInk.width,
    h: digitsInk.height,
  };
  const productTop = Math.round(digits.y + digits.h * 0.86);
  const rect = shelfRow(
    [cutout],
    { x: 120, w: frame.width - 240 },
    floor,
    Math.max(120, Math.min(format === "feed" ? 940 : 1320, floor - productTop)),
  )[0]!;
  return {
    frame,
    small: small ? { layer: small, top: smallTop } : null,
    amount: { layer: amount, left: centre(amount), top: amountTop },
    digits,
    name: { layer: name, left: centre(name), top: nameTop },
    product: rect,
  };
}

/** Big price: the shelf's price huge, the product standing in front of its foot, its name under it. */
async function bigPriceStill(
  shared: Shared,
  format: ProductAdStillFormat,
): Promise<Buffer> {
  const { colourway, product } = shared;
  const layout = await bigPriceLayout(
    product,
    shared.cutout.size,
    format,
    PRODUCT_AD_STUDIO_SWEEPS[colourway].ink,
  );
  const { frame, small, amount, name } = layout;
  return jpeg(
    sharp(
      studioSweepSvg(frame, colourway, groundShadows(layout.product)),
    ).composite([
      ...(small
        ? [
            {
              input: small.layer.image,
              left: Math.round((frame.width - small.layer.width) / 2),
              top: small.top,
            },
          ]
        : []),
      { input: amount.layer.image, left: amount.left, top: amount.top },
      ...(await standing(shared.cutout, layout.product, {
        alpha: 0.22,
        sigma: 16,
        dy: 20,
      })),
      { input: name.layer.image, left: name.left, top: name.top },
    ]),
  );
}

/** Collection: the price card at 4:5, titled by the video's opening. */
async function collectionStill(input: StillsInput): Promise<Buffer> {
  const card = await priceCardLayers({
    title: input.sticker.trim() || input.priceCardTitle,
    products: input.products.map((product) => ({
      cutout: product.cutout,
      name: product.name,
      priceText: product.priceText,
    })),
    frame: {
      size: AD_FEED_FRAME,
      safe: FEED_SAFE,
      plankTop: 900,
      maxHeight: 560,
    },
  });
  return jpeg(
    sharp(card.background).composite(
      [card.title, card.tags].map(({ layer, rect }) => ({
        input: layer.image,
        left: Math.round(rect.x),
        top: Math.round(rect.y),
      })),
    ),
  );
}

/** A dotted leader from `from` to `to` (x), `width` long at most, as a layer. */
function leader(width: number, color: string): Buffer {
  const step = 18;
  const dots: string[] = [];
  for (let x = 4; x <= width - 4; x += step)
    dots.push(`<circle cx="${x}" cy="5" r="3.2"/>`);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, width)}" height="10"><g fill="${color}" fill-opacity="0.55">${dots.join("")}</g></svg>`,
  );
}

type Placed = { layer: Layer; left: number; top: number };

export type PriceListRow = {
  productId: string;
  /** Where the cut-out is drawn, fitted in its square. */
  thumb: Rect;
  /** The name, up to two lines, over the price line. */
  name: Placed & { px: number };
  /** The price, at the right edge, under the name. */
  price: Placed;
  /** The dots from the name's edge to the price, level with its amount; null when there's no room. */
  leader: { left: number; top: number; width: number } | null;
};

export type PriceListLayout = {
  frame: Size;
  title: Placed;
  shop: Placed | null;
  ending: Placed;
  pill: Placed;
  /** Where the rows may go: under the title, over the shop's name. */
  band: { top: number; bottom: number };
  rows: PriceListRow[];
};

/** Price list's name size, and the smallest it shrinks to before a line is shortened. */
export const PRICE_LIST_NAME_PX = 46;
export const PRICE_LIST_NAME_MIN_PX = 30;

/** A row's name: one line at full size when it fits, else two balanced lines, shrunk only as needed. */
async function priceListName(
  name: string,
  maxWidth: number,
): Promise<Layer & { px: number }> {
  const style = {
    face: "text",
    weight: "semibold",
    px: PRICE_LIST_NAME_PX,
    color: AD_COLORS.ink,
  } as const;
  const text = name.trim().replace(/\s+/g, " ");
  const one = await textLayer([text], style);
  if (one.width <= maxWidth) return { ...one, px: PRICE_LIST_NAME_PX };
  return fitTextLayer(
    balancedLines(text, 2),
    style,
    maxWidth,
    PRICE_LIST_NAME_MIN_PX,
  );
}

/**
 * Where Price list draws its pieces: the title at the top; the shop's name,
 * the ending and its WhatsApp line at the foot; the rows centred in the band
 * between them. Each row is the cut-out on the left, and beside it the name
 * (up to two lines, so a long name wraps instead of shrinking away) over a
 * dotted leader to the price at the right edge.
 */
export async function priceListLayout(
  input: Pick<
    StillsInput,
    "products" | "priceCardTitle" | "ending" | "shopName" | "phone"
  >,
  cutouts: ReadonlyMap<string, Size>,
): Promise<PriceListLayout> {
  const frame = AD_FRAME;
  const safe = STORY_SAFE;
  const shopName = productAdShopName(input.shopName);
  const [title, shop, ending, pill] = await Promise.all([
    fitTextLayer(
      [input.priceCardTitle],
      { face: "display", weight: "semibold", px: 84, align: "centre" },
      safe.w - 40,
      48,
    ),
    shopName
      ? fitTextLayer(
          [shopName],
          {
            face: "text",
            weight: "semibold",
            px: 40,
            color: AD_COLORS.ink2,
            align: "centre",
          },
          safe.w - 60,
          26,
        )
      : null,
    fitTextLayer(
      balancedLines(input.ending, 2),
      { face: "display", weight: "semibold", px: 64, align: "centre" },
      safe.w - 40,
      40,
    ),
    contactPill({ phone: input.phone, shopName: input.shopName }, safe.w - 60),
  ]);
  const centre = (layer: Layer) => Math.round((frame.width - layer.width) / 2);
  const pillTop = safe.y + safe.h - pill.height;
  const endingTop = pillTop - 36 - ending.height;
  const shopTop = shop ? endingTop - 22 - shop.height : endingTop;
  const titleTop = safe.y + 24;
  const band = { top: titleTop + title.height + 56, bottom: shopTop - 48 };
  const count = Math.max(1, input.products.length);
  const rowHeight = Math.max(
    120,
    Math.min(340, Math.floor((band.bottom - band.top) / count)),
  );
  const rowsTop =
    band.top +
    Math.max(0, Math.floor((band.bottom - band.top - rowHeight * count) / 2));
  // One product gets a bigger picture: its row has the band to itself.
  const thumb = Math.max(80, Math.min(count === 1 ? 300 : 210, rowHeight - 40));
  const left = safe.x + 16;
  const right = safe.x + safe.w - 16;
  const nameLeft = left + thumb + 36;
  const textWidth = right - nameLeft;
  const priceWidth = Math.min(textWidth, 520);
  const rows = await Promise.all(
    input.products.map(async (product, index): Promise<PriceListRow> => {
      const size = cutouts.get(product.productId) ?? {
        width: thumb,
        height: thumb,
      };
      const fit = Math.min(thumb / size.width, thumb / size.height);
      const w = Math.max(1, Math.round(size.width * fit));
      const h = Math.max(1, Math.round(size.height * fit));
      const middle = rowsTop + rowHeight * index + rowHeight / 2;
      const { before, amount, after } = splitPrice(product.priceText);
      const [name, price, drawnAmount] = await Promise.all([
        priceListName(product.name, textWidth),
        priceLayer(product.priceText, 72, priceWidth),
        // The amount alone, as priceLayer draws it, to set the leader level with it.
        amountLayer(amount, 72, priceWidth),
      ]);
      const gap = 12;
      const blockTop = Math.round(
        middle - (name.height + gap + price.height) / 2,
      );
      const priceTop = blockTop + name.height + gap;
      const priceLeft = right - price.width;
      // priceLayer stacks its words above the amount ("от 5 000 ₸") or under it ("15 500 ₸ бастап").
      const amountMiddle = before
        ? price.height - drawnAmount.height / 2
        : after
          ? drawnAmount.height / 2
          : price.height / 2;
      const leaderWidth = Math.round(priceLeft - 20 - nameLeft);
      return {
        productId: product.productId,
        thumb: {
          x: Math.round(left + (thumb - w) / 2),
          y: Math.round(middle - h / 2),
          w,
          h,
        },
        name: { layer: name, px: name.px, left: nameLeft, top: blockTop },
        price: { layer: price, left: priceLeft, top: priceTop },
        leader:
          leaderWidth >= 40
            ? {
                left: nameLeft,
                top: Math.round(priceTop + amountMiddle - 5),
                width: leaderWidth,
              }
            : null,
      };
    }),
  );
  return {
    frame,
    title: { layer: title, left: centre(title), top: titleTop },
    shop: shop ? { layer: shop, left: centre(shop), top: shopTop } : null,
    ending: { layer: ending, left: centre(ending), top: endingTop },
    pill: { layer: pill, left: centre(pill), top: pillTop },
    band,
    rows,
  };
}

/** Price list: every product with a dotted leader to its price, the shop, the ending and its WhatsApp line. */
async function priceListStill(
  input: StillsInput,
  cutouts: Map<string, { image: Buffer; size: Size }>,
): Promise<Buffer> {
  const layout = await priceListLayout(
    input,
    new Map([...cutouts].map(([id, cutout]) => [id, cutout.size])),
  );
  const at = ({ layer, left, top }: Placed): OverlayOptions => ({
    input: layer.image,
    left,
    top,
  });
  const rows = await Promise.all(
    layout.rows.map(async (row): Promise<OverlayOptions[]> => {
      const cutout = cutouts.get(row.productId);
      const image = cutout
        ? await sharp(cutout.image)
            .resize(row.thumb.w, row.thumb.h, {
              fit: "fill",
              kernel: "lanczos3",
            })
            .png()
            .toBuffer()
        : null;
      return [
        ...(image
          ? [{ input: image, left: row.thumb.x, top: row.thumb.y }]
          : []),
        at(row.name),
        ...(row.leader
          ? [
              {
                input: leader(row.leader.width, AD_COLORS.ink2),
                left: row.leader.left,
                top: row.leader.top,
              },
            ]
          : []),
        at(row.price),
      ];
    }),
  );
  return jpeg(
    sharp(studioSweepSvg(layout.frame, "sand")).composite([
      at(layout.title),
      ...rows.flat(),
      ...(layout.shop ? [at(layout.shop)] : []),
      at(layout.ending),
      at(layout.pill),
    ]),
  );
}

export type SpotlightLayout = {
  frame: Size;
  name: Placed;
  caption: Placed | null;
  tag: Placed;
  /** Where the product stands, between the words and the price tag. */
  product: Rect;
};

/**
 * Where Spotlight draws its pieces: the product's name and caption at the
 * top of the Story safe band, its paper price tag at the foot, and the
 * product standing large in the room between them.
 */
export async function spotlightLayout(
  product: Pick<StillsProduct, "name" | "caption" | "priceText">,
  cutout: Size,
  ink: string,
): Promise<SpotlightLayout> {
  const frame = AD_FRAME;
  const safe = STORY_SAFE;
  const lines = captionLines(product.caption);
  const [name, caption, tag] = await Promise.all([
    fitTextLayer(
      balancedLines(product.name, 2),
      {
        face: "display",
        weight: "semibold",
        px: 68,
        color: ink,
        align: "centre",
      },
      safe.w - 40,
      38,
    ),
    lines.length
      ? fitTextLayer(
          lines,
          {
            face: "text",
            weight: "medium",
            px: 38,
            color: ink,
            align: "centre",
          },
          safe.w - 60,
          24,
        )
      : null,
    tagLayer(product.priceText),
  ]);
  const centre = (layer: Layer) => Math.round((frame.width - layer.width) / 2);
  const nameTop = safe.y + 16;
  const captionTop = nameTop + name.height + 16;
  const wordsBottom = caption
    ? captionTop + caption.height
    : nameTop + name.height;
  const tagTop = safe.y + safe.h - tag.height;
  const floor = tagTop - 28;
  const productTop = wordsBottom + 32;
  const rect = shelfRow(
    [cutout],
    { x: 110, w: frame.width - 220 },
    floor,
    Math.max(120, Math.min(960, floor - productTop)),
  )[0]!;
  return {
    frame,
    name: { layer: name, left: centre(name), top: nameTop },
    caption: caption
      ? { layer: caption, left: centre(caption), top: captionTop }
      : null,
    tag: { layer: tag, left: centre(tag), top: tagTop },
    product: rect,
  };
}

/** Spotlight: one product large on its studio sweep, under its caption, with its price tag at the foot. */
async function spotlightStill(
  shared: Shared,
  shopName: string,
): Promise<Buffer> {
  const { colourway, product } = shared;
  const ink = PRODUCT_AD_STUDIO_SWEEPS[colourway].ink;
  const [layout, mark] = await Promise.all([
    spotlightLayout(product, shared.cutout.size, ink),
    shopMark(shopName, ink),
  ]);
  return jpeg(
    sharp(
      studioSweepSvg(layout.frame, colourway, groundShadows(layout.product)),
    ).composite([
      {
        input: layout.name.layer.image,
        left: layout.name.left,
        top: layout.name.top,
      },
      ...(layout.caption
        ? [
            {
              input: layout.caption.layer.image,
              left: layout.caption.left,
              top: layout.caption.top,
            },
          ]
        : []),
      ...(await standing(shared.cutout, layout.product, {
        alpha: 0.22,
        sigma: 16,
        dy: 20,
      })),
      {
        input: layout.tag.layer.image,
        left: layout.tag.left,
        top: layout.tag.top,
      },
      ...(mark
        ? [
            {
              input: mark.image,
              left: STORY_SAFE.x + STORY_SAFE.w - mark.width,
              top: STORY_SAFE.y + STORY_SAFE.h - mark.height,
            },
          ]
        : []),
    ]),
  );
}

export type PrintLayout = {
  frame: Size;
  /** The paper print card in the 4:5 frame. */
  card: Rect;
  /** The scene photo window inside the card, in frame coordinates. */
  photo: Rect;
  name: Placed;
  caption: Placed | null;
  price: Placed;
};

/**
 * Where Print draws its pieces: a white paper print card inside the 4:5 safe
 * band, the scene photo framed at the top, and the product's name, caption
 * and price in the bottom mat.
 */
export async function printLayout(
  product: Pick<StillsProduct, "name" | "caption" | "priceText">,
): Promise<PrintLayout> {
  const frame = AD_FEED_FRAME;
  const card: Rect = { x: 84, y: 80, w: 912, h: 1190 };
  const border = 36;
  const photo: Rect = {
    x: card.x + border,
    y: card.y + border,
    w: card.w - border * 2,
    h: 860,
  };
  const matLeft = photo.x;
  const matRight = photo.x + photo.w;
  const matTop = photo.y + photo.h + 24;
  const matBottom = card.y + card.h - 24;
  const price = await priceLayer(product.priceText, 60, 320);
  const priceLeft = matRight - price.width;
  const priceTop = Math.round(matTop + (matBottom - matTop - price.height) / 2);
  const textWidth = Math.max(200, priceLeft - matLeft - 28);
  const lines = captionLines(product.caption);
  const [name, caption] = await Promise.all([
    fitTextLayer(
      balancedLines(product.name, 2),
      { face: "display", weight: "semibold", px: 44, color: AD_COLORS.ink },
      textWidth,
      26,
    ),
    lines.length
      ? fitTextLayer(
          lines,
          { face: "text", weight: "medium", px: 28, color: AD_COLORS.ink2 },
          textWidth,
          20,
        )
      : null,
  ]);
  const gap = 10;
  const textHeight = name.height + (caption ? gap + caption.height : 0);
  const nameTop = Math.round(matTop + (matBottom - matTop - textHeight) / 2);
  return {
    frame,
    card,
    photo,
    name: { layer: name, left: matLeft, top: nameTop },
    caption: caption
      ? { layer: caption, left: matLeft, top: nameTop + name.height + gap }
      : null,
    price: { layer: price, left: priceLeft, top: priceTop },
  };
}

/** Print: the product's scene framed as a photo print on paper, with its name, caption and price in the bottom mat. */
async function printStill(product: StillsProduct): Promise<Buffer> {
  const layout = await printLayout(product);
  const cropped = await coverBackground(
    product.picture,
    { width: layout.photo.w, height: layout.photo.h },
    product.box,
  );
  const card = await paperCard(
    { width: layout.card.w, height: layout.card.h },
    [
      {
        layer: {
          image: cropped.image,
          width: layout.photo.w,
          height: layout.photo.h,
        },
        left: layout.photo.x - layout.card.x,
        top: layout.photo.y - layout.card.y,
      },
      {
        layer: layout.name.layer,
        left: layout.name.left - layout.card.x,
        top: layout.name.top - layout.card.y,
      },
      ...(layout.caption
        ? [
            {
              layer: layout.caption.layer,
              left: layout.caption.left - layout.card.x,
              top: layout.caption.top - layout.card.y,
            },
          ]
        : []),
      {
        layer: layout.price.layer,
        left: layout.price.left - layout.card.x,
        top: layout.price.top - layout.card.y,
      },
    ],
    { radius: 12, shadow: { dy: 12, sigma: 14, alpha: 0.22 } },
  );
  return jpeg(
    sharp(studioSweepSvg(layout.frame, "sand")).composite([
      {
        input: card.image,
        left: layout.card.x - card.card.x,
        top: layout.card.y - card.card.y,
      },
    ]),
  );
}

export type GridCell = {
  productId: string;
  /** The paper card for this product, in frame coordinates. */
  card: Rect;
  /** Where the cut-out is drawn inside the card. */
  thumb: Rect;
  name: Placed;
  price: Placed;
};

export type GridLayout = {
  frame: Size;
  title: Placed;
  pill: Placed;
  /** Where the cells sit: under the title, over the WhatsApp pill. */
  band: { top: number; bottom: number };
  cells: GridCell[];
};

/**
 * Where Catalog grid draws its pieces: the opening at the top, the WhatsApp
 * pill at the foot, and the products in a centered grid of paper cards
 * between them (1 card alone, 2 side by side, 3 as 2 over 1).
 */
export async function gridLayout(
  input: Pick<
    StillsInput,
    "products" | "sticker" | "priceCardTitle" | "shopName" | "phone"
  >,
  cutouts: ReadonlyMap<string, Size>,
  format: ProductAdStillFormat,
): Promise<GridLayout> {
  const frame = format === "feed" ? AD_FEED_FRAME : AD_FRAME;
  const safe = format === "feed" ? FEED_SAFE : STORY_SAFE;
  const heading = input.sticker.trim() || input.priceCardTitle;
  const [title, pill] = await Promise.all([
    fitTextLayer(
      [heading],
      {
        face: "display",
        weight: "semibold",
        px: format === "feed" ? 72 : 80,
        align: "centre",
      },
      safe.w - 40,
      44,
    ),
    contactPill({ phone: input.phone, shopName: input.shopName }, safe.w - 60),
  ]);
  const centre = (layer: Layer) => Math.round((frame.width - layer.width) / 2);
  const titleTop = safe.y + (format === "feed" ? 12 : 24);
  const pillTop = safe.y + safe.h - pill.height;
  const gap = 24;
  const band = {
    top: titleTop + title.height + (format === "feed" ? 28 : 40),
    bottom: pillTop - (format === "feed" ? 28 : 40),
  };
  const count = Math.max(1, input.products.length);
  const cols = count === 1 ? 1 : 2;
  const rowCount = count <= 2 ? 1 : Math.ceil(count / 2);
  const cellW =
    cols === 1 ? Math.min(680, safe.w - 32) : Math.floor((safe.w - gap) / 2);
  const availH = Math.max(
    240,
    Math.floor((band.bottom - band.top - gap * (rowCount - 1)) / rowCount),
  );
  const maxCellH = rowCount === 1 ? (format === "feed" ? 680 : 820) : availH;
  const cellH = Math.max(240, Math.min(maxCellH, availH));
  const gridH = cellH * rowCount + gap * (rowCount - 1);
  const gridTop =
    band.top + Math.max(0, Math.floor((band.bottom - band.top - gridH) / 2));

  const cells = await Promise.all(
    input.products.map(async (product, index): Promise<GridCell> => {
      const row = Math.floor(index / cols);
      const inRow = row === rowCount - 1 ? count - row * cols : cols;
      const col = index - row * cols;
      const rowW = inRow * cellW + (inRow - 1) * gap;
      const rowLeft = Math.round((frame.width - rowW) / 2);
      const card: Rect = {
        x: rowLeft + col * (cellW + gap),
        y: gridTop + row * (cellH + gap),
        w: cellW,
        h: cellH,
      };
      const pad = 22;
      const innerW = card.w - pad * 2;
      const [name, price] = await Promise.all([
        fitTextLayer(
          balancedLines(product.name, 2),
          {
            face: "text",
            weight: "semibold",
            px: rowCount === 1 ? 36 : 30,
            color: AD_COLORS.ink,
            align: "centre",
          },
          innerW,
          20,
        ),
        priceLayer(product.priceText, rowCount === 1 ? 56 : 46, innerW),
      ]);
      const textGap = 8;
      const priceTop = card.y + card.h - pad - price.height;
      const nameTop = priceTop - textGap - name.height;
      const thumbTop = card.y + pad;
      const thumbH = Math.max(48, nameTop - 14 - thumbTop);
      const size = cutouts.get(product.productId) ?? {
        width: innerW,
        height: thumbH,
      };
      const fit = Math.min(
        innerW / Math.max(1, size.width),
        thumbH / Math.max(1, size.height),
      );
      const w = Math.max(1, Math.round(size.width * fit));
      const h = Math.max(1, Math.round(size.height * fit));
      return {
        productId: product.productId,
        card,
        thumb: {
          x: Math.round(card.x + (card.w - w) / 2),
          y: Math.round(thumbTop + (thumbH - h) / 2),
          w,
          h,
        },
        name: {
          layer: name,
          left: Math.round(card.x + (card.w - name.width) / 2),
          top: nameTop,
        },
        price: {
          layer: price,
          left: Math.round(card.x + (card.w - price.width) / 2),
          top: priceTop,
        },
      };
    }),
  );
  return {
    frame,
    title: { layer: title, left: centre(title), top: titleTop },
    pill: { layer: pill, left: centre(pill), top: pillTop },
    band,
    cells,
  };
}

/** Catalog grid: every product in a grid of paper cards under the opening, with the shop's WhatsApp pill. */
async function gridStill(
  input: StillsInput,
  cutouts: Map<string, { image: Buffer; size: Size }>,
  format: ProductAdStillFormat,
): Promise<Buffer> {
  const layout = await gridLayout(
    input,
    new Map([...cutouts].map(([id, cutout]) => [id, cutout.size])),
    format,
  );
  const at = ({ layer, left, top }: Placed): OverlayOptions => ({
    input: layer.image,
    left,
    top,
  });
  const cardsSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.frame.width}" height="${layout.frame.height}">` +
      layout.cells
        .map(
          ({ card }) =>
            `<rect x="${card.x}" y="${card.y + 6}" width="${card.w}" height="${card.h}" rx="14" fill="rgba(${AD_SHADE},0.10)"/>` +
            `<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="14" fill="${AD_COLORS.paper}" stroke="rgba(${AD_SHADE},0.10)" stroke-width="1.5"/>`,
        )
        .join("") +
      `</svg>`,
  );
  const cells = await Promise.all(
    layout.cells.map(async (cell): Promise<OverlayOptions[]> => {
      const cutout = cutouts.get(cell.productId);
      const product = cutout
        ? await standing(cutout, cell.thumb, {
            alpha: 0.18,
            sigma: 10,
            dy: 10,
          })
        : [];
      return [...product, at(cell.name), at(cell.price)];
    }),
  );
  return jpeg(
    sharp(studioSweepSvg(layout.frame, "sand")).composite([
      at(layout.title),
      { input: cardsSvg, left: 0, top: 0 },
      ...cells.flat(),
      at(layout.pill),
    ]),
  );
}

/** The studio colourways in a product's order: the one it stands out on first. */
export function studioOrder(
  first: ProductAdStudioColourway,
): ProductAdStudioColourway[] {
  return [first, ...PRODUCT_AD_STUDIO_COLOURWAYS.filter((c) => c !== first)];
}

/**
 * Every still of the ad, in the order the stillSet keeps them: per product
 * (in the ad's order) room, studio (its best colourway first), big_price
 * feed and story, spotlight, and print; then collection, price_list, and
 * grid feed and story.
 */
export async function drawAdStills(input: StillsInput): Promise<DrawnStill[]> {
  const kinds = new Set(input.kinds ?? PRODUCT_AD_STILL_KINDS);
  if (input.products.length === 0) return [];
  const shared = await Promise.all(
    input.products.map(async (product): Promise<Shared> => {
      const [cutout, colourway] = await Promise.all([
        trimmedCutout(product.cutout),
        studioColourwayFor(product.cutout),
      ]);
      return {
        product,
        cutout,
        colourway,
        tag: kinds.has("studio")
          ? shelfTagLayer(product.name, product.priceText, 460, -2)
          : Promise.resolve({ image: Buffer.alloc(0), width: 0, height: 0 }),
      };
    }),
  );
  const perProduct = await Promise.all(
    shared.map(async (one) => {
      const { product } = one;
      const id = product.productId;
      const jobs: Array<Promise<DrawnStill>> = [];
      if (kinds.has("room"))
        jobs.push(
          feedStill({
            picture: product.picture,
            box: product.box,
            name: product.name,
            caption: product.caption,
            priceText: product.priceText,
            zone: product.textZone ?? "auto",
          }).then((image) => ({
            kind: "room",
            format: "feed",
            productId: id,
            colourway: null,
            image,
          })),
        );
      if (kinds.has("studio")) {
        const colourways =
          input.studio === "default"
            ? [one.colourway]
            : studioOrder(one.colourway);
        for (const colourway of colourways)
          jobs.push(
            studioStill(one, colourway, input.shopName).then((image) => ({
              kind: "studio",
              format: "feed",
              productId: id,
              colourway,
              image,
            })),
          );
      }
      if (kinds.has("big_price"))
        for (const format of ["feed", "story"] as const)
          jobs.push(
            bigPriceStill(one, format).then((image) => ({
              kind: "big_price",
              format,
              productId: id,
              colourway: null,
              image,
            })),
          );
      if (kinds.has("spotlight"))
        jobs.push(
          spotlightStill(one, input.shopName).then((image) => ({
            kind: "spotlight",
            format: "story",
            productId: id,
            colourway: null,
            image,
          })),
        );
      if (kinds.has("print"))
        jobs.push(
          printStill(product).then((image) => ({
            kind: "print",
            format: "feed",
            productId: id,
            colourway: null,
            image,
          })),
        );
      return Promise.all(jobs);
    }),
  );
  const cutouts = new Map(
    shared.map((one) => [one.product.productId, one.cutout]),
  );
  const all: Array<Promise<DrawnStill>> = [];
  if (kinds.has("collection"))
    all.push(
      collectionStill(input).then((image) => ({
        kind: "collection",
        format: "feed",
        productId: null,
        colourway: null,
        image,
      })),
    );
  if (kinds.has("price_list"))
    all.push(
      priceListStill(input, cutouts).then((image) => ({
        kind: "price_list",
        format: "story",
        productId: null,
        colourway: null,
        image,
      })),
    );
  if (kinds.has("grid"))
    for (const format of ["feed", "story"] as const)
      all.push(
        gridStill(input, cutouts, format).then((image) => ({
          kind: "grid",
          format,
          productId: null,
          colourway: null,
          image,
        })),
      );
  return [...perProduct.flat(), ...(await Promise.all(all))];
}

/** Kept for the tests: a still's size by its format. */
export const STILL_SIZES: Record<ProductAdStillFormat, Size> = {
  feed: AD_FEED_FRAME,
  story: AD_FRAME,
};
