// The video ad studio: the brief, the making list, the finished ad and why
// one failed. Part of PRODUCTS_COPY (copy.ts).

import {
  PRODUCT_AD_IDEA_MAX_LENGTH,
  type ProductAdAdmissionStop,
  type ProductAdErrorCode,
  type ProductAdIdeaKind,
  type ProductAdProductProblem,
  type ProductAdStatus,
  type ProductAdStep,
  type ProductAdVoice,
} from "./types";

/** "Кукла Лол", "Кукла Лол and Кружка", "Кукла Лол, Кружка and Сағат". */
const listOf = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// What stops the workspace paying for the ad's AI action, as the import says it.
const SPEND_STOPS: Record<ProductAdAdmissionStop, string> = {
  spend_limit: "Your company's AI spending limit has been reached",
  ai_actions_used: "Your plan's included AI actions are used up",
  trial_ended: "Your free trial has ended",
};

export const AD_COPY = {
  ad: {
    title: "Video ad",

    // The brief: one screen, everything filled in, nothing spent yet.
    briefLead: (count: number) =>
      count === 1
        ? "A short vertical video of this product, for WhatsApp Status, Reels and TikTok."
        : `A short vertical video of these ${count} products, for WhatsApp Status, Reels and TikTok.`,
    products: "Products",
    changeProducts: "Change",
    changeProductsLabel: "Change the products",
    pricesFromShelf: "Prices come from your shelf.",
    priceLocked: "Price from your shelf",
    problems: {
      no_photo: "No photo yet",
      no_price: "No price yet",
    } satisfies Record<ProductAdProductProblem, string>,
    needsPhotoAndPrice:
      "A video ad takes 1 to 3 products with photos and prices.",
    missing: (count: number) =>
      count === 1
        ? "1 product you picked isn't on your shelf any more."
        : `${count} products you picked aren't on your shelf any more.`,
    nothingToMake: "The products you picked aren't on your shelf any more.",
    chooseProducts: "Choose products",
    idea: "Idea",
    ideas: {
      new: "New on the shelf",
      gift: "Gift idea",
      own: "Your own words",
    } satisfies Record<ProductAdIdeaKind, string>,
    ideaAbout: {
      new: "Tells buyers these just arrived.",
      gift: "Shows them as a gift to buy for someone.",
      own: "Muse Spark writes the words around your idea.",
    } satisfies Record<ProductAdIdeaKind, string>,
    ownWords: "Your idea, in a few words",
    ownWordsCount: (count: number) => `${count}/${PRODUCT_AD_IDEA_MAX_LENGTH}`,
    ownWordsNeeded: "Write your idea, or pick another one.",
    voice: "Voice",
    voices: {
      own: "Your voice, from the video",
      none: "No voice",
    } satisfies Record<ProductAdVoice, string>,
    voiceAbout: {
      // Not "taken out": music under the words stays (paid gate, 2026-11-02).
      own: "Where you say each price in your video, cleaned up: background noise turned down, long pauses tightened, levels evened. It still sounds like you.",
      none: "Words on screen only, with no sound.",
    } satisfies Record<ProductAdVoice, string>,
    voiceSilent:
      "A product without a clip of you saying its price stays silent.",
    noVoiceClips:
      "No voice: the video has no clip of you saying these products' prices.",
    presenter: "Person from your video",
    presenterShow: "Show them at the end of the ad",
    presenterConsent: "This is me, or they agreed to appear in ads.",
    presenterCredit: "Cut out of your video by SAM 3.1",
    presenterConsentNeeded: "Tick that they agreed, or leave them out.",
    ending: "Ending",
    endingWithNumber: (phone: string) =>
      `“Write to us on WhatsApp” with ${phone}`,
    endingWithShop: (shop: string) =>
      shop
        ? `“Write to us on WhatsApp” with your shop's name, ${shop}`
        : "“Write to us on WhatsApp”",
    endingConnect: "Connect WhatsApp to show your number instead.",
    language: "Language",
    languageSpoken: (language: string) => `${language}, the language you spoke`,
    languageUnknown: "English: Airi couldn't tell the language you spoke",
    cost: "1 AI action · about a minute · you can leave this page",
    make: "Make the ad",
    starting: "Starting…",
    letters: "Video ads support Latin and Cyrillic letters for now.",
    lettersIn: (text: string) =>
      `“${text}” has letters the video can't draw yet.`,
    blocked: (stop: ProductAdAdmissionStop) =>
      `${SPEND_STOPS[stop]}, so an ad can't be made.`,
    sketchCaption:
      "The first scene, sketched. Muse Image sets your product in a real place; Airi draws the price.",
    loadingBrief: "Getting your products…",
    briefFailed: "The brief couldn't be loaded.",
    retry: "Retry",
    // Why "Make the ad" was refused.
    createErrors: {
      not_enough_products:
        "A video ad takes 1 to 3 products with photos and prices. Check them on your shelf.",
      ad_letters_unsupported:
        "Video ads support Latin and Cyrillic letters for now.",
      spend_limit: `${SPEND_STOPS.spend_limit}, so an ad can't be made.`,
      ai_actions_used: `${SPEND_STOPS.ai_actions_used}, so an ad can't be made.`,
      trial_ended: `${SPEND_STOPS.trial_ended}, so an ad can't be made.`,
      ad_unavailable: "The ad couldn't be started. Try again.",
      failed: "That didn't work. Try again.",
    },

    // Making it: honest steps, each with its model and its seconds.
    making: (elapsed: string) => `Making · ${elapsed}`,
    makingTitle: "Making your video",
    remakingTitle: "Making your video again",
    waitingForSlot: "Waiting for a free slot. It starts as soon as one opens.",
    leave:
      "You can leave this page. It carries on, and you'll find it under Made from your shelf.",
    steps: {
      script: "Writing the words",
      pictures: (done: number, total: number) => `Pictures ${done} of ${total}`,
      picturesMade: (muse: number, exact: number) =>
        exact === 0
          ? muse === 1
            ? "Pictures · 1 by Muse Image"
            : `Pictures · ${muse} by Muse Image`
          : muse === 0
            ? "Pictures · your exact photos"
            : `Pictures · ${muse} by Muse Image, ${exact} exact ${exact === 1 ? "photo" : "photos"}`,
      framing: "Framing",
      video: "Putting the video together",
    },
    stepModels: {
      script: "Muse Spark 1.3",
      pictures: "Muse Image 1.0, checked by Muse Spark",
      framing: "SAM 3.1",
      video: "1080 × 1920",
    },
    stepStates: { done: "done", now: "now", next: "next" },
    seconds: (seconds: number) => `${seconds} s`,
    progress: "How far the ad is",
    statusPicture: "Status picture",
    statusPictureReady: "The Status picture is ready to post.",
    sceneMuse: "Picture by Muse Image",
    sceneChecked: (what: string) => `Still your ${what}: checked by Muse Spark`,
    sceneExact: "Your exact photo",
    sceneExactForNow: "Your exact photo for now",
    sceneWaiting: "The picture comes next",

    // Ready.
    summary: (
      names: readonly string[],
      seconds: number | null,
      language: string | null
    ) =>
      [
        listOf(names),
        seconds === null ? null : `${Math.round(seconds)} s`,
        language ? `in ${language}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ready: "Ready",
    madeIn: (took: string) => `made in ${took}`,
    player: "Your video ad",
    safeZones: "Reels safe zones",
    safeTop: "Top 14% · Reels header",
    safeBottom: "Bottom 35% · caption and buttons",
    sound: "Sound",
    download: (size: string) => `Download video · ${size}`,
    adPicture: "Ad picture 4:5",
    videoMissing:
      "The video couldn't be loaded. Refresh the page to try again.",
    pricesChanged:
      "Prices changed on your shelf since this ad was made, so it still shows the old ones.",
    chooseAgain: "Choose them for a new ad",
    wordsTitle: "Words on screen",
    wordsAbout:
      "Change any line. Names and prices stay as they are on your shelf.",
    sticker: "Sticker on the first scene",
    caption: (name: string) => `Caption for ${name}`,
    priceCardTitle: "Title of the price card",
    endingLine: "Ending",
    lineRoom: (lines: number, chars: number) =>
      lines === 1
        ? `One line of up to ${chars} letters`
        : `${lines} lines of up to ${chars} letters`,
    issues: {
      empty: "Write something here, or undo the change.",
      digits: "No numbers here: Airi adds the prices from your shelf.",
      currency: "No prices or currencies here: Airi adds them from your shelf.",
      letters: "Use Latin or Cyrillic letters only.",
      room: (lines: number, chars: number) =>
        lines === 1
          ? `Too long: it has to fit one line of ${chars} letters.`
          : `Too long: it has to fit ${lines} lines of ${chars} letters.`,
    },
    save: "Save and remake the video",
    saving: "Saving…",
    undoEdits: "Undo changes",
    saveNote: "It costs no AI action and takes about 40 seconds.",
    saveErrors: {
      ad_not_ready:
        "The ad is being made right now. Try again once it's ready.",
      invalid_request: "Some words can't go on screen. Check the lines in red.",
      ad_unavailable: "The video couldn't be made again. Try again.",
      failed: "That didn't work. Try again.",
    },
    postTitle: "Post text",
    postAbout: "For your Status, Instagram or TikTok post.",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Couldn't copy. Select the text and copy it.",
    copyField: (field: string) => `Copy the ${field.toLowerCase()}`,
    ctwaTitle: "Click-to-WhatsApp ad",
    ctwaAbout:
      "Paste it into Ads Manager. Buyers who tap the ad land in your WhatsApp chat.",
    ctwaHeadline: "Headline",
    ctwaPrimaryText: "Primary text",
    ctwaGreeting: "Greeting",
    ctwaQuestions: "Quick questions",
    copyAll: "Copy all",
    openAdsManager: "Open Ads Manager",
    checksTitle: "What Airi checked",
    checks: {
      prices: "Prices come from your shelf, drawn by Airi.",
      pictures:
        "Each picture was checked by Muse Spark, or is your exact photo.",
      safe: "The words sit inside Reels' safe zones.",
      size: (size: string) => `The video is ${size}, under WhatsApp's 16 MB.`,
      aiLabel: "Meta may label the AI pictures as made with AI.",
    },
    creditsTitle: "How this ad was made",
    credits: {
      words: "Words: Muse Spark 1.3, from what you said in the video",
      pictures: "Pictures: Muse Image 1.0, each checked by Muse Spark 1.3",
      exactPictures: "Pictures: your exact photos",
      framing: "Framing: SAM 3.1",
      voiceOwn: "Voice: your own words from the video, cleaned up",
      voiceNone: "Voice: none",
      presenter: "Person: cut out of your video by SAM 3.1",
      video: "Video: put together by Airi at 1080 × 1920",
      prices: "Prices: drawn by Airi from your shelf",
      stepNames: {
        script: "words",
        pictures: "pictures",
        framing: "framing",
        video: "video",
      } satisfies Record<ProductAdStep, string>,
      took: (parts: readonly string[]) => `Took ${parts.join(" · ")}`,
      cost: (usd: string) => `1 AI action · ${usd}`,
    },

    // Failed.
    failed: (reason: string) => `The ad couldn't be made: ${reason}.`,
    failReasons: {
      spend_limit: "your company's AI spending limit has been reached",
      ai_actions_used: "your plan's included AI actions are used up",
      trial_ended: "your free trial has ended",
      photo_missing: "a product's photo is no longer in your media storage",
      too_big: "the video stayed over WhatsApp's 16 MB, even made smaller",
      failed: "something went wrong while making it",
    } satisfies Record<ProductAdErrorCode, string>,
    failedChip: "Couldn't be made",
    tryAgain: "Try again",
    tryAgainNote:
      "It picks up where it stopped and reuses the pictures already made.",
    retryErrors: {
      spend_limit: `${SPEND_STOPS.spend_limit}, so it can't be made again.`,
      ai_actions_used: `${SPEND_STOPS.ai_actions_used}, so it can't be made again.`,
      trial_ended: `${SPEND_STOPS.trial_ended}, so it can't be made again.`,
      ad_unavailable: "It couldn't be started. Try again.",
      failed: "That didn't work. Try again.",
    },
    lastVideo: "Your last video is still here.",

    // Said to screen readers when the ad changes state.
    announce: {
      making: "The ad is being made.",
      ready: "The ad is ready.",
      failed: "The ad couldn't be made.",
    } satisfies Record<ProductAdStatus, string>,

    // Opening an ad.
    loading: "Loading the ad…",
    loadFailed: "The ad couldn't be loaded.",
    notFound: "That ad wasn't found.",
    backToProducts: "Back to products",
  },
} as const;
