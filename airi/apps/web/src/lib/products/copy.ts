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
  checkProducts: "Check products",

  // Checking what a video found, one card at a time.
  review: {
    title: "Check your products",
    back: "Products",
    acceptAll: (count: number) => `Accept all (${count})`,
    add: "Add to shelf",
    skip: "Skip",
    undo: "Undo",
    sound: "Play your voice on each card",
    hear: "Hear what you said",
    pause: "Pause",
    polished: "Polished",
    original: "Original",
    photo: "Photo",
    changeName: "Change the name",
    changePrice: "Change the price",
    priceInTenge: "Price in tenge",
    noPrice: "No price yet",
    chooseShown: "Choose the one your shelf shows",
    showOption: (description: string) => `Show ${description} on your shelf`,
    stampAdd: "Add",
    stampSkip: "Skip",
    added: (name: string) => `${name} added to your shelf.`,
    skipped: (name: string) => `${name} skipped.`,
    allAdded: (count: number) =>
      count === 1
        ? "1 product added to your shelf."
        : `${count} products added to your shelf.`,
    undone: "Undone.",
    saveFailed: "That change couldn't be saved, so it was undone. Try again.",
    loadFailed: "These products couldn't be loaded.",
    nothingLeft: "Nothing is left to check in this video.",
    done: (added: number) =>
      added === 0
        ? "Nothing was added to your shelf."
        : added === 1
          ? "1 product is on your shelf."
          : `${added} products are on your shelf.`,
    skippedCount: (skipped: number) =>
      skipped === 1 ? "1 skipped." : `${skipped} skipped.`,
    backToProducts: "Back to products",
  },

  // Sending shelf videos to Airi on WhatsApp, and what Airi writes back.
  whatsapp: {
    sendFromWhatsApp: "Send from WhatsApp",
    panelTitle: "Send videos from your phone",
    panelSteps: (number: string) =>
      `Scan this with your phone's camera and press Send in WhatsApp. After that, every shelf video you send to Airi at ${number} turns up here.`,
    openWhatsApp: "Open WhatsApp",
    codeLifetime: "The code works once, for 30 minutes.",
    makingCode: "Making your code…",
    codeFailed: "The code couldn't be made. Try again.",
    linkMessage: "Link my shop to Airi",
    linked: (workspace: string) =>
      `You're linked to ${workspace}. Send me a video of your products: hold each one up and say its name and price. I'll put them in airi for you to check.`,
    linkExpired:
      "That code has expired. Open Products in airi and scan the new one.",
    askToAdd: (workspace: string) =>
      `Should I add the products you just sent to ${workspace}?`,
    addButton: "Add them",
    skipButton: "No",
    ready: (count: number, link: string) =>
      count === 1
        ? `I found 1 product in your video. Check it before it goes on your shelf: ${link}`
        : `I found ${count} products in your video. Check them before they go on your shelf: ${link}`,
  },

  // What the owner can make on WhatsApp from the products a review added.
  drafts: {
    lead: "Share them on WhatsApp",
    carousel: "WhatsApp carousel",
    carouselAbout:
      "Buyers swipe through your products in one message. It opens in Templates for you to check and send to Meta.",
    carouselTooFew: "A carousel needs at least 2 products with photos.",
    carouselFirstTen: "The first 10 go on the cards.",
    makeCarousel: "Make a carousel",
    makingCarousel: "Making the cards…",
    openingTemplates: "Opening Templates…",
    replaceNewTemplate:
      "You have a new template you haven't saved. Replace it with this carousel?",
    replace: "Replace it",
    keep: "Keep it",
    orderForm: "Order form",
    orderFormAbout:
      "Buyers tick what they want and leave their name and address. It's saved as a draft in WhatsApp Flows for you to check and publish.",
    orderFormFirstTwenty: "The form lists the first 20.",
    makeOrderForm: "Make an order form",
    makingOrderForm: "Saving the form to WhatsApp…",
    orderFormSaved: (name: string) => `Saved as a draft: ${name}.`,
    openFlows: "Open WhatsApp Flows",
    connectWhatsApp: "Connect WhatsApp",
    errors: {
      whatsapp_not_connected: "Connect your WhatsApp number first.",
      not_enough_products:
        "These products don't have photos to put on the cards.",
      storage_full:
        "Your company's media storage is full. Delete some files in Assets, then try again.",
      failed: "That didn't work. Try again.",
    },
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
    failed: "Something went wrong while reading this video. Upload it again.",
  },
} as const;
