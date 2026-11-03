import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isElevenLabsSttAcceptedRequest } from "@icecore/airi-runtime/elevenlabs-stt";
import {
  isMetaModelApiTransientError,
  MetaModelApiError,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import {
  productAdShopName,
  type ProductAdErrorCode,
  type ProductAdFileRef,
  type ProductAdIdeaKind,
  type ProductAdMode,
  type ProductAdScript,
  type ProductAdStatus,
  type ProductAdStep,
  type ProductAdStills,
  type ProductAdStoredProduct,
  type ProductAdStoredScene,
  type ProductAdVoice,
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
import { alphaBox, composeStill, exactScene, priceCardLayers } from "./layers";
import { AD_FRAME } from "./layout";
import { AdTooBigError, posterFrame, renderAd } from "./render";
import {
  adScriptSchema,
  fallbackAdScript,
  saidAround,
  writeAdScript,
  type AdScript,
  type ScriptRequest,
} from "./script";
import {
  frameScene,
  makeMuseScene,
  SAM_MAX_COST_MICROS,
  type SceneDeps,
} from "./scenes";
import {
  adSpender,
  AdSpendRefusal,
  blockedBy,
  spendCodeOf,
  type AdSpendPort,
  type PaidCall,
} from "./spend";

// One run of a video ad, start to finish, written against small ports so the
// Temporal activity supplies Mongo, storage, the ledger and ElevenLabs, and
// tests supply fakes. "make" writes the script, draws the exact stills (so a
// result always exists), makes and checks each Muse Image scene, frames them
// with SAM, polishes the owner's words and renders; every step is saved as it
// finishes, so a retried run skips what's done and pays only for what isn't.
// "render" makes the video again from what's saved, after the owner edited
// the words: it calls no model and spends nothing.

/** A Muse Spark script call's reservation: about 5k tokens in, 2.5k out, with room. */
export const SCRIPT_MAX_COST_MICROS = 40_000;
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
  language: string | null;
  wordsCode: ProductShopWordsCode | null;
  idea: { kind: ProductAdIdeaKind; text: string | null };
  voice: ProductAdVoice;
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
  let script = ad.script;
  const scenes = new Map(
    ad.scenes.map((scene) => [scene.productId, { ...scene }]),
  );
  // Scene saves go one at a time, the latest state last.
  let sceneWrites: Promise<void> = Promise.resolve();
  const saveScenes = () => {
    const snapshot = ad.products
      .map((product) => scenes.get(product.productId))
      .filter(Boolean);
    sceneWrites = sceneWrites.then(() => update({ scenes: snapshot }));
    return sceneWrites;
  };

  if (ports.mode === "make") {
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
      scenes.set(product.productId, {
        productId: product.productId,
        exact: ref,
        muse: scene?.muse ?? null,
        method: scene?.method === "muse" && scene.muse ? "muse" : "exact",
        check: scene?.check ?? null,
        box: scene?.method === "muse" && scene.muse ? scene.box : exact.box,
        attempts: scene?.attempts ?? 0,
      });
    }
    await saveScenes();
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
        const setting =
          script!.scenes.find((entry) => entry.productId === productId)
            ?.setting ?? "oak_table_window";
        const outcome = await makeMuseScene(
          {
            productId,
            description:
              loaded.product.description ||
              loaded.product.englishName ||
              loaded.product.name,
            samPhrase: loaded.product.samPhrase,
            cutout: loaded.cutout,
            original: loaded.original,
          },
          setting,
          scene,
          {
            paid,
            save: async (next) => {
              scenes.set(productId, { ...next });
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
          },
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
      for (const { product, cutout } of unframed) {
        if (refused) break;
        const scene = scenes.get(product.productId)!;
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
        } catch (error) {
          if (error instanceof AdSpendRefusal) refused = true;
          else if (!(error instanceof MetaModelApiError)) throw error;
          // Without a box the scene is cut around its centre.
        }
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
  const voices =
    ad.voice === "own"
      ? await ownVoices(ports, ad, paid)
      : new Map<string, Pcm>();
  const pictures = await scenePictures(ports, products, scenes, saveScenes);
  const presenter = await presenterPhoto(ports, ad);
  const composed = await (ports.compose ?? composeAd)(
    {
      products: products.map(({ product, cutout }) => {
        const scene = scenes.get(product.productId)!;
        return {
          productId: product.productId,
          name: product.name,
          priceText: product.priceText,
          cutout,
          picture: pictures.get(product.productId)!,
          box: scene.box,
          caption:
            script!.scenes.find(
              (entry) => entry.productId === product.productId,
            )?.caption ?? "",
          voice: voices.get(product.productId) ?? null,
        };
      }),
      sticker: script.sticker,
      priceCardTitle: script.priceCardTitle,
      ending: script.ending,
      shopName: ad.ending.shopName,
      phone: ad.ending.phone,
      presenter,
      workDir: ports.workDir,
    },
    { signal: ports.signal, pulse: ports.pulse },
  );
  const videoPath = join(ports.workDir, "ad.mp4");
  const rendered = await (ports.render ?? renderAd)(composed.plan, videoPath, {
    signal: ports.signal,
    pulse: ports.pulse,
  });
  const posterPath = join(ports.workDir, "poster.jpg");
  await (ports.poster ?? posterFrame)(videoPath, posterPath, {
    signal: ports.signal,
  });
  const r = `r${ports.renderNo}`;
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
  await update({
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

/** A storage error for a file that isn't there. */
function isMissingFile(error: unknown): boolean {
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
            { onCost, pulse: ports.pulse },
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
 * The owner's polished words per product: kept from an earlier run, or, in
 * a "make" run, polished now (the Voice Isolator booked in the ad's action)
 * and kept. A "render" run never pays: a product without kept words is
 * silent.
 */
async function ownVoices(
  ports: AdJobPorts,
  ad: AdRecord,
  paid: PaidCall,
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
  if (ports.mode === "render" || missing.length === 0) return voices;

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

/**
 * Each product's scene picture as saved: Muse Image's when its scene passed
 * the check, else the exact still, which is drawn again (and saved) if a
 * run before this one never got to it.
 */
async function scenePictures(
  ports: AdJobPorts,
  products: Loaded[],
  scenes: Map<string, ProductAdStoredScene>,
  saveScenes: () => Promise<void>,
): Promise<Map<string, Buffer>> {
  const pictures = new Map<string, Buffer>();
  let changed = false;
  for (const [index, { product, cutout }] of products.entries()) {
    let scene = scenes.get(product.productId);
    const ref =
      scene?.method === "muse" && scene.muse ? scene.muse : scene?.exact;
    if (ref) {
      const path = join(ports.workDir, `picture-${index}.jpg`);
      try {
        await ports.storage.download(ref, path, PHOTO_MAX_BYTES);
        pictures.set(product.productId, await readFile(path));
        continue;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    const exact = await exactScene(cutout);
    const saved = await ports.storage.save({
      buffer: exact.image,
      mimeType: "image/jpeg",
      fileName: `exact-${product.productId}.jpg`,
      kind: "image",
    });
    scene = {
      productId: product.productId,
      exact: saved,
      muse: null,
      method: "exact",
      check: scene?.check ?? null,
      box: exact.box,
      attempts: scene?.attempts ?? 0,
    };
    scenes.set(product.productId, scene);
    pictures.set(product.productId, exact.image);
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
