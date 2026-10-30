// Products is English-only for now, so its copy lives here rather than in the
// en/ru/kz catalogs, whose checks require every locale. Moving it into the
// catalogs later is mechanical: every string the section shows is in this file.

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
const unbroken = (name: string) => name.replace(/ /g, "\u00a0");

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
  foundNote: "Not on your shelf until you check them.",
  yourShelf: "Your shelf",
  readyToCheck: (count: number) =>
    count === 1
      ? "1 product found. Check it before it goes on your shelf."
      : `${count} products found. Check them before they go on your shelf.`,
  nothingFound:
    "No products were found in this video. Film your shelf again, saying each product's name and price.",
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

  // The stage a video's import plays on: each step, the model doing it, and
  // each photo as it's made. The model names appear only on the steps and in
  // the line under a finished photo.
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
    leave: "You can leave this page; your products keep coming.",
    keepOpen: "Keep this page open until it's uploaded.",
    resuming: "Picking up where it left off",
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
    withPrice: (name: string, price: string) => `${name} · ${price}`,
    quote: (words: string) => `“${words}”`,
    // How a finished photo was made, by its method.
    trail: {
      restored:
        "Muse Spark found it, SAM 3.1 cut it out and Muse Image restored it.",
      filmed: "Muse Spark found it and SAM 3.1 cut it out as filmed.",
      none: "There was no clear view of it in the video.",
    },
    levelled: (degrees: number) => `Levelled ${degrees}°.`,
    at: (time: string) => `At ${time} in your video.`,
    photo: {
      making: "Photo being made",
      waiting: "Photo next in line",
      unmade: "No photo",
    },
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
    panelSteps:
      "Scan this with your phone's camera and press Send in WhatsApp. Then confirm your phone here.",
    openWhatsApp: "Open WhatsApp",
    makingQr: "Getting your QR code ready…",
    qrFailed: "The QR code couldn't be made. Try again.",
    // A phone's message names the shop and nothing else, so no phone is
    // linked under a name another shop in airi has.
    shopNameTaken:
      "Another shop in airi has the same name, so a phone's message can't say which shop it means. Contact airi to change your shop's name.",
    askPhone: (phone: string) => `Is ${phone} your phone?`,
    // Kept apart from the number, so a name can't pass for one.
    profileName: (name: string) => `WhatsApp name: ${name}`,
    confirmPhone: "Yes, link it",
    denyPhone: "Not me",
    severalAsked: "More than one phone asked. Only link the one you recognise.",
    linkedPhone: (phone: string) => `Linked: ${phone}`,
    unlink: "Unlink",
    linkAnother: "Link another phone",
    linkedSteps: (number: string) =>
      `Shelf videos you send to Airi at ${number} turn up here.`,
    businessNumbers: (numbers: readonly string[]) =>
      numbers.length === 1
        ? `Or send videos straight from your shop's WhatsApp Business number ${numbers[0]}. No linking needed.`
        : `Or send videos straight from your shop's WhatsApp Business numbers ${numbers.slice(0, -1).join(", ")} or ${numbers[numbers.length - 1]}. No linking needed.`,
    actionFailed: "That didn't work. Try again.",
    requestExpired:
      "That request has expired. Send the message from your phone again.",
    phoneLinkedElsewhere:
      "This phone is linked to another shop in airi. Unlink it there first, then send the message from your phone again.",
    // What the QR writes in WhatsApp: nothing secret, only the shop's name.
    // The phone is linked once an admin confirms it in airi.
    linkMessage: (shop: string) =>
      `Hi Airi! Please link this phone to my shop ${shop}.`,
    linked: (workspace: string) =>
      `You're linked to ${workspace}. Send me a video of your products: hold each one up and say its name and price. I'll put them in airi for you to check.`,
    // Airi's answers on WhatsApp to a phone asking to be linked.
    confirmInAiri: (shop: string) =>
      `Open airi and confirm this phone to link it to ${shop}.`,
    alreadyLinked: (shop: string) =>
      `This phone is already linked to ${shop}. Send me a video of your products.`,
    linkedElsewhere:
      "This phone is linked to another shop in airi. Unlink it there first.",
    openProducts:
      "Open Products in airi, choose Send from WhatsApp, and send the message from there.",
    askToAdd: (workspace: string) =>
      `Should I add the products you just sent to ${workspace}?`,
    addButton: "Add them",
    skipButton: "No",
    ready: (count: number, link: string) =>
      count === 1
        ? `I found 1 product in your video. Check it before it goes on your shelf: ${link}`
        : `I found ${count} products in your video. Check them before they go on your shelf: ${link}`,
    // `stopped` is PRODUCTS_COPY.photosStopped's sentence.
    readyPartial: (count: number, stopped: string, link: string) =>
      count === 1
        ? `I found 1 product in your video. ${stopped} Check it before it goes on your shelf: ${link}`
        : `I found ${count} products in your video. ${stopped} Check them before they go on your shelf: ${link}`,
    failedPartial: (count: number, link: string) =>
      count === 1
        ? `Something went wrong after I found 1 product. Check what was found: ${link}`
        : `Something went wrong after I found ${count} products. Check what was found: ${link}`,
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
    ai_actions_used:
      "Your plan's included AI actions are used up, so this video couldn't be read.",
    trial_ended: "Your free trial has ended, so this video couldn't be read.",
    failed: "Something went wrong while reading this video. Upload it again.",
  },
} as const;
