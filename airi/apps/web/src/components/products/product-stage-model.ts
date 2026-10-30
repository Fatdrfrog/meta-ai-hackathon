// What an import's stage shows, worked out from the import and the products
// it found: no React and no requests, so every state can be tested alone.

import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_VIDEO_IMPORT_PHOTO_CONCURRENCY,
  type DraftProductRecord,
  type ProductPhotoMethod,
  type ProductVideoImportRecord,
  type ProductVideoImportStage,
} from "@/lib/products/types";

const COPY = PRODUCTS_COPY.stage;

type ImportState = Pick<
  ProductVideoImportRecord,
  | "status"
  | "stage"
  | "productTotal"
  | "photoTotal"
  | "photoDone"
  | "errorCode"
  | "photosStopped"
  | "draftsLeft"
>;

const isRunning = (record: Pick<ProductVideoImportRecord, "status">) =>
  record.status === "queued" || record.status === "processing";

/**
 * Where an import is. A worker retry starts again at preparing but keeps the
 * products and photos it has: that's resuming, not a fresh start.
 */
export type ImportPhase =
  | "queued"
  | "preparing"
  | "resuming"
  | "listening"
  | "watching"
  | "cutting"
  | "ready"
  | "nothing"
  | "failed";

export function importPhase(record: ImportState): ImportPhase {
  if (record.status === "queued") return "queued";
  if (record.status === "processing") {
    const stage = record.stage ?? "preparing";
    return stage === "preparing" && record.productTotal > 0
      ? "resuming"
      : stage;
  }
  if (record.status === "ready")
    return record.productTotal > 0 ? "ready" : "nothing";
  return "failed";
}

// Where each stage starts on an import's progress bar; making the photos
// takes the rest, about four fifths of the time on the test videos.
const STAGE_FROM: Record<ProductVideoImportStage, number> = {
  preparing: 2,
  listening: 6,
  watching: 12,
  cutting: 22,
};

/** How far an import has got, 0-100; it never goes back, even on a retry. */
export function importPercent(
  record: Pick<
    ProductVideoImportRecord,
    "status" | "stage" | "productTotal" | "photoDone" | "photoTotal"
  >
): number {
  if (record.status === "queued") return 1;
  if (record.status !== "processing") return 100;
  const stage = record.stage ?? "preparing";
  // Found products mean watching is over, whatever stage a retry reports.
  if (stage !== "cutting" && record.productTotal <= 0) return STAGE_FROM[stage];
  if (record.photoTotal <= 0) return STAGE_FROM.cutting;
  const done = Math.min(record.photoDone, record.photoTotal);
  return Math.round(
    STAGE_FROM.cutting + ((100 - STAGE_FROM.cutting) * done) / record.photoTotal
  );
}

/**
 * One option's photo. made: it has its method (it may have no files);
 * making: the job is on it now; waiting: next in line; unmade: the import
 * ended before it was made.
 */
export type StagePhotoState = "made" | "making" | "waiting" | "unmade";

export type StagePhoto = {
  /** productId:optionIndex, the way the job names a photo. */
  key: string;
  productId: string;
  optionIndex: number;
  /** The option the shelf shows for its product. */
  featured: boolean;
  name: string;
  price: number | null;
  priceIsFrom: boolean;
  /** The owner's words the price came from. */
  priceQuote: string | null;
  /** The few English words the models were given for it. */
  prompt: string;
  method: ProductPhotoMethod;
  state: StagePhotoState;
  imageUrl: string | null;
  originalUrl: string | null;
  momentSeconds: number | null;
  straightenedDegrees: number;
};

/**
 * Every option photo of an import, in the order filmed. The job makes the
 * pending ones a few at a time in this same order (by product, then option,
 * whatever each product's status), so the first few pending ones are the
 * ones being made while it cuts. Once its photos stopped, it only cuts the
 * review clips before it's ready: the photos left won't be made.
 */
export function stagePhotos(
  products: readonly DraftProductRecord[],
  record: ImportState
): StagePhoto[] {
  const making = isRunning(record) && !record.photosStopped;
  const cutting = record.status === "processing" && record.stage === "cutting";
  let inFlight = 0;
  return products.flatMap(product =>
    product.options.map((option, optionIndex): StagePhoto => {
      let state: StagePhotoState = "made";
      if (option.photoMethod === "pending") {
        if (!making) state = "unmade";
        else if (cutting && inFlight < PRODUCT_VIDEO_IMPORT_PHOTO_CONCURRENCY) {
          state = "making";
          inFlight++;
        } else state = "waiting";
      }
      return {
        key: `${product.id}:${optionIndex}`,
        productId: product.id,
        optionIndex,
        featured: optionIndex === product.featuredOption,
        name: product.name,
        price: product.price,
        priceIsFrom: product.priceIsFrom,
        priceQuote: product.priceQuote,
        prompt: option.description || product.englishName || "",
        method: option.photoMethod,
        state,
        imageUrl: option.imageUrl,
        originalUrl: option.originalUrl,
        momentSeconds: option.videoMomentSeconds,
        straightenedDegrees: option.straightenedDegrees,
      };
    })
  );
}

/** The last made photo with a picture, as filmed. */
export function latestMade(
  photos: readonly StagePhoto[],
  has: "imageUrl" | "originalUrl" = "imageUrl"
): StagePhoto | null {
  for (let index = photos.length - 1; index >= 0; index--) {
    const photo = photos[index]!;
    if (photo.state === "made" && photo[has]) return photo;
  }
  return null;
}

/**
 * The newest photo that wasn't made the last time they were seen. Photos
 * that land together can't be told apart in time, so the last filmed wins.
 */
export function newestLanded(
  seen: ReadonlySet<string>,
  photos: readonly StagePhoto[]
): StagePhoto | null {
  for (let index = photos.length - 1; index >= 0; index--) {
    const photo = photos[index]!;
    if (photo.state === "made" && photo.imageUrl && !seen.has(photo.key))
      return photo;
  }
  return null;
}

/** The keys of the photos made so far, as one comparable string. */
export const madeKeys = (photos: readonly StagePhoto[]) =>
  photos
    .filter(photo => photo.state === "made")
    .map(photo => photo.key)
    .join("\n");

/** h:mm:ss, or m:ss under an hour. */
export function formatElapsed(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const ss = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${ss}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${ss}`;
}

/** How a made photo came to be, for the line under it. */
export function photoTrail(
  photo: Pick<StagePhoto, "method" | "straightenedDegrees" | "momentSeconds">
): string {
  const parts: string[] = [
    photo.method === "restored"
      ? COPY.trail.restored
      : photo.method === "none"
        ? COPY.trail.none
        : COPY.trail.filmed,
  ];
  const degrees = Math.abs(Math.round(photo.straightenedDegrees));
  if (degrees > 0) parts.push(COPY.levelled(degrees));
  if (photo.momentSeconds !== null)
    parts.push(COPY.at(formatElapsed(photo.momentSeconds)));
  return parts.join(" ");
}

// Colours an item's description names, for the glow its photo develops in.
const AURA_COLORS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["oklch(0.45 0 0)", ["black", "charcoal"]],
  ["oklch(0.95 0.01 90)", ["white", "ivory", "cream", "milky"]],
  ["oklch(0.75 0 0)", ["grey", "gray", "silver", "metal"]],
  ["oklch(0.8 0.14 85)", ["gold", "golden", "brass"]],
  ["oklch(0.86 0.17 95)", ["yellow"]],
  ["oklch(0.75 0.17 55)", ["orange", "peach", "coral"]],
  ["oklch(0.6 0.22 25)", ["red", "burgundy"]],
  ["oklch(0.78 0.13 350)", ["pink", "rose", "magenta"]],
  ["oklch(0.62 0.18 305)", ["purple", "violet", "lilac"]],
  ["oklch(0.6 0.16 255)", ["blue", "navy"]],
  ["oklch(0.78 0.12 215)", ["sky", "cyan", "turquoise", "teal"]],
  ["oklch(0.7 0.16 150)", ["green", "olive", "mint", "khaki"]],
  [
    "oklch(0.55 0.08 55)",
    ["brown", "wood", "wooden", "leather", "tan", "beige"],
  ],
  ["oklch(0.88 0.03 220)", ["clear", "transparent", "glass", "frosted"]],
];
const COLOR_OF_WORD = new Map(
  AURA_COLORS.flatMap(([color, words]) =>
    words.map(word => [word, color] as const)
  )
);

/** The first two colours a description names, or airi's own without any. */
export function auraColors(
  text: string | null | undefined
): readonly [string, string] {
  const found: string[] = [];
  for (const word of text?.toLowerCase().match(/[a-z]+/g) ?? []) {
    const color = COLOR_OF_WORD.get(word);
    if (color && !found.includes(color)) found.push(color);
    if (found.length === 2) break;
  }
  const [first, second] = found;
  if (!first) return ["var(--primary)", "var(--airi-sky)"];
  return [first, second ?? `color-mix(in oklab, ${first} 55%, white)`];
}

/**
 * What a draft shows on the shelf. photo: its cut-out; print: a whole frame,
 * as there was no clear view; initial: its first letter, without a photo;
 * making, waiting and unmade as for its photo.
 */
export type ShelfPhotoState =
  | "photo"
  | "print"
  | "initial"
  | "making"
  | "waiting"
  | "unmade";

export type DraftShelfInfo = {
  photo: ShelfPhotoState;
  /** The words its photo is made from. */
  prompt: string | null;
  aura: readonly [string, string];
  priceDoubt: boolean;
};

/** Each product's place on its import's shelf, by product id. */
export function draftShelfInfo(
  products: readonly DraftProductRecord[],
  record: ImportState
): Map<string, DraftShelfInfo> {
  const photos = new Map(
    stagePhotos(products, record).map(photo => [photo.key, photo])
  );
  return new Map(
    products.map(product => {
      const option = product.options[product.featuredOption] ?? null;
      const photo = photos.get(`${product.id}:${product.featuredOption}`);
      let state: ShelfPhotoState;
      // No option: the import's photo cap left it out.
      if (!option || !photo) state = "initial";
      else if (photo.state !== "made") state = photo.state;
      else if (!product.imageUrl) state = "initial";
      else state = photo.method === "none" ? "print" : "photo";
      const prompt = option?.description || product.englishName || null;
      return [
        product.id,
        {
          photo: state,
          prompt,
          aura: auraColors(prompt),
          priceDoubt: product.doubts.some(doubt => doubt.about === "price"),
        },
      ];
    })
  );
}

/** The steps the stage's rail names, in order. */
export const STAGE_STEPS = [
  "prepare",
  "listen",
  "watch",
  "photos",
  "check",
] as const;
export type StageStep = (typeof STAGE_STEPS)[number];

const STEP_OF_STAGE: Record<ProductVideoImportStage, StageStep> = {
  preparing: "prepare",
  listening: "listen",
  watching: "watch",
  cutting: "photos",
};

// Errors about the video itself, which every attempt fetches and prepares
// before anything else.
const VIDEO_ERRORS: ReadonlyArray<string> = [
  "video_too_long",
  "video_unreadable",
  "video_missing",
];
// The AI allowance stopping an import. Only the spending limit ever stopped
// one after its products were found, before photos had actions of their own.
const SPEND_STOPS: ReadonlyArray<string> = [
  "spend_limit",
  "ai_actions_used",
  "trial_ended",
];
// Errors that stop an import before it finds anything: the video itself, or
// no AI to start with.
const BEFORE_PRODUCTS: ReadonlyArray<string> = [
  ...VIDEO_ERRORS,
  "ai_actions_used",
  "trial_ended",
];
const stoppedBeforeProducts = (record: ImportState) =>
  BEFORE_PRODUCTS.includes(record.errorCode ?? "");

/**
 * The rail's current step, and the one where photos or the import stopped.
 * A failure clears the stage, so the step it failed at is the last stage
 * seen or, without one, what its error and products tell.
 */
export function railState(
  record: ImportState,
  lastStage: ProductVideoImportStage | null,
  hasDrafts: boolean
): { current: StageStep; stopped: StageStep | null } {
  const phase = importPhase(record);
  switch (phase) {
    case "queued":
      return { current: "prepare", stopped: null };
    case "preparing":
    case "listening":
    case "watching":
    case "cutting":
      return { current: STEP_OF_STAGE[phase], stopped: null };
    case "resuming":
      return { current: "photos", stopped: null };
    case "ready":
    case "nothing":
      return {
        current: "check",
        stopped:
          record.photosStopped && record.photoDone < record.photoTotal
            ? "photos"
            : null,
      };
    case "failed": {
      const code = record.errorCode ?? "failed";
      // Without a stage seen and with nothing found, an AI allowance that
      // can't pay stopped it before its video was even fetched.
      const stopped: StageStep = VIDEO_ERRORS.includes(code)
        ? "prepare"
        : lastStage
          ? STEP_OF_STAGE[lastStage]
          : record.productTotal > 0
            ? "photos"
            : SPEND_STOPS.includes(code)
              ? "prepare"
              : "watch";
      return { current: hasDrafts ? "check" : stopped, stopped };
    }
  }
}

/** What the stage says, and which check it offers. */
export type StageText = {
  label: string;
  helper: string | null;
  alert: boolean;
  check: "products" | "found" | null;
};

/**
 * `drafts` is how many of its products are left to check, or null before
 * they load, when the import's list entry stands in.
 */
export function stageText(
  record: ImportState,
  drafts: number | null
): StageText {
  const hasDrafts = drafts === null ? record.draftsLeft : drafts > 0;
  const phase = importPhase(record);
  switch (phase) {
    case "queued":
    case "resuming":
    case "preparing":
    case "listening":
    case "watching":
    case "cutting":
      return {
        label:
          phase === "queued"
            ? PRODUCTS_COPY.queued
            : phase === "resuming"
              ? COPY.resuming
              : PRODUCTS_COPY.stages[phase],
        helper: COPY.doing[phase],
        alert: false,
        check: null,
      };
    case "nothing":
      return {
        label: PRODUCTS_COPY.nothingFound,
        helper: null,
        alert: false,
        check: null,
      };
    case "ready": {
      if (!hasDrafts)
        return {
          label: PRODUCTS_COPY.review.nothingLeft,
          helper: null,
          alert: false,
          check: null,
        };
      const missing = record.photoTotal - record.photoDone;
      return {
        label: PRODUCTS_COPY.readyToCheck(drafts ?? record.productTotal),
        helper:
          record.photosStopped && missing > 0
            ? PRODUCTS_COPY.photosStopped(
                record.photosStopped,
                missing,
                record.photoTotal
              )
            : null,
        alert: false,
        check: "products",
      };
    }
    case "failed": {
      const code = record.errorCode ?? "failed";
      // Where it stopped is told by what it found, however many of those
      // the owner has checked since; the video's own errors and an AI
      // allowance that couldn't start it stop it before anything is found.
      const found = record.productTotal > 0 && !stoppedBeforeProducts(record);
      // Products left to check are offered whatever stopped it, once they
      // load; until then, only when the error doesn't say none were found.
      const offer = drafts === null ? record.draftsLeft && found : drafts > 0;
      return {
        label: found
          ? COPY.stoppedAfter(code, record.photoDone, record.photoTotal)
          : PRODUCTS_COPY.importErrors[code],
        helper: offer ? COPY.kept : null,
        alert: true,
        check: offer ? "found" : null,
      };
    }
  }
}

/**
 * The import the page puts on its stage: the first one running, else the
 * first whose products are waiting to be checked. The rest are rows.
 */
export function pickHero<T extends ImportState>(
  imports: readonly T[]
): T | null {
  return (
    imports.find(isRunning) ??
    imports.find(
      record =>
        record.productTotal > 0 &&
        record.draftsLeft &&
        (record.status === "ready" || record.status === "failed")
    ) ??
    null
  );
}
