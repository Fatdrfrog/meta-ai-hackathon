import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isMetaModelApiTransientError,
  MetaModelApiError,
} from "@icecore/airi-runtime/meta-model-api";
import {
  PRODUCT_VIDEO_IMPORT_MAX_PHOTOS,
  PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS,
  PRODUCT_VIDEO_MAX_BYTES,
  type ProductDoubt,
  type ProductPhotoMethod,
  type ProductTextSource,
  type ProductVideoImportErrorCode,
  type ProductVideoImportStage,
} from "@icecore/temporal";
import sharp from "sharp";
import { cutOutProduct, type ProductCutout } from "./cutout";
import {
  inventoryChecks,
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

/** Photos made at once: each mostly waits on Meta's models. */
const CUT_CONCURRENCY = 4;
/** Videos larger than this aren't downloaded; phones film a few minutes in well under it. */
export const MAX_SOURCE_VIDEO_BYTES = PRODUCT_VIDEO_MAX_BYTES;
const THUMB_HEIGHT = 352;

// Spend reserved before each paid step, in micro-dollars, and settled with
// what it really cost. Inventory: one Muse Spark call over the whole video
// (about $0.04 for a minute). A photo: about $0.06 of Muse, SAM and Muse
// Image calls, more when a restore is tried twice. Transcription: the same
// flat amount conversation transcription reserves.
const INVENTORY_MAX_COST_MICROS = 300_000;
const PHOTO_MAX_COST_MICROS = 150_000;
const TRANSCRIPTION_MAX_COST_MICROS = 100_000;
// The presenter: one Muse Spark frame pick and one SAM image, about $0.01.
const PRESENTER_MAX_COST_MICROS = 50_000;

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
  /** Null where the workspace's AI isn't billed to airi, so nothing is reserved. */
  spend: {
    reserve(
      operationId: string,
      provider: "meta" | "elevenlabs",
      maxCostMicros: number,
    ): Promise<unknown>;
    settle(
      reservation: unknown,
      actualCostMicros: number | null,
    ): Promise<void>;
  } | null;
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
  const stage = async (next: ProductVideoImportStage | null, extra = {}) => {
    await store.updateImport({ stage: next, ...extra });
    await ports.emit("import");
  };
  await stage("preparing", { status: "processing" });

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

  let transcript = job.transcript;
  if (transcript === null) {
    await stage("listening");
    transcript = prepared.audioPath
      ? await withSpend(
          ports,
          "transcription",
          "elevenlabs",
          TRANSCRIPTION_MAX_COST_MICROS,
          // A flat reservation, settled whole, like conversation transcription.
          async () => ({
            value: await ports.transcribe(prepared.audioPath!),
            costMicros: TRANSCRIPTION_MAX_COST_MICROS,
          }),
        )
      : "";
    await store.updateImport({ transcript });
  }

  let presenter = job.presenter;
  let language = job.language;
  let products = await store.listProducts();
  if (products.length === 0) {
    await stage("watching");
    const inventory = await withSpend(
      ports,
      "inventory",
      "meta",
      INVENTORY_MAX_COST_MICROS,
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
  await forEachWithConcurrency(
    pending,
    CUT_CONCURRENCY,
    ({ product, option }) =>
      cutAndSave(ports, prepared.videoPath, product, option, language),
  );
  for (const { id, clip } of products) {
    if (clip && !clip.saved)
      await cutAndSaveClip(ports, prepared, sourcePath, id, {
        fromSeconds: clip.fromSeconds,
        toSeconds: clip.toSeconds,
      });
  }
  if (presenter && !presenter.done) {
    await cutAndSavePresenter(ports, prepared, presenter.momentSeconds);
  }

  await store.updateImport({
    status: "ready",
    stage: null,
    productCount: products.length,
    finishedAt: new Date(),
  });
  await ports.emit("import");
  return { productCount: products.length };
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
    cutout = await withSpend(
      ports,
      `photo:${product.id}:${option.index}`,
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
    );
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
 * them rather than failing.
 */
async function cutAndSavePresenter(
  ports: ImportJobPorts,
  prepared: { videoPath: string; durationSeconds: number },
  momentSeconds: number,
): Promise<void> {
  let cutout: Awaited<ReturnType<typeof cutOutPresenter>>;
  try {
    cutout = await withSpend(
      ports,
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
    );
  } catch (error) {
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

/**
 * Reserves spend for one paid step, runs it, and settles what it cost: the
 * costs the step reported, or `costMicros` when it names a flat amount. A
 * failed step settles as unknown, keeping the reservation, since it may have
 * been billed before it failed.
 */
async function withSpend<T>(
  ports: ImportJobPorts,
  operation: string,
  provider: "meta" | "elevenlabs",
  maxCostMicros: number,
  step: (
    onCost: (usd: number, what: string) => void,
  ) => Promise<{ value: T; costMicros?: number }>,
): Promise<T> {
  let spentUsd = 0;
  const reservation = ports.spend
    ? await ports.spend.reserve(
        `${operation}:attempt-${ports.attempt}`,
        provider,
        maxCostMicros,
      )
    : null;
  let result: { value: T; costMicros?: number };
  try {
    result = await step((usd) => {
      spentUsd += usd;
    });
  } catch (error) {
    if (reservation) await ports.spend!.settle(reservation, null);
    if (provider === "meta" && spentUsd > 0)
      await ports.store.updateImport({}, { costUsd: spentUsd });
    throw error;
  }
  const costMicros = result.costMicros ?? Math.round(spentUsd * 1_000_000);
  if (reservation)
    await ports.spend!.settle(reservation, Math.min(costMicros, maxCostMicros));
  if (provider === "meta" && spentUsd > 0)
    await ports.store.updateImport({}, { costUsd: spentUsd });
  return result.value;
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
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "workspace_ai_spend_limit"
  ) {
    return new ProductVideoImportFailure(
      "spend_limit",
      "The workspace's AI spend limit was reached",
      false,
    );
  }
  if (error instanceof MetaModelApiError) {
    return new ProductVideoImportFailure(
      "failed",
      error.message,
      isMetaModelApiTransientError(error),
    );
  }
  if (
    error instanceof Error &&
    "info" in error &&
    typeof (error as { info?: { transient?: unknown } }).info?.transient ===
      "boolean"
  ) {
    // ElevenLabs errors carry the same `transient` flag.
    return new ProductVideoImportFailure(
      "failed",
      error.message,
      (error as { info: { transient: boolean } }).info.transient,
    );
  }
  return new ProductVideoImportFailure("failed", messageOf(error), true);
}
