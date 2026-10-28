import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import type { ProductCarouselDraft } from "@/lib/products/types";
import { parseTemplateCarouselCardsFromComponent } from "@/components/whatsapp-templates/template-carousel-model";
import {
  getTemplateEditorDraftKey,
  hasTemplateEditorDraftContent,
  readTemplateEditorDraft,
  writeTemplateEditorDraft,
} from "@/components/whatsapp-templates/template-editor-draft";
import type { TemplateFormValues } from "@/components/whatsapp-templates/template-editor-form-utils";
import type { WhatsAppCarouselComponent } from "@icecore/shared/types/whatsapp";

// A product carousel reaches airi's template editor the way an unsaved new
// template does: as the editor's own draft, which it restores when it opens
// in create mode. The owner then checks it and sends it to Meta there.

/** The editor's form for the carousel: a marketing template with one card per product. */
export function carouselTemplateValues(
  draft: ProductCarouselDraft
): TemplateFormValues {
  const carousel: WhatsAppCarouselComponent = {
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

/** Whether the owner has a new template they haven't saved, which a carousel would replace. */
export function hasUnsavedNewTemplate(workspaceId: string): boolean {
  const draft = readTemplateEditorDraft(
    getTemplateEditorDraftKey({ workspaceId })
  );
  return draft !== null && hasTemplateEditorDraftContent(draft.values);
}

/** Leaves the carousel for the template editor to open with. */
export function saveCarouselForTemplateEditor(
  workspaceId: string,
  draft: ProductCarouselDraft
): void {
  writeTemplateEditorDraft(
    getTemplateEditorDraftKey({ workspaceId }),
    carouselTemplateValues(draft)
  );
}

/** The templates page, opening the editor on a new template. */
export function newTemplateHref(workspaceId: string): string {
  return panelWorkspaceHref(
    workspaceId,
    "messengers/whatsapp-templates?create=1"
  );
}

export function whatsAppFlowsHref(workspaceId: string): string {
  return panelWorkspaceHref(workspaceId, "messengers/whatsapp-flows");
}
