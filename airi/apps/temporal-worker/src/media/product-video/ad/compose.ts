import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProductAdBox } from "@icecore/temporal";
import { buildVoiceTrack, pcmSeconds, type Pcm, type VoiceDeps } from "./audio";
import {
  alphaBox,
  composeStill,
  coverBackground,
  endingLayers,
  feedStill,
  priceCardLayers,
  productSceneLayers,
  type PlacedLayer,
} from "./layers";
import { AD_FRAME, planTimeline, type Timeline } from "./layout";
import type { RenderPlan, RenderScene } from "./render";

// Puts an ad together from what its steps saved: each product's scene
// picture and box, the script's words, the shelf's prices and the owner's
// polished words. One set of layers makes the video's scenes, the Status
// picture (the price card) and the 4:5 ad picture.

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
  /** The owner's polished words for it; null for a silent scene. */
  voice: Pcm | null;
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
};

export type ComposedAd = {
  plan: RenderPlan;
  timeline: Timeline;
  /** The Status picture (9:16): the price card. */
  status: Buffer;
  /** The 4:5 ad picture: the first scene. */
  feed: Buffer;
};

export async function composeAd(
  input: ComposeInput,
  deps: VoiceDeps = {},
): Promise<ComposedAd> {
  const timeline = planTimeline(
    input.products.map((product) => ({
      voiceSeconds: product.voice ? pcmSeconds(product.voice) : null,
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

  const scenes: RenderScene[] = [];
  for (const [index, product] of input.products.entries()) {
    const timed = timeline.scenes[index]!;
    const { image, crop } = await coverBackground(
      product.picture,
      AD_FRAME,
      product.box,
    );
    const words = await productSceneLayers({
      frame: "reels",
      product: crop.product,
      name: product.name,
      caption: product.caption,
      priceText: product.priceText,
      sticker: index === 0 && input.sticker.trim() ? input.sticker : null,
    });
    scenes.push({
      background: await file(`scene-${index}.png`, image),
      focus: crop.focus,
      zoomTo: 1.06,
      seconds: timed.seconds,
      label: await placed(`scene-${index}-label.png`, words.label),
      tag: await placed(`scene-${index}-tag.png`, words.tag),
      sticker: words.sticker
        ? await placed(`scene-${index}-sticker.png`, words.sticker)
        : null,
      transition: index < input.products.length - 1 ? "slideleft" : "fade",
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
  };
}
