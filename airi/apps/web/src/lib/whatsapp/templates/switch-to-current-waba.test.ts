const mockGetWhatsAppAccountCredentials = jest.fn();
const mockCreateWhatsAppTemplateMutation = jest.fn();
const mockRemapTemplateFlowsForCurrentWaba = jest.fn();
const mockResolvePreviousWhatsAppWabaId = jest.fn();

jest.mock("@/lib/whatsapp/account/resolution", () => ({
  getWhatsAppAccountCredentials: (...args: unknown[]) =>
    mockGetWhatsAppAccountCredentials(...args),
}));

jest.mock("@/lib/whatsapp/templates/mutation-service", () => ({
  createWhatsAppTemplateMutation: (...args: unknown[]) =>
    mockCreateWhatsAppTemplateMutation(...args),
}));

jest.mock("@/lib/whatsapp/templates/previous-waba", () => ({
  resolvePreviousWhatsAppWabaId: (...args: unknown[]) =>
    mockResolvePreviousWhatsAppWabaId(...args),
}));

jest.mock("@/lib/whatsapp/templates/remap-template-flows-for-waba", () => {
  const actual = jest.requireActual(
    "@/lib/whatsapp/templates/remap-template-flows-for-waba"
  ) as typeof import("@/lib/whatsapp/templates/remap-template-flows-for-waba");
  return {
    ...actual,
    remapTemplateFlowsForCurrentWaba: (...args: unknown[]) =>
      mockRemapTemplateFlowsForCurrentWaba(...args),
  };
});

import { switchUnifiedTemplateToCurrentWaba } from "@/lib/whatsapp/templates/switch-to-current-waba";
import { TemplateFlowRemapError } from "@/lib/whatsapp/templates/remap-template-flows-for-waba";

function createSupabaseMock(existing: Record<string, unknown> | null) {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: existing,
    error: null,
  });
  const eqWorkspace = jest.fn(() => ({ maybeSingle }));
  const eqId = jest.fn(() => ({ eq: eqWorkspace }));
  const select = jest.fn(() => ({ eq: eqId }));
  const updateEqWorkspace = jest.fn().mockResolvedValue({ error: null });
  const updateEqId = jest.fn(() => ({ eq: updateEqWorkspace }));
  const update = jest.fn(() => ({ eq: updateEqId }));
  const from = jest.fn(() => ({ select, update }));

  return {
    supabase: { from },
    from,
    update,
    updateEqId,
    updateEqWorkspace,
  };
}

describe("switchUnifiedTemplateToCurrentWaba", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppAccountCredentials.mockResolvedValue({
      accessToken: "wa-token",
      primaryCandidates: [{ id: "waba-current" }],
    });
    mockCreateWhatsAppTemplateMutation.mockResolvedValue({
      id: "meta-new",
      status: "PENDING",
    });
    mockRemapTemplateFlowsForCurrentWaba.mockImplementation(
      async (params: { components: unknown }) => params.components
    );
    mockResolvePreviousWhatsAppWabaId.mockResolvedValue({
      previousWabaId: null,
      wabaHistory: [],
    });
  });

  it("resubmits a saved WhatsApp template onto the currently connected WABA", async () => {
    const { supabase, update } = createSupabaseMock({
      id: "db-1",
      name: "welcome",
      channel: "whatsapp",
      whatsapp_data: {
        language: "en_US",
        category: "UTILITY",
        status: "PENDING",
        wabaId: "waba-old",
        components: [{ type: "BODY", text: "Hello" }],
      },
    });

    const result = await switchUnifiedTemplateToCurrentWaba({
      supabase: supabase as never,
      workspaceId: "workspace-acme",
      userId: "user-1",
      templateId: "db-1",
    });

    expect(mockGetWhatsAppAccountCredentials).toHaveBeenCalledWith(
      "workspace-acme"
    );
    expect(mockCreateWhatsAppTemplateMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-acme",
        userId: "user-1",
        name: "welcome",
        language: "en_US",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hello" }],
      })
    );
    expect(update).toHaveBeenCalledWith({
      whatsapp_data: expect.objectContaining({
        metaTemplateId: "meta-new",
        status: "PENDING",
        wabaId: "waba-current",
      }),
    });
    expect(result).toEqual({
      metaTemplateId: "meta-new",
      status: "PENDING",
      wabaId: "waba-current",
      warning: undefined,
    });
  });

  it("rejects telegram-only templates", async () => {
    const { supabase } = createSupabaseMock({
      id: "db-1",
      name: "telegram_note",
      channel: "telegram",
      whatsapp_data: null,
    });

    await expect(
      switchUnifiedTemplateToCurrentWaba({
        supabase: supabase as never,
        workspaceId: "workspace-acme",
        userId: "user-1",
        templateId: "db-1",
      })
    ).rejects.toThrow("Only WhatsApp templates can be switched to the current WABA.");
    expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
  });

  it("submits Flow templates with remapped current-WABA flow ids", async () => {
    const remappedComponents = [
      { type: "BODY", text: "Testing" },
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "What is it", flow_id: "flow-new" }],
      },
    ];
    mockRemapTemplateFlowsForCurrentWaba.mockResolvedValue(remappedComponents);

    const { supabase, update } = createSupabaseMock({
      id: "db-1",
      name: "try",
      channel: "whatsapp",
      whatsapp_data: {
        language: "en_US",
        category: "MARKETING",
        status: "PENDING",
        wabaId: "waba-old",
        components: [
          { type: "BODY", text: "Testing" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "What is it", flow_id: "flow-old" },
            ],
          },
        ],
      },
    });

    await switchUnifiedTemplateToCurrentWaba({
      supabase: supabase as never,
      workspaceId: "workspace-acme",
      userId: "user-1",
      templateId: "db-1",
    });

    expect(mockRemapTemplateFlowsForCurrentWaba).toHaveBeenCalledWith({
      accessToken: "wa-token",
      currentWabaId: "waba-current",
      sourceWabaId: "waba-old",
      components: expect.arrayContaining([
        expect.objectContaining({ type: "BUTTONS" }),
      ]),
    });
    expect(mockCreateWhatsAppTemplateMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        components: remappedComponents,
      })
    );
    expect(update).toHaveBeenCalledWith({
      whatsapp_data: expect.objectContaining({
        components: remappedComponents,
        wabaId: "waba-current",
      }),
    });
  });

  it("passes a numeric stored previous WABA id into Flow remap", async () => {
    mockRemapTemplateFlowsForCurrentWaba.mockImplementation(
      async (params: { components: unknown }) => params.components
    );

    const { supabase } = createSupabaseMock({
      id: "db-1",
      name: "try",
      channel: "whatsapp",
      created_at: "2026-04-01T00:00:00.000Z",
      whatsapp_data: {
        language: "en_US",
        category: "MARKETING",
        status: "PENDING",
        wabaId: 940525742304249,
        components: [
          { type: "BODY", text: "Testing" },
          {
            type: "BUTTONS",
            buttons: [
              {
                type: "FLOW",
                text: "What is it",
                flow_id: "1502809548249689",
              },
            ],
          },
        ],
      },
    });

    await switchUnifiedTemplateToCurrentWaba({
      supabase: supabase as never,
      workspaceId: "workspace-acme",
      userId: "user-1",
      templateId: "db-1",
    });

    expect(mockRemapTemplateFlowsForCurrentWaba).toHaveBeenCalledWith({
      accessToken: "wa-token",
      currentWabaId: "waba-current",
      sourceWabaId: "940525742304249",
      components: expect.arrayContaining([
        expect.objectContaining({ type: "BUTTONS" }),
      ]),
    });
  });

  it("does not submit to Meta when Flow remap fails", async () => {
    mockRemapTemplateFlowsForCurrentWaba.mockRejectedValue(
      new TemplateFlowRemapError(
        "This template uses a WhatsApp Flow that does not exist on the current account (flow-old). Clone or recreate that Flow on the current WhatsApp account, then try again."
      )
    );

    const { supabase } = createSupabaseMock({
      id: "db-1",
      name: "try",
      channel: "whatsapp",
      whatsapp_data: {
        language: "en_US",
        category: "MARKETING",
        components: [
          { type: "BODY", text: "Testing" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "What is it", flow_id: "flow-old" },
            ],
          },
        ],
      },
    });

    await expect(
      switchUnifiedTemplateToCurrentWaba({
        supabase: supabase as never,
        workspaceId: "workspace-acme",
        userId: "user-1",
        templateId: "db-1",
      })
    ).rejects.toThrow("does not exist on the current account");
    expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
  });
});
