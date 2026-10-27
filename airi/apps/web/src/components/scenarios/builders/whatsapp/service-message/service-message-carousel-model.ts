import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppCarouselCard,
} from "@icecore/scenario-contracts";

export type ServiceMessageCarouselInteractionKind =
  ScenarioWhatsAppCarouselCard["interaction"]["kind"];

export type ServiceMessageCarouselModelDependencies = {
  createCardId: () => string;
  createOptionId: () => string;
};

export type ServiceMessageCarouselIntent =
  | { type: "add_card" }
  | { type: "remove_card"; cardId: string }
  | {
      type: "set_interaction_kind";
      kind: ServiceMessageCarouselInteractionKind;
    }
  | { type: "add_option" }
  | { type: "remove_option" };

const MIN_CARD_COUNT = WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.min;
const MAX_CARD_COUNT = WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.max;
const MIN_OPTION_COUNT = WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.min;
const MAX_OPTION_COUNT = WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max;

function clampOptionCount(value: number): number {
  return Math.min(MAX_OPTION_COUNT, Math.max(MIN_OPTION_COUNT, value));
}

function createInteraction(params: {
  kind: ServiceMessageCarouselInteractionKind;
  optionCount: number;
  createOptionId: () => string;
}): ScenarioWhatsAppCarouselCard["interaction"] {
  return params.kind === "url"
    ? { kind: "url", buttonLabel: "", url: "" }
    : {
        kind: "quick_replies",
        options: Array.from(
          { length: clampOptionCount(params.optionCount) },
          () => ({
            id: params.createOptionId(),
            label: "",
          })
        ),
      };
}

function createCard(params: {
  kind: ServiceMessageCarouselInteractionKind;
  optionCount: number;
  dependencies: ServiceMessageCarouselModelDependencies;
}): ScenarioWhatsAppCarouselCard {
  return {
    id: params.dependencies.createCardId(),
    media: { url: "", mediaType: "image" },
    interaction: createInteraction({
      kind: params.kind,
      optionCount: params.optionCount,
      createOptionId: params.dependencies.createOptionId,
    }),
  };
}

export function createCarouselDraftCards(
  dependencies: ServiceMessageCarouselModelDependencies
): ScenarioWhatsAppCarouselCard[] {
  return Array.from({ length: MIN_CARD_COUNT }, () =>
    createCard({
      kind: "quick_replies",
      optionCount: MIN_OPTION_COUNT,
      dependencies,
    })
  );
}

export function projectServiceMessageCarousel(
  cards: ScenarioWhatsAppCarouselCard[]
) {
  const interactionKind = cards[0]?.interaction.kind ?? "quick_replies";
  const optionCount =
    cards[0]?.interaction.kind === "quick_replies"
      ? clampOptionCount(cards[0].interaction.options.length)
      : MIN_OPTION_COUNT;
  const uniform = cards.every(
    card =>
      card.interaction.kind === interactionKind &&
      (interactionKind !== "quick_replies" ||
        (card.interaction.kind === "quick_replies" &&
          card.interaction.options.length === optionCount))
  );
  const hasUserInteractionContent = cards.some(card =>
    card.interaction.kind === "url"
      ? Boolean(
          card.interaction.buttonLabel.trim() || card.interaction.url.trim()
        )
      : card.interaction.options.some(option => option.label.trim())
  );

  return {
    interactionKind,
    optionCount,
    uniform,
    hasUserInteractionContent,
    canAddCard: cards.length < MAX_CARD_COUNT,
    canRemoveCard: cards.length > MIN_CARD_COUNT,
    canAddOption:
      interactionKind === "quick_replies" && optionCount < MAX_OPTION_COUNT,
    canRemoveOption:
      interactionKind === "quick_replies" && optionCount > MIN_OPTION_COUNT,
  } as const;
}

function normalizeCards(params: {
  cards: ScenarioWhatsAppCarouselCard[];
  kind: ServiceMessageCarouselInteractionKind;
  optionCount: number;
  dependencies: ServiceMessageCarouselModelDependencies;
  replaceInteractions?: boolean;
}): ScenarioWhatsAppCarouselCard[] {
  const targetOptionCount = clampOptionCount(params.optionCount);

  return params.cards.map(card => {
    if (params.replaceInteractions || card.interaction.kind !== params.kind) {
      return {
        ...card,
        interaction: createInteraction({
          kind: params.kind,
          optionCount: targetOptionCount,
          createOptionId: params.dependencies.createOptionId,
        }),
      };
    }

    if (card.interaction.kind === "url") return card;

    const options = card.interaction.options.slice(0, targetOptionCount);
    while (options.length < targetOptionCount) {
      options.push({
        id: params.dependencies.createOptionId(),
        label: "",
      });
    }

    return {
      ...card,
      interaction: {
        kind: "quick_replies",
        options,
      },
    };
  });
}

export function applyServiceMessageCarouselIntent(
  cards: ScenarioWhatsAppCarouselCard[],
  intent: ServiceMessageCarouselIntent,
  dependencies: ServiceMessageCarouselModelDependencies
): ScenarioWhatsAppCarouselCard[] {
  const projection = projectServiceMessageCarousel(cards);

  switch (intent.type) {
    case "add_card": {
      if (cards.length === 0) return createCarouselDraftCards(dependencies);
      if (!projection.canAddCard) return cards;
      const normalized = normalizeCards({
        cards,
        kind: projection.interactionKind,
        optionCount: projection.optionCount,
        dependencies,
      });
      return [
        ...normalized,
        createCard({
          kind: projection.interactionKind,
          optionCount: projection.optionCount,
          dependencies,
        }),
      ];
    }
    case "remove_card":
      return projection.canRemoveCard
        ? cards.filter(card => card.id !== intent.cardId)
        : cards;
    case "set_interaction_kind": {
      const sourceCards =
        cards.length > 0 ? cards : createCarouselDraftCards(dependencies);
      return normalizeCards({
        cards: sourceCards,
        kind: intent.kind,
        optionCount: projection.optionCount,
        dependencies,
        replaceInteractions: intent.kind !== projection.interactionKind,
      });
    }
    case "add_option":
      if (projection.interactionKind !== "quick_replies") return cards;
      return normalizeCards({
        cards,
        kind: "quick_replies",
        optionCount: projection.optionCount + 1,
        dependencies,
      });
    case "remove_option":
      if (projection.interactionKind !== "quick_replies") return cards;
      return normalizeCards({
        cards,
        kind: "quick_replies",
        optionCount: projection.optionCount - 1,
        dependencies,
      });
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}
