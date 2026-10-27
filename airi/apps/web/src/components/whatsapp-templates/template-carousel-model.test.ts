import {
  applyTemplateCarouselIntent,
  canSetTemplateCarouselButtonType,
  createTemplateCarouselDraftCards,
  parseTemplateCarouselCardsFromComponent,
  projectTemplateCarousel,
  type TemplateCarouselCardFormValue,
} from "./template-carousel-model";

/** Cards as a Meta template with a quick reply then a URL button loads. */
function mixedButtonCards(): TemplateCarouselCardFormValue[] {
  return parseTemplateCarouselCardsFromComponent({
    type: "CAROUSEL",
    cards: ["one", "two"].map(name => ({
      components: [
        {
          type: "HEADER" as const,
          format: "IMAGE" as const,
          example: { header_handle: [`https://cdn.example.com/${name}.png`] },
        },
        { type: "BODY" as const, text: `Card ${name}` },
        {
          type: "BUTTONS" as const,
          buttons: [
            { type: "QUICK_REPLY" as const, text: "Interested" },
            {
              type: "URL" as const,
              text: "Buy",
              url: `https://shop.example.com/${name}`,
            },
          ],
        },
      ],
    })),
  });
}

function buttonShapes(cards: TemplateCarouselCardFormValue[]) {
  return cards.map(card =>
    card.buttons.map(button => ({
      type: button.type,
      text: button.text,
      url: button.url,
      phone_number: button.phone_number,
    }))
  );
}

describe("template-carousel-model", () => {
  it("starts with two uniform quick-reply cards", () => {
    const cards = createTemplateCarouselDraftCards();
    const projection = projectTemplateCarousel(cards);

    expect(cards).toHaveLength(2);
    expect(projection.headerFormat).toBe("IMAGE");
    expect(projection.buttonTypes).toEqual(["QUICK_REPLY"]);
    expect(projection.uniform).toBe(true);
    expect(projection.canRemoveCard).toBe(false);
    expect(projection.canAddButton).toBe(true);
    expect(projection.canRemoveButton).toBe(false);
  });

  it("keeps header format and button types uniform across cards", () => {
    const cards = applyTemplateCarouselIntent(
      applyTemplateCarouselIntent(createTemplateCarouselDraftCards(), {
        type: "set_header_format",
        format: "VIDEO",
      }),
      { type: "set_button_type", slot: 0, buttonType: "URL" }
    );

    expect(cards.every(card => card.headerFormat === "VIDEO")).toBe(true);
    expect(
      cards.every(card => card.buttons.every(button => button.type === "URL"))
    ).toBe(true);
  });

  it("projects a template with mixed button types slot by slot", () => {
    const projection = projectTemplateCarousel(mixedButtonCards());

    expect(projection.buttonTypes).toEqual(["QUICK_REPLY", "URL"]);
    expect(projection.uniform).toBe(true);
    expect(projection.canAddButton).toBe(false);
    expect(projection.canRemoveButton).toBe(true);
  });

  it("changes one slot's type on every card and leaves the other slot", () => {
    const cards = applyTemplateCarouselIntent(mixedButtonCards(), {
      type: "set_button_type",
      slot: 0,
      buttonType: "PHONE_NUMBER",
    });

    expect(buttonShapes(cards)).toEqual([
      [
        { type: "PHONE_NUMBER", text: "Interested", phone_number: "" },
        { type: "URL", text: "Buy", url: "https://shop.example.com/one" },
      ],
      [
        { type: "PHONE_NUMBER", text: "Interested", phone_number: "" },
        { type: "URL", text: "Buy", url: "https://shop.example.com/two" },
      ],
    ]);
  });

  it("adds a quick-reply slot after the existing buttons on every card", () => {
    const cards = applyTemplateCarouselIntent(
      applyTemplateCarouselIntent(createTemplateCarouselDraftCards(), {
        type: "set_button_type",
        slot: 0,
        buttonType: "URL",
      }),
      { type: "add_button" }
    );

    expect(projectTemplateCarousel(cards).buttonTypes).toEqual([
      "URL",
      "QUICK_REPLY",
    ]);
    expect(projectTemplateCarousel(cards).uniform).toBe(true);
    expect(applyTemplateCarouselIntent(cards, { type: "add_button" })).toBe(
      cards
    );
  });

  it("removes the chosen slot from every card, not the last one", () => {
    const cards = applyTemplateCarouselIntent(mixedButtonCards(), {
      type: "remove_button",
      slot: 0,
    });

    expect(buttonShapes(cards)).toEqual([
      [{ type: "URL", text: "Buy", url: "https://shop.example.com/one" }],
      [{ type: "URL", text: "Buy", url: "https://shop.example.com/two" }],
    ]);
    expect(
      applyTemplateCarouselIntent(cards, { type: "remove_button", slot: 0 })
    ).toBe(cards);
  });

  it("keeps a card to one phone button", () => {
    const cards = applyTemplateCarouselIntent(mixedButtonCards(), {
      type: "set_button_type",
      slot: 1,
      buttonType: "PHONE_NUMBER",
    });
    const { buttonTypes } = projectTemplateCarousel(cards);

    expect(buttonTypes).toEqual(["QUICK_REPLY", "PHONE_NUMBER"]);
    expect(
      canSetTemplateCarouselButtonType(buttonTypes, 0, "PHONE_NUMBER")
    ).toBe(false);
    expect(
      canSetTemplateCarouselButtonType(buttonTypes, 1, "PHONE_NUMBER")
    ).toBe(true);
    expect(
      applyTemplateCarouselIntent(cards, {
        type: "set_button_type",
        slot: 0,
        buttonType: "PHONE_NUMBER",
      })
    ).toBe(cards);
  });

  it("ignores slots that do not exist", () => {
    const cards = mixedButtonCards();

    expect(
      applyTemplateCarouselIntent(cards, { type: "remove_button", slot: 2 })
    ).toBe(cards);
    expect(
      applyTemplateCarouselIntent(cards, {
        type: "set_button_type",
        slot: -1,
        buttonType: "URL",
      })
    ).toBe(cards);
  });

  it("keeps mixed button types when the media type changes or a card is added", () => {
    const original = buttonShapes(mixedButtonCards());
    const video = applyTemplateCarouselIntent(mixedButtonCards(), {
      type: "set_header_format",
      format: "VIDEO",
    });
    const added = applyTemplateCarouselIntent(mixedButtonCards(), {
      type: "add_card",
    });

    expect(video.every(card => card.headerFormat === "VIDEO")).toBe(true);
    expect(buttonShapes(video)).toEqual(original);
    expect(buttonShapes(added)).toEqual([
      ...original,
      [
        { type: "QUICK_REPLY", text: "" },
        { type: "URL", text: "", url: "" },
      ],
    ]);
    expect(projectTemplateCarousel(added).uniform).toBe(true);
  });

  it("parses Meta carousel components back into form cards", () => {
    const cards = parseTemplateCarouselCardsFromComponent({
      type: "CAROUSEL",
      cards: [
        {
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: { header_handle: ["https://cdn.example.com/one.png"] },
            },
            { type: "BODY", text: "One" },
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Pick" }],
            },
          ],
        },
        {
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: { header_handle: ["https://cdn.example.com/two.png"] },
            },
            { type: "BODY", text: "Two" },
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Pick" }],
            },
          ],
        },
      ],
    });

    expect(cards).toHaveLength(2);
    expect(cards[0]?.bodyText).toBe("One");
    expect(cards[0]?.headerMediaExample).toBe(
      "https://cdn.example.com/one.png"
    );
    expect(cards[1]?.buttons[0]?.text).toBe("Pick");
  });

  it("keeps button labels when a slot's type changes", () => {
    const firstCard = createTemplateCarouselDraftCards();
    firstCard[0] = {
      ...firstCard[0]!,
      buttons: firstCard[0]!.buttons.map(button => ({
        ...button,
        text: "Shop now",
      })),
    };
    firstCard[1] = {
      ...firstCard[1]!,
      buttons: firstCard[1]!.buttons.map(button => ({
        ...button,
        text: "Shop now",
      })),
    };

    const cards = applyTemplateCarouselIntent(firstCard, {
      type: "set_button_type",
      slot: 0,
      buttonType: "URL",
    });

    expect(cards.every(card => card.buttons[0]?.type === "URL")).toBe(true);
    expect(cards.every(card => card.buttons[0]?.text === "Shop now")).toBe(true);
    expect(cards.every(card => card.buttons[0]?.url === "")).toBe(true);
  });
});
