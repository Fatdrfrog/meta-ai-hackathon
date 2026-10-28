// Products is English-only for now, so its copy lives here rather than in the
// en/ru/kz catalogs, whose checks require every locale. Moving it into the
// catalogs later is mechanical: every string the section shows is in this file.

import { PRODUCT_VIDEO_MAX_BYTES, PRODUCT_VIDEO_MAX_SECONDS } from "./types";

const MAX_MINUTES = Math.round(PRODUCT_VIDEO_MAX_SECONDS / 60);
const MAX_GB = Math.round(PRODUCT_VIDEO_MAX_BYTES / 1024 ** 3);
const shorter = `The video is longer than ${MAX_MINUTES} minutes. Film a shorter one and upload it.`;

export const PRODUCTS_COPY = {
  navLabel: "Products",
  title: "Products",
  loading: "Loading products…",
  loadError: "Products couldn't be loaded.",
  retry: "Retry",
  noPrice: "No price yet",
  emptyTitle: "Your products will appear here",
  emptyDescription:
    "Film your shelf on your phone and say each product's name and price. Airi turns the video into products for you to check.",

  // Adding products from a video.
  uploadVideo: "Upload a video",
  uploadHint: `MP4 or MOV, up to ${MAX_MINUTES} minutes`,
  dropVideo: "Drop the video to add its products",
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
  readyToCheck: (count: number) =>
    count === 1
      ? "1 product found. Check it before it goes on your shelf."
      : `${count} products found. Check them before they go on your shelf.`,
  nothingFound:
    "No products were found in this video. Film your shelf again, saying each product's name and price.",
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
    failed: "Something went wrong while reading this video. Upload it again.",
  },
} as const;
