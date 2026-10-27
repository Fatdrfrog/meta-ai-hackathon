"use client";

import { Button } from "@/components/ui/button";
import {
  ServiceGroupError,
  ServiceMessageInput as Input,
} from "./service-message-field";
import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppCommerceConfig,
} from "@icecore/scenario-contracts";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  getDisabledMultiProductIds,
  projectMultiProductSelection,
  type ServiceMessageCommerceIntent,
} from "./service-message-commerce-model";
import { ServiceMessageProductPicker } from "./service-message-product-picker";
import type { WhatsAppServiceCatalogProduct } from "./service-message-resources";

type MultiProductCommerceConfig = Extract<
  ScenarioWhatsAppCommerceConfig,
  { mode: "multi_product" }
>;

export function ServiceMessageCommerceMultiProductFields({
  commerce,
  products,
  onChange,
  onIntent,
}: {
  commerce: MultiProductCommerceConfig;
  products: WhatsAppServiceCatalogProduct[];
  onChange: (commerce: MultiProductCommerceConfig) => void;
  onIntent: (intent: ServiceMessageCommerceIntent) => void;
}) {
  const t = useTranslations("Scenarios");
  const selection = projectMultiProductSelection(commerce);

  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          className="nodrag h-8 text-xs"
          maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.header}
          fieldKey="commerce.headerText"
          value={commerce.headerText}
          aria-label={t("headerLabel")}
          placeholder={t("headerLabel")}
          onChange={event =>
            onChange({ ...commerce, headerText: event.target.value })
          }
        />
        <Input
          className="nodrag h-8 text-xs"
          maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.footer}
          fieldKey="commerce.footerText"
          value={commerce.footerText || ""}
          aria-label={t("footerTextPlaceholder")}
          placeholder={t("footerTextPlaceholder")}
          onChange={event =>
            onChange({ ...commerce, footerText: event.target.value })
          }
        />
      </div>
      <Input
        className="nodrag h-8 text-xs"
        maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body}
        fieldKey="commerce.bodyText"
        value={commerce.bodyText}
        aria-label={t("previewFieldMessage")}
        placeholder={t("actionReplyTextPlaceholder")}
        onChange={event =>
          onChange({ ...commerce, bodyText: event.target.value })
        }
      />
      <div className="space-y-2" data-sm-field="commerce.sections">
        {commerce.sections.map((section, sectionIndex) => (
          <div
            key={section.id}
            className="space-y-1.5 rounded-md border bg-background p-2"
          >
            <div className="flex gap-1.5">
              <Input
                className="nodrag h-8 min-w-0 flex-1 text-xs"
                maxLength={
                  WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct
                    .sectionTitle
                }
                fieldKey={"commerce.sections." + sectionIndex + ".title"}
                value={section.title}
                aria-label={t("whatsappServiceListSectionPlaceholder")}
                placeholder={t("whatsappServiceListSectionPlaceholder")}
                onChange={event =>
                  onIntent({
                    type: "set_section_title",
                    sectionId: section.id,
                    title: event.target.value,
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag nopan h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                title={t("whatsappServiceDeleteSection")}
                aria-label={t("whatsappServiceDeleteSection")}
                onPointerDown={event => event.stopPropagation()}
                onClick={() =>
                  onIntent({ type: "remove_section", sectionId: section.id })
                }
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
            <ServiceMessageProductPicker
              products={products}
              catalogId={commerce.catalogId}
              selectedIds={section.productRetailerIds}
              disabledIds={getDisabledMultiProductIds({
                commerce,
                sectionId: section.id,
                products,
              })}
              max={
                WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.products
                  .max
              }
              onChange={productRetailerIds =>
                onIntent({
                  type: "set_section_products",
                  sectionId: section.id,
                  productRetailerIds,
                })
              }
            />
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="nodrag h-8 w-full border-dashed"
          disabled={!selection.canAddSection}
          onClick={() => onIntent({ type: "add_section" })}
        >
          <Plus className="mr-2 h-3.5 w-3.5" aria-hidden />
          {t("whatsappServiceAddSection")}
        </Button>
        <ServiceGroupError fieldKey="commerce.sections" />
      </div>
    </>
  );
}
