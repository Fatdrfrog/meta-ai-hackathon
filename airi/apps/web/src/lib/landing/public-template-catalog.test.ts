import en from "../../../messages/en.json";
import ru from "../../../messages/ru.json";
import kz from "../../../messages/kz.json";
import {
  PUBLIC_TEMPLATES,
  filterPublicTemplates,
  getPublicTemplate,
  getPublicTemplateFilters,
  getPublicTemplateText,
  getPublicTemplateButtons,
  getPublicTemplateFooter,
  getPublicTemplateCarouselPreviews,
  isPublicTemplateAvailableInLocale,
} from "./public-template-catalog";

function message(messages: unknown, key: string): string {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown>)[part],
      messages
    ) as string;
}

describe("Public WhatsApp template catalog", () => {
  it.each([
    [
      "en",
      en,
      "*airi.chat demo: seasonal offer*",
      "To unsubscribe: samat@airi.chat",
    ],
    [
      "ru",
      ru,
      "*Демо airi.chat: сезонное предложение*",
      "Для отказа от сообщений: samat@airi.chat",
    ],
    [
      "kz",
      kz,
      "*airi.chat демосы: маусымдық ұсыныс*",
      "Хабарламадан бас тарту: samat@airi.chat",
    ],
  ] as const)(
    "shows the complete original message in %s without changing the short landing copy",
    (locale, messages, prefix, footer) => {
      const template = getPublicTemplate("seasonal-offer", locale)!;
      const translate = (key: string) => message(messages, key);
      const body = getPublicTemplateText(template, "body", translate);
      expect(body.startsWith(prefix)).toBe(true);
      expect(body).toContain(translate(template.bodyKey!));
      expect(translate(template.bodyKey!)).not.toContain("airi.chat");
      expect(getPublicTemplateFooter(template, translate)).toBe(footer);
    }
  );

  it.each([
    [
      "en",
      en,
      "*Terra vase · demo product*",
      "Explore airi.chat",
      "To unsubscribe: samat@airi.chat",
    ],
    [
      "ru",
      ru,
      "*Ваза Terra · пример товара*",
      "Открыть airi.chat",
      "Для отказа от сообщений: samat@airi.chat",
    ],
    [
      "kz",
      kz,
      "*Terra вазасы · демо тауар*",
      "airi.chat ашу",
      "Хабарламадан бас тарту: samat@airi.chat",
    ],
  ] as const)(
    "matches the original carousel card structure in %s",
    (locale, messages, firstBody, button, unsubscribe) => {
      const template = getPublicTemplate("back-in-stock", locale)!;
      const translate = (key: string) => message(messages, key);
      expect(getPublicTemplateButtons(template, translate)).toEqual([]);
      const cards = getPublicTemplateCarouselPreviews(template, translate);
      expect(cards).toHaveLength(3);
      expect(cards[0].body).toBe(firstBody);
      expect(
        cards.every(
          card =>
            card.buttons.length === 1 &&
            card.buttons[0].text === button &&
            card.buttons[0].type === "URL"
        )
      ).toBe(true);
      expect(getPublicTemplateFooter(template, translate)).toBe("");
      expect(
        getPublicTemplateText(template, "body", translate).endsWith(unsubscribe)
      ).toBe(true);
    }
  );
  it("has unique, stable IDs and complete localized previews", () => {
    expect(PUBLIC_TEMPLATES).toHaveLength(62);
    expect(new Set(PUBLIC_TEMPLATES.map(template => template.id)).size).toBe(
      62
    );
    for (const [locale, messages] of [
      ["en", en],
      ["ru", ru],
      ["kz", kz],
    ] as const) {
      for (const template of PUBLIC_TEMPLATES.filter(item =>
        isPublicTemplateAvailableInLocale(item, locale)
      )) {
        for (const field of ["title", "body", "description"] as const) {
          expect(
            getPublicTemplateText(template, field, key =>
              message(messages, key)
            ).trim()
          ).toBeTruthy();
        }
        expect(
          [
            ...getPublicTemplateButtons(template, key =>
              message(messages, key)
            ),
            ...getPublicTemplateCarouselPreviews(template, key =>
              message(messages, key)
            ).flatMap(card => card.buttons),
          ].length
        ).toBeGreaterThan(0);
        for (const button of getPublicTemplateButtons(template, key =>
          message(messages, key)
        ))
          expect(button.text.trim()).toBeTruthy();
      }
    }
    expect(getPublicTemplate("missing")).toBeUndefined();
  });

  it("reuses the exact landing campaign, recovery and repeat copy", () => {
    expect(getPublicTemplate("seasonal-offer")?.bodyKey).toBe(
      "LandingDemo.revenueWorkflows.campaign.message"
    );
    expect(getPublicTemplate("abandoned-cart")?.bodyKey).toBe(
      "LandingDemo.revenueWorkflows.recovery.message"
    );
    expect(getPublicTemplate("repeat-purchase")?.bodyKey).toBe(
      "LandingDemo.revenueWorkflows.repeat.message"
    );
  });

  it("normalizes invalid URL filters and composes valid filters", () => {
    expect(
      getPublicTemplateFilters(
        new URLSearchParams("q=+cart+&industry=nope&format=invalid&goal=nope")
      )
    ).toEqual({ q: "cart", industry: "", format: "", goal: "", useCase: "" });
    const filters = getPublicTemplateFilters(
      new URLSearchParams("industry=retail&goal=retain&format=image")
    );
    expect(
      filterPublicTemplates(filters, key => message(ru, key), "ru").map(
        template => template.id
      )
    ).toEqual([
      "repeat-purchase",
      "birthday-offer",
      "loyalty-milestone",
      "care-check-in",
      "community-invitation",
    ]);
    expect(filterPublicTemplates(filters)).toHaveLength(5);
  });

  it("searches localized sample content and yields an empty result when no entry matches", () => {
    expect(
      filterPublicTemplates(
        { q: "refresh a calm corner", industry: "", goal: "", format: "" },
        key => message(en, key)
      ).map(template => template.id)
    ).toContain("seasonal-offer");
    expect(
      filterPublicTemplates(
        { q: "nonexistent sample 999", industry: "", goal: "", format: "" },
        key => message(en, key)
      )
    ).toEqual([]);
  });

  it("normalizes use-case filters and keeps distinct learning jobs discoverable", () => {
    expect(
      getPublicTemplateFilters(new URLSearchParams("useCase=unknown"))
    ).toMatchObject({ useCase: "" });
    const filters = getPublicTemplateFilters(
      new URLSearchParams("useCase=learning")
    );
    expect(filters.useCase).toBe("learning");
    expect(filterPublicTemplates(filters).map(template => template.id)).toEqual(
      [
        "first-week-checklist",
        "learning-path",
        "lesson-recap",
        "practice-challenge",
        "study-plan",
        "webinar-follow-up",
      ]
    );
  });

  it.each([
    ["en", en, "Contacts & preferences"],
    ["ru", ru, "Контакты и предпочтения"],
    ["kz", kz, "Байланыс және қалаулар"],
  ] as const)(
    "searches the translated use case in %s",
    (locale, messages, query) => {
      const matches = filterPublicTemplates(
        { q: query, industry: "", goal: "", format: "" },
        key => message(messages, key),
        locale
      );
      expect(matches.map(template => template.id)).toEqual([
        "contact-airi",
        "preference-center",
        "company-contact",
        "branch-directory",
        "service-hours",
        "human-handoff",
      ]);
    }
  );

  it("keeps related product jobs distinct without inventing a tracking destination", () => {
    const translate = (key: string) => message(en, key);
    expect(getPublicTemplate("repeat-purchase")?.useCase).toBe("retention");
    expect(getPublicTemplate("bundle-idea")?.useCase).toBe("commerce");
    expect(getPublicTemplate("seasonal-offer")?.titleKey).toBe(
      "LandingDemo.templates.catalog.seasonal-offer.title"
    );
    expect(getPublicTemplate("abandoned-cart")?.titleKey).toBe(
      "LandingDemo.templates.catalog.abandoned-cart.title"
    );
    expect(
      getPublicTemplateText(
        getPublicTemplate("shipping-update")!,
        "description",
        translate
      )
    ).not.toMatch(/tracking link/i);
    expect(
      getPublicTemplateText(
        getPublicTemplate("account-setup-checklist")!,
        "title",
        translate
      )
    ).toMatch(/pilot/i);
  });

  it("exposes the same 62 examples with complete translated previews in every locale", () => {
    const filters = { q: "", industry: "", goal: "", format: "" } as const;
    expect(
      filterPublicTemplates(filters, key => message(en, key), "en")
    ).toHaveLength(62);
    const examples = PUBLIC_TEMPLATES.filter(template => template.locales);
    expect(examples).toHaveLength(50);
    for (const [locale, messages] of Object.entries({ en, ru, kz })) {
      const translate = (key: string) => message(messages, key);
      const localized = filterPublicTemplates(
        filters,
        translate,
        locale as "en" | "ru" | "kz"
      );
      expect(localized).toHaveLength(62);
      expect(localized.map(template => template.id)).toEqual(
        PUBLIC_TEMPLATES.map(template => template.id)
      );
      for (const template of localized) {
        expect(
          getPublicTemplateText(template, "title", translate)?.trim()
        ).toBeTruthy();
        expect(getPublicTemplateText(template, "body", translate)).toContain(
          "airi.chat"
        );
        expect(getPublicTemplateText(template, "body", translate)).not.toMatch(
          /\{\{/
        );
        expect(
          getPublicTemplateText(template, "description", translate)?.trim()
        ).toBeTruthy();
        const buttons = [
          ...getPublicTemplateButtons(template, translate),
          ...getPublicTemplateCarouselPreviews(template, translate).flatMap(
            card => card.buttons
          ),
        ];
        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) {
          expect(button.text?.trim()).toBeTruthy();
          expect(button.text.length).toBeLessThanOrEqual(25);
        }
      }
    }
    const translate = (key: string) => message(en, key);
    for (const id of ["product-comparison", "room-styling"]) {
      expect(
        getPublicTemplateButtons(getPublicTemplate(id)!, translate)
      ).toEqual([]);
      expect(
        getPublicTemplateCarouselPreviews(
          getPublicTemplate(id)!,
          translate
        ).every(card => card.buttons.length === 1)
      ).toBe(true);
    }
  });

  it("filters the added attachment formats and searches their fixed demo values", () => {
    for (const [format, count] of [
      ["document", 4],
      ["location", 2],
      ["video", 1],
    ] as const) {
      const filters = getPublicTemplateFilters(
        new URLSearchParams(`format=${format}`)
      );
      expect(filterPublicTemplates(filters)).toHaveLength(count);
      for (const [locale, messages] of Object.entries({ en, ru, kz }))
        expect(
          filterPublicTemplates(
            filters,
            key => message(messages, key),
            locale as "en" | "ru" | "kz"
          )
        ).toHaveLength(count);
    }
    const filters = getPublicTemplateFilters(new URLSearchParams("q=Q-204"));
    expect(
      filterPublicTemplates(filters, key => message(en, key)).map(
        template => template.id
      )
    ).toEqual(["quote-ready", "quote-question"]);
    expect(getPublicTemplate("quote-ready")?.documentFilename).toBe(
      "quote-ready.pdf"
    );
    expect(getPublicTemplate("product-care")?.videoPath).toMatch(/^https:\/\//);
    expect(getPublicTemplate("pickup-ready")?.location?.name).toBe(
      "Demo pin: Eiffel Tower"
    );
  });

  it.each(["ru", "kz"] as const)(
    "selects %s attachment URLs consistently for cards and dialogs",
    locale => {
      const filters = getPublicTemplateFilters(
        new URLSearchParams("format=document")
      );
      for (const card of filterPublicTemplates(filters, key => key, locale)) {
        const dialog = getPublicTemplate(card.id, locale)!;
        expect(card.documentPath).toBe(dialog.documentPath);
        expect(card.documentFilename).toBe(`${card.id}-${locale}.pdf`);
        expect(card.documentPath).toContain(`-${locale}.pdf`);
      }
      expect(getPublicTemplate("product-care", locale)?.videoPath).toContain(
        `product-care-${locale}.mp4`
      );
      expect(
        getPublicTemplate("pickup-ready", locale)?.location?.latitude
      ).toBe(48.8584);
      expect(
        getPublicTemplate("pickup-ready", locale)?.location?.name
      ).not.toBe(getPublicTemplate("pickup-ready", "en")?.location?.name);
    }
  );

  it("uses the enhanced localized reply labels without changing the original keys", () => {
    const template = getPublicTemplate("abandoned-cart")!;
    expect(
      getPublicTemplateButtons(template, key => message(en, key)).map(
        button => button.text
      )
    ).toEqual(["Show options", "Ask a question"]);
    expect(
      getPublicTemplateButtons(template, key => message(ru, key)).every(
        button => button.text.length > 0
      )
    ).toBe(true);
    expect(
      getPublicTemplateText(template, "body", key => message(en, key))
    ).toContain("*Sora*");
  });
});
