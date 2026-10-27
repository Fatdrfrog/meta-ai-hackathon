const mockCreateBusinessOwnedProductCatalog = jest.fn();
const mockGetCatalogCommerceSettings = jest.fn();
const mockGetProductCatalog = jest.fn();
const mockIsCatalogPermissionError = jest.fn();
const mockIsWabaCatalogUnsupportedMethodError = jest.fn();
const mockLinkWabaProductCatalog = jest.fn();
const mockListBusinessOwnedProductCatalogs = jest.fn();
const mockListWabaProductCatalogs = jest.fn();
const mockUpdateCatalogCommerceSettings = jest.fn();

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: jest.fn((value: unknown) =>
    typeof value === "string" ? value : null
  ),
}));

jest.mock("@/lib/whatsapp/catalog/service", () => ({
  CATALOG_PERMISSION: "catalog_management",
  dedupeCatalogs: (
    catalogs: Array<{ id?: string | null; [key: string]: unknown }>
  ) => {
    const byId = new Map<string, Record<string, unknown>>();
    for (const catalog of catalogs) {
      if (!catalog?.id) continue;
      byId.set(catalog.id, { ...byId.get(catalog.id), ...catalog });
    }
    return Array.from(byId.values());
  },
  createBusinessOwnedProductCatalog: (...args: unknown[]) =>
    mockCreateBusinessOwnedProductCatalog(...args),
  getCatalogCommerceSettings: (...args: unknown[]) =>
    mockGetCatalogCommerceSettings(...args),
  getProductCatalog: (...args: unknown[]) => mockGetProductCatalog(...args),
  isCatalogPermissionError: (...args: unknown[]) =>
    mockIsCatalogPermissionError(...args),
  isWabaCatalogUnsupportedMethodError: (...args: unknown[]) =>
    mockIsWabaCatalogUnsupportedMethodError(...args),
  linkWabaProductCatalog: (...args: unknown[]) =>
    mockLinkWabaProductCatalog(...args),
  listBusinessOwnedProductCatalogs: (...args: unknown[]) =>
    mockListBusinessOwnedProductCatalogs(...args),
  listWabaProductCatalogs: (...args: unknown[]) =>
    mockListWabaProductCatalogs(...args),
  updateCatalogCommerceSettings: (...args: unknown[]) =>
    mockUpdateCatalogCommerceSettings(...args),
}));

import { runWhatsAppCatalogSetup } from "@/lib/whatsapp/catalog/setup";

describe("runWhatsAppCatalogSetup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateBusinessOwnedProductCatalog.mockResolvedValue({
      id: "catalog-created",
      name: "airi.chat WhatsApp catalog",
    });
    mockGetCatalogCommerceSettings.mockResolvedValue({
      is_catalog_visible: false,
      is_cart_enabled: false,
    });
    mockGetProductCatalog.mockResolvedValue({
      id: "catalog-stored",
      name: "Stored catalog",
    });
    mockIsCatalogPermissionError.mockReturnValue(false);
    mockIsWabaCatalogUnsupportedMethodError.mockReturnValue(false);
    mockLinkWabaProductCatalog.mockResolvedValue({ success: true });
    mockListBusinessOwnedProductCatalogs.mockResolvedValue([]);
    mockListWabaProductCatalogs.mockResolvedValue([]);
    mockUpdateCatalogCommerceSettings.mockResolvedValue({ success: true });
  });

  it("auto-creates, links, enables, and persists a catalog when none is available", async () => {
    const savedCredentials: Record<string, unknown>[] = [];

    const result = await runWhatsAppCatalogSetup({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      credentials: {
        access_token: "access-token",
        business_id: "business-1",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        embedded_signup_flow: "cloud_api",
      },
      autoCreate: true,
      linkCatalog: true,
      enableCommerceSettings: true,
      saveCredentials: async credentials => {
        savedCredentials.push(credentials);
      },
    });

    expect(mockCreateBusinessOwnedProductCatalog).toHaveBeenCalledWith({
      accessToken: "access-token",
      businessId: "business-1",
      name: "airi.chat WhatsApp catalog",
    });
    expect(mockLinkWabaProductCatalog).toHaveBeenCalledWith({
      accessToken: "access-token",
      catalogId: "catalog-created",
      wabaId: "waba-1",
    });
    expect(mockUpdateCatalogCommerceSettings).toHaveBeenCalledWith({
      accessToken: "access-token",
      phoneNumberId: "phone-1",
      settings: {
        is_catalog_visible: true,
        is_cart_enabled: true,
      },
    });
    expect(result).toEqual(
      expect.objectContaining({
        setupStatus: "ready",
        catalogCreated: true,
        catalogLinked: true,
        selectedCatalog: expect.objectContaining({ id: "catalog-created" }),
      })
    );
    expect(savedCredentials.at(-1)).toEqual(
      expect.objectContaining({
        catalog_ids: ["catalog-created"],
        catalog_setup: expect.objectContaining({
          status: "ready",
          selected_catalog_id: "catalog-created",
        }),
      })
    );
  });

  it("keeps WABA product_catalogs unknown-method failures as diagnostics when business catalogs are available", async () => {
    const unknownMethod = new Error("Unknown method");
    mockListBusinessOwnedProductCatalogs.mockResolvedValue([
      { id: "catalog-business", name: "Business catalog" },
    ]);
    mockListWabaProductCatalogs.mockRejectedValue(unknownMethod);
    mockIsWabaCatalogUnsupportedMethodError.mockImplementation(
      error => error === unknownMethod
    );

    const result = await runWhatsAppCatalogSetup({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      credentials: {
        access_token: "access-token",
        business_id: "business-1",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        embedded_signup_flow: "cloud_api",
      },
      autoCreate: false,
      linkCatalog: false,
      enableCommerceSettings: false,
    });

    expect(result.setupStatus).toBe("ready");
    expect(result.selectedCatalog).toEqual({
      id: "catalog-business",
      name: "Business catalog",
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "waba_product_catalogs_unknown_method",
        }),
      ])
    );
    expect(result.blockingIssues).toEqual([]);
  });
});
