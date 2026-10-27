const mockGetWhatsAppAccountCredentials = jest.fn();
const mockCreateWhatsAppTemplateMutation = jest.fn();
const mockCreateTemplate = jest.fn();
const mockLogTemplateAction = jest.fn();

jest.mock("@/lib/whatsapp/account/resolution", () => ({
  getWhatsAppAccountCredentials: (...args: unknown[]) =>
    mockGetWhatsAppAccountCredentials(...args),
}));

jest.mock("@/lib/whatsapp/templates/mutation-service", () => ({
  createWhatsAppTemplateMutation: (...args: unknown[]) =>
    mockCreateWhatsAppTemplateMutation(...args),
}));

jest.mock("@/lib/whatsapp/templates/service", () => ({
  createTemplate: (...args: unknown[]) => mockCreateTemplate(...args),
  logTemplateAction: (...args: unknown[]) => mockLogTemplateAction(...args),
}));

import { createUnifiedTemplateRecord } from "@/lib/whatsapp/templates/unified-service";

function createSupabaseInsertMock() {
  const single = jest.fn().mockResolvedValue({
    data: { id: "db-template-1" },
    error: null,
  });
  const select = jest.fn(() => ({ single }));
  const insert = jest.fn(() => ({ select }));
  const from = jest.fn(() => ({ insert }));

  return {
    supabase: { from },
    from,
    insert,
    select,
    single,
  };
}

describe("createUnifiedTemplateRecord", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateWhatsAppTemplateMutation.mockResolvedValue({
      id: "meta-template-1",
      status: "PENDING",
      warning: "meta warning",
    });
    mockLogTemplateAction.mockResolvedValue(undefined);
    mockGetWhatsAppAccountCredentials.mockResolvedValue({
      primaryCandidates: [{ id: "waba-current" }],
    });
  });

  it("creates WhatsApp-backed unified templates through the shared mutation path", async () => {
    const { supabase, insert } = createSupabaseInsertMock();

    const result = await createUnifiedTemplateRecord({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "user-1",
      name: "promo",
      channel: "both",
      whatsappData: {
        language: "ru_RU",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hello" }],
        allow_category_change: true,
        optimization_spec: {
          bid_amount: 2500,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      },
      telegramData: { text: "Hello" },
    });

    expect(mockCreateWhatsAppTemplateMutation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      name: "promo",
      language: "ru_RU",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
      allowCategoryChange: true,
      optimizationSpec: {
        bid_amount: 2500,
        bid_strategy: "LOWEST_COST_WITH_BID_CAP",
      },
      audit: { enabled: false },
    });
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        whatsapp_data: expect.objectContaining({
          language: "ru_RU",
          metaTemplateId: "meta-template-1",
          status: "PENDING",
          wabaId: "waba-current",
        }),
      })
    );
    expect(mockLogTemplateAction).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      "CREATE",
      "promo",
      { templateId: "db-template-1" }
    );
    expect(result).toEqual({
      id: "db-template-1",
      warning: "meta warning",
      metaTemplateId: "meta-template-1",
      metaTemplateStatus: "PENDING",
    });
  });

  it("forwards explicit operator deferral and stores the acknowledged id, status, payload and selected WABA", async () => {
    const { supabase, insert } = createSupabaseInsertMock();
    const accountContext = {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      accessToken: "operator-token",
      wabaId: "waba-selected",
      candidateSource: "credentials.waba_id" as const,
    };
    const components = [
      {
        type: "BODY" as const,
        text: "Hello *{{first_name}}*",
        example: {
          body_text_named_params: [
            { param_name: "first_name", example: "Alex" },
          ],
        },
      },
    ];
    const result = await createUnifiedTemplateRecord({
      supabase: supabase as never,
      workspaceId: "workspace-1",
      userId: "operator-1",
      name: "demo_named",
      channel: "whatsapp",
      whatsappData: { language: "en", category: "MARKETING", components },
      accountContext,
      deferCreatedStatusReadback: true,
    });
    expect(mockCreateWhatsAppTemplateMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountContext,
        deferCreatedStatusReadback: true,
        components,
      })
    );
    expect(insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      name: "demo_named",
      channel: "whatsapp",
      whatsapp_data: {
        language: "en",
        category: "MARKETING",
        components,
        metaTemplateId: "meta-template-1",
        status: "PENDING",
        wabaId: "waba-selected",
      },
      telegram_data: null,
    });
    expect(result.metaTemplateId).toBe("meta-template-1");
    expect(result.metaTemplateStatus).toBe("PENDING");
    expect(mockGetWhatsAppAccountCredentials).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    "rejects deferred creation without a selected account before any provider or local insert",
    async accountContext => {
      const { supabase, insert } = createSupabaseInsertMock();
      await expect(
        createUnifiedTemplateRecord({
          supabase: supabase as never,
          workspaceId: "workspace-1",
          userId: "user-1",
          name: "demo",
          channel: "whatsapp",
          whatsappData: {
            language: "en",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Hello" }],
          },
          accountContext: accountContext as never,
          deferCreatedStatusReadback: true,
        })
      ).rejects.toThrow("selected WhatsApp account");
      expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(mockGetWhatsAppAccountCredentials).not.toHaveBeenCalled();
    }
  );
});

export {};
