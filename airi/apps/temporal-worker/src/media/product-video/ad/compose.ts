import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  productAdMotionOf,
  type ProductAdBox,
  type ProductAdMotion,
  type ProductAdTextOverlap,
  type ProductAdTextZone,
} from "@icecore/temporal";
import sharp from "sharp";
import { buildVoiceTrack, pcmSeconds, type Pcm, type VoiceDeps } from "./audio";
import {
  alphaBox,
  composeStill,
  coverBackground,
  endingLayers,
  exactSceneBox,
  feedStill,
  floatSceneLayers,
  groundShadows,
  popSubjectLayer,
  priceCardLayers,
  productSceneLayers,
  studioColourwayFor,
  studioSweepSvg,
  type FrameLayer,
  type PlacedLayer,
} from "./layers";
import {
  AD_FILMED_LEAD_SECONDS,
  AD_FRAME,
  AD_TRANSITION_SECONDS,
  planTimeline,
  type Rect,
  type Timeline,
} from "./layout";
import {
  AD_POSTER_SECONDS,
  type RenderOpening,
  type RenderPlan,
  type RenderScene,
  type RenderSubject,
  type SizedRenderLayer,
} from "./render";

// Puts an ad together from what its steps saved: each product's scene
// picture and box, the script's words, the shelf's prices and the owner's
// polished words. One set of layers makes the video's scenes, the Status
// picture (the price card) and the 4:5 ad picture. The ad's motion (studio
// v3) changes only how each product's scene is built:
// - shelf: v2's scene, pushed in on the product;
// - filmed_sold: v2's scene, opened by the product as the owner filmed it
//   (its original frame, cut to 9:16) for AD_FILMED_LEAD_SECONDS, then a
//   circle (first scene) or a wipe to the made scene; a product without a
//   filmed frame keeps the shelf scene;
// - float: the exact cut-out bobbing over the code wall and plank;
// - pop: the cut-out growing over its Muse Image scene, blurred; over the
//   studio sweep (the colourway it stands out on) when its scene is the
//   exact still.
// The price card and the ending are the same in every motion.

/** Pop: the scene behind the product, blurred this much (px at 1080 wide). */
const POP_BLUR = 26;
/** Pop: the slow push-in on the blurred scene. */
const POP_ZOOM_TO = 1.03;
/** The poster after a filmed opening: just past its wipe, the sticker still in. */
const FILMED_POSTER_AFTER_WIPE = 0.03;
/** ... or, with no sticker, once the words are in. */
const FILMED_POSTER_WORDS_IN = 1;

export type ComposeProduct = {
  productId: string;
  name: string;
  /** The shelf's price, as buyers read it. */
  priceText: string;
  /** The transparent cut-out, for the price card and the ending. */
  cutout: Buffer;
  /** The scene's picture: Muse Image's, or the exact still. */
  picture: Buffer;
  /** The product in the picture, as fractions; null when unknown. */
  box: ProductAdBox | null;
  caption: string;
  /**
   * The scene's voice: the owner's polished words, or the new words read in
   * a voice (Part V); null for a silent scene.
   */
  voice: Pcm | null;
  /** The words `voice` reads, when they're new words; null or absent otherwise. */
  spoken?: string | null;
  /** Where the words sit: "auto" (the default), or the owner's top or bottom. */
  textZone?: ProductAdTextZone;
  /** The product as the owner filmed it (Filmed → Sold's opening); null or absent without. */
  original?: Buffer | null;
  /** Whether `picture` is a Muse Image scene (Pop blurs it); false or absent for the exact still. */
  made?: boolean;
};

export type ComposeInput = {
  products: ComposeProduct[];
  sticker: string;
  priceCardTitle: string;
  ending: string;
  shopName: string;
  phone: string | null;
  /** The person from the video, shown on the ending when they agreed. */
  presenter: Buffer | null;
  workDir: string;
  /** How the video moves; "shelf" when absent or unknown. */
  motion?: ProductAdMotion;
};

export type ComposedAd = {
  plan: RenderPlan;
  timeline: Timeline;
  /** The Status picture (9:16): the price card. */
  status: Buffer;
  /** The 4:5 ad picture: the first scene. */
  feed: Buffer;
  /**
   * Per product, in order: whether its scene's words cover it and the band
   * that would cover less, for the studio's Top/Bottom hint; null without a
   * box.
   */
  textOverlap: Array<ProductAdTextOverlap | null>;
  /**
   * When the poster is taken: the first scene once its sticker or words are
   * in (AD_POSTER_SECONDS but after a filmed opening). Absent: AD_POSTER_SECONDS.
   */
  posterSeconds?: number;
};

export async function composeAd(
  input: ComposeInput,
  deps: VoiceDeps = {},
): Promise<ComposedAd> {
  const motion = productAdMotionOf(input.motion);
  const filmed = input.products.map(
    (product) => motion === "filmed_sold" && Boolean(product.original),
  );
  const timeline = planTimeline(
    input.products.map((product, index) => ({
      voiceSeconds: product.voice ? pcmSeconds(product.voice) : null,
      leadSeconds: filmed[index] ? AD_FILMED_LEAD_SECONDS : 0,
    })),
  );
  const file = async (name: string, data: Buffer) => {
    const path = join(input.workDir, name);
    await writeFile(path, data);
    return path;
  };
  const placed = async (name: string, layer: PlacedLayer) => ({
    path: await file(name, layer.layer.image),
    x: Math.round(layer.rect.x),
    y: Math.round(layer.rect.y),
    // Where the card's ink starts under its shadow's clear margin, so the
    // tag's drop keeps it inside the safe band.
    inkTop: (await alphaBox(layer.layer.image))?.top ?? 0,
  });
  const sized = async (
    name: string,
    layer: FrameLayer,
  ): Promise<SizedRenderLayer> => ({
    path: await file(name, layer.image),
    x: Math.round(layer.rect.x),
    y: Math.round(layer.rect.y),
    width: layer.width,
    height: layer.height,
  });

  const scenes: RenderScene[] = [];
  const textOverlap: Array<ProductAdTextOverlap | null> = [];
  for (const [index, product] of input.products.entries()) {
    const timed = timeline.scenes[index]!;
    const built = await productScene(motion, product, index, sized, file);
    const words = await productSceneLayers({
      frame: "reels",
      product: built.product,
      name: product.name,
      caption: product.caption,
      priceText: product.priceText,
      sticker: index === 0 && input.sticker.trim() ? input.sticker : null,
      zone: product.textZone ?? "auto",
    });
    textOverlap.push(words.layout.textOverlap);
    const voice =
      timed.kind === "product" && timed.voice
        ? { line: product.spoken?.trim() || null, ...timed.voice }
        : null;
    const opening: RenderOpening | null =
      filmed[index] && product.original
        ? {
            background: await file(
              `scene-${index}-filmed.png`,
              (await coverBackground(product.original, AD_FRAME, null)).image,
            ),
            seconds: AD_FILMED_LEAD_SECONDS,
            transition: index === 0 ? "circleopen" : "wiperight",
          }
        : null;
    scenes.push({
      voice,
      background: built.background,
      focus: built.focus,
      zoomTo: built.zoomTo,
      seconds: timed.seconds,
      label: await placed(`scene-${index}-label.png`, words.label),
      tag: await placed(`scene-${index}-tag.png`, words.tag),
      sticker: words.sticker
        ? await placed(`scene-${index}-sticker.png`, words.sticker)
        : null,
      transition: index < input.products.length - 1 ? "slideleft" : "fade",
      ...(opening ? { opening } : {}),
      ...(built.subject ? { subject: built.subject } : {}),
      ...(built.blur ? { blur: built.blur } : {}),
    });
  }

  const card = await priceCardLayers({
    title: input.priceCardTitle,
    products: input.products.map((product) => ({
      cutout: product.cutout,
      name: product.name,
      priceText: product.priceText,
    })),
  });
  const cardScene = timeline.scenes[input.products.length]!;
  scenes.push({
    background: await file("price-card.png", card.background),
    focus: { x: 0.5, y: 0.45 },
    zoomTo: 1.025,
    seconds: cardScene.seconds,
    label: await placed("price-card-title.png", card.title),
    tag: await placed("price-card-tags.png", card.tags),
    sticker: null,
    transition: "fade",
  });

  const ending = await endingLayers({
    cutouts: input.products.map((product) => product.cutout),
    presenter: input.presenter,
    shopName: input.shopName,
    ending: input.ending,
    phone: input.phone,
  });
  const endingScene = timeline.scenes[input.products.length + 1]!;
  scenes.push({
    background: await file("ending.png", ending.background),
    focus: { x: 0.5, y: 0.5 },
    zoomTo: 1,
    seconds: endingScene.seconds,
    label: await placed("ending-words.png", ending.words),
    tag: await placed("ending-pill.png", ending.pill),
    sticker: null,
    transition: null,
  });

  const placements = timeline.scenes.flatMap((scene) => {
    if (scene.kind !== "product" || !scene.voice) return [];
    const voice = input.products[scene.productIndex]!.voice;
    return voice
      ? [{ voice, at: scene.voice.at, seconds: scene.voice.seconds }]
      : [];
  });
  const voicePath = join(input.workDir, "voice.wav");
  const voiced = await buildVoiceTrack(
    placements,
    timeline.totalSeconds,
    voicePath,
    input.workDir,
    deps,
  );

  const first = input.products[0]!;
  const [status, feed] = await Promise.all([
    composeStill(card.background, [card.title, card.tags], AD_FRAME),
    feedStill({
      picture: first.picture,
      box: first.box,
      name: first.name,
      caption: first.caption,
      priceText: first.priceText,
      zone: first.textZone ?? "auto",
    }),
  ]);

  return {
    plan: {
      scenes,
      starts: timeline.scenes.map((scene) => scene.start),
      totalSeconds: timeline.totalSeconds,
      voice: voiced ? voicePath : null,
    },
    timeline,
    status,
    feed,
    textOverlap,
    posterSeconds: posterSeconds(scenes[0]!),
  };
}

/**
 * When the poster is taken: AD_POSTER_SECONDS, once the first scene's
 * sticker or words are in; after a filmed opening, just past its wipe while
 * the sticker shows, or once the words are in without one.
 */
export function posterSeconds(first: RenderScene): number {
  if (!first.opening) return AD_POSTER_SECONDS;
  const wiped = first.opening.seconds + AD_TRANSITION_SECONDS;
  return (
    wiped + (first.sticker ? FILMED_POSTER_AFTER_WIPE : FILMED_POSTER_WORDS_IN)
  );
}

type BuiltScene = {
  /** The picture under the scene, saved in the work folder. */
  background: string;
  focus: { x: number; y: number };
  zoomTo: number;
  /** Where the product is in the frame, for the words; null when unknown. */
  product: Rect | null;
  subject: RenderSubject | null;
  blur: number;
};

/** A product's scene picture (and its animated cut-out) for the ad's motion. */
async function productScene(
  motion: ProductAdMotion,
  product: ComposeProduct,
  index: number,
  sized: (name: string, layer: FrameLayer) => Promise<SizedRenderLayer>,
  file: (name: string, data: Buffer) => Promise<string>,
): Promise<BuiltScene> {
  if (motion === "float") {
    const floated = await floatSceneLayers(product.cutout);
    return {
      background: await file(`scene-${index}.png`, floated.background),
      focus: { x: 0.5, y: 0.5 },
      zoomTo: 1,
      product: floated.product,
      subject: {
        motion: "float",
        layer: await sized(`scene-${index}-subject.png`, floated.subject),
        shadow: await sized(`scene-${index}-shadow.png`, floated.shadow),
      },
      blur: 0,
    };
  }
  if (motion === "pop") return popScene(product, index, sized, file);
  const { image, crop } = await coverBackground(
    product.picture,
    AD_FRAME,
    product.box,
  );
  return {
    background: await file(`scene-${index}.png`, image),
    focus: crop.focus,
    zoomTo: 1.06,
    product: crop.product,
    subject: null,
    blur: 0,
  };
}

/**
 * Pop's scene: the Muse Image scene blurred behind the product's exact
 * cut-out, standing where SAM found the product; with no made scene (or no
 * box), the studio sweep it stands out on, the cut-out where the exact
 * still stands it.
 */
async function popScene(
  product: ComposeProduct,
  index: number,
  sized: (name: string, layer: FrameLayer) => Promise<SizedRenderLayer>,
  file: (name: string, data: Buffer) => Promise<string>,
): Promise<BuiltScene> {
  if (product.made && product.box) {
    const { image, crop } = await coverBackground(
      product.picture,
      AD_FRAME,
      product.box,
    );
    if (crop.product) {
      const popped = await popSubjectLayer(product.cutout, crop.product);
      return {
        background: await file(`scene-${index}.png`, image),
        focus: crop.focus,
        zoomTo: POP_ZOOM_TO,
        product: popped.product,
        subject: {
          motion: "pop",
          layer: await sized(`scene-${index}-subject.png`, popped.subject),
          shadow: null,
        },
        blur: POP_BLUR,
      };
    }
  }
  const box = await exactSceneBox(product.cutout);
  const rect = box
    ? {
        x: Math.round(box.x * AD_FRAME.width),
        y: Math.round(box.y * AD_FRAME.height),
        w: Math.round(box.w * AD_FRAME.width),
        h: Math.round(box.h * AD_FRAME.height),
      }
    : { x: 220, y: 560, w: 640, h: 640 };
  const popped = await popSubjectLayer(product.cutout, rect);
  const sweep = await sharp(
    studioSweepSvg(
      AD_FRAME,
      await studioColourwayFor(product.cutout),
      groundShadows(popped.product),
    ),
  )
    .png({ compressionLevel: 1 })
    .toBuffer();
  return {
    background: await file(`scene-${index}.png`, sweep),
    focus: {
      x: (popped.product.x + popped.product.w / 2) / AD_FRAME.width,
      y: (popped.product.y + popped.product.h / 2) / AD_FRAME.height,
    },
    zoomTo: POP_ZOOM_TO,
    product: popped.product,
    subject: {
      motion: "pop",
      layer: await sized(`scene-${index}-subject.png`, popped.subject),
      shadow: null,
    },
    blur: 0,
  };
}
