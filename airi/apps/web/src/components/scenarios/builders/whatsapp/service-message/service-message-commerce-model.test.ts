import type { ScenarioWhatsAppCommerceConfig } from "@icecore/scenario-contracts";
import {
  applyServiceMessageCommerceIntent,
  projectMultiProductSelection,
} from "./service-message-commerce-model";

const products = Array.from({ length: 35 }, (_, index) => ({
  catalog_id: "catalog-2",
  retailer_id: `product-${index + 1}`,
}));

describe("service message commerce model", () => {
  it("keeps the current catalog when switching commerce mode", () => {
    const commerce: ScenarioWhatsAppCommerceConfig = {
      mode: "catalog",
      catalogId: "catalog-2",
      bodyText: "Browse",
    };

    expect(
      applyServiceMessageCommerceIntent(
        commerce,
        { type: "set_mode", mode: "single_product" },
        {
          catalogs: [{ id: "catalog-1" }, { id: "catalog-2" }],
          products,
          createSectionId: () => "section",
        }
      )
    ).toEqual({
      mode: "single_product",
      catalogId: "catalog-2",
      productRetailerId: "",
    });
  });

  it.each([
    {
      current: {
        mode: "catalog" as const,
        catalogId: "catalog-1",
        thumbnailProductRetailerId: "old-product",
      },
      expected: {
        mode: "catalog",
        catalogId: "catalog-2",
        thumbnailProductRetailerId: undefined,
      },
    },
    {
      current: {
        mode: "single_product" as const,
        catalogId: "catalog-1",
        productRetailerId: "old-product",
      },
      expected: {
        mode: "single_product",
        catalogId: "catalog-2",
        productRetailerId: "",
      },
    },
    {
      current: {
        mode: "product_carousel" as const,
        catalogId: "catalog-1",
        bodyText: "Products",
        productRetailerIds: ["old-product", "product-2", "product-2"],
      },
      expected: {
        mode: "product_carousel",
        catalogId: "catalog-2",
        bodyText: "Products",
        productRetailerIds: ["product-2"],
      },
    },
    {
      current: {
        mode: "multi_product" as const,
        catalogId: "catalog-1",
        headerText: "Header",
        bodyText: "Products",
        sections: [
          {
            id: "one",
            title: "One",
            productRetailerIds: ["old-product", "product-2", "product-2"],
          },
          {
            id: "two",
            title: "Two",
            productRetailerIds: ["product-2", "product-3"],
          },
        ],
      },
      expected: {
        mode: "multi_product",
        catalogId: "catalog-2",
        headerText: "Header",
        bodyText: "Products",
        sections: [
          {
            id: "one",
            title: "One",
            productRetailerIds: ["product-2"],
          },
          {
            id: "two",
            title: "Two",
            productRetailerIds: ["product-3"],
          },
        ],
      },
    },
  ])("filters stale and duplicate products when changing catalog", value => {
    expect(
      applyServiceMessageCommerceIntent(
        value.current,
        { type: "set_catalog", catalogId: "catalog-2" },
        {
          catalogs: [{ id: "catalog-1" }, { id: "catalog-2" }],
          products,
          createSectionId: () => "section",
        }
      )
    ).toEqual(value.expected);
  });

  it("clears unscoped product rows when changing catalog", () => {
    const commerce: ScenarioWhatsAppCommerceConfig = {
      mode: "single_product",
      catalogId: "catalog-1",
      productRetailerId: "unscoped-product",
    };

    expect(
      applyServiceMessageCommerceIntent(
        commerce,
        { type: "set_catalog", catalogId: "catalog-2" },
        {
          catalogs: [{ id: "catalog-1" }, { id: "catalog-2" }],
          products: [{ retailer_id: "unscoped-product" }],
          createSectionId: () => "section",
        }
      )
    ).toEqual({
      mode: "single_product",
      catalogId: "catalog-2",
      productRetailerId: "",
    });
  });

  it("deduplicates multi-product sections and enforces 30 products globally", () => {
    const commerce: ScenarioWhatsAppCommerceConfig = {
      mode: "multi_product",
      catalogId: "catalog-2",
      headerText: "Header",
      bodyText: "Products",
      sections: [
        {
          id: "one",
          title: "One",
          productRetailerIds: products
            .slice(0, 20)
            .map(product => product.retailer_id!),
        },
        {
          id: "two",
          title: "Two",
          productRetailerIds: [],
        },
      ],
    };

    const next = applyServiceMessageCommerceIntent(
      commerce,
      {
        type: "set_section_products",
        sectionId: "two",
        productRetailerIds: products
          .slice(15)
          .map(product => product.retailer_id!),
      },
      {
        catalogs: [{ id: "catalog-2" }],
        products,
        createSectionId: () => "section",
      }
    );

    expect(next.mode).toBe("multi_product");
    if (next.mode !== "multi_product")
      throw new Error("expected multi product");
    expect(next.sections[0].productRetailerIds).toHaveLength(20);
    expect(next.sections[1].productRetailerIds).toEqual(
      products.slice(20, 30).map(product => product.retailer_id)
    );
    expect(projectMultiProductSelection(next).totalSelected).toBe(30);
  });

  it("does not erase valid selections that are outside the loaded product page", () => {
    const commerce: ScenarioWhatsAppCommerceConfig = {
      mode: "multi_product",
      catalogId: "catalog-2",
      headerText: "Header",
      bodyText: "Products",
      sections: [
        {
          id: "one",
          title: "One",
          productRetailerIds: ["not-loaded"],
        },
        {
          id: "two",
          title: "Two",
          productRetailerIds: [],
        },
      ],
    };

    const next = applyServiceMessageCommerceIntent(
      commerce,
      {
        type: "set_section_products",
        sectionId: "two",
        productRetailerIds: ["product-1"],
      },
      {
        catalogs: [{ id: "catalog-2" }],
        products,
        createSectionId: () => "section",
      }
    );

    expect(next).toMatchObject({
      sections: [
        { id: "one", productRetailerIds: ["not-loaded"] },
        { id: "two", productRetailerIds: ["product-1"] },
      ],
    });
  });

  it("owns bounded section add and remove transitions", () => {
    const commerce: ScenarioWhatsAppCommerceConfig = {
      mode: "multi_product",
      catalogId: "catalog-2",
      headerText: "",
      bodyText: "",
      sections: [],
    };
    const dependencies = {
      catalogs: [{ id: "catalog-2" }],
      products,
      createSectionId: () => "new-section",
    };

    const added = applyServiceMessageCommerceIntent(
      commerce,
      { type: "add_section" },
      dependencies
    );
    expect(added).toMatchObject({
      sections: [{ id: "new-section", title: "", productRetailerIds: [] }],
    });

    expect(
      applyServiceMessageCommerceIntent(
        added,
        { type: "remove_section", sectionId: "new-section" },
        dependencies
      )
    ).toMatchObject({ sections: [] });
  });
});
