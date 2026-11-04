import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isElevenLabsSttAcceptedRequest } from "@icecore/airi-runtime/elevenlabs-stt";
import {
  createMetaResponse,
  isMetaModelApiTransientError,
  isMetaModelRefusal,
  MetaModelApiError,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import { getWorkspaceAiRequiredDetails } from "@icecore/shared/lib/workspace-ai-errors";
import {
  cleanAdScriptForLanguage,
  PRODUCT_AD_PLACE_MAX_COST_MICROS,
  PRODUCT_AD_REDO_ATTEMPTS,
  productAdMotionOf,
  productAdMusicOf,
  productAdShopName,
  type ProductAdBox,
  type ProductAdErrorCode,
  type ProductAdFileRef,
  type ProductAdIdeaKind,
  type ProductAdMode,
  type ProductAdMotion,
  type ProductAdMusic,
  type ProductAdRedoOutcome,
  type ProductAdRunKind,
  type ProductAdScenePlace,
  type ProductAdStillSetItem,
  type ProductAdScript,
  type ProductAdSetting,
  type ProductAdStatus,
  type ProductAdStep,
  type ProductAdStills,
  type ProductAdStoredProduct,
  type ProductAdStoredScene,
  type ProductAdVoiceMode,
  type ProductAdVoiceOver,
  type ProductShopWordsCode,
} from "@icecore/temporal";
import sharp from "sharp";
import { askMuseAboutImages } from "../ask-muse";
import { cutoutForMuse } from "../restore";
import {
  decodeVoice,
  encodeFlac,
  polishVoices,
  type Pcm,
  type VoiceSource,
} from "./audio";
import { composeAd } from "./compose";
import {
  alphaBox,
  composeStill,
  exactScene,
  exactSceneBox,
  priceCardLayers,
} from "./layers";
import { AD_FRAME } from "./layout";
import { readPlace, type PlaceReading } from "./place";
import { drawAdStills, stillFileName } from "./stills";
import {
  AD_POSTER_SECONDS,
  AdTooBigError,
  posterFrame,
  renderAd,
} from "./render";
import {
  adScriptSchema,
  fallbackAdScript,
  saidAround,
  writeAdScript,
  type AdScript,
  type ScriptRequest,
} from "./script";
import {
  framePicture,
  frameScene,
  makeMuseScene,
  placeName,
  SAM_MAX_COST_MICROS,
  type SceneDeps,
  type SceneJob,
  type ScenePlace,
  type SceneProduct,
} from "./scenes";
import {
  adSpender,
  AdSpendRefusal,
  blockedBy,
  spendCodeOf,
  type AdSpendPort,
  type PaidCall,
} from "./spend";
import { newWordsVoices, type VoiceOverPorts } from "./voice";

// One run of a video ad, start to finish, written against small ports so the
// Temporal activity supplies Mongo, storage, the ledger and ElevenLabs, and
// tests supply fakes. "make" writes the script, draws the exact stills (so a
// result always exists), makes and checks each Muse Image scene, frames them
// with SAM, polishes the owner's words and renders; every step is saved as it
// finishes, so a retried run skips what's done and pays only for what isn't.
// "render" makes the video again from what's saved, after the owner edited
// the words, their place, the exact photo or an earlier picture: it calls no
// model and spends nothing. The ad's `runKind` says which edit a "make" run
// is: "scene" ("New picture") pays only for its one scene, "voice" only for
// the voice-over (voice.ts). Every finished run records itself (`lastRun`).

/**
 * A Muse Spark script call's reservation: up to about 8k tokens in (three
 * products' photos and the narration) and SCRIPT_MAX_OUTPUT_TOKENS out.
 */
export const SCRIPT_MAX_COST_MICROS = 40_000;
/**
 * Tokens the script call may write, its reasoning included. ask-muse's
 * 3 000 cut off the v2 script (three openings, three endings and the
 * spoken lines) twice for QazOner's Kazakh promo in the paid gate
 * (2026-11-03), and the ad fell back to the code's words; the toy shelf's
 * took about 2 200.
 */
export const SCRIPT_MAX_OUTPUT_TOKENS = 6_000;

/** Muse Spark's Responses call for the script, with SCRIPT_MAX_OUTPUT_TOKENS of room. */
export function scriptResponse(
  create: typeof createMetaResponse = createMetaResponse,
): typeof createMetaResponse {
  return (request, options) =>
    create(
      { ...request, max_output_tokens: SCRIPT_MAX_OUTPUT_TOKENS },
      options,
    );
}
const ELEVENLABS_ISOLATION_MIN_MICROS = 10_000;
/** The import's videos this size or smaller are cut for the words; bigger ones use the saved clip. */
const SOURCE_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
const PHOTO_MAX_BYTES = 40 * 1024 * 1024;
const CLIP_MAX_BYTES = 40 * 1024 * 1024;
const SCENE_CONCURRENCY = 3;

/** A failure the run reports to the owner; `retryable` says whether trying again can help. */
export class ProductAdFailure extends Error {
  constructor(
    readonly code: ProductAdErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProductAdFailure";
  }
}

/** A newer run of the ad (the owner edited it again) took over: this one stops quietly. */
export class AdRunSuperseded extends Error {
  constructor() {
    super("A newer run of this ad took over");
    this.name = "AdRunSuperseded";
  }
}

/** The ad as a run reads it. */
export type AdRecord = {
  status: ProductAdStatus;
  renderNo: number;
  /**
   * What this run does: make, or an edit run (render, scene, voice) on an
   * ad that has a video. "make" when absent (ads from before edit runs).
   */
  runKind?: ProductAdRunKind;
  language: string | null;
  wordsCode: ProductShopWordsCode | null;
  idea: { kind: ProductAdIdeaKind; text: string | null };
  voice: ProductAdVoiceMode;
  /** With "stock": the Airi voice asked for; null otherwise. */
  stockVoiceId: string | null;
  /** The new words a run read before, which a later one reuses (voice.ts). */
  voiceOver: ProductAdVoiceOver | null;
  presenter: {
    use: boolean;
    consentAt: Date | null;
    photo: ProductAdFileRef | null;
  } | null;
  ending: { phone: string | null; shopName: string };
  products: ProductAdStoredProduct[];
  script: ProductAdScript | null;
  scenes: ProductAdStoredScene[];
  stills: ProductAdStills;
  costMicros: number;
  /**
   * How the video moves (studio v3); read with productAdMotionOf, so an ad
   * from before motions, or one this worker doesn't know, renders as "shelf".
   */
  motion?: ProductAdMotion;
  /** Background music style; absent or "none" when silent. */
  music?: ProductAdMusic;
};

/** What a run reads about each product beyond the ad's snapshot. */
export type AdProductSource = {
  productId: string;
  /** The import's narration, as timed lines. */
  transcript: string | null;
  /** The stretch of the video its review clip plays, with the owner saying its price. */
  clipWindow: { fromSeconds: number; toSeconds: number } | null;
  /** The import's video, its sound the original. */
  video: ProductAdFileRef | null;
};

export type AdFile = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  kind: "image" | "video" | "audio";
};

export type AdJobPorts = {
  store: {
    loadAd(): Promise<AdRecord | null>;
    /**
     * Sets fields on the ad, and adds `inc` to its cost, while the ad is
     * still on this run's render; false once a newer run took over.
     */
    updateAd(
      set: Record<string, unknown>,
      inc?: { costMicros?: number },
    ): Promise<boolean>;
    loadSources(productIds: string[]): Promise<AdProductSource[]>;
  };
  storage: {
    download(
      ref: ProductAdFileRef,
      destination: string,
      maxBytes: number,
    ): Promise<void>;
    save(file: AdFile): Promise<ProductAdFileRef>;
    /** Fetches a product's kept voice to `destination`; false when there is none. */
    loadVoice(productId: string, destination: string): Promise<boolean>;
    saveVoice(productId: string, flac: Buffer): Promise<void>;
  };
  spend: AdSpendPort;
  /** ElevenLabs Voice Isolator; null when it isn't configured. */
  isolate: ((wav: Buffer) => Promise<Buffer>) | null;
  /** The isolator's list price for `seconds` of audio, in micro-dollars. */
  isolationCostMicros: (seconds: number) => number;
  /** New words read by ElevenLabs ("clone" and "stock", voice.ts); null or absent when not set up. */
  voiceOver?: VoiceOverPorts | null;
  /** ElevenLabs instrumental background music for `seconds` of video; null or absent when not set up. */
  music?: ((seconds: number, prompt: string) => Promise<Buffer>) | null;
  /** The music generator's list price for `seconds` of audio, in micro-dollars. */
  musicCostMicros?: (seconds: number) => number;
  mode: ProductAdMode;
  renderNo: number;
  /** The activity's attempt, so each retry reserves its own operations. */
  attempt: number;
  workDir: string;
  pulse(): void;
  signal?: AbortSignal;
  /** What the run reports for the worker's log (the activity adds the ad's id). */
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => Date;
  /** Fields saved on the ad when the run starts (its workflow's id). */
  started?: Record<string, unknown>;
  /** Muse Spark, for the script; the tests' fake. */
  askMuse?: typeof askMuseAboutImages;
  sceneDeps?: SceneDeps;
  /** The putting together and the render; the tests' fakes. */
  compose?: typeof composeAd;
  /** The stills drawn beside the video (stills.ts); the tests' fake. */
  stills?: typeof drawAdStills;
  render?: typeof renderAd;
  poster?: typeof posterFrame;
};

export type AdRunResult = { status: "ready" | "superseded" };

type Loaded = {
  product: ProductAdStoredProduct;
  cutout: Buffer;
  original: Buffer | null;
};

export async function runProductAd(ports: AdJobPorts): Promise<AdRunResult> {
  const now = ports.now ?? (() => new Date());
  const ad = await ports.store.loadAd();
  if (!ad)
    throw new ProductAdFailure("failed", "The ad no longer exists", false);
  if (ad.renderNo !== ports.renderNo) return { status: "superseded" };
  if (ad.status === "ready") return { status: "ready" };
  if (ad.products.length === 0)
    throw new ProductAdFailure("failed", "The ad has no products", false);

  const update = async (
    set: Record<string, unknown>,
    inc?: { costMicros?: number },
  ) => {
    if (!(await ports.store.updateAd(set, inc))) throw new AdRunSuperseded();
  };
  const begin = (step: ProductAdStep) =>
    update({
      step,
      [`timings.${step}`]: { startedAt: now(), finishedAt: null },
    });
  const finish = (step: ProductAdStep) =>
    update({ [`timings.${step}.finishedAt`]: now() });
  const options: MetaRequestOptions = { signal: ports.signal };
  // The run has a slot: the studio stops saying it waits for one.
  await update({
    status: "making",
    startedAt: now(),
    errorCode: null,
    errorMessage: null,
    ...ports.started,
  });

  // Costs settle into the ad's total one at a time, in order.
  let costs: Promise<void> = Promise.resolve();
  let paidAnything = ad.costMicros > 0;
  const paid: PaidCall = adSpender(
    ports.spend,
    { renderNo: ports.renderNo, attempt: ports.attempt },
    (costMicros) => {
      paidAnything = true;
      if (costMicros <= 0) return costs;
      costs = costs.then(() => update({}, { costMicros }));
      return costs;
    },
  );

  const products = await loadProducts(ports, ad.products);
  let script = ad.script
    ? cleanAdScriptForLanguage(ad.script, ad.language, ad.wordsCode)
    : null;
  const scenes = new Map(
    ad.scenes.map((scene) => [scene.productId, { ...scene }]),
  );
  // Scene saves go one at a time, the latest state last.
  let sceneWrites: Promise<void> = Promise.resolve();
  const sceneSnapshot = () =>
    structuredClone(
      ad.products
        .map((product) => scenes.get(product.productId))
        .filter(Boolean),
    );
  const saveScenes = () => {
    const snapshot = sceneSnapshot();
    sceneWrites = sceneWrites.then(() => update({ scenes: snapshot }));
    return sceneWrites;
  };

  // What this run may pay for (render, scene and voice are edit runs on an
  // ad that has a video): a make run, every step not saved yet; a scene run
  // ("New picture"), only its one scene; a voice run, only the voice-over
  // (voice.ts); a render run, nothing.
  const runKind: ProductAdRunKind = ad.runKind ?? "make";
  if (ports.mode === "make" && runKind !== "make") {
    if (!script)
      throw new ProductAdFailure(
        "failed",
        "The ad has no words to change",
        false,
      );
    // The exact stills cost nothing: drawn here if a run before never got to them.
    await exactStills(ports, products, scenes, saveScenes);
    if (runKind === "scene")
      await redoScene({
        ports,
        products,
        scenes,
        script,
        paid,
        saveScenes,
        begin,
        finish,
        options,
        now,
      });
  } else if (ports.mode === "make") {
    // 1. The words.
    if (!script) {
      await begin("script");
      const written = await writeScript(
        ports,
        ad,
        products,
        paid,
        () => paidAnything,
        options,
      );
      script = { ...written, edited: false };
      await update({ script });
      await finish("script");
    }

    // 2. The pictures: the exact stills first, so a result always exists,
    // and the Status picture from them; then Muse Image's scenes.
    await begin("pictures");
    await exactStills(ports, products, scenes, saveScenes);
    if (!ad.stills.status) {
      const status = await statusStill(products, script!.priceCardTitle);
      await update({
        "stills.status": await ports.storage.save({
          buffer: status,
          mimeType: "image/jpeg",
          fileName: "status.jpg",
          kind: "image",
        }),
      });
    }
    let refused = false;
    await forEachWithConcurrency(
      products,
      SCENE_CONCURRENCY,
      async (loaded) => {
        const productId = loaded.product.productId;
        const scene = scenes.get(productId)!;
        if (scene.method === "muse" && scene.muse) return;
        if (refused) {
          // The ledger refused another product's spend: this one keeps its exact still.
          return;
        }
        const setting = scriptSetting(script!, productId);
        if (!scene.place)
          scene.place = { setting, words: null, englishPlace: null };
        const outcome = await makeMuseScene(
          sceneProduct(loaded),
          { setting },
          scene,
          sceneJob(ports, scenes, saveScenes, paid, options, now),
        );
        scenes.set(productId, outcome.scene);
        if (outcome.refused) refused = true;
      },
    );
    await saveScenes();
    await finish("pictures");

    // 3. Framing: SAM's box of each Muse Image scene.
    const unframed = products.filter(({ product }) => {
      const scene = scenes.get(product.productId)!;
      return scene.method === "muse" && scene.muse && !scene.box;
    });
    if (unframed.length > 0) {
      await begin("framing");
      for (const loaded of unframed) {
        if (refused) break;
        const scene = scenes.get(loaded.product.productId)!;
        if ((await frame(ports, loaded, scene, paid, options)) === "refused")
          refused = true;
        await saveScenes();
      }
      await finish("framing");
    }
  }

  // 4. The video, the poster and the stills: no model calls.
  if (!script)
    throw new ProductAdFailure(
      "failed",
      "The ad has no words to render",
      false,
    );
  await begin("video");
  const { voices, lines } = await adVoices(ports, ad, script, paid, update);
  const music = await adMusic(ports, ad, paid);
  const pictures = await scenePictures(ports, products, scenes, saveScenes);
  const presenter = await presenterPhoto(ports, ad);
  const composeProducts = products.map(({ product, cutout, original }) => {
    const scene = scenes.get(product.productId)!;
    const picture = pictures.get(product.productId)!;
    return {
      productId: product.productId,
      name: product.name,
      priceText: product.priceText,
      cutout,
      picture: picture.image,
      box: picture.box,
      made: picture.made,
      original,
      caption:
        script!.scenes.find((entry) => entry.productId === product.productId)
          ?.caption ?? "",
      voice: voices.get(product.productId) ?? null,
      spoken: lines.get(product.productId) ?? null,
      textZone: scene.textZone ?? "auto",
    };
  });
  const motion = productAdMotionOf(ad.motion);
  const composed = await (ports.compose ?? composeAd)(
    {
      products: composeProducts,
      sticker: script.sticker,
      priceCardTitle: script.priceCardTitle,
      ending: script.ending,
      shopName: ad.ending.shopName,
      phone: ad.ending.phone,
      presenter,
      music,
      workDir: ports.workDir,
      motion,
    },
    { signal: ports.signal, pulse: ports.pulse },
  );
  const videoPath = join(ports.workDir, "ad.mp4");
  // The stills are drawn while ffmpeg renders. They're extras: one that
  // can't be drawn never fails the video, the ad then keeps no stillSet for
  // this render (the page hides the tiles that need it).
  const [rendered, drawn] = await Promise.all([
    (ports.render ?? renderAd)(composed.plan, videoPath, {
      signal: ports.signal,
      pulse: ports.pulse,
    }),
    (ports.stills ?? drawAdStills)({
      products: composeProducts,
      sticker: script.sticker,
      priceCardTitle: script.priceCardTitle,
      ending: script.ending,
      shopName: ad.ending.shopName,
      phone: ad.ending.phone,
    }).catch((error: unknown) => {
      ports.log?.("products.ad_stills_failed", { error: messageOf(error) });
      return null;
    }),
  ]);
  const posterPath = join(ports.workDir, "poster.jpg");
  await (ports.poster ?? posterFrame)(
    videoPath,
    posterPath,
    { signal: ports.signal },
    composed.posterSeconds ?? AD_POSTER_SECONDS,
  );
  const r = `r${ports.renderNo}`;
  const stillSet = drawn?.length
    ? {
        renderNo: ports.renderNo,
        items: await Promise.all(
          drawn.map(
            async (still): Promise<ProductAdStillSetItem> => ({
              kind: still.kind,
              format: still.format,
              productId: still.productId,
              colourway: still.colourway,
              ref: await ports.storage.save({
                buffer: still.image,
                mimeType: "image/jpeg",
                fileName: stillFileName(ports.renderNo, still),
                kind: "image",
              }),
            }),
          ),
        ),
      }
    : null;
  const [video, poster, status, feed] = await Promise.all([
    ports.storage.save({
      buffer: await readFile(videoPath),
      mimeType: "video/mp4",
      fileName: `${r}-ad.mp4`,
      kind: "video",
    }),
    ports.storage.save({
      buffer: await readFile(posterPath),
      mimeType: "image/jpeg",
      fileName: `${r}-poster.jpg`,
      kind: "image",
    }),
    ports.storage.save({
      buffer: composed.status,
      mimeType: "image/jpeg",
      fileName: `${r}-status.jpg`,
      kind: "image",
    }),
    ports.storage.save({
      buffer: composed.feed,
      mimeType: "image/jpeg",
      fileName: `${r}-feed.jpg`,
      kind: "image",
    }),
  ]);
  await costs;
  // Whether each scene's words cover its product, for the studio's hint,
  // saved with the video it describes.
  products.forEach(({ product }, index) => {
    const scene = scenes.get(product.productId)!;
    scene.textOverlap = composed.textOverlap?.[index] ?? null;
  });
  await sceneWrites;
  await update({
    scenes: sceneSnapshot(),
    lastRun: {
      renderNo: ports.renderNo,
      kind: runKind,
      outcome: "ready",
      errorCode: null,
      message: null,
      at: now(),
    },
    render: {
      renderNo: ports.renderNo,
      video,
      bytes: rendered.bytes,
      seconds: composed.timeline.totalSeconds,
      width: rendered.size.width,
      height: rendered.size.height,
      poster,
      ms: rendered.ms,
    },
    stills: { status, feed },
    // Top-level, never inside `stills` (written whole just above), and
    // with this render's number: the page shows them only with its video.
    ...(stillSet ? { stillSet } : {}),
    "timings.video.finishedAt": now(),
    status: "ready",
    step: null,
    errorCode: null,
    errorMessage: null,
    readyAt: now(),
  });
  return { status: "ready" };
}

/**
 * Each product's cut-out (and the item as filmed), downloaded into the work
 * folder. Every product's downloads finish before a failure is thrown: one
 * still running would go on writing into the folder after the run ended,
 * while the activity removes it, and fail that removal (ENOTEMPTY).
 */
async function loadProducts(
  ports: AdJobPorts,
  products: ProductAdStoredProduct[],
): Promise<Loaded[]> {
  const settled = await Promise.allSettled(
    products.map(async (product, index): Promise<Loaded> => {
      if (!product.cutout)
        throw new ProductAdFailure(
          "photo_missing",
          `${product.name} has no cut-out photo`,
          false,
        );
      const cutoutPath = join(ports.workDir, `cutout-${index}.png`);
      try {
        await ports.storage.download(
          product.cutout,
          cutoutPath,
          PHOTO_MAX_BYTES,
        );
      } catch (error) {
        if (isMissingFile(error))
          throw new ProductAdFailure(
            "photo_missing",
            `${product.name}'s cut-out photo is gone from storage`,
            false,
          );
        throw error;
      }
      let original: Buffer | null = null;
      if (product.original) {
        const originalPath = join(ports.workDir, `original-${index}.jpg`);
        try {
          await ports.storage.download(
            product.original,
            originalPath,
            PHOTO_MAX_BYTES,
          );
          original = await readFile(originalPath);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      return { product, cutout: await readFile(cutoutPath), original };
    }),
  );
  const loaded: Loaded[] = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    loaded.push(result.value);
  }
  return loaded;
}

/**
 * Removes a run's work folder. The cleanup never changes how the run ended:
 * a file still landing, or one Windows holds open, is retried, and a folder
 * that still can't go is only reported.
 */
export async function removeWorkDir(
  workDir: string,
  onError: (error: unknown) => void = () => undefined,
  remove: typeof rm = rm,
): Promise<void> {
  try {
    await remove(workDir, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    onError(error);
  }
}

/** A storage error for a file that isn't there (also voice-clone.ts's). */
export function isMissingFile(error: unknown): boolean {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : null;
  return (
    code === 404 ||
    code === "ENOENT" ||
    /No such object|not found/i.test(String(error))
  );
}

/**
 * The script, from Muse Spark or the code's own words. The ledger refusing
 * the very first reservation means the ad's AI action can't start: the ad
 * fails with the import's own reason. Refused later, the code writes.
 */
async function writeScript(
  ports: AdJobPorts,
  ad: AdRecord,
  products: Loaded[],
  paid: PaidCall,
  paidAnything: () => boolean,
  options: MetaRequestOptions,
): Promise<AdScript> {
  const sources = new Map(
    (
      await ports.store.loadSources(
        ad.products.map((product) => product.productId),
      )
    ).map((source) => [source.productId, source]),
  );
  const images = await Promise.all(
    products.map(({ cutout }) => cutoutForMuse(cutout)),
  );
  const ids = ad.products.map((product) => product.productId);
  const request: ScriptRequest = {
    language: ad.language,
    wordsCode: ad.wordsCode,
    idea: ad.idea,
    // Only a name the ending can draw: Muse Spark is told to write it as given.
    shopName: productAdShopName(ad.ending.shopName),
    products: ad.products.map((product) => {
      const source = sources.get(product.productId);
      return {
        productId: product.productId,
        name: product.name,
        englishName: product.englishName,
        priceText: product.priceText,
        priceQuote: product.priceQuote,
        description: product.description,
        said: saidAround(
          source?.transcript ?? null,
          product.priceQuote,
          source?.clipWindow ?? null,
          ad.products.flatMap((other) =>
            other.productId !== product.productId && other.priceQuote
              ? [other.priceQuote]
              : [],
          ),
        ),
      };
    }),
  };
  try {
    const written = await writeAdScript(request, (question, call) =>
      paid(
        `script:a${call}`,
        "meta",
        SCRIPT_MAX_COST_MICROS,
        async (onCost) => ({
          value: await (ports.askMuse ?? askMuseAboutImages)(
            {
              images,
              question,
              schema: adScriptSchema(ids),
              purpose: "ad script",
            },
            {
              onCost,
              pulse: ports.pulse,
              createMetaResponse: scriptResponse(),
            },
            options,
          ),
        }),
      ),
    );
    return written.script;
  } catch (error) {
    if (!(error instanceof AdSpendRefusal)) throw error;
    if (!paidAnything()) throw await admissionFailure(ports, error);
    return fallbackAdScript(request);
  }
}

/**
 * Why the ad's action couldn't start, in the import's own words: the
 * company's limit, the plan's included actions, or the free trial.
 */
async function admissionFailure(
  ports: AdJobPorts,
  refusal: AdSpendRefusal,
): Promise<ProductAdFailure> {
  const stop =
    refusal.code === "workspace_ai_spend_limit"
      ? "spend_limit"
      : (blockedBy(await ports.spend.allowance()) ?? "spend_limit");
  const messages = {
    spend_limit: "The company's AI spending limit was reached",
    ai_actions_used: "The plan's included AI actions are used up",
    trial_ended: "The company's free trial has ended",
  } as const;
  return new ProductAdFailure(stop, messages[stop], false);
}

/** The script's setting for a product's scene; the oak table when it names none. */
function scriptSetting(
  script: ProductAdScript,
  productId: string,
): ProductAdSetting {
  return (
    script.scenes.find((entry) => entry.productId === productId)?.setting ??
    "oak_table_window"
  );
}

/** A product as its Muse Image scene is asked for. */
function sceneProduct({ product, cutout, original }: Loaded): SceneProduct {
  return {
    productId: product.productId,
    description: product.description || product.englishName || product.name,
    samPhrase: product.samPhrase,
    cutout,
    original,
  };
}

/** What makeMuseScene needs from the run: its spend, its saves and its storage. */
function sceneJob(
  ports: AdJobPorts,
  scenes: Map<string, ProductAdStoredScene>,
  saveScenes: () => Promise<void>,
  paid: PaidCall,
  options: MetaRequestOptions,
  now: () => Date,
): SceneJob {
  return {
    paid,
    save: async (next) => {
      scenes.set(next.productId, { ...next });
      await saveScenes();
    },
    storeScene: (id, attempt, jpeg) =>
      ports.storage.save({
        buffer: jpeg,
        mimeType: "image/jpeg",
        fileName: `scene-${id}-a${attempt}.jpg`,
        kind: "image",
      }),
    deps: { ...ports.sceneDeps, pulse: ports.pulse },
    options,
    now,
  };
}

/**
 * Each product's exact still (its cut-out on the code-drawn wall) and the
 * product's box in it, drawn and saved for any scene without one, so a
 * result always exists. Code only, no model call.
 */
async function exactStills(
  ports: AdJobPorts,
  products: Loaded[],
  scenes: Map<string, ProductAdStoredScene>,
  saveScenes: () => Promise<void>,
): Promise<void> {
  let changed = false;
  for (const { product, cutout } of products) {
    const scene = scenes.get(product.productId);
    if (scene?.exact) continue;
    const exact = await exactScene(cutout);
    const ref = await ports.storage.save({
      buffer: exact.image,
      mimeType: "image/jpeg",
      fileName: `exact-${product.productId}.jpg`,
      kind: "image",
    });
    const muse = scene?.method === "muse" && scene.muse;
    scenes.set(product.productId, {
      ...scene,
      productId: product.productId,
      exact: ref,
      exactBox: exact.box,
      muse: scene?.muse ?? null,
      method: muse ? "muse" : "exact",
      check: scene?.check ?? null,
      box: muse ? (scene?.box ?? null) : exact.box,
      attempts: scene?.attempts ?? 0,
    });
    changed = true;
  }
  if (changed) await saveScenes();
}

/**
 * SAM 3.1's box of the product in its Muse Image scene, grown to the whole
 * product's shape, set on the scene and its kept picture. "unframed" when a
 * Meta model didn't answer (the scene is then cut around its centre);
 * "refused" when the ledger refused the spend.
 */
async function frame(
  ports: AdJobPorts,
  { product, cutout }: Loaded,
  scene: ProductAdStoredScene,
  paid: PaidCall,
  options: MetaRequestOptions,
): Promise<"framed" | "unframed" | "refused"> {
  const path = join(ports.workDir, `frame-${product.productId}.jpg`);
  await ports.storage.download(scene.muse!, path, PHOTO_MAX_BYTES);
  const picture = await readFile(path);
  // The whole product's shape, for a box SAM drew round only part of it.
  const shape = await alphaBox(cutout);
  try {
    scene.box = await paid(
      `sam:${product.productId}`,
      "meta",
      SAM_MAX_COST_MICROS,
      async (onCost) => ({
        value: await frameScene(
          picture,
          product.samPhrase || product.englishName || product.name,
          { ...ports.sceneDeps, pulse: ports.pulse, onCost },
          options,
          shape && { width: shape.width, height: shape.height },
        ),
      }),
    );
    framePicture(scene);
    return "framed";
  } catch (error) {
    if (error instanceof AdSpendRefusal) return "refused";
    if (!(error instanceof MetaModelApiError)) throw error;
    return "unframed";
  }
}

type RedoRun = {
  ports: AdJobPorts;
  products: Loaded[];
  scenes: Map<string, ProductAdStoredScene>;
  script: ProductAdScript;
  paid: PaidCall;
  saveScenes: () => Promise<void>;
  begin: (step: ProductAdStep) => Promise<void>;
  finish: (step: ProductAdStep) => Promise<void>;
  options: MetaRequestOptions;
  now: () => Date;
};

/**
 * A "New picture" press (a scene run): only the scene whose `redo` is still
 * running pays, nothing else. The described place is read by Muse Spark
 * first (place.ts; a refusal ends the press), then Muse Image makes the
 * scene there with this press's PRODUCT_AD_REDO_ATTEMPTS tries, each
 * checked by Muse Spark, and SAM 3.1 frames the one that passes. Short of a
 * new picture the scene gets back what it had (`redo.from`), and the press
 * says why (`redo.outcome`); the video then renders either way.
 */
async function redoScene(run: RedoRun): Promise<void> {
  const { ports, scenes, script, paid, saveScenes } = run;
  const loaded = run.products.find(
    ({ product }) => scenes.get(product.productId)?.redo?.outcome === null,
  );
  if (!loaded) return;
  const productId = loaded.product.productId;
  let scene = scenes.get(productId)!;
  const redo = scene.redo!;
  let picturesDone = false;
  const end = async (
    outcome: ProductAdRedoOutcome,
    reason: string | null = null,
  ) => {
    // The step list's pictures step ends with the press, however it ends.
    if (!picturesDone) await run.finish("pictures");
    if (outcome !== "new")
      Object.assign(scene, {
        muse: redo.from.muse,
        box: redo.from.box,
        method: redo.from.method,
        check: redo.from.check,
      });
    // The owner asked for a new picture: they see it, not their exact photo.
    else scene.useExact = false;
    scene.redo = { ...scene.redo!, outcome, reason };
    scenes.set(productId, scene);
    await saveScenes();
  };
  await run.begin("pictures");
  // The picture it replaces stays one to pick again (ads from before kept
  // none), named by the place it was made in, not the one just pressed.
  if (!scene.pictures?.length && redo.from.method === "muse" && redo.from.muse)
    scene.pictures = [
      {
        ref: redo.from.muse,
        box: redo.from.box,
        place: placeName({
          setting: redo.from.setting ?? scriptSetting(script, productId),
        }),
        madeAt: run.now(),
      },
    ];

  // 1. Where: a tested setting, or the owner's words as Muse Spark reads them.
  const asked: ProductAdScenePlace = scene.place ?? {
    setting: scriptSetting(script, productId),
    words: null,
    englishPlace: null,
  };
  let place: ScenePlace;
  if (asked.words && asked.englishPlace) {
    place = { englishPlace: asked.englishPlace };
  } else if (asked.words) {
    let reading: PlaceReading;
    try {
      reading = await paid(
        `place:${productId}:p${redo.renderNo}`,
        "meta",
        PRODUCT_AD_PLACE_MAX_COST_MICROS,
        async (onCost) => ({
          value: await readPlace(
            asked.words!,
            {
              ...ports.sceneDeps,
              askMuse: ports.askMuse,
              pulse: ports.pulse,
              onCost,
            },
            run.options,
          ),
        }),
      );
    } catch (error) {
      if (error instanceof AdSpendRefusal) return end("no_budget");
      // Muse Spark refusing the words outright is a refused place, not an
      // outage: the same words pressed again would only be refused again.
      if (isMetaModelRefusal(error)) return end("place_refused", "unclear");
      if (error instanceof MetaModelApiError) return end("unavailable");
      throw error;
    }
    if (!reading.ok) return end("place_refused", reading.reason);
    scene.place = { ...asked, englishPlace: reading.place };
    place = { englishPlace: reading.place };
  } else {
    place = { setting: asked.setting ?? scriptSetting(script, productId) };
  }

  // 2. This press's tries, raised once however often the run is retried.
  if (redo.allowance == null) {
    scene.allowance = scene.attempts + PRODUCT_AD_REDO_ATTEMPTS;
    scene.redo = { ...redo, allowance: scene.allowance };
  }
  scenes.set(productId, scene);
  await saveScenes();
  const made = await makeMuseScene(
    sceneProduct(loaded),
    place,
    scene,
    sceneJob(ports, scenes, saveScenes, paid, run.options, run.now),
  );
  scene = made.scene;
  scenes.set(productId, scene);
  await run.finish("pictures");
  picturesDone = true;
  if (made.stop !== "new" || !scene.muse) return end(made.stop);

  // 3. SAM 3.1 frames the new picture; without a box it's cut around its centre.
  if (!scene.box) {
    await run.begin("framing");
    await frame(ports, loaded, scene, paid, run.options);
    await run.finish("framing");
  }
  await end("new");
}

/** The Status picture: the price card, with every product on the plank. */
async function statusStill(products: Loaded[], title: string): Promise<Buffer> {
  const card = await priceCardLayers({
    title,
    products: products.map(({ product, cutout }) => ({
      cutout,
      name: product.name,
      priceText: product.priceText,
    })),
  });
  return composeStill(card.background, [card.title, card.tags], AD_FRAME);
}

/**
 * The ad's voice per product's scene: the owner's polished recording
 * ("own"), the script's spoken lines read by ElevenLabs ("clone" in the
 * owner's cloned voice, "stock" in an Airi voice; voice.ts), or silence.
 * New words that can't be read fall back to the recording, else silence,
 * and the ad keeps why (`voiceResult`). `lines` holds the words each new
 * voice reads, for the plan's record of the voice-over; empty otherwise.
 */
async function adVoices(
  ports: AdJobPorts,
  ad: AdRecord,
  script: ProductAdScript,
  paid: PaidCall,
  update: (set: Record<string, unknown>) => Promise<void>,
): Promise<{ voices: Map<string, Pcm>; lines: Map<string, string> }> {
  const lines = new Map<string, string>();
  // Only a make or a voice run pays for the voice; a scene run ("New
  // picture") also reads a new stock or cloned voice when one rode along
  // with the press (kept lines for an unchanged voice cost $0).
  const runKind = ad.runKind ?? "make";
  const mode: ProductAdMode =
    ports.mode === "make" &&
    (runKind === "make" ||
      runKind === "voice" ||
      (runKind === "scene" && (ad.voice === "clone" || ad.voice === "stock")))
      ? "make"
      : "render";
  if (ad.voice !== "clone" && ad.voice !== "stock") {
    // The video's voice is exactly the one asked for: an earlier voice's
    // fallback no longer describes it.
    await update({ voiceResult: null });
    return {
      voices:
        ad.voice === "own"
          ? await ownVoices(ports, ad, paid, mode)
          : new Map<string, Pcm>(),
      lines,
    };
  }
  const read = await newWordsVoices({
    ad,
    script,
    ports: ports.voiceOver ?? null,
    storage: ports.storage,
    paid,
    mode,
    workDir: ports.workDir,
    signal: ports.signal,
    pulse: ports.pulse,
    log: ports.log,
  });
  if (read.ok) {
    await update({
      voiceOver: read.voiceOver,
      voiceResult: { used: ad.voice, fallback: null },
    });
    for (const line of read.voiceOver.lines)
      if (read.voices.has(line.productId)) lines.set(line.productId, line.text);
    return { voices: read.voices, lines };
  }
  const recording = await ownVoices(ports, ad, paid, mode);
  await update({
    voiceResult: {
      used: recording.size > 0 ? "own" : "none",
      fallback: read.fallback,
    },
  });
  return { voices: recording, lines };
}

/**
 * The owner's polished words per product: kept from an earlier run, or, in
 * a "make" run, polished now (the Voice Isolator booked in the ad's action)
 * and kept. A "render" run never pays: a product without kept words is
 * silent.
 */
async function ownVoices(
  ports: AdJobPorts,
  ad: AdRecord,
  paid: PaidCall,
  mode: ProductAdMode,
): Promise<Map<string, Pcm>> {
  const voices = new Map<string, Pcm>();
  const missing: ProductAdStoredProduct[] = [];
  for (const product of ad.products) {
    const path = join(ports.workDir, `kept-voice-${product.productId}.flac`);
    if (await ports.storage.loadVoice(product.productId, path))
      voices.set(
        product.productId,
        await decodeVoice(
          path,
          ports.workDir,
          `kept-voice-${product.productId}`,
          {
            signal: ports.signal,
          },
        ),
      );
    else missing.push(product);
  }
  if (mode === "render" || missing.length === 0) return voices;

  const sources = new Map(
    (
      await ports.store.loadSources(missing.map((product) => product.productId))
    ).map((source) => [source.productId, source]),
  );
  const clips: Array<{ productId: string; source: VoiceSource }> = [];
  const videos = new Map<string, string | null>();
  for (const product of missing) {
    const source = sources.get(product.productId);
    let voiceSource: VoiceSource | null = null;
    if (source?.video && source.clipWindow) {
      const key = `${source.video.bucket}/${source.video.path}`;
      if (!videos.has(key)) {
        const path = join(ports.workDir, `source-${videos.size}`);
        try {
          await ports.storage.download(
            source.video,
            path,
            SOURCE_VIDEO_MAX_BYTES,
          );
          videos.set(key, path);
        } catch {
          // Too big or gone: the saved clip has the same words.
          videos.set(key, null);
        }
      }
      const path = videos.get(key);
      if (path)
        voiceSource = {
          kind: "video",
          path,
          fromSeconds: source.clipWindow.fromSeconds,
          toSeconds: source.clipWindow.toSeconds,
        };
    }
    if (!voiceSource && product.clip) {
      const path = join(ports.workDir, `clip-${product.productId}.mp4`);
      try {
        await ports.storage.download(product.clip, path, CLIP_MAX_BYTES);
        voiceSource = { kind: "clip", path };
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    if (voiceSource)
      clips.push({ productId: product.productId, source: voiceSource });
  }
  if (clips.length === 0) return voices;

  const isolate = ports.isolate;
  const polished = await polishVoices(
    clips,
    isolate
      ? (wav, seconds) => {
          const costMicros = Math.max(
            ELEVENLABS_ISOLATION_MIN_MICROS,
            ports.isolationCostMicros(seconds),
          );
          return paid("voice", "elevenlabs", costMicros, async (onCost) => {
            try {
              return {
                value: await isolate(wav),
                costMicros: ports.isolationCostMicros(seconds),
              };
            } catch (error) {
              // A 2xx whose answer was lost still billed the audio.
              if (isElevenLabsSttAcceptedRequest(error))
                onCost(
                  ports.isolationCostMicros(seconds) / 1_000_000,
                  "voice isolation",
                );
              throw error;
            }
          });
        }
      : null,
    ports.workDir,
    {
      signal: ports.signal,
      pulse: ports.pulse,
      // The denoiser stepping in for the isolator is otherwise silent.
      onIsolatorSkipped: (reason, detail) =>
        ports.log?.("products.ad_voice_isolation_skipped", { reason, detail }),
    },
  );
  for (const voice of polished) {
    voices.set(voice.productId, voice.voice);
    const flac = await encodeFlac(
      voice.voice,
      ports.workDir,
      `voice-${voice.productId}`,
      {
        signal: ports.signal,
      },
    );
    await ports.storage.saveVoice(voice.productId, flac);
  }
  return voices;
}

const AD_MUSIC_SECONDS = 20;

const MUSIC_PROMPTS: Record<Exclude<ProductAdMusic, "none">, string> = {
  acoustic:
    "Warm, calm boutique instrumental background music for a product showcase reel, soft acoustic guitar, gentle piano and light rhythm, no vocals",
  upbeat:
    "Upbeat, modern lifestyle instrumental background music for a product showcase reel, warm lo-fi groove and light percussion, no vocals",
  piano:
    "Calm, elegant solo piano and soft warm strings instrumental background music for a boutique product showcase, gentle and modern, no vocals",
  cinematic:
    "Warm, inspiring cinematic instrumental background music for a product showcase reel, soft orchestral strings and gentle modern pulse, no vocals",
  festive:
    "Warm, uplifting festive instrumental background music for a gift shop reel, gentle acoustic guitar, soft bells and cheerful light rhythm, no vocals",
};

export function adMusicPrompt(
  ad: Pick<AdRecord, "idea" | "motion" | "music" | "products">,
): string {
  const style = productAdMusicOf(ad.music);
  if (style !== "none") return MUSIC_PROMPTS[style];
  const motion = productAdMotionOf(ad.motion);
  if (ad.idea.kind === "gift") return MUSIC_PROMPTS.festive;
  if (motion === "pop" || motion === "filmed_sold") return MUSIC_PROMPTS.upbeat;
  return MUSIC_PROMPTS.acoustic;
}

/**
 * The ad's instrumental background music: kept from an earlier run, or
 * generated once via ElevenLabs Music (booked in the ad's action on a make
 * run) and saved as FLAC for later renders. Any failure is logged and leaves
 * the ad without music so the video still finishes.
 */
async function adMusic(
  ports: AdJobPorts,
  ad: AdRecord,
  paid: PaidCall,
): Promise<Pcm | null> {
  const chosen = ad.music ? productAdMusicOf(ad.music) : null;
  if (chosen === "none") return null;
  const style: Exclude<ProductAdMusic, "none"> = chosen ?? "acoustic";
  const key = `music-${style}`;
  const keptPath = join(ports.workDir, `kept-${key}.flac`);
  try {
    if (await ports.storage.loadVoice(key, keptPath))
      return await decodeVoice(keptPath, ports.workDir, `kept-${key}`, {
        signal: ports.signal,
        pulse: ports.pulse,
      });
  } catch (error) {
    ports.log?.("products.ad_music_load_failed", { error: messageOf(error) });
  }
  if (!ports.music) return null;
  const generate = ports.music;
  const costMicros = ports.musicCostMicros
    ? ports.musicCostMicros(AD_MUSIC_SECONDS)
    : 20_000;
  const prompt = adMusicPrompt({ ...ad, music: style });
  try {
    const raw =
      ports.mode === "make"
        ? await paid(
            `music:${style}`,
            "elevenlabs",
            costMicros,
            async (onCost) => {
              try {
                return {
                  value: await generate(AD_MUSIC_SECONDS, prompt),
                  costMicros,
                };
              } catch (error) {
                if (isElevenLabsSttAcceptedRequest(error))
                  onCost(costMicros / 1_000_000, "background music");
                throw error;
              }
            },
          )
        : await generate(AD_MUSIC_SECONDS, prompt);
    const rawPath = join(ports.workDir, `${key}-raw.mp3`);
    await writeFile(rawPath, raw);
    const pcm = await decodeVoice(rawPath, ports.workDir, `${key}-decoded`, {
      signal: ports.signal,
      pulse: ports.pulse,
    });
    const flac = await encodeFlac(pcm, ports.workDir, key, {
      signal: ports.signal,
      pulse: ports.pulse,
    });
    await ports.storage.saveVoice(key, flac);
    return pcm;
  } catch (error) {
    ports.log?.("products.ad_music_skipped", { error: messageOf(error) });
    return null;
  }
}

/**
 * Each product's scene picture as saved, and the product's box in it:
 * Muse Image's when its scene passed the check, else the exact still; the
 * exact still also when the owner asked for their exact photo there
 * (`useExact`), with its own box (worked out from the cut-out for ads made
 * before it was kept). An exact still a run before this one never drew, or
 * that's gone, is drawn again and saved; a Muse Image picture that's gone
 * leaves the exact still.
 */
async function scenePictures(
  ports: AdJobPorts,
  products: Loaded[],
  scenes: Map<string, ProductAdStoredScene>,
  saveScenes: () => Promise<void>,
): Promise<
  Map<string, { image: Buffer; box: ProductAdBox | null; made: boolean }>
> {
  const pictures = new Map<
    string,
    { image: Buffer; box: ProductAdBox | null; made: boolean }
  >();
  let changed = false;
  for (const [index, { product, cutout }] of products.entries()) {
    let scene = scenes.get(product.productId);
    if (scene && scene.exactBox === undefined) {
      scene.exactBox = await exactSceneBox(cutout);
      changed = true;
    }
    const exactOnly = scene?.useExact === true;
    const muse = !exactOnly && scene?.method === "muse" ? scene.muse : null;
    for (const ref of [muse, scene?.exact ?? null]) {
      if (!ref) continue;
      const path = join(ports.workDir, `picture-${index}.jpg`);
      try {
        await ports.storage.download(ref, path, PHOTO_MAX_BYTES);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        continue;
      }
      if (ref !== muse && muse) {
        // Muse Image's picture is gone from storage: the exact still stands in.
        Object.assign(scene!, {
          muse: null,
          method: "exact",
          box: scene!.exactBox ?? null,
        });
        changed = true;
      }
      pictures.set(product.productId, {
        image: await readFile(path),
        box: ref === muse ? scene!.box : (scene!.exactBox ?? null),
        made: ref === muse,
      });
      break;
    }
    if (pictures.has(product.productId)) continue;
    const exact = await exactScene(cutout);
    const saved = await ports.storage.save({
      buffer: exact.image,
      mimeType: "image/jpeg",
      fileName: `exact-${product.productId}.jpg`,
      kind: "image",
    });
    scene = {
      ...scene,
      productId: product.productId,
      exact: saved,
      exactBox: exact.box,
      muse: null,
      method: "exact",
      check: scene?.check ?? null,
      box: exact.box,
      attempts: scene?.attempts ?? 0,
    };
    scenes.set(product.productId, scene);
    pictures.set(product.productId, {
      image: exact.image,
      box: exact.box,
      made: false,
    });
    changed = true;
  }
  if (changed) await saveScenes();
  return pictures;
}

/** The person from the video, only when the owner said they agreed; null on any trouble. */
async function presenterPhoto(
  ports: AdJobPorts,
  ad: AdRecord,
): Promise<Buffer | null> {
  const presenter = ad.presenter;
  if (!presenter?.use || !presenter.consentAt || !presenter.photo) return null;
  const path = join(ports.workDir, "presenter.png");
  try {
    await ports.storage.download(presenter.photo, path, PHOTO_MAX_BYTES);
    const photo = await readFile(path);
    // A cut-out with nothing opaque in it can't be shown.
    const { channels } = await sharp(photo).ensureAlpha().stats();
    return channels[3] && channels[3].max > 0 ? photo : null;
  } catch {
    return null;
  }
}

async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length && failure === null) {
        const item = items[next++]!;
        try {
          await run(item);
        } catch (error) {
          failure ??= error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failure !== null) throw failure;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Maps any error from a run to what the owner sees and whether to retry. */
export function classifyAdError(error: unknown): ProductAdFailure {
  if (error instanceof ProductAdFailure) return error;
  // The company turned AI off (a reservation, or the clone's own check):
  // by its code, as the web host's error crosses the ESM/CJS boundary.
  if (getWorkspaceAiRequiredDetails(error)?.code === "workspace_ai_disabled")
    return new ProductAdFailure(
      "ai_disabled",
      "AI is turned off for this company",
      false,
    );
  if (error instanceof AdTooBigError)
    return new ProductAdFailure("too_big", error.message, false);
  if (error instanceof AdSpendRefusal)
    return new ProductAdFailure(
      error.code === "workspace_ai_spend_limit"
        ? "spend_limit"
        : "ai_actions_used",
      error.message,
      false,
    );
  const spendCode = spendCodeOf(error);
  if (spendCode === "workspace_ai_spend_limit")
    return new ProductAdFailure("spend_limit", messageOf(error), false);
  if (spendCode === "own_ai_source_required")
    return new ProductAdFailure("ai_actions_used", messageOf(error), false);
  if (spendCode) return new ProductAdFailure("failed", messageOf(error), true);
  if (error instanceof MetaModelApiError)
    return new ProductAdFailure(
      "failed",
      error.message,
      isMetaModelApiTransientError(error),
    );
  return new ProductAdFailure("failed", messageOf(error), true);
}
