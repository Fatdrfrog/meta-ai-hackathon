// What the owner makes from shelf products: for customers on WhatsApp, the
// carousel and the order form one press makes (the kit); for new customers,
// the way into a video ad; what buyers see; and the list of everything made.
// Part of PRODUCTS_COPY (copy.ts).

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export const MAKE_COPY = {
  // The make view: under a finished review, or for products chosen on the shelf.
  make: {
    title: "Make something with them",
    language: (name: string) =>
      `Buyers see it in ${name}, the language you spoke.`,
    languageChosen: (name: string) => `Buyers see it in ${name}.`,
    change: "Change",
    languageLabel: "The language buyers read",
    languages: { kk: "Kazakh", ru: "Russian", en: "English" },
    productsFromVideo: (n: number) =>
      `${count(n, "product", "products")} from this video`,
    productsFromShelf: (n: number) =>
      `${count(n, "product", "products")} from your shelf`,
    changeProducts: "Change",
    loading: "Getting your products ready…",
    loadError: "Your products couldn't be loaded.",
    retry: "Retry",
    noneOnShelf:
      "None of these products are on your shelf now. Choose others to make something.",
    // "What buyers see", built from the real products.
    preview: {
      title: "What buyers see",
      tabs: { carousel: "Carousel", orderForm: "Order form" },
      tabsLabel: "Preview",
      shop: "Your shop · WhatsApp",
      caption: (language: string, spoken: boolean) =>
        spoken
          ? `Written in ${language}, the language you spoke. Prices come from your shelf.`
          : `Written in ${language}. Prices come from your shelf.`,
      noCards: "The carousel needs products with photos.",
    },
  },

  // The card for customers on WhatsApp: the carousel and the order form.
  kit: {
    forWhom: "For your customers on WhatsApp",
    title: "Carousel + order form",
    about:
      "Buyers swipe through your products in one message and tick what they want in the order form.",
    noAi: "No AI actions",
    carousel: "Carousel",
    carouselMeta: (n: number) =>
      `${count(n, "card", "cards")} · Meta checks it first`,
    carouselTooFew: "Needs at least 2 products with photos",
    carouselFirstTen: "The first 10 with photos go on the cards.",
    orderForm: "Order form",
    orderFormMeta: (n: number) =>
      `${count(n, "product", "products")} · ready right away`,
    orderFormFirstTwenty: "The form lists the first 20.",
    makeBoth: "Make carousel + order form",
    makeCarousel: "Make the carousel",
    makeOrderForm: "Make the order form",
    chooseWhat: "Choose what to make",
    footnote:
      "The order form is ready right away. Meta reviews the carousel first: usually minutes, at most 24 hours.",
    notConnected: "Connect your WhatsApp number to make these.",
    connectWhatsApp: "Connect WhatsApp",
    // While the press is being made.
    makingTitle: "Making them now",
    makingOrderForm: "Publishing the order form",
    makingCarousel: (n: number) =>
      `Making ${count(n, "card", "cards")} and sending them to Meta`,
    makingTiming: "This usually takes about 20 seconds, at most a minute.",
    makingLeave:
      "You can leave this page. It carries on, and you'll find it under Made from your shelf.",
    // The kit once made.
    madeAt: (when: string, products: number) =>
      `Made ${when} · ${count(products, "product", "products")}`,
    makeAnother: "Make another",
    pricesChanged:
      "Prices changed since this was made. Make another to show the new ones.",
    orderFormReady: (name: string, products: number) =>
      `Published on WhatsApp as “${name}”, with ${count(products, "product", "products")} to tick.`,
    orderFormDraft:
      "Meta didn't publish it, so it's saved as a draft. Publish it in WhatsApp Flows.",
    orderFormMaking: "Publishing the order form…",
    carouselMaking: (n: number) =>
      `Making ${count(n, "card", "cards")} and sending them to Meta…`,
    carouselChecking:
      "Checking with Meta… It was slow to answer, so Airi is looking for the carousel there. This page updates on its own.",
    carouselPending:
      "Meta is checking it. That usually takes minutes, and at most 24 hours. This page updates on its own.",
    carouselApproved: (time: string) =>
      `Meta approved it at ${time}. Send it from a scenario or a bulk campaign.`,
    carouselApprovedNoTime:
      "Meta approved it. Send it from a scenario or a bulk campaign.",
    carouselRejected: (reason: string | null) =>
      reason ? `Meta didn't approve it: ${reason}` : "Meta didn't approve it.",
    carouselPaused:
      "Meta paused it because buyers reported or blocked it. It comes back on its own if quality improves.",
    carouselDisabled:
      "Meta turned it off. Edit it in Templates and send it again.",
    carouselLimit:
      "Your WhatsApp account has as many templates as Meta allows. Delete ones you don't use in Templates, then try again.",
    carouselSkipped: "These products don't have photos to put on the cards.",
    // What still works when the other part wasn't made.
    keptOrderForm: "The order form stays ready.",
    keptCarousel: "The carousel stays with Meta.",
    openFlows: "Open WhatsApp Flows",
    openTemplates: "Open in Templates",
    editInTemplates: "Edit it in Templates",
    makeAgain: "Make it again",
    tryAgain: "Try again",
    openAssets: "Open Assets",
    chips: {
      making: "Making",
      checking: "Checking",
      ready: "Ready",
      draft: "Draft",
      withMeta: "With Meta",
      approved: "Approved",
      notApproved: "Not approved",
      paused: "Paused",
      turnedOff: "Turned off",
      limit: "Template limit",
      notMade: "Not made",
      skipped: "Not made",
    },
    errors: {
      whatsapp_not_connected: "Connect your WhatsApp number to make these.",
      not_enough_products:
        "These products don't have photos to put on the cards.",
      storage_full:
        "Your company's media storage is full. Delete some files in Assets, then try again.",
      meta_refused: (message: string | null) =>
        message ? `Meta refused it: ${message}` : "Meta refused it.",
      timed_out: "This took too long. Try again.",
      failed: "That didn't work. Try again.",
    },
  },

  // The card for new customers: the way into a video ad.
  adCard: {
    forWhom: "For new customers",
    title: "Video ad",
    new: "New",
    about:
      "A short vertical video of up to 3 products, in the language you spoke, for WhatsApp Status, Reels and TikTok.",
    cost: "1 AI action",
    make: "Make a video ad",
    noneEligible: "Add a photo and a price to a product to put it in an ad.",
  },

  // "Made from your shelf", above the shelf.
  made: {
    title: "Made from your shelf",
    about:
      "Carousels, order forms and video ads you made. Open one to finish or share it.",
    showAll: (n: number) => `Show all ${n}`,
    showFewer: "Show fewer",
    kitBoth: "Carousel + order form",
    kitMeta: (products: number, when: string) =>
      `${count(products, "product", "products")} · ${when}`,
    adTitle: "Video ad",
    adProducts: (first: string, more: number) =>
      more > 0 ? `${first} and ${more} more` : first,
    open: "Open",
    makeAd: "Make a video ad with these",
    // A list row's own "Try again" names its part, as a row can show two.
    remake: {
      orderForm: "Make the order form again",
      carousel: "Make the carousel again",
    },
    loadError: "What you made couldn't be loaded.",
    retry: "Retry",
    today: (time: string) => `today at ${time}`,
    yesterday: (time: string) => `yesterday at ${time}`,
    onDay: (day: string, time: string) => `${day} at ${time}`,
    chips: {
      orderFormMaking: "Order form making",
      orderFormReady: "Order form ready",
      orderFormDraft: "Order form draft",
      orderFormNotMade: "Order form not made",
      carouselMaking: "Carousel making",
      carouselChecking: "Carousel checking",
      carouselWithMeta: "Carousel with Meta",
      carouselApproved: "Carousel approved",
      carouselNotApproved: "Carousel not approved",
      carouselPaused: "Carousel paused",
      carouselTurnedOff: "Carousel turned off",
      carouselLimit: "Template limit",
      carouselNotMade: "Carousel not made",
      needsAttention: "Needs attention",
      pricesChanged: "Prices changed",
      adMaking: (elapsed: string) => `Making · ${elapsed}`,
      adReady: "Ready",
      adFailed: "Couldn't be made",
    },
  },
} as const;
