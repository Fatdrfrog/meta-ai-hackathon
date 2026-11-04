"use client";

// "Edit questions": airi's own WhatsApp Flow editor, unchanged, holding a
// kit's order form, in English. Its products question stays the shelf's
// (each option is a product), so only its words change; the owner's own
// questions are free. Products' Paper form screen is its preview. Loaded only
// when the sheet opens.

import { AiriBuilderIntlProvider } from "@/components/ai/airi-builder-intl-provider";
import { FlowFormEditorContent } from "@/components/scenarios/builders/whatsapp/field-editor";
import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  checkOrderFormConfig,
  ORDER_FORM_PRODUCTS_FIELD_ID,
} from "@/lib/products/order-form-config";
import type { ProductShopWordsCode } from "@/lib/products/types";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { CircleAlert, Lock } from "lucide-react";
import { useState } from "react";
import { OrderFormScreen } from "./product-buyers-preview";
import styles from "./product-kit-editor-sheet.module.css";

const EDIT = PRODUCTS_COPY.kit.edit;
const PROTECTED_FIELD_IDS = [ORDER_FORM_PRODUCTS_FIELD_ID] as const;

export type ProductOrderFormEditorProps = {
  /** The questions to open with: the shelf's, the saved edits, or what was published. */
  initialConfig: WhatsAppFlowConfig;
  language: ProductShopWordsCode;
  /** The kit's products: the products question may list only these. */
  productIds: readonly string[];
  /** The line beside the buttons: when it goes to WhatsApp. */
  note: string;
  submitLabel: string;
  /** Saving or publishing: the buttons wait. */
  busy?: boolean;
  /** Why the last save didn't go, from the caller. */
  error?: string | null;
  /** Checked questions; the caller saves or publishes them. */
  onSave: (config: WhatsAppFlowConfig) => void;
  onCancel: () => void;
};

export function ProductOrderFormEditor({
  initialConfig,
  language,
  productIds,
  note,
  submitLabel,
  busy = false,
  error = null,
  onSave,
  onCancel,
}: ProductOrderFormEditorProps) {
  const [config, setConfig] = useState(initialConfig);
  const [issue, setIssue] = useState<string | null>(null);
  const shown = issue ?? error;

  const save = () => {
    const issues = checkOrderFormConfig(config, productIds);
    if (issues.length > 0) {
      setIssue(issues[0]!);
      return;
    }
    setIssue(null);
    onSave(config);
  };

  return (
    <div className={styles.formEditor}>
      <p className={styles.lockNote}>
        <Lock aria-hidden="true" />
        <span>{EDIT.lockNote}</span>
      </p>
      <div className={styles.formEditorBody}>
        <AiriBuilderIntlProvider
          locale="en"
          fallback={
            <p role="status" className={styles.loading}>
              {EDIT.loadingForm}
            </p>
          }
        >
          <FlowFormEditorContent
            authoringContext="manager"
            fillAvailableHeight
            flowConfig={config}
            onChange={next => {
              setConfig(next);
              setIssue(null);
            }}
            protectedFieldIds={PROTECTED_FIELD_IDS}
            renderPreview={screenId => (
              <OrderFormScreen
                config={config}
                language={language}
                screenId={screenId}
              />
            )}
          />
        </AiriBuilderIntlProvider>
      </div>
      {shown ? (
        <p role="alert" className={styles.alert}>
          <CircleAlert aria-hidden="true" />
          <span>{shown}</span>
        </p>
      ) : null}
      <div className={styles.footer}>
        <p className={styles.footerNote}>{note}</p>
        <div className={styles.footerActions}>
          <Button type="button" variant="outline" onClick={onCancel}>
            {EDIT.cancel}
          </Button>
          <Button type="button" disabled={busy} onClick={save}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
