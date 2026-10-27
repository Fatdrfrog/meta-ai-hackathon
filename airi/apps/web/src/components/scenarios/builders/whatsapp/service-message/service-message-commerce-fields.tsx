"use client";

import {
  ServiceMessageInput as Input,
  ServiceGroupError,
  useServiceGroupError,
} from "./service-message-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppCommerceConfig,
} from "@icecore/scenario-contracts";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { ServiceMessageCommerceMultiProductFields } from "./service-message-commerce-multi-product-fields";
import {
  applyServiceMessageCommerceIntent,
  type ServiceMessageCommerceIntent,
} from "./service-message-commerce-model";
import { createServiceMessageEntityId } from "./service-message-ids";
import { ServiceMessageProductPicker } from "./service-message-product-picker";
import type {
  WhatsAppServiceCatalog,
  WhatsAppServiceCatalogProduct,
} from "./service-message-resources";
import { availableServiceProducts } from "./service-message-resources";

type CommerceMode = ScenarioWhatsAppCommerceConfig["mode"];

/** The thumbnail select's value for "let WhatsApp pick". */
const AUTO_THUMBNAIL_VALUE = "none";

export function ServiceMessageCommerceFields({
  commerce,
  catalogs,
  products,
  loading,
  failed = false,
  onChange,
}: {
  commerce: ScenarioWhatsAppCommerceConfig;
  catalogs: WhatsAppServiceCatalog[];
  products: WhatsAppServiceCatalogProduct[];
  loading: boolean;
  failed?: boolean;
  onChange: (commerce: ScenarioWhatsAppCommerceConfig) => void;
}) {
  const t = useTranslations("Scenarios");
  const commerceError = useServiceGroupError("commerce");
  const catalogOptions = catalogs.map((catalog, index) => ({
    ...catalog,
    label: catalog.name || `${t("whatsappServiceCatalogOption")} ${index + 1}`,
  }));
  const applyIntent = (intent: ServiceMessageCommerceIntent) =>
    onChange(
      applyServiceMessageCommerceIntent(commerce, intent, {
        catalogs,
        products,
        createSectionId: createServiceMessageEntityId,
      })
    );

  return (
    <div className="space-y-2" data-sm-field="commerce">
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          value={commerce.mode}
          onValueChange={value =>
            applyIntent({ type: "set_mode", mode: value as CommerceMode })
          }
        >
          <SelectTrigger
            data-sm-field="commerce.mode"
            aria-label={t("whatsappServiceCommerceMode")}
            className="nodrag h-8 w-full min-w-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="catalog">
              {t("whatsappServiceFormatCatalog")}
            </SelectItem>
            <SelectItem value="single_product">
              {t("whatsappServiceSingleProduct")}
            </SelectItem>
            <SelectItem value="multi_product">
              {t("whatsappServiceMultipleProducts")}
            </SelectItem>
            <SelectItem value="product_carousel">
              {t("whatsappServiceProductCarousel")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={commerce.catalogId}
          onValueChange={catalogId =>
            applyIntent({ type: "set_catalog", catalogId })
          }
        >
          <SelectTrigger
            data-sm-field="commerce.catalogId"
            aria-label={t("whatsappServiceActionCatalog")}
            {...commerceError.inputProps}
            className="nodrag h-8 w-full min-w-0"
          >
            <SelectValue placeholder={t("whatsappServiceCatalogChoose")} />
            {loading ? (
              <span className="ms-auto flex items-center">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                <span className="sr-only">{t("loadingItems")}</span>
              </span>
            ) : null}
          </SelectTrigger>
          <SelectContent>
            {catalogOptions.map(catalog => (
              <SelectItem key={catalog.id} value={catalog.id}>
                {catalog.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {commerce.mode === "catalog" ? (
        <>
          <Input
            className="nodrag h-8 text-xs"
            maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body}
            fieldKey="commerce.bodyText"
            value={commerce.bodyText || ""}
            aria-label={t("previewFieldMessage")}
            placeholder={t("actionReplyTextPlaceholder")}
            onChange={event =>
              onChange({ ...commerce, bodyText: event.target.value })
            }
          />
          <div className="grid grid-cols-2 gap-1.5">
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
            <Select
              value={
                commerce.thumbnailProductRetailerId || AUTO_THUMBNAIL_VALUE
              }
              onValueChange={thumbnailProductRetailerId =>
                applyIntent({
                  type: "set_thumbnail_product",
                  productRetailerId:
                    thumbnailProductRetailerId === AUTO_THUMBNAIL_VALUE
                      ? undefined
                      : thumbnailProductRetailerId,
                })
              }
            >
              <SelectTrigger
                data-sm-field="commerce.thumbnailProductRetailerId"
                aria-label={t("whatsappServiceCatalogThumbnail")}
                className="nodrag h-8 w-full min-w-0"
              >
                <SelectValue
                  placeholder={t("whatsappServiceCatalogThumbnail")}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_THUMBNAIL_VALUE}>
                  {t("whatsappServiceCatalogThumbnailAuto")}
                </SelectItem>
                {availableServiceProducts({
                  products,
                  catalogId: commerce.catalogId,
                }).map((product, index) => (
                  <SelectItem
                    key={product.retailer_id}
                    value={product.retailer_id!}
                  >
                    {product.name ||
                      `${t("whatsappServiceProductOption")} ${index + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      ) : null}

      {commerce.mode === "single_product" ? (
        <>
          <Select
            value={commerce.productRetailerId}
            onValueChange={productRetailerId =>
              applyIntent({ type: "set_single_product", productRetailerId })
            }
          >
            <SelectTrigger
              data-sm-field="commerce.productRetailerId"
              aria-label={t("whatsappServiceSingleProduct")}
              className="nodrag h-8 w-full min-w-0"
            >
              <SelectValue placeholder={t("whatsappServiceSingleProduct")} />
            </SelectTrigger>
            <SelectContent>
              {availableServiceProducts({
                products,
                catalogId: commerce.catalogId,
              }).map((product, index) => (
                <SelectItem
                  key={product.retailer_id}
                  value={product.retailer_id!}
                >
                  {product.name ||
                    `${t("whatsappServiceProductOption")} ${index + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              className="nodrag h-8 text-xs"
              maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body}
              fieldKey="commerce.bodyText"
              value={commerce.bodyText || ""}
              aria-label={t("previewFieldMessage")}
              placeholder={t("actionReplyTextPlaceholder")}
              onChange={event =>
                onChange({ ...commerce, bodyText: event.target.value })
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
        </>
      ) : null}

      {commerce.mode === "product_carousel" ? (
        <>
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
          <ServiceMessageProductPicker
            products={products}
            catalogId={commerce.catalogId}
            selectedIds={commerce.productRetailerIds}
            max={
              WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.productCarousel.products
                .max
            }
            onChange={productRetailerIds =>
              applyIntent({
                type: "set_product_carousel_products",
                productRetailerIds,
              })
            }
          />
        </>
      ) : null}

      {commerce.mode === "multi_product" ? (
        <ServiceMessageCommerceMultiProductFields
          commerce={commerce}
          products={products}
          onChange={onChange}
          onIntent={applyIntent}
        />
      ) : null}

      {!loading && !failed && catalogs.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t("whatsappServiceCatalogUnavailable")}
        </p>
      ) : null}
      <ServiceGroupError fieldKey="commerce" id={commerceError.id} />
    </div>
  );
}
