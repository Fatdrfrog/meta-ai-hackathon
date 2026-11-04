import type {
  ProductAdBox,
  ProductAdTextOverlap,
  ProductAdTextZone,
} from "@icecore/temporal";

// Where everything goes in a video ad, as pure geometry: the frame, Meta's
// Reels safe band the words stay inside, the cover crop of each picture
// around its product, where the paper label, price tag and sticker stand,
// and how long each scene lasts. layers.ts draws to these numbers and
// render.ts animates them.

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** The video and the Status picture: 9:16. */
export const AD_FRAME: Size = { width: 1080, height: 1920 };
/** The Click-to-WhatsApp ad picture: 4:5. */
export const AD_FEED_FRAME: Size = { width: 1080, height: 1350 };

/**
 * Meta's Reels safe zone at 1080x1920: the top 14% (269 px), the bottom 35%
 * (672 px) and 6% (65 px) on each side hold the app's own header, caption
 * and buttons, so every word stays inside the rest.
 */
export const REELS_SAFE: Rect = { x: 65, y: 269, w: 950, h: 979 };
/** The 4:5 picture has no app chrome over it; words keep a 64 px margin. */
export const FEED_SAFE: Rect = { x: 64, y: 64, w: 952, h: 1222 };

/** How far text layers sit inside the safe band. */
const INSET = 7;
const GAP = 24;

export const right = (rect: Rect) => rect.x + rect.w;
export const bottom = (rect: Rect) => rect.y + rect.h;

export function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    right(inner) <= right(outer) &&
    bottom(inner) <= bottom(outer)
  );
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const h = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const union = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    w: Math.max(...rects.map(right)) - x,
    h: Math.max(...rects.map(bottom)) - y,
  };
};

const grown = (rect: Rect, by: number): Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  w: rect.w + by * 2,
  h: rect.h + by * 2,
});

/** A box the image's fractions describe, clamped to the picture. */
export function clampBox(box: ProductAdBox | null): ProductAdBox | null {
  if (!box) return null;
  const values = [box.x, box.y, box.w, box.h];
  if (!values.every((value) => Number.isFinite(value))) return null;
  const x = Math.min(1, Math.max(0, box.x));
  const y = Math.min(1, Math.max(0, box.y));
  const w = Math.min(1 - x, Math.max(0, box.w));
  const h = Math.min(1 - y, Math.max(0, box.h));
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

export type CoverCrop = {
  /** The picture scaled to cover the frame. */
  resize: Size;
  /** Where the frame is cut from the scaled picture. */
  left: number;
  top: number;
  /** The product in frame pixels; null without a box. */
  product: Rect | null;
  /** The point the camera pushes in on, as fractions of the frame. */
  focus: { x: number; y: number };
};

/**
 * A picture scaled to cover the frame and cut around its product: the
 * product's centre as near the frame's centre as the picture allows. With no
 * box the cut is centred.
 */
export function coverCrop(
  picture: Size,
  frame: Size,
  box: ProductAdBox | null,
): CoverCrop {
  const scale = Math.max(
    frame.width / picture.width,
    frame.height / picture.height,
  );
  const resize = {
    width: Math.max(frame.width, Math.round(picture.width * scale)),
    height: Math.max(frame.height, Math.round(picture.height * scale)),
  };
  const product = clampBox(box);
  const centre = product
    ? {
        x: (product.x + product.w / 2) * resize.width,
        y: (product.y + product.h / 2) * resize.height,
      }
    : { x: resize.width / 2, y: resize.height / 2 };
  const left = Math.round(
    Math.min(
      resize.width - frame.width,
      Math.max(0, centre.x - frame.width / 2),
    ),
  );
  const top = Math.round(
    Math.min(
      resize.height - frame.height,
      Math.max(0, centre.y - frame.height / 2),
    ),
  );
  const rect = product && {
    x: Math.round(product.x * resize.width) - left,
    y: Math.round(product.y * resize.height) - top,
    w: Math.round(product.w * resize.width),
    h: Math.round(product.h * resize.height),
  };
  return {
    resize,
    left,
    top,
    product: rect,
    focus: {
      x: Math.min(1, Math.max(0, (centre.x - left) / frame.width)),
      y: Math.min(1, Math.max(0, (centre.y - top) / frame.height)),
    },
  };
}

export type SceneTextLayout = {
  label: Rect;
  tag: Rect;
  sticker: Rect | null;
  /** Where the label and tag went: above the product, or below it. */
  zone: "top" | "bottom";
  /**
   * Whether the label and tag cover the product (more than
   * AD_TEXT_COVERS_SHARE of its box) and the band that would cover less;
   * null without a product box.
   */
  textOverlap: ProductAdTextOverlap | null;
};

/** The share of the product's box the words may cover before the studio suggests the other band. */
export const AD_TEXT_COVERS_SHARE = 0.04;

/**
 * Where a product scene's words stand: the paper label (name and caption) at
 * the left and the price tag at the right, side by side when they fit, else
 * the tag under the label at the right. With `zone` "auto" (or none) they go
 * at the top of the safe band, where Muse Image is asked to leave a calm
 * wall, unless the product reaches up there and the bottom of the band is
 * clearer; "top" or "bottom" (the owner's choice) puts them there, and the
 * first scene's sticker with them. In "auto" the sticker takes the label's
 * place at the top before the label comes in (render.ts shows them one after
 * the other). The paper is opaque, so a layer that still meets the product
 * stays legible; `textOverlap` says whether it does, for the studio's hint.
 * Every layer is inside `safe`; one larger than the band is the caller's
 * error.
 */
export function placeSceneText(input: {
  safe: Rect;
  product: Rect | null;
  label: Size;
  tag: Size;
  sticker?: Size | null;
  zone?: ProductAdTextZone;
}): SceneTextLayout {
  const { safe, label, tag } = input;
  const sticker = input.sticker ?? null;
  const zone = input.zone ?? "auto";
  const left = safe.x + INSET;
  const rightEdge = right(safe) - INSET;
  const sideBySide = label.width + GAP + tag.width <= safe.w - INSET * 2;
  const stickerRect: Rect | null = sticker && {
    x: left,
    y:
      zone === "bottom"
        ? bottom(safe) - INSET - sticker.height
        : safe.y + INSET,
    w: sticker.width,
    h: sticker.height,
  };

  const block = (top: number): { label: Rect; tag: Rect } => {
    const labelRect = { x: left, y: top, w: label.width, h: label.height };
    const tagRect = sideBySide
      ? { x: rightEdge - tag.width, y: top, w: tag.width, h: tag.height }
      : {
          x: Math.max(left, rightEdge - tag.width),
          y: bottom(labelRect) + GAP,
          w: tag.width,
          h: tag.height,
        };
    return { label: labelRect, tag: tagRect };
  };
  const blockHeight = (() => {
    const placed = block(0);
    return Math.max(bottom(placed.label), bottom(placed.tag));
  })();

  const top = block(safe.y + INSET);
  const low = block(bottom(safe) - INSET - blockHeight);

  const cost = (placed: { label: Rect; tag: Rect }) =>
    input.product
      ? overlapArea(union([placed.label, placed.tag]), grown(input.product, 16))
      : 0;
  // The top is where the prompt leaves room: the bottom wins only when it is
  // clearly better, or when the owner asked for it.
  const useBottom =
    zone === "bottom" || (zone === "auto" && cost(low) < cost(top) * 0.6);
  const chosen = useBottom ? low : top;
  // How much of the product's own box each band's words cover.
  const share = (placed: { label: Rect; tag: Rect }) => {
    const product = input.product;
    if (!product || product.w <= 0 || product.h <= 0) return 0;
    return (
      (overlapArea(placed.label, product) + overlapArea(placed.tag, product)) /
      (product.w * product.h)
    );
  };
  const here = share(chosen);
  const there = share(useBottom ? top : low);
  const covers = here > AD_TEXT_COVERS_SHARE;
  return {
    label: chosen.label,
    tag: chosen.tag,
    sticker: stickerRect,
    zone: useBottom ? "bottom" : "top",
    textOverlap: input.product
      ? {
          covers,
          suggested:
            covers && there < here ? (useBottom ? "top" : "bottom") : null,
        }
      : null,
  };
}

/**
 * Where products stand side by side on a plank, scaled alike: as tall as
 * `maxHeight` allows, unless the row would be wider than `area`. Each rect is
 * a product's picture, its bottom on the plank at `baseline`.
 */
export function shelfRow(
  pictures: Size[],
  area: { x: number; w: number },
  baseline: number,
  maxHeight: number,
  gap = 40,
): Rect[] {
  if (pictures.length === 0) return [];
  // One height for every product would make a mug as tall as a table, so
  // each fits its own box: the row's width shared out by aspect.
  const slot = (area.w - gap * (pictures.length - 1)) / pictures.length;
  const sizes = pictures.map((picture) => {
    const aspect = picture.width / Math.max(1, picture.height);
    let height = maxHeight;
    let width = height * aspect;
    if (width > slot) {
      width = slot;
      height = width / aspect;
    }
    return { width: Math.round(width), height: Math.round(height) };
  });
  const rowWidth =
    sizes.reduce((total, size) => total + size.width, 0) +
    gap * (sizes.length - 1);
  let x = area.x + Math.round((area.w - rowWidth) / 2);
  return sizes.map((size) => {
    const rect = {
      x,
      y: baseline - size.height,
      w: size.width,
      h: size.height,
    };
    x += size.width + gap;
    return rect;
  });
}

// ---------------------------------------------------------------------------
// The timeline.

/** Cross-fade between scenes. */
export const AD_TRANSITION_SECONDS = 0.35;
export const AD_FPS = 30;
const MIN_PRODUCT_SECONDS = 3;
const MAX_PRODUCT_SECONDS = 6;
const SILENT_PRODUCT_SECONDS = 3.5;
const PRICE_CARD_SECONDS = 3;
const ENDING_SECONDS = 3;
const MIN_TOTAL_SECONDS = 10;
const MAX_TOTAL_SECONDS = 20;
/** The voice starts once the scene's transition has played. */
export const AD_VOICE_LEAD_SECONDS = 0.35;
/** Room after the voice, so it ends before the next scene's voice starts. */
const VOICE_TAIL_SECONDS = 0.45;
/** The first scene's sticker. */
export const AD_STICKER_IN_SECONDS = 0.2;
export const AD_STICKER_OUT_SECONDS = 1.8;
/**
 * The first scene's words come in after its sticker leaves (render.ts: at
 * 1.9 s, not 0.3 s), so that scene is at least this much longer than the
 * shortest, and its name and price stay on screen as long as any other
 * scene's. The paid gate's toy shelf had a 3 s first scene: its price was
 * whole for a fifth of a second before the slide.
 */
const STICKER_WORDS_DELAY_SECONDS = AD_STICKER_OUT_SECONDS + 0.1 - 0.3;
const FIRST_PRODUCT_MIN_SECONDS =
  MIN_PRODUCT_SECONDS + STICKER_WORDS_DELAY_SECONDS;

export type TimelineScene =
  | {
      kind: "product";
      productIndex: number;
      seconds: number;
      /** When the scene starts in the video. */
      start: number;
      /** The owner's words in this scene; null when it is silent. */
      voice: { at: number; seconds: number } | null;
    }
  | { kind: "price_card" | "ending"; seconds: number; start: number };

export type Timeline = {
  scenes: TimelineScene[];
  totalSeconds: number;
};

const frames = (seconds: number) => Math.round(seconds * AD_FPS);
const onFrames = (seconds: number) => frames(seconds) / AD_FPS;

/**
 * Filmed → Sold (motion "filmed_sold"): how long a product's scene opens on
 * its filmed frame before the made scene wipes in. The scene grows by as
 * much (planTimeline's `leadSeconds`), so its words stay on screen as long
 * as a shelf scene's.
 */
export const AD_FILMED_LEAD_SECONDS = 1.2;

/**
 * How long each scene lasts: a product's scene as long as the owner's words
 * for it (3 to 6 s), or 3.5 s without them; the price card and the ending
 * 3 s each; cross-faded by 0.35 s. The whole ad is 10 to 20 s: longer
 * product scenes give back time (the longest first, never below 3 s, their
 * words then cut short), and an ad too short lengthens its product scenes.
 * A product with `leadSeconds` (Filmed → Sold's filmed frame) has that much
 * more on top, which the 20 s cap never takes back. Durations fall on whole
 * frames, so the cross-fades land exactly.
 */
export function planTimeline(
  products: Array<{ voiceSeconds: number | null; leadSeconds?: number }>,
): Timeline {
  const leads = products.map(({ leadSeconds }) =>
    Math.max(0, leadSeconds ?? 0),
  );
  /** A product scene's length from its own part: the lead on top, and the first scene's floor. */
  const withLead = (base: number, index: number) =>
    Math.max(base + leads[index]!, index === 0 ? FIRST_PRODUCT_MIN_SECONDS : 0);
  const bases = products.map(({ voiceSeconds }) =>
    voiceSeconds !== null && voiceSeconds > 0
      ? Math.min(
          MAX_PRODUCT_SECONDS,
          Math.max(
            MIN_PRODUCT_SECONDS,
            voiceSeconds + AD_VOICE_LEAD_SECONDS + VOICE_TAIL_SECONDS,
          ),
        )
      : SILENT_PRODUCT_SECONDS,
  );
  const wanted = bases.map(withLead);
  const fixed =
    PRICE_CARD_SECONDS +
    ENDING_SECONDS -
    AD_TRANSITION_SECONDS * (products.length + 1);
  const total = (lengths: number[]) =>
    lengths.reduce((sum, seconds) => sum + seconds, 0) + fixed;
  // The cap on product scenes that brings a long ad down to 20 s, or the
  // floor that brings a short one up to 10 s, found by halving: the longest
  // scenes give back time evenly, and the shortest grow evenly. A frame's
  // margin keeps rounding to whole frames inside the limits.
  // The first scene never gives back the time its words wait for the sticker.
  const capped = (cap: number) =>
    bases.map((base, index) => withLead(Math.min(base, cap), index));
  const floored = (floor: number) =>
    bases.map((base, index) => withLead(Math.max(base, floor), index));
  let lengths = wanted;
  if (total(lengths) > MAX_TOTAL_SECONDS) {
    let low = MIN_PRODUCT_SECONDS;
    let high = MAX_PRODUCT_SECONDS;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (total(capped(mid)) > MAX_TOTAL_SECONDS - 0.05) high = mid;
      else low = mid;
    }
    lengths = capped(low);
  } else if (total(lengths) < MIN_TOTAL_SECONDS) {
    let low = MIN_PRODUCT_SECONDS;
    let high = MAX_PRODUCT_SECONDS;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (total(floored(mid)) >= MIN_TOTAL_SECONDS + 0.05) high = mid;
      else low = mid;
    }
    lengths = floored(high);
  }

  const scenes: TimelineScene[] = [];
  let start = 0;
  // The next scene starts on the frame at or before the cross-fade's start,
  // so the scene before it lasts the whole cross-fade.
  const step = (seconds: number) => {
    const at = start;
    start =
      Math.floor((start + seconds - AD_TRANSITION_SECONDS) * AD_FPS + 1e-6) /
      AD_FPS;
    return at;
  };
  products.forEach(({ voiceSeconds }, productIndex) => {
    const seconds = onFrames(lengths[productIndex]!);
    const at = step(seconds);
    const room = seconds - AD_VOICE_LEAD_SECONDS - AD_TRANSITION_SECONDS - 0.1;
    scenes.push({
      kind: "product",
      productIndex,
      seconds,
      start: at,
      voice:
        voiceSeconds !== null && voiceSeconds > 0
          ? {
              at: onFrames(at + AD_VOICE_LEAD_SECONDS),
              seconds: Math.min(voiceSeconds, Math.max(0, room)),
            }
          : null,
    });
  });
  const priceSeconds = onFrames(PRICE_CARD_SECONDS);
  scenes.push({
    kind: "price_card",
    seconds: priceSeconds,
    start: step(priceSeconds),
  });
  const endingSeconds = onFrames(ENDING_SECONDS);
  scenes.push({
    kind: "ending",
    seconds: endingSeconds,
    start: step(endingSeconds),
  });
  const last = scenes.at(-1)!;
  return {
    scenes,
    totalSeconds: onFrames(last.start + last.seconds),
  };
}

export const timelineFrames = frames;
