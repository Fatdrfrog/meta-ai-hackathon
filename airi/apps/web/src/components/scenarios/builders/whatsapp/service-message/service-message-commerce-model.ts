import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppCommerceConfig,
} from "@icecore/scenario-contracts";
import type {
  WhatsAppServiceCatalog,
  WhatsAppServiceCatalogProduct,
} from "./service-message-resources";

type CommerceMode = ScenarioWhatsAppCommerceConfig["mode"];
type MultiProductCommerceConfig = Extract<
  ScenarioWhatsAppCommerceConfig,
  { mode: "multi_product" }
>;

export type ServiceMessageCommerceModelDependencies = {
  catalogs: WhatsAppServiceCatalog[];
  products: WhatsAppServiceCatalogProduct[];
  createSectionId: () => string;
};

export type ServiceMessageCommerceIntent =
  | { type: "set_mode"; mode: CommerceMode }
  | { type: "set_catalog"; catalogId: string }
  | { type: "set_thumbnail_product"; productRetailerId?: string }
  | { type: "set_single_product"; productRetailerId: string }
  | { type: "set_product_carousel_products"; productRetailerIds: string[] }
  | { type: "add_section" }
  | { type: "remove_section"; sectionId: string }
  | { type: "set_section_title"; sectionId: string; title: string }
  | {
      type: "set_section_products";
      sectionId: string;
      productRetailerIds: string[];
    };

const MAX_MULTI_PRODUCT_COUNT =
  WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.products.max;
const MAX_MULTI_PRODUCT_SECTION_COUNT =
  WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.sections.max;
const MAX_PRODUCT_CAROUSEL_COUNT =
  WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.productCarousel.products.max;

function availableProductIds(
  products: WhatsAppServiceCatalogProduct[],
  catalogId: string,
  requireCatalogMatch = false
): Set<string> {
  return new Set(
    products.flatMap(product =>
      product.retailer_id &&
      (product.catalog_id === catalogId ||
        (!requireCatalogMatch && !product.catalog_id))
        ? [product.retailer_id]
        : []
    )
  );
}

function dedupeIds(params: {
  ids: string[];
  availableIds?: Set<string>;
  max: number;
  seen?: Set<string>;
}): string[] {
  const seen = params.seen ?? new Set<string>();
  const result: string[] = [];
  for (const id of params.ids) {
    if (
      result.length >= params.max ||
      (params.availableIds && !params.availableIds.has(id)) ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeMultiProductSections(
  commerce: MultiProductCommerceConfig,
  products: WhatsAppServiceCatalogProduct[],
  requireCatalogMatch = false
): MultiProductCommerceConfig["sections"] {
  const availableIds = requireCatalogMatch
    ? availableProductIds(products, commerce.catalogId, true)
    : undefined;
  const seen = new Set<string>();
  let remaining = MAX_MULTI_PRODUCT_COUNT;

  return commerce.sections
    .slice(0, MAX_MULTI_PRODUCT_SECTION_COUNT)
    .map(section => {
      const productRetailerIds = dedupeIds({
        ids: section.productRetailerIds,
        availableIds,
        max: remaining,
        seen,
      });
      remaining -= productRetailerIds.length;
      return { ...section, productRetailerIds };
    });
}

function createCommerceConfig(
  mode: CommerceMode,
  catalogId: string
): ScenarioWhatsAppCommerceConfig {
  switch (mode) {
    case "catalog":
      return { mode, catalogId };
    case "single_product":
      return { mode, catalogId, productRetailerId: "" };
    case "multi_product":
      return {
        mode,
        catalogId,
        headerText: "",
        bodyText: "",
        sections: [],
      };
    case "product_carousel":
      return { mode, catalogId, bodyText: "", productRetailerIds: [] };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

function normalizeCatalogSelection(
  commerce: ScenarioWhatsAppCommerceConfig,
  products: WhatsAppServiceCatalogProduct[],
  requireCatalogMatch = false
): ScenarioWhatsAppCommerceConfig {
  const availableIds = requireCatalogMatch
    ? availableProductIds(products, commerce.catalogId, true)
    : undefined;

  switch (commerce.mode) {
    case "catalog":
      return {
        ...commerce,
        thumbnailProductRetailerId:
          commerce.thumbnailProductRetailerId &&
          (!availableIds ||
            availableIds.has(commerce.thumbnailProductRetailerId))
            ? commerce.thumbnailProductRetailerId
            : undefined,
      };
    case "single_product":
      return {
        ...commerce,
        productRetailerId:
          !availableIds || availableIds.has(commerce.productRetailerId)
            ? commerce.productRetailerId
            : "",
      };
    case "multi_product":
      return {
        ...commerce,
        sections: normalizeMultiProductSections(
          commerce,
          products,
          requireCatalogMatch
        ),
      };
    case "product_carousel":
      return {
        ...commerce,
        productRetailerIds: dedupeIds({
          ids: commerce.productRetailerIds,
          availableIds,
          max: MAX_PRODUCT_CAROUSEL_COUNT,
        }),
      };
    default: {
      const exhaustive: never = commerce;
      return exhaustive;
    }
  }
}

export function projectMultiProductSelection(
  commerce: MultiProductCommerceConfig
) {
  const totalSelected = commerce.sections.reduce(
    (total, section) => total + section.productRetailerIds.length,
    0
  );
  return {
    totalSelected,
    remaining: Math.max(0, MAX_MULTI_PRODUCT_COUNT - totalSelected),
    canAddSection: commerce.sections.length < MAX_MULTI_PRODUCT_SECTION_COUNT,
  } as const;
}

export function getDisabledMultiProductIds(params: {
  commerce: MultiProductCommerceConfig;
  sectionId: string;
  products: WhatsAppServiceCatalogProduct[];
}): Set<string> {
  const selectedElsewhere = new Set<string>();
  for (const section of params.commerce.sections) {
    if (section.id === params.sectionId) continue;
    for (const productId of section.productRetailerIds) {
      selectedElsewhere.add(productId);
    }
  }

  if (
    projectMultiProductSelection(params.commerce).totalSelected <
    MAX_MULTI_PRODUCT_COUNT
  ) {
    return selectedElsewhere;
  }

  const selectedHere = new Set(
    params.commerce.sections.find(section => section.id === params.sectionId)
      ?.productRetailerIds ?? []
  );
  for (const productId of availableProductIds(
    params.products,
    params.commerce.catalogId
  )) {
    if (!selectedHere.has(productId)) selectedElsewhere.add(productId);
  }
  return selectedElsewhere;
}

export function applyServiceMessageCommerceIntent(
  commerce: ScenarioWhatsAppCommerceConfig,
  intent: ServiceMessageCommerceIntent,
  dependencies: ServiceMessageCommerceModelDependencies
): ScenarioWhatsAppCommerceConfig {
  switch (intent.type) {
    case "set_mode":
      return createCommerceConfig(
        intent.mode,
        commerce.catalogId || dependencies.catalogs[0]?.id || ""
      );
    case "set_catalog":
      return normalizeCatalogSelection(
        { ...commerce, catalogId: intent.catalogId },
        dependencies.products,
        true
      );
    case "set_thumbnail_product":
      return commerce.mode === "catalog"
        ? {
            ...commerce,
            thumbnailProductRetailerId: intent.productRetailerId,
          }
        : commerce;
    case "set_single_product":
      return commerce.mode === "single_product"
        ? { ...commerce, productRetailerId: intent.productRetailerId }
        : commerce;
    case "set_product_carousel_products":
      return commerce.mode === "product_carousel"
        ? normalizeCatalogSelection(
            {
              ...commerce,
              productRetailerIds: intent.productRetailerIds,
            },
            dependencies.products
          )
        : commerce;
    case "add_section":
      return commerce.mode === "multi_product" &&
        commerce.sections.length < MAX_MULTI_PRODUCT_SECTION_COUNT
        ? {
            ...commerce,
            sections: [
              ...commerce.sections,
              {
                id: dependencies.createSectionId(),
                title: "",
                productRetailerIds: [],
              },
            ],
          }
        : commerce;
    case "remove_section":
      return commerce.mode === "multi_product"
        ? {
            ...commerce,
            sections: commerce.sections.filter(
              section => section.id !== intent.sectionId
            ),
          }
        : commerce;
    case "set_section_title":
      return commerce.mode === "multi_product"
        ? {
            ...commerce,
            sections: commerce.sections.map(section =>
              section.id === intent.sectionId
                ? { ...section, title: intent.title }
                : section
            ),
          }
        : commerce;
    case "set_section_products":
      if (commerce.mode !== "multi_product") return commerce;
      return {
        ...commerce,
        sections: normalizeMultiProductSections(
          {
            ...commerce,
            sections: commerce.sections.map(section =>
              section.id === intent.sectionId
                ? {
                    ...section,
                    productRetailerIds: intent.productRetailerIds,
                  }
                : section
            ),
          },
          dependencies.products
        ),
      };
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}
