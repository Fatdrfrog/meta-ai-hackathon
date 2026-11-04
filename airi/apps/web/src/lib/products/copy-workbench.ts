// The workbench's copy (studio v3, stream U2): the result built in place
// under its tile, its picture rails and its one Meta action, the confirm
// sheets, the Click-to-WhatsApp panel and "Out on Meta". Seeded from the
// spec's words; U2 owns it.

import type {
  ProductAdPostDestination,
  ProductAdStudioColourway,
  ProductsErrorCode,
} from "./types";
import type { ProductAdCtwaStep } from "./types-meta";
import type { ProductTemplateAction } from "./templates";

const ACTIONS: Record<ProductTemplateAction, string> = {
  post_reel: "Post Reel",
  post_story: "Post Story",
  post: "Post",
  post_carousel: "Post carousel",
  create_ad: "Create ad",
  create_on_whatsapp: "Create on WhatsApp",
};

const CTWA_STEPS: Record<ProductAdCtwaStep, string> = {
  video: "Video",
  campaign: "Campaign",
  adset: "Ad set",
  creative: "Creative",
  ad: "Ad",
};

const COLOURWAYS: Record<ProductAdStudioColourway, string> = {
  white: "White",
  sand: "Sand",
  rose: "Rose",
  sage: "Sage",
  night: "Night",
};

const dollars = (cents: number) =>
  Number.isInteger(cents / 100)
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;

/** "14:32" on the owner's clock. */
const clock = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};

/** Why a Meta action was refused before anything was sent, in the owner's terms. */
const META_REFUSALS = {
  instagram_not_connected:
    "Instagram isn't connected with posting allowed. Connect it in Integrations.",
  instagram_quota:
    "Instagram's daily limit is reached. Nothing was posted; try tomorrow.",
  post_busy: "This is already being posted there. Wait for it to finish.",
  ads_not_connected:
    "Meta Ads isn't connected. Connect it in Integrations. Nothing was spent.",
  page_whatsapp_missing:
    "WhatsApp isn't linked to your Facebook Page yet. Link it in Business Suite. Nothing was spent.",
  budget_refused: "That budget is above what this ad may spend.",
  run_disabled: "Running ads isn't turned on for this workspace.",
  post_failed: "Instagram refused it. Nothing was posted.",
  ctwa_failed: "Meta refused it. Nothing was spent.",
  price_to_check: "A product's price needs checking first: tap its red tag.",
  ad_not_ready: "Wait for the video to finish first.",
  ad_not_found: "This ad isn't there any more.",
  invalid_request: "This picture isn't ready yet. Try again in a moment.",
  ai_disabled: "AI is turned off for your company.",
  failed: "That didn't work. Nothing was sent. Try again.",
} satisfies Partial<Record<ProductsErrorCode | "failed", string>>;

export const WORKBENCH_COPY = {
  workbench: {
    close: "Close",
    rails: { shots: "Shots", look: "Look", voice: "Voice" },
    actions: ACTIONS,
    more: "More",
    menu: {
      downloadVideo: "Download video",
      downloadPicture: "Download picture",
      editCards: "Edit cards",
      editQuestions: "Edit questions",
      sendTest: "Send me a test",
      describePlace: "Describe a place…",
      backToVideo: (renderNo: number) => `Back to video ${renderNo}`,
      checkOneByOne: "Check one by one",
    },
    /** The Meta credit chips, once per workbench. */
    credits: ["Muse Spark", "Muse Image", "SAM 3.1"],
    creditsChat: ["Muse Spark", "SAM 3.1"],
    creditsLabel: "Made with Meta models",
    updating: "Updating",
    updatingNote: "Free · the video you see keeps playing",
    /** The same, for a run that pays (a new voice, a new place). */
    updatingNotePaid: "The video you see keeps playing",
    /** The one press that makes the picks into a new video. */
    update: {
      button: "Update video",
      buttonCost: (cents: number) => `Update video · ${dollars(cents)}`,
      discard: "Discard",
      waiting: "Pick as much as you like. Nothing is made until you update.",
    },
    keepPicking: "You can keep picking.",
    loading: "Loading…",
    loadFailed: "This couldn't be loaded.",
    retry: "Retry",
    notFound: "This ad isn't there any more.",
    making: (clock: string) => `Making · ${clock}`,
    asking: "Starting…",
    makingFailed: (reason: string) => `It couldn't be made: ${reason}`,
    /** The tile's preview frames. */
    frames: {
      reels: "Reels",
      story: "Story",
      sponsored: "Sponsored",
      whatsapp: "WhatsApp",
      follow: "Follow",
      originalAudio: "Original audio",
      slide: (index: number, count: number) =>
        `Picture ${index + 1} of ${count}`,
      previous: "Previous picture",
      next: "Next picture",
      noVideo: "The video isn't there yet.",
      noPicture: "This picture comes with the next video.",
    },
    /** The opening and ending stickers on the preview, a tap cycles them. */
    cycle: {
      opening: (index: number, count: number) =>
        `Opening ${index + 1} of ${count}. Tap for the next one.`,
      ending: (index: number, count: number) =>
        `Ending ${index + 1} of ${count}. Tap for the next one.`,
      openingInput: "Opening words",
      endingInput: "Ending words",
    },
    shots: {
      shot: (index: number, name: string) => `Shot ${index + 1}: ${name}`,
      product: (name: string) => `Show ${name}`,
    },
    look: {
      wall: "Wall",
      newPlace: "New place",
      makeOnePicture: "Make · 1 picture",
      making: "Muse Image",
      picture: (index: number, place: string) =>
        place ? `${place}` : `Picture ${index + 1}`,
      colourways: COLOURWAYS,
      exactPhoto: "Your exact photo, free",
      keptPicture: "A kept picture, free",
      newPlaceNote: (left: number | null) =>
        left === null
          ? "New place: a new picture by Muse Image, from this ad's AI action"
          : `New place: a new picture by Muse Image, ${left} left on this ad`,
      noneLeft: "No new pictures left on this ad",
      modalTitle: "Choose a new place",
      modalSubtitle: (left: number | null) =>
        left === null
          ? "Pick one of the 20 places or describe your own. Nothing is made until you update the video."
          : `Pick one of the 20 places or describe your own (${left} left on this ad). Nothing is made until you update the video.`,
      placesLabel: "20 places",
      ownPlaceLabel: "Or describe your own place, in any language",
      ownPlacePlaceholder: "e.g. a felt rug inside a yurt",
      choosePlace: "Choose place",
      describeTitle: "Describe a place",
      describeLabel: "Your place, in any language",
      describeMake: "Make · 1 picture",
      describeCancel: "Not now",
    },
    voice: {
      you: "You",
      youNew: "You · new",
      off: "Off",
      picked: (cents: number) =>
        cents > 0
          ? `picked, ${dollars(cents)} on Update`
          : "picked, free on Update",
      now: "In the video",
      running: "New voice…",
      fellBack: "The video kept another voice. Tap to try again.",
    },
    states: {
      priceToCheck: "Tap the red tag first",
      otherAdMaking:
        "The other WhatsApp ad format is being created. Wait for it to finish before creating this one.",
      otherAdRunning:
        "The other WhatsApp ad format is running. Manage it in Ads Manager before creating this one.",
      connectInstagram: "Connect Instagram",
      connectMetaAds: "Connect Meta Ads",
      connectWhatsApp: "Connect WhatsApp",
      instagramQuota: "Instagram's daily limit is reached",
      aiOff: "AI is off for your company",
      pageWhatsAppMissing: "WhatsApp isn't linked to your Facebook Page yet",
      linkInBusinessSuite: "Link in Business Suite",
      checkAgain: "Check again",
      nothingPosted: "Nothing was posted",
      nothingSpent: "Nothing was spent",
      tryAgain: "Try again",
      stillProcessing: "Still processing at Instagram",
      waitForVideo: "Wait for the video",
      waitForUpdate: "Wait for the update",
      updateFirst: "Update the video first, or discard your picks",
      noPicture: "This picture isn't made yet",
      checking: "Checking Meta…",
    },
    /** Who it goes out as, beside the action. */
    target: {
      instagram: (username: string | null) =>
        username ? `@${username}` : "Instagram",
      ads: (account: string | null) => account ?? "Meta ad account",
      whatsapp: "Your WhatsApp",
    },
    refusals: META_REFUSALS,
    updateFailed:
      "The video couldn't be updated. The video you see is still the latest.",
    voiceFailed: "The voice couldn't be changed. Try again.",
    newPlaceFailed: "The new picture couldn't be started. Try again.",
    kit: {
      carousel: (cards: number) =>
        cards === 1 ? "Carousel · 1 card" : `Carousel · ${cards} cards`,
      orderForm: (count: number) =>
        count === 1
          ? "Order form · 1 product"
          : `Order form · ${count} products`,
      noCarousel: "Carousel needs 2 products with photos",
      making: "Making the carousel and the order form…",
      reviewNote: "Meta reviews the carousel; nothing is sent to buyers yet.",
    },
  },
  publish: {
    title: {
      reel: "Post Reel to Instagram",
      story: "Post Story to Instagram",
      post: "Post to Instagram",
      carousel: "Post carousel to Instagram",
    } satisfies Record<ProductAdPostDestination, string>,
    publicNote: "Public. Everyone can see it.",
    caption: "Caption",
    editCaption: "Edit the caption",
    captionCount: (count: number, max: number) => `${count}/${max}`,
    tooManyHashtags: (max: number) =>
      `Instagram takes at most ${max} hashtags.`,
    tooLong: "The caption is too long for Instagram.",
    notNow: "Not now",
    post: "Post",
    posting: "Posting…",
    processing: "Instagram is getting it ready…",
    publishing: "Publishing…",
    unconfirmed:
      "We couldn't confirm the result. Try again to check the same post.",
  },
  ctwa: {
    steps: CTWA_STEPS,
    stepsLabel: "Made at Meta",
    paused: "Paused",
    adsManager: "Ads Manager",
    placements: "Facebook",
    instagramLocked: "Instagram",
    country: "Kazakhstan",
    ages: "18–65",
    chatOpensWith: "Chat opens with",
    shown: "Shown",
    now: "Now",
    greeting: "Greeting",
    pausedLine: "Paused · nothing is spent until it runs",
    /** A failed attempt; Meta's reason is said by the footer. */
    failedLine: "Stopped · nothing was spent",
    deliveryUnknown: "Stopped. Check Ads Manager for any delivery and spend.",
    notMadeLine:
      "Created paused. Meta may review the ad; it will not spend until you run it.",
    creating: "Creating at Meta…",
    page: "Facebook Page",
    whatsappNumber: "WhatsApp number",
    run: "Run",
    runTitle: "Run the ad",
    perDayLabel: "A day",
    forLabel: "For",
    less: "Less a day",
    more: "More a day",
    keepPaused: "Keep paused",
    perDay: (cents: number) => `${dollars(cents)} a day`,
    days: (count: number) => (count === 1 ? "1 day" : `${count} days`),
    atMost: (cents: number) =>
      `At most ${dollars(cents)} · Meta reviews it before it runs`,
    runFor: (cents: number) => `Run · ${dollars(cents)}`,
    running: "Running",
    checkingMeta: "Checking Meta",
    inReview: "In review",
    disapproved: "Not approved",
    stoppedHere: "stopped here",
    runningLine: (cents: number, endsAt: string | null) =>
      endsAt
        ? `${dollars(cents)} a day until ${new Date(endsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
        : `${dollars(cents)} a day`,
    createAgain: "Create again",
  },
  outOnMeta: {
    title: "Out on Meta",
    onInstagram: (time: string) => `On Instagram · ${time}`,
    viewPost: "View post",
    clock,
    kinds: {
      reel: "Reel",
      story: "Story",
      post: "Post",
      carousel: "Carousel",
      ctwa: "WhatsApp ad",
      kit: "Carousel + form",
    },
    places: {
      instagram: "Instagram",
      facebook: "Facebook",
      whatsapp: "WhatsApp",
    },
    open: (what: string) => `Open ${what}`,
    link: (what: string) => `${what} at Meta`,
    loadError: "What went out on Meta couldn't be loaded.",
    retry: "Retry",
  },
} as const;
