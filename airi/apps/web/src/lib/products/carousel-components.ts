import type { ProductCarouselDraft } from "@/lib/products/types";
import type {
  WhatsAppCarouselComponent,
  WhatsAppComponent,
} from "@icecore/shared/types/whatsapp";

// A product carousel as Meta takes it. The kit sends these components to Meta
// itself, and the template editor opens the same CAROUSEL when the owner
// edits it afterwards, so both describe one template.

/**
 * The cards: one per product, with its picture on white as the header's
 * sample, its name and price, and the order button.
 */
export function carouselComponent(
  draft: ProductCarouselDraft
): WhatsAppCarouselComponent {
  return {
    type: "CAROUSEL",
    cards: draft.cards.map(card => ({
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: [card.imageUrl] },
        },
        { type: "BODY", text: card.bodyText },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: card.buttonText }],
        },
      ],
    })),
  };
}

/** The whole template: the message above the cards, then the cards. */
export function carouselTemplateComponents(
  draft: ProductCarouselDraft
): WhatsAppComponent[] {
  return [{ type: "BODY", text: draft.bodyText }, carouselComponent(draft)];
}
