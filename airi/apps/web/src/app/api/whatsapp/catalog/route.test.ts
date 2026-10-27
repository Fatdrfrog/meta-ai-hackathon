const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockCreateCatalogProduct = jest.fn();
const mockUpdateCurrentWhatsAppSourceCredentials = jest.fn();
const mockDeleteCatalogProduct = jest.fn();
const mockGetCatalogCommerceSettings = jest.fn();
const mockListBusinessOwnedProductCatalogs = jest.fn();
const mockListCatalogProducts = jest.fn();
const mockListWabaProductCatalogs = jest.fn();
const mockParseCatalogCsvRows = jest.fn();
const mockRunWhatsAppCatalogSetup = jest.fn();
const mockSerializeCatalogProductsCsv = jest.fn();
const mockUpdateCatalogCommerceSettings = jest.fn();
const mockUpdateCatalogProduct = jest.fn();
const mockSendWhatsappCatalogMessage = jest.fn();
const mockSendWhatsappCatalogLinkMessage = jest.fn();
const mockSendWhatsappMultiProductMessage = jest.fn();
const mockSendWhatsappProductCarouselMessage = jest.fn();
const mockSendWhatsappSingleProductMessage = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockStartWhatsAppCatalogImportWorkflow = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/catalog/service", () => ({
  CATALOG_PERMISSION: "catalog_management",
  createCatalogProduct: (...args: unknown[]) =>
    mockCreateCatalogProduct(...args),
  dedupeCatalogs: (catalogs: Array<{ id: string }>) => catalogs,
  deleteCatalogProduct: (...args: unknown[]) =>
    mockDeleteCatalogProduct(...args),
  getCatalogCommerceSettings: (...args: unknown[]) =>
    mockGetCatalogCommerceSettings(...args),
  isCatalogPermissionError: (error: unknown) =>
    Boolean(
      (error as { isCatalogPermissionError?: boolean })
        ?.isCatalogPermissionError
    ),
  isWabaCatalogUnsupportedMethodError: (error: unknown) =>
    Boolean(
      (error as { isWabaCatalogUnsupportedMethodError?: boolean })
        ?.isWabaCatalogUnsupportedMethodError
    ),
  listBusinessOwnedProductCatalogs: (...args: unknown[]) =>
    mockListBusinessOwnedProductCatalogs(...args),
  listCatalogProducts: (...args: unknown[]) => mockListCatalogProducts(...args),
  listWabaProductCatalogs: (...args: unknown[]) =>
    mockListWabaProductCatalogs(...args),
  parseCatalogCsvRows: (...args: unknown[]) => mockParseCatalogCsvRows(...args),
  serializeCatalogProductsCsv: (...args: unknown[]) =>
    mockSerializeCatalogProductsCsv(...args),
  updateCatalogCommerceSettings: (...args: unknown[]) =>
    mockUpdateCatalogCommerceSettings(...args),
  updateCatalogProduct: (...args: unknown[]) =>
    mockUpdateCatalogProduct(...args),
}));

jest.mock("@/lib/whatsapp/catalog/setup", () => ({
  runWhatsAppCatalogSetup: (...args: unknown[]) =>
    mockRunWhatsAppCatalogSetup(...args),
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCurrentWhatsAppSourceCredentials(...args),
}));

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappCatalogMessage: (...args: unknown[]) =>
    mockSendWhatsappCatalogMessage(...args),
  sendWhatsappCatalogLinkMessage: (...args: unknown[]) =>
    mockSendWhatsappCatalogLinkMessage(...args),
  sendWhatsappMultiProductMessage: (...args: unknown[]) =>
    mockSendWhatsappMultiProductMessage(...args),
  sendWhatsappProductCarouselMessage: (...args: unknown[]) =>
    mockSendWhatsappProductCarouselMessage(...args),
  sendWhatsappSingleProductMessage: (...args: unknown[]) =>
    mockSendWhatsappSingleProductMessage(...args),
}));

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: () => mockIsTemporalConfigured(),
}));

jest.mock("@/lib/temporal/whatsapp-catalog-import", () => ({
  startWhatsAppCatalogImportWorkflow: (...args: unknown[]) =>
    mockStartWhatsAppCatalogImportWorkflow(...args),
}));

function mockContext(overrides: Record<string, unknown> = {}) {
  mockGetWhatsAppWorkspaceContext.mockResolvedValue({
    error: null,
    context: {
      accessToken: "access-token",
      phoneNumberId: "phone-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      credentials: {
        businessId: "business-1",
        catalogIds: ["catalog-business"],
        embeddedSignupFlow: "cloud_api",
        coexistenceMode: false,
        isOnBizApp: false,
      },
      ...overrides,
    },
  });
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/whatsapp/catalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext();
    mockUpdateCurrentWhatsAppSourceCredentials.mockResolvedValue({
      credentials: {},
    });
    mockListWabaProductCatalogs.mockResolvedValue([
      { id: "catalog-waba", name: "WABA catalog" },
    ]);
    mockListBusinessOwnedProductCatalogs.mockResolvedValue([
      { id: "catalog-business", name: "Business catalog" },
    ]);
    mockListCatalogProducts.mockResolvedValue([
      { retailer_id: "sku-1", name: "Product 1" },
    ]);
    mockGetCatalogCommerceSettings.mockResolvedValue({
      is_catalog_visible: true,
      is_cart_enabled: true,
    });
    mockRunWhatsAppCatalogSetup.mockResolvedValue({
      setupStatus: "ready",
      checks: [],
      blockingIssues: [],
      diagnostics: [],
      catalogCreated: false,
      catalogLinked: false,
      catalogs: [{ id: "catalog-business", name: "Business catalog" }],
      selectedCatalog: { id: "catalog-business", name: "Business catalog" },
      commerceSettings: {
        is_catalog_visible: true,
        is_cart_enabled: true,
      },
    });
    mockParseCatalogCsvRows.mockReturnValue({
      validItems: [
        {
          retailer_id: "sku-1",
          name: "Product 1",
          description: "Description",
          price: "10",
          currency: "USD",
          image_url: "https://example.com/1.jpg",
          url: "https://example.com/1",
        },
      ],
      errors: [],
    });
    mockIsTemporalConfigured.mockReturnValue(true);
    mockStartWhatsAppCatalogImportWorkflow.mockResolvedValue({
      workflowId: "whatsapp-catalog-import:workspace-1:catalog-business:run-1",
    });
    mockSendWhatsappSingleProductMessage.mockResolvedValue({
      messageId: "wamid.1",
    });
  });

  it("returns live products from the selected full Cloud API catalog", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/catalog?workspaceId=workspace-1&includeCommerceSettings=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.selectedCatalog).toEqual({
      id: "catalog-business",
      name: "Business catalog",
    });
    expect(body.products).toEqual([
      { retailer_id: "sku-1", name: "Product 1" },
    ]);
    expect(body.commerceSettings).toEqual({
      is_catalog_visible: true,
      is_cart_enabled: true,
    });
    expect(mockListCatalogProducts).toHaveBeenCalledWith({
      accessToken: "access-token",
      catalogId: "catalog-business",
      limit: 200,
    });
  });

  it("blocks coexistence connections with a reconnect requirement", async () => {
    mockContext({
      credentials: {
        businessId: "business-1",
        embeddedSignupFlow: "coexistence",
        coexistenceMode: true,
        isOnBizApp: true,
      },
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/catalog?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.requiresReconnect).toBe(true);
    expect(body.products).toEqual([]);
    expect(mockListCatalogProducts).not.toHaveBeenCalled();
  });

  it("allows full Cloud API catalog access when old coexistence flags are stale", async () => {
    mockContext({
      credentials: {
        businessId: "business-1",
        catalogIds: ["catalog-business"],
        embeddedSignupFlow: "cloud_api",
        coexistenceMode: true,
        isOnBizApp: false,
        platformType: "NOT_APPLICABLE",
      },
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/catalog?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.requiresReconnect).toBe(false);
    expect(body.selectedCatalog).toEqual({
      id: "catalog-business",
      name: "Business catalog",
    });
    expect(mockListCatalogProducts).toHaveBeenCalledWith({
      accessToken: "access-token",
      catalogId: "catalog-business",
      limit: 200,
    });
  });

  it("reports unsupported WABA catalog edge as diagnostics instead of raw OAuth errors", async () => {
    mockListWabaProductCatalogs.mockRejectedValue({
      isWabaCatalogUnsupportedMethodError: true,
      message: "OAuthException (3, subcode 1798083): Unknown method",
    });
    mockListBusinessOwnedProductCatalogs.mockResolvedValue([]);
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/catalog?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.error).not.toContain("Unknown method");
    expect(body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "waba_product_catalogs_unknown_method",
        }),
      ])
    );
    expect(body.blockingIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "catalog_missing",
        }),
      ])
    );
  });

  it("runs protected catalog setup through the setup action and scopes credential persistence by workspace", async () => {
    mockRunWhatsAppCatalogSetup.mockImplementationOnce(
      async ({
        saveCredentials,
      }: {
        saveCredentials: (
          credentials: Record<string, unknown>
        ) => Promise<void>;
      }) => {
        await saveCredentials({
          catalog_ids: ["catalog-business"],
          catalog_setup: { status: "ready" },
        });
        return {
          setupStatus: "ready",
          checks: [],
          blockingIssues: [],
          diagnostics: [],
          catalogCreated: false,
          catalogLinked: false,
          catalogs: [{ id: "catalog-business", name: "Business catalog" }],
          selectedCatalog: {
            id: "catalog-business",
            name: "Business catalog",
          },
          commerceSettings: {
            is_catalog_visible: true,
            is_cart_enabled: true,
          },
        };
      }
    );
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest({
        action: "setup",
        workspaceId: "workspace-1",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.setupStatus).toBe("ready");
    expect(mockRunWhatsAppCatalogSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: expect.any(String),
        autoCreate: true,
        linkCatalog: true,
        enableCommerceSettings: true,
        saveCredentials: expect.any(Function),
      })
    );
    expect(mockUpdateCurrentWhatsAppSourceCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        buildCredentials: expect.any(Function),
      })
    );
    const buildCredentials = mockUpdateCurrentWhatsAppSourceCredentials.mock
      .calls[0][0].buildCredentials as (
      current: Record<string, unknown>
    ) => Record<string, unknown>;
    expect(buildCredentials({ existing: true })).toEqual(
      expect.objectContaining({
        existing: true,
        catalog_ids: ["catalog-business"],
        catalog_setup: { status: "ready" },
      })
    );
  });

  it("dry-runs CSV bulk imports before calling items_batch", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest({
        action: "bulk_import",
        workspaceId: "workspace-1",
        catalogId: "catalog-business",
        dryRun: true,
        csv: "retailer_id,name,description,price,currency,image_url,url\nsku-1,Product,Description,10,USD,https://example.com/1.jpg,https://example.com/1",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      dryRun: true,
      validCount: 1,
    });
  });

  it("authenticates bulk dry-runs before parsing uploaded rows", async () => {
    mockGetWhatsAppWorkspaceContext.mockResolvedValueOnce({
      error: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest({
        action: "bulk_import",
        workspaceId: "workspace-1",
        catalogId: "catalog-business",
        dryRun: true,
        csv: "retailer_id,name,description,price,currency,image_url,url\nsku-1,Product,Description,10,USD,https://example.com/1.jpg,https://example.com/1",
      })
    );

    expect(response.status).toBe(401);
    expect(mockParseCatalogCsvRows).not.toHaveBeenCalled();
  });

  it("queues committed bulk imports in Temporal instead of blocking the API request", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest({
        action: "bulk_import",
        workspaceId: "workspace-1",
        catalogId: "catalog-business",
        dryRun: false,
        csv: "retailer_id,name,description,price,currency,image_url,url\nsku-1,Product,Description,10,USD,https://example.com/1.jpg,https://example.com/1",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      queued: true,
      importCount: 1,
      workflowId: "whatsapp-catalog-import:workspace-1:catalog-business:run-1",
    });
    expect(mockStartWhatsAppCatalogImportWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        catalogId: "catalog-business",
        accessToken: "access-token",
        items: expect.arrayContaining([
          expect.objectContaining({ retailer_id: "sku-1" }),
        ]),
      })
    );
  });

  it("rejects catalog mutations for coexistence connections before calling Meta", async () => {
    mockContext({
      credentials: {
        businessId: "business-1",
        embeddedSignupFlow: "coexistence",
        coexistenceMode: true,
        isOnBizApp: true,
      },
    });
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest({
        workspaceId: "workspace-1",
        catalogId: "catalog-business",
        retailer_id: "sku-1",
        name: "Product",
        description: "Description",
        price: "10",
        currency: "USD",
        image_url: "https://example.com/1.jpg",
        url: "https://example.com/1",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.requiresReconnect).toBe(true);
    expect(mockCreateCatalogProduct).not.toHaveBeenCalled();
  });

  it("does not require a phone number for catalog item creation", async () => {
    mockContext({ phoneNumberId: undefined });
    mockCreateCatalogProduct.mockResolvedValue({
      retailer_id: "sku-1",
      name: "Product",
    });
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest({
        workspaceId: "workspace-1",
        catalogId: "catalog-business",
        retailer_id: "sku-1",
        name: "Product",
        description: "Description",
        price: "10",
        currency: "USD",
        image_url: "https://example.com/1.jpg",
        url: "https://example.com/1",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        requireManager: true,
        requirePhoneNumber: false,
      })
    );
    expect(mockCreateCatalogProduct).toHaveBeenCalledWith({
      accessToken: "access-token",
      catalogId: "catalog-business",
      product: expect.objectContaining({ retailer_id: "sku-1" }),
    });
  });

  it("sends selected single-product messages through the connected phone number", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      jsonRequest({
        action: "send_single_product_message",
        workspaceId: "workspace-1",
        to: "77012345678",
        catalogId: "catalog-business",
        productRetailerId: "sku-1",
        bodyText: "This item is available",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSendWhatsappSingleProductMessage).toHaveBeenCalledWith(
      "phone-1",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({
        catalogId: "catalog-business",
        productRetailerId: "sku-1",
      })
    );
  });

  it("keeps /api/whatsapp/catalogue as a compatibility route", async () => {
    const canonical = await import("./route");
    const compatibility = await import("../catalogue/route");

    expect(compatibility.GET).toBe(canonical.GET);
    expect(compatibility.POST).toBe(canonical.POST);
    expect(compatibility.PATCH).toBe(canonical.PATCH);
    expect(compatibility.DELETE).toBe(canonical.DELETE);
  });
});

export {};
