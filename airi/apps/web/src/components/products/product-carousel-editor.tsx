"use client";

// "Edit cards": airi's own WhatsApp template editor, unchanged, holding a
// kit's carousel. Products hands it the cards, keeps its unsaved draft apart
// from the Templates page's, takes the saved template instead of creating it,
// and shows it in English. Loaded only when the sheet opens.

import { AiriBuilderIntlProvider } from "@/components/ai/airi-builder-intl-provider";
import {
  TemplateEditorForm,
  type TemplateEditorCreateInput,
} from "@/components/whatsapp-templates/template-editor-form";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductShopWordsCode } from "@/lib/products/types";
import type {
  WhatsAppComponent,
  WhatsAppTemplate,
} from "@icecore/shared/types/whatsapp";
import { useMemo, type ComponentProps } from "react";
import styles from "./product-kit-editor-sheet.module.css";

export type ProductCarouselEditorPrefill = {
  name: string;
  language: ProductShopWordsCode;
  components: readonly WhatsAppComponent[];
};

export type ProductCarouselEditorProps = {
  workspaceId: string;
  /** The cards to open with: the shelf's, the saved edits, or what was sent. */
  prefill: ProductCarouselEditorPrefill;
  /** The editor's own draft key's scope (products:…). */
  draftScope: string;
  submitLabel: string;
  onCreate: NonNullable<ComponentProps<typeof TemplateEditorForm>["onCreate"]>;
  onSaved: () => void;
  onCancel: () => void;
};

export type { TemplateEditorCreateInput };

export function ProductCarouselEditor({
  workspaceId,
  prefill,
  draftScope,
  submitLabel,
  onCreate,
  onSaved,
  onCancel,
}: ProductCarouselEditorProps) {
  // The editor starts over whenever its template object changes, so it is
  // made once per prefill: the kit's polling never resets the owner's edits.
  const template = useMemo<WhatsAppTemplate>(
    () => ({
      name: prefill.name,
      language: prefill.language,
      category: "MARKETING",
      status: "PENDING",
      components: [...prefill.components],
    }),
    [prefill]
  );
  const fixedShape = useMemo(
    () => ({
      category: "MARKETING" as const,
      layout: "carousel" as const,
      language: prefill.language,
    }),
    [prefill.language]
  );
  return (
    // The editor reads the templates and Scenarios catalogs: in English,
    // downloaded once, whatever the page's language (Products is English-only).
    <AiriBuilderIntlProvider
      locale="en"
      fallback={
        <p role="status" className={styles.loading}>
          {PRODUCTS_COPY.kit.edit.loadingEditor}
        </p>
      }
    >
      <TemplateEditorForm
        key={draftScope}
        template={template}
        workspaceId={workspaceId}
        layout="modal"
        platformScope="whatsapp"
        draftScope={draftScope}
        fixedShape={fixedShape}
        submitLabel={submitLabel}
        onCreate={onCreate}
        onSuccess={onSaved}
        onCancel={onCancel}
        className={styles.carouselEditor}
      />
    </AiriBuilderIntlProvider>
  );
}
