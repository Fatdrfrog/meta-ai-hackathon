import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import {
  buildCatalogItemsBatchParams,
  buildCreateCatalogProductParams,
  getCatalogCommerceSettings,
  isCatalogPermissionError,
  isWabaCatalogUnsupportedMethodError,
  listCatalogProducts,
  parseCatalogCsvRows,
  serializeCatalogProductsCsv,
  updateCatalogCommerceSettings,
} from "./service";

describe("catalog/service request builders", () => {
  it("builds product create params with Meta-required fields", () => {
    const params = buildCreateCatalogProductParams({
      retailer_id: "review-sku-1",
      name: "Review Demo Item",
      description: "Visible only during Meta review.",
      price: "19.99",
      currency: "usd",
      image_url: "https://example.com/item.jpg",
      additional_image_urls: [
        "https://example.com/item-side.jpg",
        "https://example.com/item-back.jpg",
      ],
      url: "https://example.com/item",
      brand: "Ice Core",
      availability: "in stock",
      condition: "new",
      sale_price: "17.99",
      inventory: 12,
      product_type: "Demo",
      color: "Blue",
      size: "M",
      material: "Cotton",
      gender: "unisex",
      age_group: "adult",
      custom_label_0: "review",
    });

    expect(params.get("retailer_id")).toBe("review-sku-1");
    expect(params.get("name")).toBe("Review Demo Item");
    expect(params.get("price")).toBe("1999");
    expect(params.get("currency")).toBe("USD");
    expect(params.get("image_url")).toBe("https://example.com/item.jpg");
    expect(params.get("additional_image_urls")).toBe(
      "https://example.com/item-side.jpg,https://example.com/item-back.jpg"
    );
    expect(params.get("url")).toBe("https://example.com/item");
    expect(params.get("availability")).toBe("in stock");
    expect(params.get("condition")).toBe("new");
    expect(params.get("sale_price")).toBe("17.99 USD");
    expect(params.get("inventory")).toBe("12");
    expect(params.get("custom_label_0")).toBe("review");
  });

  it("normalizes commerce settings from Meta data arrays", async () => {
    const client = {
      getJson: jest.fn().mockResolvedValue({
        data: [
          {
            id: "catalog-1",
            is_catalog_visible: true,
            is_cart_enabled: false,
          },
        ],
      }),
    };

    await expect(
      getCatalogCommerceSettings({
        accessToken: "access-token",
        phoneNumberId: "phone-1",
        client: client as never,
      })
    ).resolves.toEqual({
      id: "catalog-1",
      catalog_id: "catalog-1",
      is_catalog_visible: true,
      is_cart_enabled: false,
    });
  });

  it("does not send catalog_id when updating commerce settings", async () => {
    const client = {
      postJson: jest.fn().mockResolvedValue({ success: true }),
    };

    await updateCatalogCommerceSettings({
      accessToken: "access-token",
      phoneNumberId: "phone-1",
      settings: {
        catalog_id: "catalog-1",
        is_catalog_visible: true,
        is_cart_enabled: true,
      },
      client: client as never,
    });

    const body = client.postJson.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("is_catalog_visible")).toBe("true");
    expect(body.get("is_cart_enabled")).toBe("true");
    expect(body.has("catalog_id")).toBe(false);
  });

  it("builds items_batch update requests keyed by product content id", () => {
    const params = buildCatalogItemsBatchParams({
      method: "UPDATE",
      retailerId: "review-sku-1",
      data: {
        name: "Renamed",
        price: "24.5",
        currency: "eur",
        availability: "out of stock",
        inventory: 0,
        sale_price: "20",
        additional_image_urls: ["https://example.com/new.jpg"],
      },
    });

    expect(params.get("item_type")).toBe("PRODUCT_ITEM");
    expect(JSON.parse(params.get("requests") || "[]")).toEqual([
      {
        method: "UPDATE",
        data: {
          id: "review-sku-1",
          title: "Renamed",
          price: "24.50 EUR",
          availability: "out of stock",
          inventory: 0,
          sale_price: "20.00 EUR",
          additional_image_link: ["https://example.com/new.jpg"],
        },
      },
    ]);
  });

  it("builds items_batch delete requests with only the product identifier", () => {
    const params = buildCatalogItemsBatchParams({
      method: "DELETE",
      retailerId: "review-sku-1",
    });

    expect(JSON.parse(params.get("requests") || "[]")).toEqual([
      {
        method: "DELETE",
        data: {
          id: "review-sku-1",
        },
      },
    ]);
  });

  it("parses CSV uploads and reports row validation failures", () => {
    const parsed = parseCatalogCsvRows(
      [
        "retailer_id,name,description,price,currency,image_url,url,inventory",
        "sku-1,Product 1,Good item,10,USD,https://example.com/1.jpg,https://example.com/1,5",
        "sku-2,,Missing name,12,USD,https://example.com/2.jpg,https://example.com/2,",
      ].join("\n")
    );

    expect(parsed.validItems).toHaveLength(1);
    expect(parsed.validItems[0]?.retailer_id).toBe("sku-1");
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        rowNumber: 3,
        field: "name",
      }),
    ]);
  });

  it("exports catalog products as CSV with stable headers", () => {
    const csv = serializeCatalogProductsCsv([
      {
        retailer_id: "sku-1",
        name: "Product 1",
        description: "Good item",
        price: "10.00 USD",
        currency: "USD",
        image_url: "https://example.com/1.jpg",
        url: "https://example.com/1",
        availability: "in stock",
      },
    ]);

    expect(csv.split("\n")[0]).toContain("retailer_id,name,description");
    expect(csv).toContain("sku-1,Product 1,Good item");
  });
});

describe("isCatalogPermissionError", () => {
  it("recognizes Meta permission errors as reconnect-required catalog access failures", () => {
    const error = new MetaGraphRequestError({
      message: "Permissions error: missing catalog_management permission",
      status: 403,
      statusText: "Forbidden",
      url: "https://graph.facebook.com/v25.0/123/products",
      details: {
        error: {
          message: "(#200) Permissions error",
          type: "OAuthException",
          code: 200,
        },
      },
      metaError: {
        message: "(#200) Permissions error",
        type: "OAuthException",
        code: 200,
      },
    });

    expect(isCatalogPermissionError(error)).toBe(true);
  });

  it("does not hide expired-token errors behind catalog permission messaging", () => {
    const error = new MetaGraphRequestError({
      message: "Invalid OAuth 2.0 Access Token",
      status: 401,
      statusText: "Unauthorized",
      url: "https://graph.facebook.com/v25.0/123/products",
      details: {
        error: {
          message: "Error validating access token: Session has expired",
          type: "OAuthException",
          code: 190,
        },
      },
      metaError: {
        message: "Error validating access token: Session has expired",
        type: "OAuthException",
        code: 190,
      },
    });

    expect(isCatalogPermissionError(error)).toBe(false);
  });

  it("does not classify unrelated permission errors as catalog permission failures", () => {
    const error = new MetaGraphRequestError({
      message: "(#200) Permissions error",
      status: 403,
      statusText: "Forbidden",
      url: "https://graph.facebook.com/v25.0/act_1/campaigns",
      details: {
        error: {
          message: "(#200) Permissions error",
          type: "OAuthException",
          code: 200,
        },
      },
      metaError: {
        message: "(#200) Permissions error",
        type: "OAuthException",
        code: 200,
      },
    });

    expect(isCatalogPermissionError(error)).toBe(false);
  });
});

describe("isWabaCatalogUnsupportedMethodError", () => {
  it("recognizes Meta unknown-method failures on the WABA product_catalogs edge", () => {
    const error = new MetaGraphRequestError({
      message: "OAuthException (3, subcode 1798083): Unknown method",
      status: 400,
      statusText: "Bad Request",
      url: "https://graph.facebook.com/v25.0/waba-1/product_catalogs",
      details: {
        error: {
          message: "Unknown method",
          type: "OAuthException",
          code: 3,
          error_subcode: 1798083,
        },
      },
      metaError: {
        message: "Unknown method",
        type: "OAuthException",
        code: 3,
        error_subcode: 1798083,
      },
    });

    expect(isWabaCatalogUnsupportedMethodError(error)).toBe(true);
  });
});

describe("catalog/service paging", () => {
  it("follows Meta paging links when listing catalog products", async () => {
    const client = {
      getJson: jest
        .fn()
        .mockResolvedValueOnce({
          data: [{ retailer_id: "sku-1", name: "First" }],
          paging: {
            next: "https://graph.facebook.com/v25.0/catalog-1/products?after=page-2&access_token=query-secret",
          },
        })
        .mockResolvedValueOnce({
          data: [{ retailer_id: "sku-2", name: "Second" }],
        }),
    };

    const products = await listCatalogProducts({
      accessToken: "access-token",
      catalogId: "catalog-1",
      limit: 500,
      client: client as never,
    });

    expect(products.map(product => product.retailer_id)).toEqual([
      "sku-1",
      "sku-2",
    ]);
    expect(client.getJson).toHaveBeenCalledTimes(2);
    expect(client.getJson).toHaveBeenLastCalledWith(
      "https://graph.facebook.com/v25.0/catalog-1/products?after=page-2",
      {
        token: "access-token",
      }
    );
  });
});
