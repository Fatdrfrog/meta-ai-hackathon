import { carouselComponent } from "@/lib/products/carousel-components";
import type { ProductCarouselDraft } from "@/lib/products/types";
import { parseTemplateCarouselCardsFromComponent } from "@/components/whatsapp-templates/template-carousel-model";
import type { TemplateFormValues } from "@/components/whatsapp-templates/template-editor-form-utils";

// A product carousel as airi's template editor reads it. Kits send the
// carousel to Meta themselves (carousel-components.ts); when the owner opens
// it in Templates afterwards, the editor reads the same CAROUSEL, which the
// carousel-components test checks against this form.

/**
 * The editor's form for the carousel: a marketing template with one card per
 * product, the same CAROUSEL the kit sends to Meta.
 */
export function carouselTemplateValues(
  draft: ProductCarouselDraft
): TemplateFormValues {
  const carousel = carouselComponent(draft);
  return {
    name: draft.name,
    targetPlatform: "whatsapp",
    language: draft.language,
    category: "MARKETING",
    bodyText: draft.bodyText,
    hasHeader: false,
    hasFooter: false,
    hasButtons: false,
    hasCarousel: true,
    carouselHeaderFormat: "IMAGE",
    // The editor's own reading of a carousel, with its ids for each card.
    carouselCards: parseTemplateCarouselCardsFromComponent(carousel),
  };
}
