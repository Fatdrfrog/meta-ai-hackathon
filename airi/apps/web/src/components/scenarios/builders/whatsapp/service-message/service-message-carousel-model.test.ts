import type { ScenarioWhatsAppCarouselCard } from "@icecore/scenario-contracts";
import {
  applyServiceMessageCarouselIntent,
  createCarouselDraftCards,
  projectServiceMessageCarousel,
} from "./service-message-carousel-model";

function quickReplyCard(
  id: string,
  optionLabels: string[]
): ScenarioWhatsAppCarouselCard {
  return {
    id,
    media: { mediaType: "image", url: "" },
    interaction: {
      kind: "quick_replies",
      options: optionLabels.map((label, index) => ({
        id: `${id}-${index + 1}`,
        label,
      })),
    },
  };
}

function urlCard(id: string): ScenarioWhatsAppCarouselCard {
  return {
    id,
    media: { mediaType: "image", url: "" },
    interaction: {
      kind: "url",
      buttonLabel: "Visit",
      url: "https://example.com",
    },
  };
}

function createIds(...ids: string[]) {
  let index = 0;
  return () => ids[index++] ?? `generated-${index}`;
}

describe("service message carousel model", () => {
  it("creates the minimum uniform quick-reply draft", () => {
    const cards = createCarouselDraftCards({
      createCardId: createIds("card-1", "card-2"),
      createOptionId: createIds("option-1", "option-2"),
    });

    expect(cards).toHaveLength(2);
    expect(cards.map(card => card.id)).toEqual(["card-1", "card-2"]);
    expect(
      cards.map(card =>
        card.interaction.kind === "quick_replies"
          ? card.interaction.options.length
          : 0
      )
    ).toEqual([1, 1]);
  });

  it("normalizes every mixed quick-reply card when adding a row", () => {
    const cards = [
      quickReplyCard("one", ["One"]),
      quickReplyCard("two", ["One", "Two", "Three"]),
    ];

    const next = applyServiceMessageCarouselIntent(
      cards,
      { type: "add_option" },
      {
        createCardId: createIds(),
        createOptionId: createIds("one-new"),
      }
    );

    expect(
      next.map(card =>
        card.interaction.kind === "quick_replies"
          ? card.interaction.options.map(option => option.label)
          : []
      )
    ).toEqual([
      ["One", ""],
      ["One", "Two"],
    ]);
  });

  it("normalizes every mixed quick-reply card when removing a row", () => {
    const cards = [
      quickReplyCard("one", ["One", "Two"]),
      quickReplyCard("two", ["One"]),
    ];

    const next = applyServiceMessageCarouselIntent(
      cards,
      { type: "remove_option" },
      {
        createCardId: createIds(),
        createOptionId: createIds(),
      }
    );

    expect(
      next.map(card =>
        card.interaction.kind === "quick_replies"
          ? card.interaction.options.length
          : 0
      )
    ).toEqual([1, 1]);
  });

  it("switches every card to one interaction family and bounded count", () => {
    const cards = [quickReplyCard("one", ["One", "Two"]), urlCard("two")];

    const next = applyServiceMessageCarouselIntent(
      cards,
      { type: "set_interaction_kind", kind: "quick_replies" },
      {
        createCardId: createIds(),
        createOptionId: createIds("new-1", "new-2"),
      }
    );

    expect(projectServiceMessageCarousel(next)).toMatchObject({
      interactionKind: "quick_replies",
      optionCount: 2,
      uniform: true,
    });
    expect(
      next.map(card =>
        card.interaction.kind === "quick_replies"
          ? card.interaction.options.length
          : 0
      )
    ).toEqual([2, 2]);
  });

  it("adds a card after normalizing existing cards to the projected shape", () => {
    const cards = [
      quickReplyCard("one", ["One", "Two"]),
      quickReplyCard("two", ["One"]),
    ];

    const next = applyServiceMessageCarouselIntent(
      cards,
      { type: "add_card" },
      {
        createCardId: createIds("card-3"),
        createOptionId: createIds("two-new", "card-3-1", "card-3-2"),
      }
    );

    expect(next).toHaveLength(3);
    expect(projectServiceMessageCarousel(next).uniform).toBe(true);
    expect(
      next.map(card =>
        card.interaction.kind === "quick_replies"
          ? card.interaction.options.length
          : 0
      )
    ).toEqual([2, 2, 2]);
  });

  it("does not remove a card below the WhatsApp minimum", () => {
    const cards = [
      quickReplyCard("one", ["One"]),
      quickReplyCard("two", ["One"]),
    ];

    expect(
      applyServiceMessageCarouselIntent(
        cards,
        { type: "remove_card", cardId: "one" },
        {
          createCardId: createIds(),
          createOptionId: createIds(),
        }
      )
    ).toBe(cards);
  });
});
