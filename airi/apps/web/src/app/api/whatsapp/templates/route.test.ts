const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockCreateTemplate = jest.fn();
const mockDeleteTemplate = jest.fn();
const mockListTemplates = jest.fn();
const mockLogTemplateAction = jest.fn();
const mockUpdateTemplate = jest.fn();
const mockResolvePreviousWhatsAppWabaId = jest.fn();
const mockResolveTemplateAccountContext = jest.fn();
const mockGetTemplate = jest.fn();
const mockAccountContext = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  wabaId: "waba-1",
  accessToken: "access-token",
};

jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

jest.mock("@/lib/whatsapp/templates/template-mirror", () => ({
  deleteTemplateSnapshots: jest.fn().mockResolvedValue(undefined),
  mirrorWhatsAppTemplate: jest.fn().mockResolvedValue({ errors: [] }),
}));

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  ...jest.requireActual("@/lib/whatsapp/get-workspace-context"),
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/templates/service", () => ({
  createTemplate: (...args: unknown[]) => mockCreateTemplate(...args),
  deleteTemplate: (...args: unknown[]) => mockDeleteTemplate(...args),
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
  logTemplateAction: (...args: unknown[]) => mockLogTemplateAction(...args),
  updateTemplate: (...args: unknown[]) => mockUpdateTemplate(...args),
  resolveTemplateAccountContext: (...args: unknown[]) =>
    mockResolveTemplateAccountContext(...args),
  getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
}));

jest.mock("@/lib/whatsapp/templates/previous-waba", () => ({
  resolvePreviousWhatsAppWabaId: (...args: unknown[]) =>
    mockResolvePreviousWhatsAppWabaId(...args),
}));

function mockContext(credentials: Record<string, unknown>) {
  mockGetWhatsAppWorkspaceContext.mockResolvedValue({
    context: {
      credentials,
      membership: { role: "admin" },
      user: { id: "user-1" },
      wabaId:
        typeof credentials.wabaId === "string" ? credentials.wabaId : undefined,
    },
  });
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/templates", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/whatsapp/templates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext({});
    mockResolveTemplateAccountContext.mockResolvedValue(mockAccountContext);
    mockGetTemplate.mockResolvedValue({
      id: "template-1",
      name: "template_name",
      language: "en",
      status: "PENDING",
      category: "MARKETING",
      components: [],
    });
    mockListTemplates.mockResolvedValue({ templates: [] });
    mockCreateTemplate.mockResolvedValue({
      id: "template-1",
      status: "PENDING",
    });
    mockUpdateTemplate.mockResolvedValue({ success: true });
    mockLogTemplateAction.mockResolvedValue(undefined);
    mockResolvePreviousWhatsAppWabaId.mockResolvedValue({
      previousWabaId: null,
      wabaHistory: [],
    });
  });

  it("preserves a rate limit and supplies a bounded Retry-After without exposing provider internals", async () => {
    mockContext({ wabaId: "waba-selected", accessToken: "access-token" });
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    mockListTemplates.mockRejectedValue(
      new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        message: "Meta is limiting template refreshes.",
        retryAt,
        providerCode: 80008,
        providerStatus: 400,
      })
    );
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1"
      )
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
    expect(await response.json()).toEqual({
      error: "Meta is limiting template refreshes.",
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      providerCode: 80008,
      retryAt,
    });
  });

  it.each([
    ["WHATSAPP_TEMPLATES_UNAVAILABLE", 503],
    ["WHATSAPP_TEMPLATES_INCOMPLETE", 502],
  ] as const)("preserves cold catalog failure %s", async (code, status) => {
    mockContext({ wabaId: "waba-selected", accessToken: "access-token" });
    mockListTemplates.mockRejectedValue(
      new WhatsAppTemplateCatalogError({
        code,
        message: "Refresh unavailable.",
      })
    );
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1"
      )
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      code,
      error: "Refresh unavailable.",
    });
  });

  it("returns saved catalog rows with honest metadata and their actual WABA identity", async () => {
    mockContext({ wabaId: "waba-old", accessToken: "access-token" });
    const catalog = {
      source: "cache",
      stale: true,
      fetchedAt: "2026-10-06T08:00:00.000Z",
      wabaId: "waba-current",
      refreshOutcome: "cooldown",
      retryAt: "2026-10-06T10:00:00.000Z",
    };
    mockListTemplates.mockResolvedValue({
      templates: [{ id: "t-1", name: "saved" }],
      catalog,
    });
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1&_refresh=1"
      )
    );
    expect(response.status).toBe(200);
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: undefined,
      limit: undefined,
      force: true,
    });
    expect(await response.json()).toMatchObject({
      templates: [{ id: "t-1", name: "saved" }],
      wabaId: "waba-current",
      catalog,
    });
    expect(mockResolvePreviousWhatsAppWabaId).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      currentWabaId: "waba-current",
    });
  });

  it("loads templates from the explicitly authorized WhatsApp source", async () => {
    mockContext({ wabaId: "waba-selected", accessToken: "access-token" });
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1&sourceId=source-2"
      )
    );
    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      {
        requireCredentials: false,
        sourceId: "source-2",
      }
    );
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: undefined,
      limit: undefined,
      sourceId: "source-2",
    });
  });

  it("does not fall back to another source when selected-source access is denied", async () => {
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
      }),
    });
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1&sourceId=other-source"
      )
    );
    expect(response.status).toBe(404);
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("reports a connection-required state instead of calling Meta without credentials", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "whatsapp_not_connected",
      requiresWhatsAppConnection: true,
      templates: [],
    });
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("rejects template creation before calling Meta when credentials are incomplete", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "welcome_message",
        language: "en_US",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hello" }],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "whatsapp_not_connected",
      requiresWhatsAppConnection: true,
    });
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockLogTemplateAction).not.toHaveBeenCalled();
  });

  it("continues to list templates when the workspace has template credentials", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    mockListTemplates.mockResolvedValue({
      templates: [{ id: "template-1", name: "welcome_message" }],
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1&limit=5"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.templates).toEqual([
      { id: "template-1", name: "welcome_message" },
    ]);
    expect(body.wabaId).toBe("waba-1");
    expect(body.previousWabaId).toBeNull();
    expect(body.wabaHistory).toEqual([]);
    expect(mockResolvePreviousWhatsAppWabaId).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      currentWabaId: "waba-1",
    });
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: undefined,
      limit: 5,
    });
  });

  it("returns workspace-scoped previous WABA history for orphaned templates", async () => {
    mockContext({ wabaId: "waba-current", accessToken: "access-token" });
    mockResolvePreviousWhatsAppWabaId.mockResolvedValue({
      previousWabaId: "waba-previous",
      wabaHistory: [
        { wabaId: "waba-previous", recordedAt: "2026-01-01T00:00:00.000Z" },
        { wabaId: "waba-current", recordedAt: "2026-06-01T00:00:00.000Z" },
      ],
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-acme"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.wabaId).toBe("waba-current");
    expect(body.previousWabaId).toBe("waba-previous");
    expect(body.wabaHistory).toEqual([
      { wabaId: "waba-previous", recordedAt: "2026-01-01T00:00:00.000Z" },
      { wabaId: "waba-current", recordedAt: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(mockResolvePreviousWhatsAppWabaId).toHaveBeenCalledWith({
      workspaceId: "workspace-acme",
      currentWabaId: "waba-current",
    });
  });

  it("continues to list templates when the workspace can discover WABAs from Business credentials", async () => {
    mockContext({ businessId: "business-1", accessToken: "access-token" });
    mockListTemplates.mockResolvedValue({ templates: [] });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/templates?workspaceId=workspace-1"
      )
    );

    expect(response.status).toBe(200);
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: undefined,
      limit: undefined,
    });
  });

  it("normalizes legacy locale-style template language codes before creating templates", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "rassilka_19",
        language: "ru_RU",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hello" }],
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        language: "ru",
      }),
      { accountContext: mockAccountContext }
    );
  });

  it("passes marketing template optimization_spec to Meta template creation", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "promo_with_bid",
        language: "en_US",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hello" }],
        optimization_spec: {
          bid_amount: 2500,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        optimization_spec: {
          bid_amount: 2500,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      }),
      { accountContext: mockAccountContext }
    );
  });

  it("preserves WhatsApp formatting markers when creating templates", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { POST } = await import("./route");
    const formattedBody = "Hi *{{1}}*, _order_ ~old~ ```SKU-1```";

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "formatted_offer",
        language: "en_US",
        category: "MARKETING",
        components: [{ type: "BODY", text: formattedBody }],
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        components: [{ type: "BODY", text: formattedBody }],
      }),
      { accountContext: mockAccountContext }
    );
  });

  it("rejects image header creation without a media example before calling Meta", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "promo_image",
        language: "en_US",
        category: "MARKETING",
        components: [
          { type: "HEADER", format: "IMAGE" },
          { type: "BODY", text: "Hello" },
        ],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Media header example is required/);
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockLogTemplateAction).not.toHaveBeenCalled();
  });

  it("rejects optimization_spec for non-marketing template creation", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "utility_with_bid",
        language: "en_US",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hello" }],
        optimization_spec: {
          bid_amount: 2500,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/MARKETING templates/);
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("passes marketing template optimization_spec to Meta template updates", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        templateId: "template-1",
        category: "MARKETING",
        optimization_spec: {
          bid_amount: 3000,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "template-1",
      expect.objectContaining({
        optimization_spec: {
          bid_amount: 3000,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      }),
      { accountContext: mockAccountContext }
    );
  });

  it("preserves WhatsApp formatting markers when updating templates", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { PATCH } = await import("./route");
    const formattedBody = "Updated *body* with _style_";

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        templateId: "template-1",
        components: [{ type: "BODY", text: formattedBody }],
      })
    );

    expect(response.status).toBe(200);
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "template-1",
      expect.objectContaining({
        components: [{ type: "BODY", text: formattedBody }],
      }),
      { accountContext: mockAccountContext }
    );
  });

  it("rejects image header updates without a media example before calling Meta", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        templateId: "template-1",
        components: [
          { type: "HEADER", format: "IMAGE" },
          { type: "BODY", text: "Updated body" },
        ],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Media header example is required/);
    expect(mockUpdateTemplate).not.toHaveBeenCalled();
    expect(mockLogTemplateAction).not.toHaveBeenCalled();
  });

  it("rejects unsupported template language codes before calling Meta", async () => {
    mockContext({ wabaId: "waba-1", accessToken: "access-token" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "promo_portuguese",
        language: "pt",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hello" }],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Unsupported WhatsApp template language code/);
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });
});

export {};
import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";
