import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import type {
  WhatsAppCarouselCard,
  WhatsAppCarouselCardHeaderFormat,
  WhatsAppComponent,
} from "@icecore/shared/types/whatsapp";

export const TEMPLATE_CAROUSEL_BUTTON_TYPES = [
  "QUICK_REPLY",
  "URL",
  "PHONE_NUMBER",
] as const;

export type TemplateCarouselButtonType =
  (typeof TEMPLATE_CAROUSEL_BUTTON_TYPES)[number];

export type TemplateCarouselCardButtonFormValue = {
  clientId: string;
  type: TemplateCarouselButtonType;
  text?: string;
  url?: string;
  phone_number?: string;
};

export type TemplateCarouselCardFormValue = {
  clientId: string;
  headerFormat: WhatsAppCarouselCardHeaderFormat;
  headerMediaExample: string;
  bodyText: string;
  buttons: TemplateCarouselCardButtonFormValue[];
};

/**
 * A `slot` is a button's place on a card. Meta requires every card to carry
 * the same button types in the same order, so a slot's type applies to every
 * card while its label, link, and phone number stay per card.
 */
export type TemplateCarouselIntent =
  | { type: "add_card" }
  | { type: "remove_card"; clientId: string }
  | { type: "set_header_format"; format: WhatsAppCarouselCardHeaderFormat }
  | {
      type: "set_button_type";
      slot: number;
      buttonType: TemplateCarouselButtonType;
    }
  | { type: "add_button" }
  | { type: "remove_button"; slot: number };

const MIN_CARD_COUNT = WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MIN;
const MAX_CARD_COUNT = WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MAX;
const MIN_BUTTON_COUNT = 1;
const MAX_BUTTON_COUNT = WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BUTTONS_MAX_COUNT;
const NEW_BUTTON_TYPE: TemplateCarouselButtonType = "QUICK_REPLY";

function createClientId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createButton(
  type: TemplateCarouselButtonType,
  text = ""
): TemplateCarouselCardButtonFormValue {
  return {
    clientId: createClientId("carousel-btn"),
    type,
    text,
    url: type === "URL" ? "" : undefined,
    phone_number: type === "PHONE_NUMBER" ? "" : undefined,
  };
}

function createCard(params: {
  headerFormat: WhatsAppCarouselCardHeaderFormat;
  buttonTypes: readonly TemplateCarouselButtonType[];
}): TemplateCarouselCardFormValue {
  return {
    clientId: createClientId("carousel-card"),
    headerFormat: params.headerFormat,
    headerMediaExample: "",
    bodyText: "",
    buttons: params.buttonTypes.map(buttonType => createButton(buttonType)),
  };
}

export function createTemplateCarouselDraftCards(): TemplateCarouselCardFormValue[] {
  return Array.from({ length: MIN_CARD_COUNT }, () =>
    createCard({ headerFormat: "IMAGE", buttonTypes: [NEW_BUTTON_TYPE] })
  );
}

/** The first card's button types, slot by slot; every card follows them. */
function readButtonSlotTypes(
  card: TemplateCarouselCardFormValue | undefined
): TemplateCarouselButtonType[] {
  const buttonTypes = (card?.buttons ?? [])
    .slice(0, MAX_BUTTON_COUNT)
    .map(button => button.type);
  return buttonTypes.length > 0 ? buttonTypes : [NEW_BUTTON_TYPE];
}

export function projectTemplateCarousel(
  cards: TemplateCarouselCardFormValue[]
) {
  const headerFormat = cards[0]?.headerFormat ?? "IMAGE";
  const buttonTypes = readButtonSlotTypes(cards[0]);
  const uniform = cards.every(
    card =>
      card.headerFormat === headerFormat &&
      card.buttons.length === buttonTypes.length &&
      card.buttons.every((button, slot) => button.type === buttonTypes[slot])
  );

  return {
    headerFormat,
    buttonTypes,
    uniform,
    canAddCard: cards.length < MAX_CARD_COUNT,
    canRemoveCard: cards.length > MIN_CARD_COUNT,
    canAddButton: buttonTypes.length < MAX_BUTTON_COUNT,
    canRemoveButton: buttonTypes.length > MIN_BUTTON_COUNT,
  } as const;
}

/**
 * Gives every card the header format and the button types slot by slot. A
 * button whose slot changes type keeps its label and drops its link or phone.
 */
function normalizeCards(params: {
  cards: TemplateCarouselCardFormValue[];
  headerFormat: WhatsAppCarouselCardHeaderFormat;
  buttonTypes: readonly TemplateCarouselButtonType[];
}): TemplateCarouselCardFormValue[] {
  return params.cards.map(card => ({
    ...card,
    headerFormat: params.headerFormat,
    buttons: params.buttonTypes.map((buttonType, slot) => {
      const button = card.buttons[slot];
      if (!button) return createButton(buttonType);
      return button.type === buttonType
        ? button
        : createButton(buttonType, button.text);
    }),
  }));
}

function isButtonSlot(slot: number, buttonTypes: readonly unknown[]): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < buttonTypes.length;
}

/**
 * Whether `slot` may take `buttonType`. Like a standard template, a card has
 * at most one phone button.
 */
export function canSetTemplateCarouselButtonType(
  buttonTypes: readonly TemplateCarouselButtonType[],
  slot: number,
  buttonType: TemplateCarouselButtonType
): boolean {
  return (
    buttonType !== "PHONE_NUMBER" ||
    buttonTypes.every(
      (current, index) => index === slot || current !== "PHONE_NUMBER"
    )
  );
}

export function applyTemplateCarouselIntent(
  cards: TemplateCarouselCardFormValue[],
  intent: TemplateCarouselIntent
): TemplateCarouselCardFormValue[] {
  const projection = projectTemplateCarousel(cards);

  switch (intent.type) {
    case "add_card":
      if (!projection.canAddCard) return cards;
      return [
        ...cards,
        createCard({
          headerFormat: projection.headerFormat,
          buttonTypes: projection.buttonTypes,
        }),
      ];
    case "remove_card":
      if (!projection.canRemoveCard) return cards;
      return cards.filter(card => card.clientId !== intent.clientId);
    case "set_header_format":
      return normalizeCards({
        cards,
        headerFormat: intent.format,
        buttonTypes: projection.buttonTypes,
      });
    case "set_button_type":
      if (
        !isButtonSlot(intent.slot, projection.buttonTypes) ||
        !canSetTemplateCarouselButtonType(
          projection.buttonTypes,
          intent.slot,
          intent.buttonType
        )
      ) {
        return cards;
      }
      return normalizeCards({
        cards,
        headerFormat: projection.headerFormat,
        buttonTypes: projection.buttonTypes.map((buttonType, slot) =>
          slot === intent.slot ? intent.buttonType : buttonType
        ),
      });
    case "add_button":
      if (!projection.canAddButton) return cards;
      return normalizeCards({
        cards,
        headerFormat: projection.headerFormat,
        buttonTypes: [...projection.buttonTypes, NEW_BUTTON_TYPE],
      });
    case "remove_button":
      if (
        !projection.canRemoveButton ||
        !isButtonSlot(intent.slot, projection.buttonTypes)
      ) {
        return cards;
      }
      return normalizeCards({
        cards: cards.map(card => ({
          ...card,
          buttons: card.buttons.filter((_, slot) => slot !== intent.slot),
        })),
        headerFormat: projection.headerFormat,
        buttonTypes: projection.buttonTypes.filter(
          (_, slot) => slot !== intent.slot
        ),
      });
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

function isCarouselHeaderFormat(
  value: unknown
): value is WhatsAppCarouselCardHeaderFormat {
  return value === "IMAGE" || value === "VIDEO";
}

function isCarouselButtonType(value: unknown): value is TemplateCarouselButtonType {
  return TEMPLATE_CAROUSEL_BUTTON_TYPES.some(
    buttonType => buttonType === value
  );
}

export function parseTemplateCarouselCardsFromComponent(
  component: Extract<WhatsAppComponent, { type: "CAROUSEL" }> | undefined
): TemplateCarouselCardFormValue[] {
  if (!component?.cards?.length) return [];

  return component.cards.map(card => parseTemplateCarouselCard(card));
}

function parseTemplateCarouselCard(
  card: WhatsAppCarouselCard
): TemplateCarouselCardFormValue {
  const header = card.components.find(
    (component): component is Extract<WhatsAppCarouselCard["components"][number], { type: "HEADER" }> =>
      component.type === "HEADER"
  );
  const body = card.components.find(
    (component): component is Extract<WhatsAppCarouselCard["components"][number], { type: "BODY" }> =>
      component.type === "BODY"
  );
  const buttonsComponent = card.components.find(
    (
      component
    ): component is Extract<
      WhatsAppCarouselCard["components"][number],
      { type: "BUTTONS" }
    > => component.type === "BUTTONS"
  );
  const headerFormat = isCarouselHeaderFormat(header?.format)
    ? header.format
    : "IMAGE";
  const mediaExample = header?.example?.header_handle?.[0] || "";

  return {
    clientId: createClientId("carousel-card"),
    headerFormat,
    headerMediaExample: typeof mediaExample === "string" ? mediaExample : "",
    bodyText: body && body.type === "BODY" ? body.text || "" : "",
    buttons:
      buttonsComponent && buttonsComponent.type === "BUTTONS"
        ? buttonsComponent.buttons
            .filter(button => isCarouselButtonType(button.type))
            .slice(0, MAX_BUTTON_COUNT)
            .map(button => ({
              clientId: createClientId("carousel-btn"),
              type: button.type,
              text: button.text || "",
              url: button.type === "URL" ? button.url : undefined,
              phone_number:
                button.type === "PHONE_NUMBER" ? button.phone_number : undefined,
            }))
        : [createButton("QUICK_REPLY")],
  };
}

export function getWhatsAppTemplateCarouselComponent(
  components: WhatsAppComponent[] | null | undefined
): Extract<WhatsAppComponent, { type: "CAROUSEL" }> | undefined {
  return components?.find(
    (component): component is Extract<WhatsAppComponent, { type: "CAROUSEL" }> =>
      component.type === "CAROUSEL"
  );
}
