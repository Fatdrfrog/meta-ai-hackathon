import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isMetaModelApiTransientError,
  MetaModelApiError,
} from "@icecore/airi-runtime/meta-model-api";
import {
  PRODUCT_VIDEO_IMPORT_MAX_PHOTOS,
  PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS,
  PRODUCT_VIDEO_IMPORT_PHOTO_CONCURRENCY,
  PRODUCT_VIDEO_MAX_BYTES,
  type ProductDoubt,
  type ProductPhotoMethod,
  type ProductTextSource,
  type ProductVideoImportErrorCode,
  type ProductVideoImportPhotoStop,
  type ProductVideoImportStage,
} from "@icecore/temporal";
import sharp from "sharp";
import { cutOutProduct, type ProductCutout } from "./cutout";
import {
  inventoryChecks,
  inventoryMaxCostMicros,
  modelDoubtSubject,
  presentationWindows,
  readProductInventory,
  reviewClipWindow,
} from "./inventory";
import {
  extractReviewClip,
  prepareProductVideo,
  ProductVideoError,
} from "./media";
import { cutOutPresenter } from "./presenter";

// One product video import, start to finish, written against small ports so
// the Temporal activity supplies Mongo, storage, spend and realtime, and
// tests supply fakes. Every step is saved as it finishes (the transcript, the
// draft products, each option's photo, each product's review clip), so a
// retried run skips what is done and pays only for what isn't.

/** Videos larger than this aren't downloaded; phones film a few minutes in well under it. */
export const MAX_SOURCE_VIDEO_BYTES = PRODUCT_VIDEO_MAX_BYTES;
const THUMB_HEIGHT = 352;

// Spend reserved before each paid step, in micro-dollars, and settled with
// what it really cost. Each AI action's spend is capped at $0.50 on every
// plan, so an attempt's read steps (transcription, inventory, presenter) are
// sized to fit in their action together. A photo has an action of its own:
// about $0.06 of Muse, SAM and Muse Image calls, more when a restore is
// tried twice, so its three attempts fit too.
const ACTION_SPEND_LIMIT_MICROS = 500_000;
const PHOTO_MAX_COST_MICROS = 150_000;
// The presenter: one Muse Spark frame pick and one SAM image, about $0.01.
const PRESENTER_MAX_COST_MICROS = 50_000;
// ElevenLabs lists Scribe v2 at $0.22 an hour of audio.
const SCRIBE_MICROS_PER_SECOND = 220_000 / 3600;

/** Scribe's list price for this much narration, in micro-dollars. */
const transcriptionMicros = (seconds: number) =>
  Math.ceil(seconds * SCRIBE_MICROS_PER_SECOND);

export type StoredFileRef = { bucket: string; path: string };

/** A failure the run reports to the owner; `retryable` says whether trying again can help. */
export class ProductVideoImportFailure extends Error {
  readonly code: ProductVideoImportErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ProductVideoImportErrorCode,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "ProductVideoImportFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * A video sent to airi's own WhatsApp number: the stored message and its
 * WhatsApp media, which the job fetches itself.
 */
export type WhatsAppVideoRef = {
  sourceId: string;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  mediaId: string;
  mimeType: string | null;
};

export type ImportRecord = {
  status: "queued" | "processing" | "ready" | "failed";
  /** The video in the workspace's media; null for one sent on WhatsApp until it's copied there. */
  video: StoredFileRef | null;
  whatsapp: WhatsAppVideoRef | null;
  transcript: string | null;
  /** The language spoken, once the video was watched. */
  language: string | null;
  /** The person presenting the products, once the video was watched; null when no one does. */
  presenter: { momentSeconds: number; done: boolean } | null;
};

/** One of a product's options, as the photo step needs it. */
export type ImportOption = {
  /** Its place among the product's options. */
  index: number;
  /** English words that tell it apart, which the models are prompted with. */
  description: string;
  samPhrase: string;
  videoWindow: { fromSeconds: number; toSeconds: number };
  photoMethod: ProductPhotoMethod;
};

export type ClipWindow = { fromSeconds: number; toSeconds: number };

export type ImportProduct = {
  id: string;
  /** The catalog name in English. */
  englishName: string;
  options: ImportOption[];
  /** Its review clip's stretch of the video, and whether the clip is saved; null without one. */
  clip: (ClipWindow & { saved: boolean }) | null;
};

export type NewDraftOption = {
  description: string;
  samPhrase: string;
  videoWindow: { fromSeconds: number; toSeconds: number };
};

export type NewDraftProduct = {
  importIndex: number;
  name: string;
  englishName: string;
  nameSource: ProductTextSource;
  category: string;
  price: number | null;
  currency: string | null;
  priceQuote: string | null;
  priceSource: ProductTextSource | null;
  priceIsFrom: boolean;
  doubts: ProductDoubt[];
  options: NewDraftOption[];
  /** The option the shelf shows for the product. */
  featuredOption: number;
  /** The stretch of the video its review card plays, with the owner saying its price. */
  clip: ClipWindow | null;
};

export type ProductPhoto = {
  method: Exclude<ProductPhotoMethod, "pending">;
  cutout?: StoredFileRef;
  thumb?: StoredFileRef;
  original?: StoredFileRef;
  frameTimeSeconds?: number;
  /** Degrees the photo was turned to stand level, clockwise; 0 when it wasn't. */
  straightenedDegrees?: number;
};

/**
 * A unit of paid work, which the activity books to an AI action of its own:
 * the steps that read the video, or one option's photo.
 */
export type SpendUnit =
  | { kind: "read" }
  | { kind: "photo"; productId: string; optionIndex: number };

/** The workspace's AI allowance as the import checks it. */
export type SpendAllowance = {
  /** Null when the plan sets no number of included actions. */
  includedActions: number | null;
  remainingActions: number | null;
  spendLimitReached: boolean;
  /** A free company whose trial is over (or never started): it can't start AI actions. */
  trialEnded: boolean;
};

export type ImportJobPorts = {
  store: {
    loadImport(): Promise<ImportRecord | null>;
    updateImport(
      set: Record<string, unknown>,
      inc?: { photoDone?: number; costUsd?: number },
    ): Promise<void>;
    listProducts(): Promise<ImportProduct[]>;
    /** Adds the drafts after everything on the workspace's shelf; a retry adds none twice. */
    createProducts(drafts: NewDraftProduct[]): Promise<void>;
    savePhoto(
      productId: string,
      optionIndex: number,
      photo: ProductPhoto,
      notes: string[],
    ): Promise<void>;
    saveClip(productId: string, video: StoredFileRef): Promise<void>;
  };
  storage: {
    downloadVideo(video: StoredFileRef, destination: string): Promise<void>;
    /** Fetches a video sent on WhatsApp to `destination`, and keeps a copy in the workspace's media. */
    fetchWhatsAppVideo(
      video: WhatsAppVideoRef,
      destination: string,
    ): Promise<StoredFileRef>;
    savePhoto(
      productId: string,
      file: { buffer: Buffer; mimeType: string; fileName: string },
    ): Promise<StoredFileRef>;
    savePresenterPhoto(file: {
      buffer: Buffer;
      mimeType: string;
      fileName: string;
    }): Promise<StoredFileRef>;
    saveClip(
      productId: string,
      file: { buffer: Buffer; mimeType: string; fileName: string },
    ): Promise<StoredFileRef>;
  };
  /**
   * The workspace's AI spend ledger. airi always pays: Meta's models and its
   * ElevenLabs key have no customer equivalent.
   */
  spend: {
    /** The allowance as projected now, without admitting an action. */
    allowance(): Promise<SpendAllowance>;
    /** Throws the ledger's refusal when the unit can't spend `maxCostMicros`. */
    reserve(
      unit: SpendUnit,
      operationId: string,
      provider: "meta" | "elevenlabs",
      maxCostMicros: number,
    ): Promise<unknown>;
    /** null when the cost is unknown: the reservation is then kept. */
    settle(
      reservation: unknown,
      actualCostMicros: number | null,
    ): Promise<void>;
  };
  /** The narration as timed lines, from the MP3 the run prepared. */
  transcribe(audioPath: string): Promise<string>;
  emit(
    reason: "import" | "products_found" | "photo",
    productId?: string,
  ): Promise<void>;
  pulse(): void;
  signal?: AbortSignal;
  /** The activity's attempt, so each retry reserves its own spend. */
  attempt: number;
  workDir: string;
  prepare?: typeof prepareProductVideo;
  readInventory?: typeof readProductInventory;
  cutOut?: typeof cutOutProduct;
  cutOutPresenter?: typeof cutOutPresenter;
  extractClip?: typeof extractReviewClip;
};

export async function runProductVideoImport(
  ports: ImportJobPorts,
): Promise<{ productCount: number }> {
  const { store } = ports;
  const job = await store.loadImport();
  if (!job)
    throw new ProductVideoImportFailure(
      "failed",
      "The import no longer exists",
      false,
    );
  if (job.status === "ready") {
    return { productCount: (await store.listProducts()).length };
  }
  let products = await store.listProducts();
  // A video the workspace can't pay to read isn't even downloaded. Once its
  // products are found, running out only leaves photos unmade.
  if (products.length === 0) {
    const blocked = blockedBy(await ports.spend.allowance());
    if (blocked) throw spendFailure(blocked);
  }
  const stage = async (next: ProductVideoImportStage | null, extra = {}) => {
    await store.updateImport({ stage: next, ...extra });
    await ports.emit("import");
  };
  // An earlier attempt's photo stop no longer holds: this one tries again.
  await stage("preparing", { status: "processing", photosStopped: null });

  const sourcePath = join(ports.workDir, "source");
  if (job.video) {
    try {
      await ports.storage.downloadVideo(job.video, sourcePath);
    } catch (error) {
      throw new ProductVideoImportFailure(
        "video_missing",
        `The uploaded video couldn't be read from storage: ${messageOf(error)}`,
        false,
      );
    }
  } else if (job.whatsapp) {
    // The first run copies it into the workspace's media, so a retry reads it
    // there; WhatsApp keeps media for a limited time.
    let video: StoredFileRef;
    try {
      video = await ports.storage.fetchWhatsAppVideo(job.whatsapp, sourcePath);
    } catch (error) {
      throw new ProductVideoImportFailure(
        "video_missing",
        `The video couldn't be fetched from WhatsApp: ${messageOf(error)}`,
        true,
      );
    }
    await store.updateImport({ video });
  } else {
    throw new ProductVideoImportFailure(
      "video_missing",
      "The import has no video",
      false,
    );
  }
  const prepared = await (ports.prepare ?? prepareProductVideo)(
    sourcePath,
    join(ports.workDir, "prepared"),
    { signal: ports.signal, pulse: ports.pulse },
  );

  // What this attempt's read steps have committed in their action.
  let readCommitted = 0;
  const read = async <T>(
    operation: string,
    provider: "meta" | "elevenlabs",
    maxCostMicros: number,
    step: PaidStep<T>,
  ): Promise<T> => {
    try {
      const done = await withSpend(
        ports,
        { kind: "read" },
        operation,
        provider,
        maxCostMicros,
        step,
      );
      readCommitted += done.costMicros;
      return done.value;
    } catch (error) {
      if (!(error instanceof SpendRefusal)) throw error;
      // Without the transcript and the products there is nothing to show.
      throw await readRefusalFailure(
        ports,
        error,
        readCommitted + maxCostMicros > ACTION_SPEND_LIMIT_MICROS,
      );
    }
  };

  let transcript = job.transcript;
  if (transcript === null) {
    await stage("listening");
    const audioPath = prepared.audioPath;
    transcript = audioPath
      ? await read(
          "transcription",
          "elevenlabs",
          // By the minute started, a little more than the narration's length.
          transcriptionMicros(Math.ceil(prepared.durationSeconds / 60) * 60),
          async () => ({
            value: await ports.transcribe(audioPath),
            costMicros: transcriptionMicros(prepared.durationSeconds),
          }),
        )
      : "";
    await store.updateImport({ transcript });
  }

  let presenter = job.presenter;
  let language = job.language;
  if (products.length === 0) {
    await stage("watching");
    const inventory = await read(
      "inventory",
      "meta",
      // Leaving room in the action for the presenter.
      Math.min(
        inventoryMaxCostMicros(prepared.durationSeconds),
        ACTION_SPEND_LIMIT_MICROS - readCommitted - PRESENTER_MAX_COST_MICROS,
      ),
      async (onCost) => ({
        value: await (ports.readInventory ?? readProductInventory)(
          { videoPath: prepared.videoPath, transcript: transcript ?? "" },
          { onCost, pulse: ports.pulse },
          { signal: ports.signal },
        ),
      }),
    );
    // Options past the photo cap are left out: the cap holds an import's cost.
    let photosLeft = PRODUCT_VIDEO_IMPORT_MAX_PHOTOS;
    const items = inventory.items
      .slice(0, PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS)
      .map((item) => {
        const options = item.options.slice(0, Math.max(0, photosLeft));
        photosLeft -= options.length;
        return {
          ...item,
          options,
          featuredOption:
            item.featuredOption < options.length ? item.featuredOption : 0,
        };
      });
    const checks = inventoryChecks(items, transcript ?? "");
    const windows = presentationWindows(
      items.flatMap((item) => item.options),
      prepared.durationSeconds,
    );
    let window = 0;
    // Saved before the products, so a retry that skips watching still knows.
    presenter = inventory.presenter && {
      momentSeconds: inventory.presenter.clearestMomentSeconds,
      done: false,
    };
    await store.updateImport({
      presenter: presenter && {
        momentSeconds: presenter.momentSeconds,
        photo: null,
      },
    });
    await store.createProducts(
      items.map((item, index) => ({
        importIndex: index,
        name: item.localName || item.name,
        englishName: item.name,
        nameSource: item.nameSource,
        category: item.category,
        price: item.price === null ? null : Math.round(item.price),
        currency: item.currency,
        priceQuote: item.priceQuote,
        priceSource: item.priceSource,
        priceIsFrom: item.priceIsFrom,
        // The model's doubt first, then our own checks, which are all about
        // the price.
        doubts: [
          ...(item.doubt
            ? [{ about: modelDoubtSubject(item.doubt), text: item.doubt }]
            : []),
          ...(checks[index] ?? []).map((text) => ({
            about: "price" as const,
            text,
          })),
        ],
        options: item.options.map((option) => ({
          description: option.description,
          samPhrase: option.samPhrase,
          videoWindow: windows[window++]!,
        })),
        featuredOption: item.featuredOption,
        clip: reviewClipWindow(
          item,
          transcript ?? "",
          prepared.durationSeconds,
        ),
      })),
    );
    products = await store.listProducts();
    language = inventory.language || null;
    await store.updateImport({
      language,
      productTotal: products.length,
      photoTotal: products.reduce(
        (total, product) => total + product.options.length,
        0,
      ),
    });
    await ports.emit("products_found");
  }

  await stage("cutting");
  const pending = products.flatMap((product) =>
    product.options
      .filter((option) => option.photoMethod === "pending")
      .map((option) => ({ product, option })),
  );
  const refused = await cutPhotos(ports, prepared.videoPath, pending, language);
  // The products are kept either way; the photos not made stay pending.
  const photosStopped = refused && (await refusalStop(ports, refused));
  if (photosStopped) {
    // Said now, so the page stops showing photos being made while the
    // clips are cut.
    await store.updateImport({ photosStopped });
    await ports.emit("import");
  }
  for (const { id, clip } of products) {
    if (clip && !clip.saved)
      await cutAndSaveClip(ports, prepared, sourcePath, id, {
        fromSeconds: clip.fromSeconds,
        toSeconds: clip.toSeconds,
      });
  }
  // The presenter costs AI too: once photos stopped, it waits for a later run.
  if (presenter && !presenter.done && !photosStopped) {
    await cutAndSavePresenter(ports, prepared, presenter.momentSeconds);
  }

  await store.updateImport({
    status: "ready",
    stage: null,
    productCount: products.length,
    finishedAt: new Date(),
    photosStopped,
  });
  await ports.emit("import");
  return { productCount: products.length };
}

/**
 * Makes the options' photos a few at a time, each booked to its own AI
 * action. Once the ledger refuses one, no new photo starts and those being
 * made finish; the refusal is returned.
 */
async function cutPhotos(
  ports: ImportJobPorts,
  videoPath: string,
  pending: Array<{ product: ImportProduct; option: ImportOption }>,
  language: string | null,
): Promise<SpendRefusal | null> {
  let refused: SpendRefusal | null = null;
  // The photos reserve one at a time. At the company's limit the ledger
  // admits a photo's action, counting an included action, before refusing
  // its spend: after the first refusal, the photos waiting their turn are
  // refused here instead.
  let turn: Promise<unknown> = Promise.resolve();
  let ledgerRefusal: unknown = null;
  const photoPorts: ImportJobPorts = {
    ...ports,
    spend: {
      ...ports.spend,
      reserve(...args) {
        const reservation = turn.then(async () => {
          if (ledgerRefusal) throw ledgerRefusal;
          try {
            return await ports.spend.reserve(...args);
          } catch (error) {
            if (isRefusalCode(spendCodeOf(error))) ledgerRefusal = error;
            throw error;
          }
        });
        turn = reservation.catch(() => undefined);
        return reservation;
      },
    },
  };
  await forEachWithConcurrency(
    pending,
    PRODUCT_VIDEO_IMPORT_PHOTO_CONCURRENCY,
    async ({ product, option }) => {
      if (refused) return;
      try {
        await cutAndSave(photoPorts, videoPath, product, option, language);
      } catch (error) {
        if (!(error instanceof SpendRefusal)) throw error;
        refused ??= error;
      }
    },
  );
  return refused;
}

async function cutAndSave(
  ports: ImportJobPorts,
  videoPath: string,
  product: ImportProduct,
  option: ImportOption,
  language: string | null,
): Promise<void> {
  let cutout: ProductCutout;
  try {
    ({ value: cutout } = await withSpend(
      ports,
      { kind: "photo", productId: product.id, optionIndex: option.index },
      "photo",
      "meta",
      PHOTO_MAX_COST_MICROS,
      async (onCost) => ({
        value: await (ports.cutOut ?? cutOutProduct)(
          {
            videoPath,
            window: option.videoWindow,
            name: option.description || product.englishName,
            samPhrase: option.samPhrase,
            language,
            workDir: join(
              ports.workDir,
              "products",
              product.id,
              String(option.index),
            ),
          },
          { onCost, pulse: ports.pulse, signal: ports.signal },
          { signal: ports.signal },
        ),
      }),
    ));
  } catch (error) {
    // A problem with this one option (no frames in its stretch, a model
    // answer that will fail the same way again): the others carry on, and the
    // owner sees why it has no photo.
    if (!isPermanentProductError(error)) throw error;
    await ports.store.savePhoto(product.id, option.index, { method: "none" }, [
      "The photo couldn't be made from the video.",
    ]);
    await ports.store.updateImport({}, { photoDone: 1 });
    await ports.emit("photo", product.id);
    return;
  }

  const save = (buffer: Buffer, mimeType: string, name: string) =>
    ports.storage.savePhoto(product.id, {
      buffer,
      mimeType,
      fileName: `option-${option.index}-${name}`,
    });
  const photo: ProductPhoto = {
    method: cutout.method,
    original: await save(
      await readFile(cutout.originalPath),
      "image/jpeg",
      "original.jpg",
    ),
    frameTimeSeconds: cutout.frameTimeSeconds,
    straightenedDegrees: cutout.straightenedDegrees,
  };
  const shelfSource = cutout.cutoutPath
    ? await readFile(cutout.cutoutPath)
    : await readFile(cutout.originalPath);
  if (cutout.cutoutPath) {
    photo.cutout = await save(shelfSource, "image/png", "cutout.png");
  }
  photo.thumb = await save(
    await smallCopy(shelfSource),
    "image/webp",
    "thumb.webp",
  );
  await ports.store.savePhoto(product.id, option.index, photo, cutout.notes);
  await ports.store.updateImport({}, { photoDone: 1 });
  await ports.emit("photo", product.id);
}

/**
 * Cuts a product's review clip, with the owner's own voice, and saves it. A
 * clip ffmpeg can't make leaves the card without one rather than failing
 * the import; anything else is thrown, for a retry.
 */
async function cutAndSaveClip(
  ports: ImportJobPorts,
  prepared: { videoPath: string; audioPath: string | null },
  sourcePath: string,
  productId: string,
  window: ClipWindow,
): Promise<void> {
  const clipPath = join(ports.workDir, "clips", `${productId}.mp4`);
  try {
    await (ports.extractClip ?? extractReviewClip)(
      {
        videoPath: prepared.videoPath,
        soundPath: prepared.audioPath ? sourcePath : null,
      },
      window,
      clipPath,
      { signal: ports.signal, pulse: ports.pulse },
    );
  } catch (error) {
    if (!/exited with code/.test(messageOf(error))) throw error;
    return;
  }
  const video = await ports.storage.saveClip(productId, {
    buffer: await readFile(clipPath),
    mimeType: "video/mp4",
    fileName: "clip.mp4",
  });
  await ports.store.saveClip(productId, video);
}

/** The WebP copy the shelf and lists show, about twice its display height. */
function smallCopy(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .resize({ height: THUMB_HEIGHT, withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 90 })
    .toBuffer();
}

/**
 * Cuts out the person presenting the products and saves them on the import.
 * They're an extra: when they can't be cut out, the import goes on without
 * them rather than failing, and when the ledger refuses their spend, they're
 * left for a later run.
 */
async function cutAndSavePresenter(
  ports: ImportJobPorts,
  prepared: { videoPath: string; durationSeconds: number },
  momentSeconds: number,
): Promise<void> {
  let cutout: Awaited<ReturnType<typeof cutOutPresenter>>;
  try {
    ({ value: cutout } = await withSpend(
      ports,
      { kind: "read" },
      "presenter",
      "meta",
      PRESENTER_MAX_COST_MICROS,
      async (onCost) => ({
        value: await (ports.cutOutPresenter ?? cutOutPresenter)(
          {
            videoPath: prepared.videoPath,
            momentSeconds,
            durationSeconds: prepared.durationSeconds,
            workDir: join(ports.workDir, "presenter"),
          },
          { onCost, pulse: ports.pulse, signal: ports.signal },
          { signal: ports.signal },
        ),
      }),
    ));
  } catch (error) {
    if (error instanceof SpendRefusal) return;
    if (!isPermanentProductError(error)) throw error;
    cutout = null;
  }
  if (!cutout) {
    await ports.store.updateImport({ presenter: null });
    return;
  }
  const png = await readFile(cutout.cutoutPath);
  const save = (buffer: Buffer, mimeType: string, fileName: string) =>
    ports.storage.savePresenterPhoto({ buffer, mimeType, fileName });
  const photo = {
    original: await save(
      await readFile(cutout.originalPath),
      "image/jpeg",
      "original.jpg",
    ),
    cutout: await save(png, "image/png", "cutout.png"),
    thumb: await save(await smallCopy(png), "image/webp", "thumb.webp"),
    frameTimeSeconds: cutout.frameTimeSeconds,
  };
  await ports.store.updateImport({ presenter: { momentSeconds, photo } });
  await ports.emit("import");
}

function isPermanentProductError(error: unknown): boolean {
  if (error instanceof ProductVideoError) return true;
  return (
    error instanceof MetaModelApiError &&
    !error.info.transient &&
    error.info.kind === "invalid_request"
  );
}

const SPEND_ERROR_CODES = [
  "workspace_ai_spend_limit",
  "own_ai_source_required",
  "workspace_ai_policy_unavailable",
  "workspace_ai_operation_replayed",
] as const;

/** The AI spend ledger's code for an error, from the ledger itself or the web's allowance check. */
function spendCodeOf(
  error: unknown,
): (typeof SPEND_ERROR_CODES)[number] | null {
  const code = error instanceof Error && "code" in error ? error.code : null;
  return (SPEND_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as (typeof SPEND_ERROR_CODES)[number])
    : null;
}

/** The ledger's codes for a reservation it refused, rather than couldn't check. */
const isRefusalCode = (
  code: (typeof SPEND_ERROR_CODES)[number] | null,
): code is "workspace_ai_spend_limit" | "own_ai_source_required" =>
  code === "workspace_ai_spend_limit" || code === "own_ai_source_required";

/**
 * The ledger refused a reservation: it would pass the company's spending
 * limit or the action's cap, or the action wasn't admitted
 * (own_ai_source_required), since the workspace can't pay for AI now.
 */
class SpendRefusal extends Error {
  constructor(
    readonly code: "workspace_ai_spend_limit" | "own_ai_source_required",
  ) {
    super(`The AI spend ledger refused a reservation (${code})`);
    this.name = "SpendRefusal";
  }
}

/**
 * What stops the workspace paying for AI now, by its projected allowance;
 * null when nothing does. The limit is named first, as it stops every plan.
 */
function blockedBy(
  allowance: SpendAllowance,
): ProductVideoImportPhotoStop | null {
  if (allowance.spendLimitReached) return "spend_limit";
  if (allowance.trialEnded) return "trial_ended";
  if (allowance.includedActions !== null && allowance.remainingActions === 0)
    return "ai_actions_used";
  return null;
}

const SPEND_FAILURES: Record<ProductVideoImportPhotoStop, string> = {
  spend_limit: "The company's AI spending limit was reached",
  ai_actions_used: "The plan's included AI actions are used up",
  trial_ended: "The company's free trial has ended",
};

function spendFailure(
  stop: ProductVideoImportPhotoStop,
): ProductVideoImportFailure {
  return new ProductVideoImportFailure(stop, SPEND_FAILURES[stop], false);
}

/**
 * What a refusal stopped on. Each action's reservations are sized to fit
 * under its cap, so a refused reservation is the company's limit. A refused
 * admission is the included actions running out or the free trial ending,
 * when the allowance says so now; otherwise it was the company's limit,
 * reached with reservations held then that may have settled lower since.
 */
async function refusalStop(
  ports: ImportJobPorts,
  refusal: SpendRefusal,
): Promise<ProductVideoImportPhotoStop> {
  if (refusal.code === "workspace_ai_spend_limit") return "spend_limit";
  return blockedBy(await ports.spend.allowance()) ?? "spend_limit";
}

/**
 * The failure for a read step the ledger refused. Its action is new for each
 * attempt and sized to fit the read steps, so its own cap refusing it is a
 * bug in that sizing, not the owner's limit.
 */
async function readRefusalFailure(
  ports: ImportJobPorts,
  refusal: SpendRefusal,
  overActionCap: boolean,
): Promise<ProductVideoImportFailure> {
  if (refusal.code === "workspace_ai_spend_limit" && overActionCap)
    return new ProductVideoImportFailure(
      "failed",
      "A read step's reservation passed its AI action's spend cap",
      false,
    );
  return spendFailure(await refusalStop(ports, refusal));
}

/**
 * Whether a failed step may have been billed for a request whose cost it
 * never reported: a model call that failed, was cut off or never answered.
 * A Muse answer that wasn't valid JSON was priced before it was read, a
 * missing key sends nothing, a request the provider answered with a 4xx was
 * turned away rather than run, and local steps (ffmpeg, frames, images) run
 * only between paid calls, never alongside one.
 */
function mayHaveUnreportedCost(error: unknown): boolean {
  const info = providerErrorInfo(error);
  if (info === null || info.code === "invalid_json" || info.kind === "config")
    return false;
  return !(
    typeof info.status === "number" &&
    info.status >= 400 &&
    info.status < 500
  );
}

type ProviderErrorInfo = {
  kind?: string;
  code?: string;
  status?: number;
  transient: boolean;
};

/** What a Meta or ElevenLabs error says about itself; null for any other error. */
function providerErrorInfo(error: unknown): ProviderErrorInfo | null {
  if (error instanceof MetaModelApiError) return error.info;
  // ElevenLabs errors carry the same `transient` flag.
  const info = error instanceof Error && "info" in error ? error.info : null;
  return info !== null &&
    typeof info === "object" &&
    typeof (info as { transient?: unknown }).transient === "boolean"
    ? (info as ProviderErrorInfo)
    : null;
}

const microsOf = (usd: number) => Math.round(usd * 1_000_000);

/** A paid step: it reports what its calls cost, or names its own cost. */
type PaidStep<T> = (
  onCost: (usd: number, what: string) => void,
) => Promise<{ value: T; costMicros?: number }>;

/**
 * Reserves spend for one paid step of `unit`, runs it, and settles what it
 * cost: the costs the step reported, or `costMicros` when it names its own,
 * overruns included, which the ledger keeps against the limits. A failed step
 * settles what it reported, unless it may have been billed for more: then the
 * cost is unknown and the whole reservation is kept. A refused reservation
 * throws a SpendRefusal.
 */
async function withSpend<T>(
  ports: ImportJobPorts,
  unit: SpendUnit,
  operation: string,
  provider: "meta" | "elevenlabs",
  maxCostMicros: number,
  step: PaidStep<T>,
): Promise<{ value: T; costMicros: number }> {
  let spentUsd = 0;
  let reservation: unknown;
  try {
    reservation = await ports.spend.reserve(
      unit,
      `${operation}:attempt-${ports.attempt}`,
      provider,
      maxCostMicros,
    );
  } catch (error) {
    const code = spendCodeOf(error);
    if (isRefusalCode(code)) throw new SpendRefusal(code);
    throw error;
  }
  let result: { value: T; costMicros?: number };
  try {
    result = await step((usd) => {
      spentUsd += usd;
    });
  } catch (error) {
    await ports.spend.settle(
      reservation,
      mayHaveUnreportedCost(error) ? null : microsOf(spentUsd),
    );
    if (provider === "meta" && spentUsd > 0)
      await ports.store.updateImport({}, { costUsd: spentUsd });
    throw error;
  }
  const costMicros = result.costMicros ?? microsOf(spentUsd);
  await ports.spend.settle(reservation, costMicros);
  if (provider === "meta" && spentUsd > 0)
    await ports.store.updateImport({}, { costUsd: spentUsd });
  return { value: result.value, costMicros };
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
          // Stop taking new products; the ones running finish and are saved.
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
export function classifyImportError(error: unknown): ProductVideoImportFailure {
  if (error instanceof ProductVideoImportFailure) return error;
  if (error instanceof ProductVideoError) {
    return new ProductVideoImportFailure(
      error.code === "video_too_long" ? "video_too_long" : "video_unreadable",
      error.message,
      false,
    );
  }
  // The run turns the ledger's refusals into stops and failures itself;
  // these are what else the ledger can answer, or a refusal it didn't expect.
  const spendCode = spendCodeOf(error);
  if (spendCode === "workspace_ai_spend_limit")
    return spendFailure("spend_limit");
  if (spendCode === "own_ai_source_required")
    return spendFailure("ai_actions_used");
  if (spendCode) {
    // The ledger couldn't be checked, or an operation was reserved twice,
    // which a retry's new operation ids don't repeat.
    return new ProductVideoImportFailure("failed", messageOf(error), true);
  }
  if (error instanceof MetaModelApiError) {
    return new ProductVideoImportFailure(
      "failed",
      error.message,
      isMetaModelApiTransientError(error),
    );
  }
  const info = providerErrorInfo(error);
  if (info) {
    return new ProductVideoImportFailure(
      "failed",
      messageOf(error),
      info.transient,
    );
  }
  return new ProductVideoImportFailure("failed", messageOf(error), true);
}
