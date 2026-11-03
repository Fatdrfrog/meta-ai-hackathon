// What an import's stage shows, worked out from the import and the products
// it found: no React and no requests, so every state can be tested alone.

import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  formatProductPrice,
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
  /** The price's ISO currency code, as its product has it. */
  currency: string | null;
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
        currency: product.currency,
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
      return [
        product.id,
        {
          photo: state,
          prompt: option?.description || product.englishName || null,
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
 * What the stage and a row say about an import: a title, the lines under it,
 * and the check it offers. Making photos counts them; a finished import
 * names how many it found, then what to do with them.
 */
export type StageHead = {
  title: string;
  lines: string[];
  alert: boolean;
  check: StageText["check"];
};

export function stageHead(
  record: ImportState,
  drafts: number | null
): StageHead {
  const text = stageText(record, drafts);
  const phase = importPhase(record);
  const missing = record.photoTotal - record.photoDone;
  if (isRunning(record) && record.photosStopped && missing > 0)
    // Only the review clips are left: the photos stopped for good.
    return {
      title: text.label,
      lines: [
        PRODUCTS_COPY.photosStopped(
          record.photosStopped,
          missing,
          record.photoTotal
        ),
      ],
      alert: false,
      check: null,
    };
  if (phase === "cutting" && record.photoTotal > 0)
    return {
      title: text.label,
      lines: [
        COPY.photosDone(
          Math.min(record.photoDone, record.photoTotal),
          record.photoTotal
        ),
      ],
      alert: false,
      check: null,
    };
  if (phase === "ready" && text.check === "products") {
    const count = drafts ?? record.productTotal;
    return {
      title: COPY.foundTitle(count),
      lines: [COPY.checkBefore(count), ...(text.helper ? [text.helper] : [])],
      alert: false,
      check: "products",
    };
  }
  const [title, rest] = splitSentences(text.label);
  return {
    title,
    lines: [...(rest ? [rest] : []), ...(text.helper ? [text.helper] : [])],
    alert: text.alert,
    check: text.check,
  };
}

/**
 * A message's first sentence, which says what happened, and the rest, which
 * says what to do: "This video couldn't be read." and "Try an MP4 or MOV
 * straight from your phone's camera." A title stays short that way, and the
 * rest reads as the line under it. One sentence stands alone.
 */
export function splitSentences(text: string): [string, string | null] {
  // The copy is English: a sentence starts with a capital Latin letter.
  const match = /^([\s\S]+?[.!?])\s+([A-Z][\s\S]*)$/.exec(text);
  return match ? [match[1]!, match[2]!] : [text, null];
}

/**
 * What the steps say beside their names: how many photos are made on the
 * step making them, and, once a step is behind, what it came to.
 */
export function railNotes(
  record: ImportState,
  rail: { current: StageStep; stopped: StageStep | null }
): {
  counts: Partial<Record<StageStep, string>>;
  results: Partial<Record<StageStep, string>>;
} {
  const at = STAGE_STEPS.indexOf(rail.current);
  const counts: Partial<Record<StageStep, string>> = {};
  const results: Partial<Record<StageStep, string>> = {};
  if (record.productTotal > 0 && at > STAGE_STEPS.indexOf("watch"))
    results.watch = COPY.foundTitle(record.productTotal);
  if (record.photoTotal > 0) {
    const made = PRODUCTS_COPY.photosMade(
      Math.min(record.photoDone, record.photoTotal),
      record.photoTotal
    );
    if (rail.current === "photos") counts.photos = made;
    else if (rail.stopped === "photos" || at > STAGE_STEPS.indexOf("photos"))
      results.photos = made;
  }
  return { counts, results };
}

/** Where a product's photo is, as the ledger says it. */
export type LedgerPhoto = "made" | "making" | "waiting" | "unmade" | "noView";

/** One product in the stage's "What you said" ledger. */
export type LedgerRow = {
  key: string;
  /** Seconds into the video where its photo was taken. */
  moment: number | null;
  /** The owner's words the price came from. */
  quote: string | null;
  /** The words were read on screen, not heard. */
  onScreen: boolean;
  name: string;
  /** Its price as the shelf writes it; null without one. */
  price: string | null;
  priceDoubt: boolean;
  photo: LedgerPhoto;
};

/**
 * Each product an import found, in the order filmed: what the owner said,
 * the name and price the models made of it, and where its photo is. The
 * photo is the featured option's, the one the shelf shows.
 */
export function ledgerRows(
  products: readonly DraftProductRecord[],
  photos: readonly StagePhoto[]
): LedgerRow[] {
  const byKey = new Map(photos.map(photo => [photo.key, photo]));
  return products.map(product => {
    const photo = byKey.get(`${product.id}:${product.featuredOption}`);
    let state: LedgerPhoto = "unmade";
    if (photo && photo.state !== "made") state = photo.state;
    else if (photo?.method === "none") state = "noView";
    else if (photo?.imageUrl) state = "made";
    return {
      key: product.id,
      moment: photo?.momentSeconds ?? null,
      quote: product.priceQuote,
      onScreen:
        product.priceQuote !== null && product.priceSource === "on_screen",
      name: product.name,
      price:
        product.price === null
          ? null
          : formatProductPrice(product.price, {
              from: product.priceIsFrom,
              currency: product.currency,
            }),
      priceDoubt: product.doubts.some(doubt => doubt.about === "price"),
      photo: state,
    };
  });
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

// A size in the unit its whole fits: tenths below 10, whole numbers above.
function sizeIn(bytes: number, unit: number): string {
  const value = Math.max(0, bytes) / unit;
  return value < 10
    ? String(Math.round(value * 10) / 10)
    : String(Math.round(value));
}
const unitOf = (bytes: number): [number, string] =>
  bytes >= GB ? [GB, "GB"] : bytes >= MB ? [MB, "MB"] : [KB, "KB"];

/** A video's size: "43 MB", "4.5 MB", "1.2 GB". */
export function formatVideoSize(bytes: number): string {
  const [unit, name] = unitOf(bytes);
  return `${sizeIn(bytes, unit)} ${name}`;
}

/** How much of a video is sent, in the unit of its size: "18 of 43 MB". */
export function formatSentOf(sent: number, total: number): string {
  const [unit, name] = unitOf(total);
  return `${sizeIn(Math.min(sent, total), unit)} of ${sizeIn(total, unit)} ${name}`;
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
