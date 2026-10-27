const mockCreateClient = jest.fn();
const mockAuditCreate = jest.fn();
const mockMirrorTemplate = jest.fn();
const mockDnsLookup = jest.fn();

// Header media URLs pass the crawler's SSRF check, which resolves the host.
jest.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/mongoose", () => ({ connectDB: jest.fn() }));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateAuditLog: {
    create: (...args: unknown[]) => mockAuditCreate(...args),
  },
  WhatsAppTemplateModel: {},
}));

jest.mock("@/lib/whatsapp/templates/template-mirror", () => ({
  ...jest.requireActual("@/lib/whatsapp/templates/template-mirror"),
  mirrorWhatsAppTemplate: (...args: unknown[]) => mockMirrorTemplate(...args),
}));

import { updateWhatsAppTemplateMutation } from "./mutation-service";
import { createTemplate, getTemplate, updateTemplate } from "./service";
import {
  createUnifiedTemplateRecord,
  WhatsAppTemplateRecordPersistenceError,
} from "./unified-service";

const accountContext = {
  workspaceId: "workspace-1",
  sourceId: "source-selected",
  wabaId: "waba-selected",
  accessToken: "operator-token",
  candidateSource: "credentials.waba_id" as const,
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

describe("template operator account context", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockRejectedValue(
      new Error("No request cookies available")
    );
    mockAuditCreate.mockResolvedValue(undefined);
    mockDnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    global.fetch = mockFetch;
    process.env.NEXT_PUBLIC_META_APP_ID = "app-selected";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_META_APP_ID;
  });

  it("creates and mirrors a media template on the pinned account without cookies", async () => {
    const sampleUrl = "https://assets.airi.chat/demo/welcome.png";
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      // The header download passes a URL object; Graph calls pass strings.
      if (String(url) === sampleUrl) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("/app-selected/uploads?"))
        return jsonResponse({ id: "upload:sample" });
      if (url.endsWith("/upload:sample"))
        return jsonResponse({ h: "review-sample-handle" });
      if (
        url.endsWith("/waba-selected/message_templates") &&
        init?.method === "POST"
      ) {
        return jsonResponse({ id: "meta-demo-1", status: "PENDING" });
      }
      if (url.includes("/meta-demo-1?")) {
        return jsonResponse({
          id: "meta-demo-1",
          name: "airi_demo_welcome",
          language: "kk",
          status: "APPROVED",
        });
      }
      throw new Error("Unexpected provider operation");
    });
    const insert = jest.fn(() => ({
      select: () => ({
        single: async () => ({ data: { id: "local-demo-1" }, error: null }),
      }),
    }));
    const components = [
      {
        type: "HEADER" as const,
        format: "IMAGE" as const,
        example: { header_handle: [sampleUrl] },
      },
      { type: "BODY" as const, text: "Welcome to the airi.chat demo" },
    ];

    const result = await createUnifiedTemplateRecord({
      workspaceId: "workspace-1",
      userId: "operator-user",
      supabase: { from: () => ({ insert }) } as never,
      name: "airi_demo_welcome",
      channel: "whatsapp",
      whatsappData: { language: "kk", category: "MARKETING", components },
      accountContext,
    });

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: "local-demo-1",
      metaTemplateId: "meta-demo-1",
      metaTemplateStatus: "APPROVED",
      warning: undefined,
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        whatsapp_data: expect.objectContaining({
          wabaId: "waba-selected",
          metaTemplateId: "meta-demo-1",
          status: "APPROVED",
          components,
        }),
      })
    );
    const createCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/waba-selected/message_templates") &&
        init?.method === "POST"
    );
    expect(createCall).toBeDefined();
    expect(JSON.parse(createCall![1].body)).toEqual(
      expect.objectContaining({
        language: "kk",
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: ["review-sample-handle"] },
          },
          { type: "BODY", text: "Welcome to the airi.chat demo" },
        ],
      })
    );
  });

  it.each([
    { ...accountContext, workspaceId: "another-workspace" },
    { ...accountContext, sourceId: "" },
    { ...accountContext, wabaId: "" },
    { ...accountContext, accessToken: "" },
  ])(
    "rejects an unbound account context before any provider or cookie lookup",
    async context => {
      await expect(
        createTemplate(
          "workspace-1",
          {
            name: "airi_demo_welcome",
            language: "en",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Welcome" }],
          },
          { accountContext: context }
        )
      ).rejects.toThrow("Invalid WhatsApp template account context");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
    }
  );

  it("reads created template status with the same account without cookies", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        id: "meta-demo-1",
        name: "airi_demo_welcome",
        language: "en",
        status: "PENDING",
      })
    );
    await expect(
      getTemplate("workspace-1", "meta-demo-1", { accountContext })
    ).resolves.toEqual(
      expect.objectContaining({ id: "meta-demo-1", status: "PENDING" })
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/meta-demo-1?"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer operator-token",
        }),
      })
    );
  });

  it("defers the immediate GET on the canonical creation path while persisting the POST acknowledgment", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ id: "meta-demo-1", status: "PENDING" })
    );
    const insert = jest.fn(() => ({
      select: () => ({
        single: async () => ({ data: { id: "local-demo-1" }, error: null }),
      }),
    }));
    const components = [
      {
        type: "BODY" as const,
        text: "Welcome *{{first_name}}*",
        example: {
          body_text_named_params: [
            { param_name: "first_name", example: "Alex" },
          ],
        },
      },
    ];
    await expect(
      createUnifiedTemplateRecord({
        workspaceId: "workspace-1",
        userId: "operator-user",
        supabase: { from: () => ({ insert }) } as never,
        name: "airi_demo_welcome",
        channel: "whatsapp",
        whatsappData: { language: "en", category: "MARKETING", components },
        accountContext,
        deferCreatedStatusReadback: true,
      })
    ).resolves.toMatchObject({
      id: "local-demo-1",
      metaTemplateId: "meta-demo-1",
      metaTemplateStatus: "PENDING",
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/waba-selected\/message_templates$/),
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      parameter_format: "NAMED",
      components,
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        whatsapp_data: {
          language: "en",
          category: "MARKETING",
          components,
          wabaId: "waba-selected",
          metaTemplateId: "meta-demo-1",
          status: "PENDING",
        },
      })
    );
  });

  it.each([
    undefined,
    null,
    { ...accountContext, workspaceId: "wrong-workspace" },
    { ...accountContext, sourceId: "" },
  ])(
    "fails deferred creation closed on missing or malformed selected account",
    async context => {
      await expect(
        createUnifiedTemplateRecord({
          workspaceId: "workspace-1",
          userId: "operator-user",
          supabase: {} as never,
          name: "airi_demo_welcome",
          channel: "whatsapp",
          whatsappData: {
            language: "en",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Welcome" }],
          },
          accountContext: context as never,
          deferCreatedStatusReadback: true,
        })
      ).rejects.toThrow(
        /selected WhatsApp account|Invalid WhatsApp template account context/
      );
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it("preserves the authenticated credential lookup when no context is supplied", async () => {
    await expect(
      createTemplate("workspace-1", {
        name: "airi_demo_welcome",
        language: "en",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Welcome" }],
      })
    ).rejects.toThrow("No request cookies available");
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects an explicit malformed context instead of selecting another source", async () => {
    await expect(
      createUnifiedTemplateRecord({
        workspaceId: "workspace-1",
        userId: "operator-user",
        supabase: {} as never,
        name: "airi_demo_welcome",
        channel: "whatsapp",
        whatsappData: {
          language: "en",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Welcome" }],
        },
        accountContext: null as never,
      })
    ).rejects.toThrow("Invalid WhatsApp template account context");
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "preserves an acknowledged provider id when local persistence fails (throws=%s, deferred=%s)",
    async (throws, deferred) => {
      mockFetch.mockImplementation(async (url: string) =>
        url.includes("/meta-demo-1?")
          ? jsonResponse({
              id: "meta-demo-1",
              name: "airi_demo_welcome",
              status: "PENDING",
            })
          : jsonResponse({ id: "meta-demo-1", status: "PENDING" })
      );
      const single = jest.fn(async () => {
        if (throws) throw new Error("connection interrupted");
        return { data: null, error: { message: "local insert failed" } };
      });
      let failure: unknown;
      try {
        await createUnifiedTemplateRecord({
          workspaceId: "workspace-1",
          userId: "operator-user",
          supabase: {
            from: () => ({ insert: () => ({ select: () => ({ single }) }) }),
          } as never,
          name: "airi_demo_welcome",
          channel: "whatsapp",
          whatsappData: {
            language: "en",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Welcome" }],
          },
          accountContext,
          ...(deferred ? { deferCreatedStatusReadback: true } : {}),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(WhatsAppTemplateRecordPersistenceError);
      expect(failure).toEqual(
        expect.objectContaining({
          metaTemplateId: "meta-demo-1",
          metaTemplateStatus: "PENDING",
        })
      );
      expect(
        mockFetch.mock.calls.filter(([, init]) => init?.method === "POST")
      ).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(deferred ? 1 : 2);
      expect(mockAuditCreate).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
    }
  );
});

describe("template operator update context", () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockRejectedValue(
      new Error("No request cookies available")
    );
    global.fetch = mockFetch;
  });
  const payload = {
    components: [
      { type: "BODY" as const, text: "*Your sample order is ready.*" },
    ],
  };
  it("updates the selected template without request cookies using the same pinned account", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));
    await expect(
      updateTemplate("workspace-1", "meta-demo-1", payload, { accountContext })
    ).resolves.toEqual({ success: true });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/meta-demo-1$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer operator-token",
        }),
        body: JSON.stringify(payload),
      })
    );
  });
  it.each([
    { ...accountContext, workspaceId: "another-workspace" },
    { ...accountContext, sourceId: "" },
    null,
  ])(
    "rejects malformed update contexts before provider and cookie lookup",
    async context => {
      await expect(
        updateTemplate("workspace-1", "meta-demo-1", payload, {
          accountContext: context as never,
        })
      ).rejects.toThrow("Invalid WhatsApp template account context");
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );
  it("keeps authenticated update credential lookup when context is omitted", async () => {
    await expect(
      updateTemplate("workspace-1", "meta-demo-1", payload)
    ).rejects.toThrow("No request cookies available");
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

it("updates and rereads with the pinned context before refreshing the canonical local mirrors", async () => {
  jest.clearAllMocks();
  mockCreateClient.mockRejectedValue(new Error("No request cookies available"));
  const template = {
    id: "meta-demo-1",
    name: "airi_demo_welcome",
    language: "en",
    category: "MARKETING",
    status: "PENDING",
    components: [{ type: "BODY", text: "Updated sample" }],
  };
  const mockFetch = jest.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ success: true })
        : jsonResponse(template)
  );
  global.fetch = mockFetch;
  mockMirrorTemplate.mockResolvedValue({
    errors: [],
    snapshotUpdated: true,
    unifiedRows: 1,
  });
  await expect(
    updateWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      templateId: "meta-demo-1",
      accountContext,
      components: template.components,
      audit: { enabled: false },
    })
  ).resolves.toEqual({ success: true, warning: undefined, template });
  expect(mockCreateClient).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(2);
  for (const [, init] of mockFetch.mock.calls)
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer operator-token",
    });
  expect(mockMirrorTemplate).toHaveBeenCalledWith({
    supabase: {},
    workspaceId: "workspace-1",
    template,
  });
});

it.each(["create", "update"])(
  "emits NAMED format for %s without changing examples or WhatsApp markdown",
  async operation => {
    const mockFetch = jest.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          operation === "create"
            ? { id: "meta-demo-1", status: "PENDING" }
            : { success: true }
        )
    );
    global.fetch = mockFetch;
    const components = [
      {
        type: "BODY" as const,
        text: "Hi *{{first_name}}*, your _{{order_name}}_ is ready.",
        example: {
          body_text_named_params: [
            { param_name: "first_name", example: "Alex" },
            { param_name: "order_name", example: "Demo order" },
          ],
        },
      },
    ];
    if (operation === "create")
      await createTemplate(
        "workspace-1",
        {
          name: "airi_demo_named",
          language: "en",
          category: "MARKETING",
          components,
        },
        { accountContext }
      );
    else
      await updateTemplate(
        "workspace-1",
        "meta-demo-1",
        { components },
        { accountContext }
      );
    expect(
      JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
    ).toMatchObject({ parameter_format: "NAMED", components });
  }
);
