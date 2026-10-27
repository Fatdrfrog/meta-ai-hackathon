import type { TemplateCarouselCardFormValue } from "./template-carousel-model";

export type WhatsAppMarketingLayout = "standard" | "carousel";

export function getWhatsAppMarketingLayout(
  hasCarousel: boolean | undefined
): WhatsAppMarketingLayout {
  return hasCarousel ? "carousel" : "standard";
}

export function standardLayoutHasExclusiveSections(params: {
  hasHeader?: boolean;
  hasFooter?: boolean;
  hasButtons?: boolean;
}): boolean {
  return Boolean(params.hasHeader || params.hasFooter || params.hasButtons);
}

export function carouselCardsHaveUserContent(
  cards: TemplateCarouselCardFormValue[] | undefined
): boolean {
  return (cards ?? []).some(card => {
    if (card.headerMediaExample.trim() || card.bodyText.trim()) {
      return true;
    }

    return card.buttons.some(button =>
      Boolean(
        button.text?.trim() ||
          button.url?.trim() ||
          button.phone_number?.trim()
      )
    );
  });
}
