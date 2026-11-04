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
      // When the owner edited the cards or the questions before Make.
      captionEdited:
        "With your edits, as buyers will see them. Card prices are the words you wrote; your shelf prices don't change.",
      noCards: "The carousel needs products with photos.",
      // A question of the owner's the preview can't draw as WhatsApp does.
      otherField: (label: string) => label,
      noQuestions: "This screen has no questions.",
    },
    // Edits made before Make go when the language or the products change.
    confirmLanguage: {
      body: (from: string, to: string) =>
        `Your edits are in ${from}. Switching to ${to} starts the cards and the questions again from your shelf.`,
      keep: (from: string) => `Keep ${from}`,
      switch: (to: string) => `Switch to ${to}`,
    },
    confirmProducts: {
      body: "Changing the products starts the cards and the questions again from your shelf.",
      keep: "Keep my edits",
      change: "Change products",
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
      "Change any words, pictures or questions first: nothing goes to WhatsApp or Meta until you press Make. Meta reviews the carousel: usually minutes, at most 24 hours.",
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
      timed_out:
        "We couldn't confirm Meta got it. Try again looks for it at Meta first, so nothing is sent twice.",
      failed: "That didn't work. Try again.",
    },

    // Editing the parts: "Edit cards" and "Edit questions" before Make, and
    // sending a made part again with edits after it.
    edit: {
      editCards: "Edit cards",
      editQuestions: "Edit questions",
      edited: "Edited",
      reset: "Reset",
      resetConfirm: {
        carousel: "Reset the cards to your shelf? Your edits go.",
        orderForm: "Reset the questions to your shelf? Your edits go.",
      },
      resetYes: "Reset",
      resetKeep: "Keep my edits",
      saved: {
        carousel: "Carousel edited. It goes to Meta when you press Make.",
        orderForm: "Order form edited. It's published when you press Make.",
      },
      reverted: {
        carousel: "The cards are back to your shelf's.",
        orderForm: "The questions are back to your shelf's.",
      },
      close: "Close",
      cancel: "Cancel",
      saveChanges: "Save changes",
      sendForReview: "Send to Meta for review",
      publish: "Publish",
      tryAgain: "Try again",
      editorLoadError:
        "The editor couldn't load. Check your connection and try again.",
      // The carousel's sheet.
      carouselTitle: "Edit carousel",
      carouselBefore: (n: number) =>
        `airi's template editor, filled from your ${count(n, "shelf product", "shelf products")}. Nothing goes to Meta until you press Make.`,
      carouselAfter: "A new template, from the one with Meta now.",
      preparing: (n: number) =>
        `Putting ${count(n, "product", "products")} on cards…`,
      prepareFailed:
        "Couldn't put your products on cards. Check your connection and try again.",
      notEnoughPhotos: "A carousel needs at least 2 products with photos.",
      loadingSent: "Opening what was sent…",
      loadingEditor: "Opening the editor…",
      sending: (elapsed: string) => `Sending… ${elapsed}`,
      sendingNote: "Closing the sheet doesn't stop it.",
      // Why it goes to Meta as a new template, by what Meta did with the first.
      banner: {
        pending: (name: string) =>
          `Meta is checking ${name} and won't let it change, so this goes to Meta as a new template. The first one stays in Templates; the kit will show this one.`,
        approved: (name: string) =>
          `This goes to Meta as a new template; ${name} stays approved in Templates. The kit will show the new one.`,
        turnedDown: (name: string) =>
          `Meta turned ${name} down, so this goes to Meta as a new template. The first one stays in Templates; the kit will show this one.`,
        failed:
          "The first carousel didn't reach Meta. This sends your cards as a new template.",
      },
      carouselFound:
        "Meta did get your first carousel after all; it's with Meta now. Your edits weren't sent. To send them as a new template, press Send to Meta for review again.",
      nameTaken:
        "This kit already used that template name. Change the template name and send again.",
      // Meta's own words; a refusal about the name gets the fix.
      metaRefused: (message: string | null, aboutName: boolean) =>
        `${message ? `Meta refused it: ${message}` : "Meta refused it."}${aboutName ? " Change the template name and send again." : ""}`,
      busy: "This part is still being made. Wait for it, then try again.",
      notSent: (issue: string) => `It wasn't sent: ${issue}`,
      sentCarousel: "Sent to Meta as a new template.",
      // The order form's sheet.
      formTitle: "Edit order form",
      formBefore: (n: number) =>
        `airi's form editor, with ${count(n, "shelf product", "shelf products")} to tick. Nothing goes to WhatsApp until you press Make.`,
      formAfterReady: (version: number) =>
        `Publishes a new form, version ${version}. Forms you already sent keep opening version ${version - 1}.`,
      formAfterDraft:
        "Saves your questions into the same form and publishes it.",
      formFooter: "Nothing goes to WhatsApp until you press Make.",
      formFooterAfter: "It's published on WhatsApp when you press Publish.",
      lockNote:
        "Each option of the products question is a product on your shelf, so it stays linked: rename it freely. Add or remove products with Change on the Make page.",
      loadingForm: "Opening the questions…",
      publishedForm: (version: number) =>
        `Order form published as version ${version}.`,
      // After Make, on the kit's rows.
      editAndSendAgain: "Edit and send again",
      editAndTryAgain: "Edit and try again",
      editOrderForm: "Edit order form",
      editAndPublish: "Edit and publish",
      notes: {
        pending:
          "Meta doesn't let anyone change a template while it checks it, so your edits go to Meta as a new template.",
        turnedDown:
          "Fix it and send it as a new template. This one stays in Templates.",
        paused:
          "Your edits go to Meta as a new template; this one stays in Templates.",
        approved:
          "Your edits go to Meta as a new template; this one stays approved in Templates.",
      },
      version: (n: number) => `Version ${n}`,
      versionNote: (n: number) =>
        `Forms you already sent keep opening version ${n - 1}. New sends use version ${n}.`,
      // "Send me the order form": the published form to the owner's test phone.
      sendTest: "Send me the order form",
      sendingTest: "Sending the order form…",
      sentTest: "Sent to your test number. Open WhatsApp to try the form.",
      testErrors: {
        test_phone_missing:
          "Add your test number in a campaign's Test send first.",
        test_phone_is_shop:
          "Your test number is the shop's own WhatsApp number. Use another phone.",
        test_phone_unreachable:
          "Your test number can't get WhatsApp messages. Check it in a campaign's Test send.",
        test_phone_not_allowed:
          "Meta doesn't let this WhatsApp number message your test number yet.",
        rate_limited: "That's a lot of test sends this hour. Try again later.",
        failed: "The order form couldn't be sent. Try again.",
      },
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
