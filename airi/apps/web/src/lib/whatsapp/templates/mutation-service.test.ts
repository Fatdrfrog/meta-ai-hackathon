const mockCreateTemplate = jest.fn();
const mockDeleteTemplate = jest.fn();
const mockGetTemplate = jest.fn();
const mockMirrorWhatsAppTemplate = jest.fn();
const mockDeleteTemplateSnapshots = jest.fn();
const mockMutationLoggerWarn = jest.fn();
const mockLogTemplateAction = jest.fn();
const mockSyncTemplatesToMongo = jest.fn();
const mockUpdateTemplate = jest.fn();
const mockResolveTemplateAccountContext = jest.fn();
const resolvedAccountContext = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  accessToken: "resolved-token",
  wabaId: "fallback-waba",
  candidateSource: "credentials.messaging_account_id" as const,
};

jest.mock("@/lib/whatsapp/templates/service", () => ({
  createTemplate: (...args: unknown[]) => mockCreateTemplate(...args),
  deleteTemplate: (...args: unknown[]) => mockDeleteTemplate(...args),
  getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
  logTemplateAction: (...args: unknown[]) => mockLogTemplateAction(...args),
  syncTemplatesToMongo: (...args: unknown[]) =>
    mockSyncTemplatesToMongo(...args),
  updateTemplate: (...args: unknown[]) => mockUpdateTemplate(...args),
  resolveTemplateAccountContext: (...args: unknown[]) =>
    mockResolveTemplateAccountContext(...args),
}));

jest.mock("@/lib/whatsapp/templates/template-mirror", () => ({
  deleteTemplateSnapshots: (...args: unknown[]) =>
    mockDeleteTemplateSnapshots(...args),
  mirrorWhatsAppTemplate: (...args: unknown[]) =>
    mockMirrorWhatsAppTemplate(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { name: "supabase-admin" },
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockMutationLoggerWarn(...args),
  }),
}));

const mockCaptureFunnelEvent = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

import {
  createWhatsAppTemplateMutation,
  deleteWhatsAppTemplateMutation,
  syncWhatsAppTemplatesMutation,
  updateWhatsAppTemplateMutation,
  WhatsAppTemplateMutationValidationError,
} from "@/lib/whatsapp/templates/mutation-service";

describe("template-mutation-service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveTemplateAccountContext.mockResolvedValue(resolvedAccountContext);
    mockCreateTemplate.mockResolvedValue({
      id: "meta-template-1",
      status: "PENDING",
      warning: "saved without bid",
    });
    mockUpdateTemplate.mockResolvedValue({
      success: true,
      warning: "update warning",
    });
    mockDeleteTemplate.mockResolvedValue({
      success: true,
      deletedBy: "id",
      templateId: "meta-template-1",
    });
    mockSyncTemplatesToMongo.mockResolvedValue({
      synced: 2,
      errors: 0,
    });
    mockLogTemplateAction.mockResolvedValue(undefined);
    mockGetTemplate.mockResolvedValue({
      id: "meta-template-1",
      name: "promo_ru",
      language: "ru",
      status: "APPROVED",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Updated _body_" }],
    });
    mockMirrorWhatsAppTemplate.mockResolvedValue({
      snapshotUpdated: true,
      unifiedRows: 1,
      errors: [],
    });
    mockDeleteTemplateSnapshots.mockResolvedValue(undefined);
  });

  it("passes one resolved fallback account through default creation and its status readback", async () => {
    await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      name: "promo_ru",
      language: "ru",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
    });
    expect(mockResolveTemplateAccountContext).toHaveBeenCalledTimes(1);
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(Object),
      { accountContext: resolvedAccountContext }
    );
    expect(mockGetTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "meta-template-1",
      { accountContext: resolvedAccountContext }
    );
  });

  it("passes one resolved fallback account through default update and readback without changing its public result", async () => {
    const result = await updateWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      templateId: "meta-template-1",
      category: "MARKETING",
    });
    expect(mockResolveTemplateAccountContext).toHaveBeenCalledTimes(1);
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "meta-template-1",
      { category: "MARKETING" },
      { accountContext: resolvedAccountContext }
    );
    expect(mockGetTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "meta-template-1",
      { accountContext: resolvedAccountContext }
    );
    expect(result).toEqual({ success: true, warning: "update warning" });
  });

  it("creates a template through the shared mutation path and logs the Meta id", async () => {
    const result = await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      userId: "user-1",
      name: "promo_ru",
      language: "ru_RU",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello *{{1}}*" }],
      allowCategoryChange: true,
      optimizationSpec: {
        bid_amount: 2500,
        bid_strategy: "LOWEST_COST_WITH_BID_CAP",
      },
    });

    expect(mockCreateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      {
        name: "promo_ru",
        language: "ru",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hello *{{1}}*" }],
        allow_category_change: true,
        optimization_spec: {
          bid_amount: 2500,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      },
      { accountContext: resolvedAccountContext }
    );
    expect(mockLogTemplateAction).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      "CREATE",
      "promo_ru",
      { templateId: "meta-template-1" }
    );
    // The status read back from Meta, which may already be approved.
    expect(result).toEqual({
      id: "meta-template-1",
      status: "APPROVED",
      warning: "saved without bid",
    });
    // No origin means a system re-creation, not a person's submission.
    expect(mockCaptureFunnelEvent).not.toHaveBeenCalled();
  });

  it("counts a person's submission once per Meta template id", async () => {
    await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      userId: "user-1",
      name: "promo_ru",
      language: "ru_RU",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
      analyticsOrigin: "templates_page",
    });

    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith({
      event: "template_submitted",
      userId: "user-1",
      workspaceId: "workspace-1",
      properties: {
        origin: "templates_page",
        category: "MARKETING",
        language: "ru",
        status: "APPROVED",
      },
      insertId: "template_submitted:meta-template-1",
    });
  });

  it("preserves authentication creation options through the canonical mutation path", async () => {
    const components = [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 5 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
    ];
    await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      name: "verification",
      language: "kk",
      category: "AUTHENTICATION",
      components,
    });
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      {
        name: "verification",
        language: "kk",
        category: "AUTHENTICATION",
        components,
      },
      { accountContext: resolvedAccountContext }
    );
  });

  it("returns the create status when Meta can't be read back", async () => {
    mockGetTemplate.mockRejectedValueOnce(new Error("Graph timeout"));

    await expect(
      createWhatsAppTemplateMutation({
        workspaceId: "workspace-1",
        name: "promo_ru",
        language: "ru",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hello" }],
      })
    ).resolves.toMatchObject({ id: "meta-template-1", status: "PENDING" });
  });

  it.each(["PENDING", "APPROVED", undefined])(
    "defers status readback only for an explicit scoped operator and keeps POST status %s",
    async postStatus => {
      mockCreateTemplate.mockResolvedValueOnce({
        id: "meta-template-1",
        status: postStatus,
      });
      const accountContext = {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        accessToken: "operator-token",
        wabaId: "waba-1",
        candidateSource: "credentials.waba_id" as const,
      };
      await expect(
        createWhatsAppTemplateMutation({
          workspaceId: "workspace-1",
          name: "promo_en",
          language: "en",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hello" }],
          accountContext,
          deferCreatedStatusReadback: true,
          audit: { enabled: false },
        })
      ).resolves.toMatchObject({
        id: "meta-template-1",
        status: postStatus || "PENDING",
      });
      expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
      expect(mockCreateTemplate).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({ name: "promo_en" }),
        { accountContext }
      );
      expect(mockGetTemplate).not.toHaveBeenCalled();
      expect(mockMirrorWhatsAppTemplate).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null])(
    "rejects deferred readback without a selected account before creation",
    async accountContext => {
      await expect(
        createWhatsAppTemplateMutation({
          workspaceId: "workspace-1",
          name: "promo_en",
          language: "en",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hello" }],
          accountContext: accountContext as never,
          deferCreatedStatusReadback: true,
        })
      ).rejects.toBeInstanceOf(WhatsAppTemplateMutationValidationError);
      expect(mockCreateTemplate).not.toHaveBeenCalled();
      expect(mockGetTemplate).not.toHaveBeenCalled();
    }
  );

  it("keeps the immediate status read when a scoped caller explicitly disables deferral", async () => {
    const accountContext = {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      accessToken: "operator-token",
      wabaId: "waba-1",
      candidateSource: "credentials.waba_id" as const,
    };
    const result = await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      name: "promo_en",
      language: "en",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
      accountContext,
      deferCreatedStatusReadback: false,
    });
    expect(result.status).toBe("APPROVED");
    expect(mockGetTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "meta-template-1",
      { accountContext }
    );
  });

  it("creates a template without audit logging when the caller owns the audit record", async () => {
    await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      userId: "user-1",
      name: "promo_ru",
      language: "ru",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
      audit: { enabled: false },
    });

    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    expect(mockLogTemplateAction).not.toHaveBeenCalled();
  });

  it("updates a template through the shared mutation path and logs the exact payload", async () => {
    const result = await updateWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      userId: "user-1",
      templateId: "meta-template-1",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Updated _body_" }],
      allowCategoryChange: false,
      optimizationSpec: {
        bid_amount: 3000,
        bid_strategy: "LOWEST_COST_WITH_BID_CAP",
      },
    });

    const expectedPayload = {
      category: "MARKETING",
      components: [{ type: "BODY", text: "Updated _body_" }],
      allow_category_change: false,
      optimization_spec: {
        bid_amount: 3000,
        bid_strategy: "LOWEST_COST_WITH_BID_CAP",
      },
    };
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "meta-template-1",
      expectedPayload,
      { accountContext: resolvedAccountContext }
    );
    expect(mockLogTemplateAction).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      "UPDATE",
      "promo_ru",
      {
        templateId: "meta-template-1",
        changes: expectedPayload,
      }
    );
    expect(result).toEqual({ success: true, warning: "update warning" });
    expect(result).not.toHaveProperty("template");
  });

  it("returns the existing fresh readback only to a scoped operator without reading twice", async () => {
    const template = {
      id: "meta-template-1",
      name: "promo_ru",
      language: "ru",
      status: "PENDING",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Updated _body_" }],
    };
    mockGetTemplate.mockResolvedValueOnce(template);
    const accountContext = {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      accessToken: "operator-token",
      wabaId: "waba-1",
      candidateSource: "credentials.waba_id" as const,
    };
    const result = await updateWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      templateId: template.id,
      components: template.components,
      accountContext,
      audit: { enabled: false },
    });
    expect(result.template).toBe(template);
    expect(mockGetTemplate).toHaveBeenCalledTimes(1);
    expect(mockGetTemplate).toHaveBeenCalledWith("workspace-1", template.id, {
      accountContext,
    });
  });

  it("never fabricates an operator snapshot when the accepted edit cannot be read back", async () => {
    mockGetTemplate.mockRejectedValueOnce(new Error("Graph rate limit"));
    const accountContext = {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      accessToken: "operator-token",
      wabaId: "waba-1",
      candidateSource: "credentials.waba_id" as const,
    };
    const result = await updateWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      templateId: "meta-template-1",
      components: [{ type: "BODY", text: "Updated _body_" }],
      accountContext,
      audit: { enabled: false },
    });
    expect(result).toEqual({ success: true, warning: "update warning" });
    expect(result).not.toHaveProperty("template");
    expect(mockGetTemplate).toHaveBeenCalledTimes(1);
  });

  it("deletes a template through the shared mutation path using normalized language", async () => {
    const result = await deleteWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      userId: "user-1",
      templateName: "promo_ru",
      templateId: "meta-template-1",
      templateLanguage: "ru_RU",
    });

    expect(mockDeleteTemplate).toHaveBeenCalledWith("workspace-1", {
      templateName: "promo_ru",
      templateId: "meta-template-1",
      language: "ru",
    });
    expect(mockLogTemplateAction).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      "DELETE",
      "promo_ru",
      { templateId: "meta-template-1" }
    );
    expect(result).toEqual({
      success: true,
      deletedBy: "id",
      templateId: "meta-template-1",
    });
    expect(mockDeleteTemplateSnapshots).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      templateId: "meta-template-1",
      name: "promo_ru",
    });
  });

  it("clears every cached language when Meta deleted by name", async () => {
    mockDeleteTemplate.mockResolvedValueOnce({
      success: true,
      deletedBy: "name",
    });

    await deleteWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      templateName: "promo_ru",
    });

    expect(mockDeleteTemplateSnapshots).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      templateId: undefined,
      name: "promo_ru",
    });
  });

  it("copies Meta's version into the cache and stored rows after an edit", async () => {
    await updateWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      userId: "user-1",
      templateId: "meta-template-1",
      components: [{ type: "BODY", text: "Updated _body_" }],
    });

    expect(mockGetTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "meta-template-1",
      { accountContext: resolvedAccountContext }
    );
    expect(mockMirrorWhatsAppTemplate).toHaveBeenCalledWith({
      supabase: { name: "supabase-admin" },
      workspaceId: "workspace-1",
      template: expect.objectContaining({
        id: "meta-template-1",
        status: "APPROVED",
      }),
    });
  });

  it("reads a new template's status back without writing copies yet", async () => {
    await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      name: "promo_ru",
      language: "ru",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
    });

    expect(mockGetTemplate).toHaveBeenCalledWith(
      "workspace-1",
      "meta-template-1",
      { accountContext: resolvedAccountContext }
    );
    // No cached snapshot or stored row exists for it until the caller saves.
    expect(mockMirrorWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("keeps an edit Meta accepted when copying it back fails", async () => {
    mockGetTemplate.mockRejectedValueOnce(new Error("Graph timeout"));

    await expect(
      updateWhatsAppTemplateMutation({
        workspaceId: "workspace-1",
        userId: "user-1",
        templateId: "meta-template-1",
        components: [{ type: "BODY", text: "Updated _body_" }],
      })
    ).resolves.toEqual({ success: true, warning: "update warning" });
    expect(mockMirrorWhatsAppTemplate).not.toHaveBeenCalled();
    expect(mockMutationLoggerWarn).toHaveBeenCalledWith(
      "WhatsApp template mirror refresh failed",
      expect.objectContaining({ templateId: "meta-template-1" })
    );
    // Without Meta's read-back the audit still names the template by id.
    expect(mockLogTemplateAction).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      "UPDATE",
      "meta-template-1",
      expect.anything()
    );
  });

  it("does not read the template back when Meta rejects the edit", async () => {
    mockUpdateTemplate.mockRejectedValueOnce(new Error("Edit limit reached"));

    await expect(
      updateWhatsAppTemplateMutation({
        workspaceId: "workspace-1",
        templateId: "meta-template-1",
        components: [{ type: "BODY", text: "Updated _body_" }],
      })
    ).rejects.toThrow("Edit limit reached");
    expect(mockGetTemplate).not.toHaveBeenCalled();
  });

  it("syncs templates through the shared mutation path", async () => {
    await expect(
      syncWhatsAppTemplatesMutation({
        workspaceId: "workspace-1",
        userId: "user-1",
      })
    ).resolves.toEqual({ synced: 2, errors: 0 });

    expect(mockSyncTemplatesToMongo).toHaveBeenCalledWith(
      "workspace-1",
      "user-1"
    );
  });

  it("rejects invalid create payloads before calling Meta", async () => {
    await expect(
      createWhatsAppTemplateMutation({
        workspaceId: "workspace-1",
        userId: "user-1",
        name: "bad_header",
        language: "en_US",
        category: "MARKETING",
        components: [{ type: "HEADER", format: "IMAGE" }],
      })
    ).rejects.toBeInstanceOf(WhatsAppTemplateMutationValidationError);

    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockLogTemplateAction).not.toHaveBeenCalled();
  });
});

export {};
