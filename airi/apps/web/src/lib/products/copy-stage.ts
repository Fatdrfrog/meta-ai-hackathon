// Adding products from a video: the upload, the import's stage and rows, and
// why one failed. Part of PRODUCTS_COPY (copy.ts). The WhatsApp intake sends
// nothingFound, photosStopped and importErrors to owners as they are.

import {
  PRODUCT_VIDEO_MAX_BYTES,
  PRODUCT_VIDEO_MAX_SECONDS,
  type ProductVideoImportErrorCode,
  type ProductVideoImportPhotoStop,
} from "./types";

const MAX_MINUTES = Math.round(PRODUCT_VIDEO_MAX_SECONDS / 60);
const MAX_GB = Math.round(PRODUCT_VIDEO_MAX_BYTES / 1024 ** 3);
const shorter = `The video is longer than ${MAX_MINUTES} minutes. Film a shorter one and upload it.`;
// A model's name never breaks across lines.
const unbroken = (name: string) => name.replace(/ /g, " ");

export const STAGE_COPY = {
  cancel: "Cancel",
  dismiss: "Dismiss",
  tryAgain: "Try again",
  uploading: "Uploading your video",
  queued: "Getting ready to read your video",
  stages: {
    preparing: "Preparing your video",
    listening: "Listening to what you said",
    watching: "Finding your products",
    cutting: "Making photos",
  },
  photosMade: (done: number, total: number) => `${done} of ${total}`,
  found: "Found in your video",
  foundNote: "Not on your shelf until you check them.",
  readyToCheck: (count: number) =>
    count === 1
      ? "1 product found. Check it before it goes on your shelf."
      : `${count} products found. Check them before they go on your shelf.`,
  nothingFound:
    "No products were found in this video. Film your shelf again, saying each product's name and price, with the currency at least once.",
  // Why some photos weren't made, when the import still found its products.
  photosStopped: (
    stop: ProductVideoImportPhotoStop,
    missing: number,
    total: number
  ) => {
    const why =
      stop === "spend_limit"
        ? "your company's AI spending limit was reached"
        : stop === "trial_ended"
          ? "your free trial has ended"
          : "your plan's included AI actions are used up";
    if (missing >= total) return `No photos were made because ${why}.`;
    return missing === 1
      ? `1 photo wasn't made because ${why}.`
      : `${missing} photos weren't made because ${why}.`;
  },
  checkProducts: "Check products",

  // The stage a video's import plays on: the video's first frame, each step
  // with the model doing it, and what the owner said, product by product.
  // The model names appear only on the steps and the ledger's credit.
  stage: {
    // What a running import is doing, under the step's name; then that the
    // owner needn't wait for it.
    doing: {
      queued: "Your video is next in line.",
      preparing: "Getting your video ready to read.",
      resuming: "The products and photos already made are kept.",
      listening: "Writing down each name and price you said.",
      watching: "Spotting each product you showed.",
      cutting: "Cutting out each product and cleaning its photo.",
    },
    // While photos are made, the count says more than the doing line.
    photosDone: (done: number, total: number) =>
      total === 1
        ? `${done} of 1 photo is made.`
        : `${done} of ${total} photos are made.`,
    leave: "You can leave this page; your products keep coming.",
    keepOpen: "Keep this page open until it's uploaded.",
    resuming: "Picking up where it left off",
    // How long the import has taken: ticking while it runs, then in total.
    soFar: (time: string) => `${time} so far`,
    took: (time: string) => `Took ${time}`,
    // A finished import's title, and what the owner does next.
    foundTitle: (count: number) =>
      count === 1 ? "1 product found" : `${count} products found`,
    checkBefore: (count: number) =>
      count === 1
        ? "Check it before it goes on your shelf."
        : "Check them before they go on your shelf.",
    // The upload's progress: "42% · 18 of 43 MB".
    sent: (percent: number, amounts: string) => `${percent}% · ${amounts}`,
    // More found photos than the ready stage's strip shows.
    morePhotos: (count: number) => `+${count}`,
    uploadAgain: "Upload it again",
    stepsLabel: "How Airi turns your video into products",
    steps: {
      prepare: { label: "Prepare", maker: "Airi" },
      listen: { label: "Listen", maker: unbroken("ElevenLabs Scribe v2") },
      watch: { label: "Watch", maker: unbroken("Muse Spark 1.3") },
      photos: {
        label: "Make photos",
        maker: `${unbroken("Muse Spark")}, ${unbroken("SAM 3.1")} and ${unbroken("Muse Image 1.0")}`,
        // On a phone, the step's one line.
        short: `${unbroken("Muse Spark")}, ${unbroken("SAM 3.1")}, ${unbroken("Muse Image")}`,
      },
      check: { label: "Check", maker: "You" },
    },
    stepDone: "Done",
    stepStopped: "Stopped here",
    // "What you said": each product's own words, name, price and photo, as
    // Scribe heard them and Muse Spark priced them.
    ledger: {
      title: "What you said",
      credit: "Heard by Scribe, priced by Muse Spark",
      quote: (words: string) => `«${words}»`,
      // A price read from text in the video, which nobody said.
      onScreen: "Written on screen:",
      noPrice: "No price",
      photo: {
        made: "Photo made",
        making: "Making photo",
        waiting: "Next in line",
        unmade: "No photo",
        noView: "No clear view",
      },
      showAll: (count: number) => `Show all ${count}`,
      showFewer: "Show fewer",
    },
    // How a finished photo was made, by its method.
    trail: {
      restored:
        "Muse Spark found it, SAM 3.1 cut it out and Muse Image restored it.",
      filmed: "Muse Spark found it and SAM 3.1 cut it out as filmed.",
      none: "There was no clear view of it in the video.",
    },
    levelled: (degrees: number) => `Levelled ${degrees}°.`,
    at: (time: string) => `At ${time} in your video.`,
    checkPrice: "Check this price",
    // An import that failed after finding products: they're kept.
    stoppedAfter: (
      code: ProductVideoImportErrorCode,
      made: number,
      total: number
    ) => {
      const what =
        code === "spend_limit"
          ? "Airi reached an AI spending limit"
          : code === "ai_actions_used"
            ? "Your plan's included AI actions ran out"
            : code === "trial_ended"
              ? "Your free trial ended"
              : "Something went wrong";
      if (made <= 0) return `${what} before any photos were made.`;
      if (made >= total) return `${what} after the photos were made.`;
      return `${what} after ${made} of ${total} photos.`;
    },
    kept: "The products it found are kept for you to check.",
    checkFound: "Check what was found",
    otherVideos: "Other videos",
  },

  uploadErrors: {
    not_a_video: "That file isn't a video. Choose an MP4 or MOV.",
    too_big: `The video is larger than ${MAX_GB} GB. Film a shorter one and upload it.`,
    too_long: shorter,
    storage_full:
      "Your company's media storage is full. Delete some files in Assets, then try again.",
    upload_failed: "The video couldn't be uploaded. Try again.",
    connection:
      "The upload lost its connection. Check your internet and try again.",
    import_failed:
      "The video was uploaded, but reading it couldn't start. Try again.",
  },
  importErrors: {
    video_too_long: shorter,
    video_unreadable:
      "This video couldn't be read. Try an MP4 or MOV straight from your phone's camera.",
    video_missing: "The uploaded video went missing. Upload it again.",
    spend_limit:
      "Your company's AI spending limit has been reached, so this video couldn't be read.",
    ai_actions_used:
      "Your plan's included AI actions are used up, so this video couldn't be read.",
    trial_ended: "Your free trial has ended, so this video couldn't be read.",
    failed: "Something went wrong while reading this video. Upload it again.",
  },
} as const;
