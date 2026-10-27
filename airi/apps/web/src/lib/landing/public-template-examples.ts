import type { PublicTemplate } from "./public-template-catalog";

/** Shared metadata; message text uses the existing locale catalogs. */
export const PUBLIC_TEMPLATE_EXAMPLES: readonly PublicTemplate[] = [
  {
    id: "enquiry-follow-up",
    useCase: "follow-up",
    industry: "services",
    goal: "convert",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.enquiry-follow-up.title",
    descriptionKey:
      "LandingDemo.templates.catalog.enquiry-follow-up.description",
    bodyKey: "LandingDemo.templates.catalog.enquiry-follow-up.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.enquiry-follow-up.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.enquiry-follow-up.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.enquiry-follow-up.footer",
  },
  {
    id: "discovery-recap",
    useCase: "follow-up",
    industry: "services",
    goal: "convert",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.discovery-recap.title",
    descriptionKey: "LandingDemo.templates.catalog.discovery-recap.description",
    bodyKey: "LandingDemo.templates.catalog.discovery-recap.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.discovery-recap.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.discovery-recap.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.discovery-recap.footer",
  },
  {
    id: "quote-ready",
    useCase: "follow-up",
    industry: "services",
    goal: "convert",
    format: "document",
    locales: ["en", "ru", "kz"],
    documentPath:
      "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/4dcbaa81d6c70f3293c7c54cc29d93409729244d3a150fdf90bdc4263f4d8a7b-quote-ready.pdf",
    documentFilename: "quote-ready.pdf",
    titleKey: "LandingDemo.templates.catalog.quote-ready.title",
    descriptionKey: "LandingDemo.templates.catalog.quote-ready.description",
    bodyKey: "LandingDemo.templates.catalog.quote-ready.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.quote-ready.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.quote-ready.footer",
    localeAttachments: {
      ru: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/7afca6a7b0b885cf9aec426b91f86587b0a4f7eabf92371e6a8aefe822abae45-quote-ready-ru.pdf",
        documentFilename: "quote-ready-ru.pdf",
      },
      kz: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/5894150e28d14071126e721813ca6efa559f40de2671118aff23990165eb88da-quote-ready-kz.pdf",
        documentFilename: "quote-ready-kz.pdf",
      },
    },
  },
  {
    id: "quote-question",
    useCase: "follow-up",
    industry: "services",
    goal: "convert",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.quote-question.title",
    descriptionKey: "LandingDemo.templates.catalog.quote-question.description",
    bodyKey: "LandingDemo.templates.catalog.quote-question.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.quote-question.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.quote-question.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.quote-question.footer",
  },
  {
    id: "proposal-comparison",
    useCase: "follow-up",
    industry: "services",
    goal: "convert",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.proposal-comparison.title",
    descriptionKey:
      "LandingDemo.templates.catalog.proposal-comparison.description",
    bodyKey: "LandingDemo.templates.catalog.proposal-comparison.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.proposal-comparison.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.proposal-comparison.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.proposal-comparison.footer",
  },
  {
    id: "decision-check-in",
    useCase: "follow-up",
    industry: "services",
    goal: "convert",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.decision-check-in.title",
    descriptionKey:
      "LandingDemo.templates.catalog.decision-check-in.description",
    bodyKey: "LandingDemo.templates.catalog.decision-check-in.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.decision-check-in.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.decision-check-in.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.decision-check-in.footer",
  },
  {
    id: "showroom-visit-follow-up",
    useCase: "follow-up",
    industry: "retail",
    goal: "convert",
    format: "image",
    locales: ["en", "ru", "kz"],
    imagePath: "/templates/seasonal-offer.png",
    titleKey: "LandingDemo.templates.catalog.showroom-visit-follow-up.title",
    descriptionKey:
      "LandingDemo.templates.catalog.showroom-visit-follow-up.description",
    bodyKey: "LandingDemo.templates.catalog.showroom-visit-follow-up.body",
    buttonKeys: [
      {
        type: "URL",
        textKey:
          "LandingDemo.templates.catalog.showroom-visit-follow-up.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.showroom-visit-follow-up.footer",
  },
  {
    id: "home-service-quote",
    useCase: "follow-up",
    industry: "services",
    goal: "convert",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.home-service-quote.title",
    descriptionKey:
      "LandingDemo.templates.catalog.home-service-quote.description",
    bodyKey: "LandingDemo.templates.catalog.home-service-quote.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.home-service-quote.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.home-service-quote.footer",
  },
  {
    id: "appointment-booking",
    useCase: "booking",
    industry: "services",
    goal: "convert",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.appointment-booking.title",
    descriptionKey:
      "LandingDemo.templates.catalog.appointment-booking.description",
    bodyKey: "LandingDemo.templates.catalog.appointment-booking.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.appointment-booking.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.appointment-booking.footer",
  },
  {
    id: "restaurant-table",
    useCase: "booking",
    industry: "services",
    goal: "convert",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.restaurant-table.title",
    descriptionKey:
      "LandingDemo.templates.catalog.restaurant-table.description",
    bodyKey: "LandingDemo.templates.catalog.restaurant-table.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.restaurant-table.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.restaurant-table.footer",
  },
  {
    id: "travel-date-range",
    useCase: "booking",
    industry: "services",
    goal: "acquire",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.travel-date-range.title",
    descriptionKey:
      "LandingDemo.templates.catalog.travel-date-range.description",
    bodyKey: "LandingDemo.templates.catalog.travel-date-range.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.travel-date-range.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.travel-date-range.footer",
  },
  {
    id: "event-registration",
    useCase: "booking",
    industry: "services",
    goal: "convert",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.event-registration.title",
    descriptionKey:
      "LandingDemo.templates.catalog.event-registration.description",
    bodyKey: "LandingDemo.templates.catalog.event-registration.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.event-registration.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.event-registration.footer",
  },
  {
    id: "appointment-rescheduled",
    useCase: "booking",
    industry: "services",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.appointment-rescheduled.title",
    descriptionKey:
      "LandingDemo.templates.catalog.appointment-rescheduled.description",
    bodyKey: "LandingDemo.templates.catalog.appointment-rescheduled.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey:
          "LandingDemo.templates.catalog.appointment-rescheduled.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey:
          "LandingDemo.templates.catalog.appointment-rescheduled.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.appointment-rescheduled.footer",
  },
  {
    id: "visit-preparation",
    useCase: "booking",
    industry: "services",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.visit-preparation.title",
    descriptionKey:
      "LandingDemo.templates.catalog.visit-preparation.description",
    bodyKey: "LandingDemo.templates.catalog.visit-preparation.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.visit-preparation.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.visit-preparation.footer",
  },
  {
    id: "delivery-preferences",
    useCase: "service",
    industry: "retail",
    goal: "inform",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.delivery-preferences.title",
    descriptionKey:
      "LandingDemo.templates.catalog.delivery-preferences.description",
    bodyKey: "LandingDemo.templates.catalog.delivery-preferences.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.delivery-preferences.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.delivery-preferences.footer",
  },
  {
    id: "return-request",
    useCase: "service",
    industry: "retail",
    goal: "retain",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.return-request.title",
    descriptionKey: "LandingDemo.templates.catalog.return-request.description",
    bodyKey: "LandingDemo.templates.catalog.return-request.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.return-request.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.return-request.footer",
  },
  {
    id: "pickup-ready",
    useCase: "service",
    industry: "retail",
    goal: "inform",
    format: "location",
    locales: ["en", "ru", "kz"],
    location: {
      latitude: 48.8584,
      longitude: 2.2945,
      name: "Demo pin: Eiffel Tower",
      address: "5 avenue Anatole France, 75007 Paris, France",
    },
    titleKey: "LandingDemo.templates.catalog.pickup-ready.title",
    descriptionKey: "LandingDemo.templates.catalog.pickup-ready.description",
    bodyKey: "LandingDemo.templates.catalog.pickup-ready.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.pickup-ready.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.pickup-ready.footer",
    localeAttachments: {
      ru: {
        location: {
          latitude: 48.8584,
          longitude: 2.2945,
          name: "Пример: Эйфелева башня",
          address: "Авеню Анатоль Франс, 5, 75007 Париж, Франция",
        },
      },
      kz: {
        location: {
          latitude: 48.8584,
          longitude: 2.2945,
          name: "Үлгі орын: Эйфель мұнарасы",
          address: "Анатоль Франс даңғылы, 5, 75007 Париж, Франция",
        },
      },
    },
  },
  {
    id: "repair-progress",
    useCase: "service",
    industry: "services",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.repair-progress.title",
    descriptionKey: "LandingDemo.templates.catalog.repair-progress.description",
    bodyKey: "LandingDemo.templates.catalog.repair-progress.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.repair-progress.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.repair-progress.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.repair-progress.footer",
  },
  {
    id: "service-completed",
    useCase: "service",
    industry: "services",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.service-completed.title",
    descriptionKey:
      "LandingDemo.templates.catalog.service-completed.description",
    bodyKey: "LandingDemo.templates.catalog.service-completed.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.service-completed.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.service-completed.footer",
  },
  {
    id: "refund-status",
    useCase: "service",
    industry: "finance",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.refund-status.title",
    descriptionKey: "LandingDemo.templates.catalog.refund-status.description",
    bodyKey: "LandingDemo.templates.catalog.refund-status.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.refund-status.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.refund-status.footer",
  },
  {
    id: "subscription-renewal",
    useCase: "service",
    industry: "finance",
    goal: "retain",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.subscription-renewal.title",
    descriptionKey:
      "LandingDemo.templates.catalog.subscription-renewal.description",
    bodyKey: "LandingDemo.templates.catalog.subscription-renewal.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.subscription-renewal.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.subscription-renewal.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.subscription-renewal.footer",
  },
  {
    id: "service-summary",
    useCase: "service",
    industry: "services",
    goal: "inform",
    format: "document",
    locales: ["en", "ru", "kz"],
    documentPath:
      "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/b03dd7848bfb1c26ad0d45e74295297aff0b33f930dfe770ed20b97a35008c4f-service-summary.pdf",
    documentFilename: "service-summary.pdf",
    titleKey: "LandingDemo.templates.catalog.service-summary.title",
    descriptionKey: "LandingDemo.templates.catalog.service-summary.description",
    bodyKey: "LandingDemo.templates.catalog.service-summary.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.service-summary.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.service-summary.footer",
    localeAttachments: {
      ru: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/90346214a162c17c0621938446ab013c50cbd77e5955c7a9493b8a49967a7f8b-service-summary-ru.pdf",
        documentFilename: "service-summary-ru.pdf",
      },
      kz: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/ff298a8cc69356dd3d4621946f9201c70bd8594d7190fddeb1a05276c259c04a-service-summary-kz.pdf",
        documentFilename: "service-summary-kz.pdf",
      },
    },
  },
  {
    id: "product-finder",
    useCase: "commerce",
    industry: "retail",
    goal: "convert",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.product-finder.title",
    descriptionKey: "LandingDemo.templates.catalog.product-finder.description",
    bodyKey: "LandingDemo.templates.catalog.product-finder.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.product-finder.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.product-finder.footer",
  },
  {
    id: "product-comparison",
    useCase: "commerce",
    industry: "retail",
    goal: "convert",
    format: "carousel",
    locales: ["en", "ru", "kz"],
    carouselImagePaths: [
      "/templates/back-in-stock-01.png",
      "/templates/back-in-stock-02.png",
      "/templates/back-in-stock-03.png",
    ],
    titleKey: "LandingDemo.templates.catalog.product-comparison.title",
    descriptionKey:
      "LandingDemo.templates.catalog.product-comparison.description",
    bodyKey: "LandingDemo.templates.catalog.product-comparison.body",
    buttonKeys: [],
    carouselPreviewKeys: [
      {
        bodyKey:
          "LandingDemo.templates.catalog.product-comparison.cards.0.body",
        buttonKeys: [
          {
            type: "URL",
            textKey:
              "LandingDemo.templates.catalog.product-comparison.cards.0.buttons.0",
            url: "https://www.airi.chat/",
          },
        ],
      },
      {
        bodyKey:
          "LandingDemo.templates.catalog.product-comparison.cards.1.body",
        buttonKeys: [
          {
            type: "URL",
            textKey:
              "LandingDemo.templates.catalog.product-comparison.cards.1.buttons.0",
            url: "https://www.airi.chat/",
          },
        ],
      },
      {
        bodyKey:
          "LandingDemo.templates.catalog.product-comparison.cards.2.body",
        buttonKeys: [
          {
            type: "URL",
            textKey:
              "LandingDemo.templates.catalog.product-comparison.cards.2.buttons.0",
            url: "https://www.airi.chat/",
          },
        ],
      },
    ],
  },
  {
    id: "room-styling",
    useCase: "commerce",
    industry: "retail",
    goal: "convert",
    format: "carousel",
    locales: ["en", "ru", "kz"],
    carouselImagePaths: [
      "/templates/back-in-stock-01.png",
      "/templates/back-in-stock-02.png",
      "/templates/back-in-stock-03.png",
    ],
    titleKey: "LandingDemo.templates.catalog.room-styling.title",
    descriptionKey: "LandingDemo.templates.catalog.room-styling.description",
    bodyKey: "LandingDemo.templates.catalog.room-styling.body",
    buttonKeys: [],
    carouselPreviewKeys: [
      {
        bodyKey: "LandingDemo.templates.catalog.room-styling.cards.0.body",
        buttonKeys: [
          {
            type: "URL",
            textKey:
              "LandingDemo.templates.catalog.room-styling.cards.0.buttons.0",
            url: "https://www.airi.chat/",
          },
        ],
      },
      {
        bodyKey: "LandingDemo.templates.catalog.room-styling.cards.1.body",
        buttonKeys: [
          {
            type: "URL",
            textKey:
              "LandingDemo.templates.catalog.room-styling.cards.1.buttons.0",
            url: "https://www.airi.chat/",
          },
        ],
      },
      {
        bodyKey: "LandingDemo.templates.catalog.room-styling.cards.2.body",
        buttonKeys: [
          {
            type: "URL",
            textKey:
              "LandingDemo.templates.catalog.room-styling.cards.2.buttons.0",
            url: "https://www.airi.chat/",
          },
        ],
      },
    ],
  },
  {
    id: "product-care",
    useCase: "commerce",
    industry: "retail",
    goal: "retain",
    format: "video",
    locales: ["en", "ru", "kz"],
    videoPath:
      "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/ca576f2e74ec330ef7d9497f2b6a676cee1b101923763fef71dc853faa2f35c8-product-care.mp4",
    videoPosterPath: "/templates/back-in-stock-01.png",
    titleKey: "LandingDemo.templates.catalog.product-care.title",
    descriptionKey: "LandingDemo.templates.catalog.product-care.description",
    bodyKey: "LandingDemo.templates.catalog.product-care.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.product-care.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.product-care.footer",
    localeAttachments: {
      ru: {
        videoPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/b29b550b301ca925fa8bff233c2e4986feac9606fb95b12c628339f218641c91-product-care-ru.mp4",
      },
      kz: {
        videoPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/4cb812f5d6826599fe5e88595da4175e814d88fac8c87500041047bdcca5e6f1-product-care-kz.mp4",
      },
    },
  },
  {
    id: "bundle-idea",
    useCase: "commerce",
    industry: "retail",
    goal: "convert",
    format: "image",
    locales: ["en", "ru", "kz"],
    imagePath: "/templates/repeat-purchase.png",
    titleKey: "LandingDemo.templates.catalog.bundle-idea.title",
    descriptionKey: "LandingDemo.templates.catalog.bundle-idea.description",
    bodyKey: "LandingDemo.templates.catalog.bundle-idea.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.bundle-idea.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.bundle-idea.footer",
  },
  {
    id: "sizing-guide",
    useCase: "commerce",
    industry: "retail",
    goal: "convert",
    format: "image",
    locales: ["en", "ru", "kz"],
    imagePath: "/templates/back-in-stock-02.png",
    titleKey: "LandingDemo.templates.catalog.sizing-guide.title",
    descriptionKey: "LandingDemo.templates.catalog.sizing-guide.description",
    bodyKey: "LandingDemo.templates.catalog.sizing-guide.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.sizing-guide.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.sizing-guide.footer",
  },
  {
    id: "gift-selection",
    useCase: "commerce",
    industry: "retail",
    goal: "convert",
    format: "image",
    locales: ["en", "ru", "kz"],
    imagePath: "/templates/birthday-offer.png",
    titleKey: "LandingDemo.templates.catalog.gift-selection.title",
    descriptionKey: "LandingDemo.templates.catalog.gift-selection.description",
    bodyKey: "LandingDemo.templates.catalog.gift-selection.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.gift-selection.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.gift-selection.buttons.1",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.gift-selection.buttons.2",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.gift-selection.footer",
  },
  {
    id: "onboarding-guide",
    useCase: "information",
    industry: "services",
    goal: "acquire",
    format: "document",
    locales: ["en", "ru", "kz"],
    documentPath:
      "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/e3298cbe879195f8db63ace75277955c312cced556c06a0269867ae57371a39d-onboarding-guide.pdf",
    documentFilename: "onboarding-guide.pdf",
    titleKey: "LandingDemo.templates.catalog.onboarding-guide.title",
    descriptionKey:
      "LandingDemo.templates.catalog.onboarding-guide.description",
    bodyKey: "LandingDemo.templates.catalog.onboarding-guide.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.onboarding-guide.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.onboarding-guide.footer",
    localeAttachments: {
      ru: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/caa676705b548dd113955290218fe27f1119300cf92fd7ac2b9992ecc290959f-onboarding-guide-ru.pdf",
        documentFilename: "onboarding-guide-ru.pdf",
      },
      kz: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/b3c5dada023ec6b308ce4ecce46cb417cee3f5975cf743916f93798a880b1b28-onboarding-guide-kz.pdf",
        documentFilename: "onboarding-guide-kz.pdf",
      },
    },
  },
  {
    id: "event-agenda",
    useCase: "information",
    industry: "services",
    goal: "inform",
    format: "document",
    locales: ["en", "ru", "kz"],
    documentPath:
      "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/648a70c681e9c30f0da1111b20774ca50c9b9525287ac20f17e9debf20c7d4b3-event-agenda.pdf",
    documentFilename: "event-agenda.pdf",
    titleKey: "LandingDemo.templates.catalog.event-agenda.title",
    descriptionKey: "LandingDemo.templates.catalog.event-agenda.description",
    bodyKey: "LandingDemo.templates.catalog.event-agenda.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.event-agenda.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.event-agenda.footer",
    localeAttachments: {
      ru: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/626923b93bc8c4bc3e0c70d6c8979bdde972579c93be0d39adbe8c65ea06efc9-event-agenda-ru.pdf",
        documentFilename: "event-agenda-ru.pdf",
      },
      kz: {
        documentPath:
          "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/41b51d55-697c-4455-875a-9a7238bdf272/public-demo/0b9ca52d35b60affa42862efc3eb3586ade14d0461007725a575e748ab141ebf-event-agenda-kz.pdf",
        documentFilename: "event-agenda-kz.pdf",
      },
    },
  },
  {
    id: "first-week-checklist",
    useCase: "learning",
    industry: "education",
    goal: "retain",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.first-week-checklist.title",
    descriptionKey:
      "LandingDemo.templates.catalog.first-week-checklist.description",
    bodyKey: "LandingDemo.templates.catalog.first-week-checklist.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.first-week-checklist.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.first-week-checklist.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.first-week-checklist.footer",
  },
  {
    id: "account-setup-checklist",
    useCase: "information",
    industry: "services",
    goal: "acquire",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.account-setup-checklist.title",
    descriptionKey:
      "LandingDemo.templates.catalog.account-setup-checklist.description",
    bodyKey: "LandingDemo.templates.catalog.account-setup-checklist.body",
    buttonKeys: [
      {
        type: "URL",
        textKey:
          "LandingDemo.templates.catalog.account-setup-checklist.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.account-setup-checklist.footer",
  },
  {
    id: "subscription-change-summary",
    useCase: "information",
    industry: "finance",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.subscription-change-summary.title",
    descriptionKey:
      "LandingDemo.templates.catalog.subscription-change-summary.description",
    bodyKey: "LandingDemo.templates.catalog.subscription-change-summary.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey:
          "LandingDemo.templates.catalog.subscription-change-summary.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey:
          "LandingDemo.templates.catalog.subscription-change-summary.buttons.1",
      },
    ],
    footerKey:
      "LandingDemo.templates.catalog.subscription-change-summary.footer",
  },
  {
    id: "privacy-request-acknowledgement",
    useCase: "information",
    industry: "services",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey:
      "LandingDemo.templates.catalog.privacy-request-acknowledgement.title",
    descriptionKey:
      "LandingDemo.templates.catalog.privacy-request-acknowledgement.description",
    bodyKey:
      "LandingDemo.templates.catalog.privacy-request-acknowledgement.body",
    buttonKeys: [
      {
        type: "URL",
        textKey:
          "LandingDemo.templates.catalog.privacy-request-acknowledgement.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey:
      "LandingDemo.templates.catalog.privacy-request-acknowledgement.footer",
  },
  {
    id: "contact-airi",
    useCase: "contacts",
    industry: "services",
    goal: "acquire",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.contact-airi.title",
    descriptionKey: "LandingDemo.templates.catalog.contact-airi.description",
    bodyKey: "LandingDemo.templates.catalog.contact-airi.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.contact-airi.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.contact-airi.footer",
  },
  {
    id: "preference-center",
    useCase: "contacts",
    industry: "services",
    goal: "retain",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.preference-center.title",
    descriptionKey:
      "LandingDemo.templates.catalog.preference-center.description",
    bodyKey: "LandingDemo.templates.catalog.preference-center.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.preference-center.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.preference-center.footer",
  },
  {
    id: "feedback-survey",
    useCase: "retention",
    industry: "services",
    goal: "retain",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.feedback-survey.title",
    descriptionKey: "LandingDemo.templates.catalog.feedback-survey.description",
    bodyKey: "LandingDemo.templates.catalog.feedback-survey.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.feedback-survey.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.feedback-survey.footer",
  },
  {
    id: "company-contact",
    useCase: "contacts",
    industry: "services",
    goal: "acquire",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.company-contact.title",
    descriptionKey: "LandingDemo.templates.catalog.company-contact.description",
    bodyKey: "LandingDemo.templates.catalog.company-contact.body",
    buttonKeys: [
      {
        type: "PHONE_NUMBER",
        textKey: "LandingDemo.templates.catalog.company-contact.buttons.0",
        phoneNumber: "+77082609346",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.company-contact.footer",
  },
  {
    id: "branch-directory",
    useCase: "contacts",
    industry: "services",
    goal: "inform",
    format: "location",
    locales: ["en", "ru", "kz"],
    location: {
      latitude: -33.8568,
      longitude: 151.2153,
      name: "Demo pin: Sydney Opera House",
      address: "Bennelong Point, Sydney NSW 2000, Australia",
    },
    titleKey: "LandingDemo.templates.catalog.branch-directory.title",
    descriptionKey:
      "LandingDemo.templates.catalog.branch-directory.description",
    bodyKey: "LandingDemo.templates.catalog.branch-directory.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.branch-directory.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.branch-directory.footer",
    localeAttachments: {
      ru: {
        location: {
          latitude: -33.8568,
          longitude: 151.2153,
          name: "Пример: Сиднейский оперный театр",
          address: "Беннелонг-Пойнт, Сидней, Новый Южный Уэльс 2000, Австралия",
        },
      },
      kz: {
        location: {
          latitude: -33.8568,
          longitude: 151.2153,
          name: "Үлгі орын: Сидней опера театры",
          address: "Беннелонг-Пойнт, Сидней, NSW 2000, Австралия",
        },
      },
    },
  },
  {
    id: "service-hours",
    useCase: "contacts",
    industry: "services",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.service-hours.title",
    descriptionKey: "LandingDemo.templates.catalog.service-hours.description",
    bodyKey: "LandingDemo.templates.catalog.service-hours.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.service-hours.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.service-hours.footer",
  },
  {
    id: "human-handoff",
    useCase: "contacts",
    industry: "services",
    goal: "inform",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.human-handoff.title",
    descriptionKey: "LandingDemo.templates.catalog.human-handoff.description",
    bodyKey: "LandingDemo.templates.catalog.human-handoff.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.human-handoff.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.human-handoff.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.human-handoff.footer",
  },
  {
    id: "learning-path",
    useCase: "learning",
    industry: "education",
    goal: "convert",
    format: "flow",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.learning-path.title",
    descriptionKey: "LandingDemo.templates.catalog.learning-path.description",
    bodyKey: "LandingDemo.templates.catalog.learning-path.body",
    buttonKeys: [
      {
        type: "FLOW",
        textKey: "LandingDemo.templates.catalog.learning-path.buttons.0",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.learning-path.footer",
  },
  {
    id: "lesson-recap",
    useCase: "learning",
    industry: "education",
    goal: "retain",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.lesson-recap.title",
    descriptionKey: "LandingDemo.templates.catalog.lesson-recap.description",
    bodyKey: "LandingDemo.templates.catalog.lesson-recap.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.lesson-recap.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.lesson-recap.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.lesson-recap.footer",
  },
  {
    id: "practice-challenge",
    useCase: "learning",
    industry: "education",
    goal: "retain",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.practice-challenge.title",
    descriptionKey:
      "LandingDemo.templates.catalog.practice-challenge.description",
    bodyKey: "LandingDemo.templates.catalog.practice-challenge.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.practice-challenge.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.practice-challenge.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.practice-challenge.footer",
  },
  {
    id: "study-plan",
    useCase: "learning",
    industry: "education",
    goal: "retain",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.study-plan.title",
    descriptionKey: "LandingDemo.templates.catalog.study-plan.description",
    bodyKey: "LandingDemo.templates.catalog.study-plan.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.study-plan.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.study-plan.footer",
  },
  {
    id: "webinar-follow-up",
    useCase: "learning",
    industry: "education",
    goal: "retain",
    format: "text",
    locales: ["en", "ru", "kz"],
    titleKey: "LandingDemo.templates.catalog.webinar-follow-up.title",
    descriptionKey:
      "LandingDemo.templates.catalog.webinar-follow-up.description",
    bodyKey: "LandingDemo.templates.catalog.webinar-follow-up.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.webinar-follow-up.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.webinar-follow-up.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.webinar-follow-up.footer",
  },
  {
    id: "loyalty-milestone",
    useCase: "retention",
    industry: "retail",
    goal: "retain",
    format: "image",
    locales: ["en", "ru", "kz"],
    imagePath: "/templates/birthday-offer.png",
    titleKey: "LandingDemo.templates.catalog.loyalty-milestone.title",
    descriptionKey:
      "LandingDemo.templates.catalog.loyalty-milestone.description",
    bodyKey: "LandingDemo.templates.catalog.loyalty-milestone.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.loyalty-milestone.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.loyalty-milestone.footer",
  },
  {
    id: "care-check-in",
    useCase: "retention",
    industry: "retail",
    goal: "retain",
    format: "image",
    locales: ["en", "ru", "kz"],
    imagePath: "/templates/repeat-purchase.png",
    titleKey: "LandingDemo.templates.catalog.care-check-in.title",
    descriptionKey: "LandingDemo.templates.catalog.care-check-in.description",
    bodyKey: "LandingDemo.templates.catalog.care-check-in.body",
    buttonKeys: [
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.care-check-in.buttons.0",
      },
      {
        type: "QUICK_REPLY",
        textKey: "LandingDemo.templates.catalog.care-check-in.buttons.1",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.care-check-in.footer",
  },
  {
    id: "community-invitation",
    useCase: "retention",
    industry: "retail",
    goal: "retain",
    format: "image",
    locales: ["en", "ru", "kz"],
    imagePath: "/templates/seasonal-offer.png",
    titleKey: "LandingDemo.templates.catalog.community-invitation.title",
    descriptionKey:
      "LandingDemo.templates.catalog.community-invitation.description",
    bodyKey: "LandingDemo.templates.catalog.community-invitation.body",
    buttonKeys: [
      {
        type: "URL",
        textKey: "LandingDemo.templates.catalog.community-invitation.buttons.0",
        url: "https://www.airi.chat/",
      },
    ],
    footerKey: "LandingDemo.templates.catalog.community-invitation.footer",
  },
];
