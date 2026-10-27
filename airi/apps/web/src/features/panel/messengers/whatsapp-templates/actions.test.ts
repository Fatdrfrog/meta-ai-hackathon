const mockCreateClient = jest.fn();
const mockCreateWhatsAppTemplateMutation = jest.fn();
const mockDeleteTemplate = jest.fn();
const mockDeleteWhatsAppTemplateMutation = jest.fn();
const mockSwitchUnifiedTemplateToCurrentWaba = jest.fn();
const mockSyncWhatsAppTemplatesMutation = jest.fn();
const mockUpdateWhatsAppTemplateMutation = jest.fn();
const mockLogTemplateAction = jest.fn();
const mockRevalidatePath = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/whatsapp/templates/mutation-service", () => ({
  createWhatsAppTemplateMutation: (...args: unknown[]) =>
    mockCreateWhatsAppTemplateMutation(...args),
  deleteWhatsAppTemplateMutation: (...args: unknown[]) =>
    mockDeleteWhatsAppTemplateMutation(...args),
  syncWhatsAppTemplatesMutation: (...args: unknown[]) =>
    mockSyncWhatsAppTemplatesMutation(...args),
  updateWhatsAppTemplateMutation: (...args: unknown[]) =>
    mockUpdateWhatsAppTemplateMutation(...args),
}));

jest.mock("@/lib/whatsapp/templates/switch-to-current-waba", () => ({
  SwitchUnifiedTemplateWabaError: class extends Error {},
  switchUnifiedTemplateToCurrentWaba: (...args: unknown[]) =>
    mockSwitchUnifiedTemplateToCurrentWaba(...args),
}));

jest.mock("@/lib/whatsapp/templates/service", () => ({
  deleteTemplate: (...args: unknown[]) => mockDeleteTemplate(...args),
  logTemplateAction: (...args: unknown[]) => mockLogTemplateAction(...args),
}));

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

type QueryResult = {
  data?: unknown;
  error?: { message: string } | null;
};

type QueryMock = {
  eq: jest.Mock;
  in: jest.Mock;
  order: jest.Mock;
  then: (resolve: (value: QueryResult) => unknown) => unknown;
  maybeSingle: jest.Mock;
  select: jest.Mock;
  single: jest.Mock;
};

type DeleteQueryMock = {
  eq: jest.Mock;
  then: (resolve: (value: QueryResult) => unknown) => unknown;
};

/** A query whose single-row reads return `result` and whose list read `list`. */
function createQuery(result: QueryResult, list: QueryResult = result) {
  const query = {} as QueryMock;
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.in = jest.fn(() => query);
  query.then = (resolve: (value: QueryResult) => unknown) => resolve(list);
  query.maybeSingle = jest.fn(async () => result);
  query.single = jest.fn(async () => result);

  return query;
}

function createDeleteQuery(result: QueryResult) {
  const query = {} as DeleteQueryMock;
  query.eq = jest.fn(() => query);
  query.then = (resolve: (value: QueryResult) => unknown) => resolve(result);

  return query;
}

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ROW_ID = "22222222-2222-4222-8222-222222222222";
const WHATSAPP_DATA = {
  language: "ru",
  category: "MARKETING",
  components: [{ type: "BODY", text: "Hello" }],
};

describe("whatsapp template actions", () => {
  let memberRole = "admin";
  let deleteRow: jest.Mock;
  let updateRow: jest.Mock;

  beforeEach(() => {
    memberRole = "admin";
    deleteRow = jest.fn(() => createDeleteQuery({ error: null }));
    updateRow = jest.fn(() => createDeleteQuery({ error: null }));
    jest.clearAllMocks();
    mockDeleteTemplate.mockResolvedValue({ success: true, deletedBy: "id" });
    mockDeleteWhatsAppTemplateMutation.mockResolvedValue({
      success: true,
      deletedBy: "id",
      templateId: "meta-template-1",
    });
    mockLogTemplateAction.mockResolvedValue(undefined);
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: { id: "user-1" } },
        })),
      },
      from: jest.fn((table: string) => {
        if (table === "company_users") {
          return createQuery({ data: { role: memberRole }, error: null });
        }

        return {
          select: jest.fn(() => {
            const row = {
              name: "promo",
              channel: "whatsapp",
              whatsapp_data: {
                language: "ru",
                metaTemplateId: "meta-template-1",
              },
            };
            return createQuery(
              { data: row, error: null },
              { data: [row], error: null }
            );
          }),
          delete: deleteRow,
          update: updateRow,
        };
      }),
    });
  });

  it("validates preset authentication unchanged-category edits through the canonical contract", async () => {
    mockUpdateWhatsAppTemplateMutation.mockResolvedValueOnce({ success: true });
    const { updateTemplateAction } = await import("./actions");
    const components = [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 5 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
    ];
    expect(
      await updateTemplateAction({
        workspaceId: WORKSPACE_ID,
        templateId: "auth-1",
        components,
      })
    ).toEqual({ success: true, data: { success: true } });
    expect(mockUpdateWhatsAppTemplateMutation).toHaveBeenCalledWith(
      expect.objectContaining({ components })
    );
  });

  it("rejects authentication definitions under promotional or utility categories before access/provider calls", async () => {
    const { createUnifiedTemplateAction } = await import("./actions");
    const components = [
      { type: "BODY", add_security_recommendation: true },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
    ];
    for (const category of ["MARKETING", "UTILITY"]) {
      expect(
        await createUnifiedTemplateAction({
          workspaceId: WORKSPACE_ID,
          name: "invalid_code",
          channel: "whatsapp",
          whatsappData: { language: "en", category, components },
        })
      ).toMatchObject({ success: false });
    }
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
  });

  it("deletes a unified WhatsApp template through the shared mutation service", async () => {
    const { deleteUnifiedTemplateAction } = await import("./actions");

    const result = await deleteUnifiedTemplateAction({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      templateId: "22222222-2222-4222-8222-222222222222",
    });

    expect(result).toEqual({ success: true, data: { success: true } });
    expect(mockDeleteWhatsAppTemplateMutation).toHaveBeenCalledWith({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      templateName: "promo",
      templateId: "meta-template-1",
      templateLanguage: "ru",
      audit: { enabled: false },
    });
    expect(mockDeleteTemplate).not.toHaveBeenCalled();
  });

  describe("template permissions", () => {
    const managerOnlyActions = [
      {
        name: "updateTemplateAction",
        input: {
          workspaceId: WORKSPACE_ID,
          templateId: "meta-template-1",
          components: WHATSAPP_DATA.components,
        },
        error: "Only managers and admins can update templates",
      },
      {
        name: "deleteTemplateAction",
        input: { workspaceId: WORKSPACE_ID, templateName: "promo" },
        error: "Only managers and admins can delete templates",
      },
      {
        name: "createUnifiedTemplateAction",
        input: {
          workspaceId: WORKSPACE_ID,
          name: "promo",
          channel: "whatsapp",
          whatsappData: WHATSAPP_DATA,
        },
        error: "Only managers and admins can create templates",
      },
      {
        name: "updateUnifiedTemplateAction",
        input: {
          workspaceId: WORKSPACE_ID,
          templateId: TEMPLATE_ROW_ID,
          whatsappData: WHATSAPP_DATA,
        },
        error: "Only managers and admins can update templates",
      },
      {
        name: "deleteUnifiedTemplateAction",
        input: { workspaceId: WORKSPACE_ID, templateId: TEMPLATE_ROW_ID },
        error: "Only managers and admins can delete templates",
      },
      {
        name: "switchUnifiedTemplateToCurrentWabaAction",
        input: { workspaceId: WORKSPACE_ID, templateId: TEMPLATE_ROW_ID },
        error: "Only managers and admins can create templates",
      },
    ] as const;

    it.each(managerOnlyActions)(
      "refuses a member in $name",
      async ({ name, input, error }) => {
        memberRole = "member";
        const actions = await import("./actions");

        const result = await (
          actions[name] as (input: unknown) => Promise<unknown>
        )(input);

        expect(result).toEqual({ success: false, error });
        expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
        expect(mockUpdateWhatsAppTemplateMutation).not.toHaveBeenCalled();
        expect(mockDeleteWhatsAppTemplateMutation).not.toHaveBeenCalled();
        expect(mockSwitchUnifiedTemplateToCurrentWaba).not.toHaveBeenCalled();
        expect(deleteRow).not.toHaveBeenCalled();
        expect(updateRow).not.toHaveBeenCalled();
        expect(mockLogTemplateAction).not.toHaveBeenCalled();
      }
    );

    it.each(["admin", "manager"])(
      "lets a workspace %s update a template",
      async role => {
        memberRole = role;
        mockUpdateWhatsAppTemplateMutation.mockResolvedValue({ success: true });
        const { updateTemplateAction } = await import("./actions");

        await expect(
          updateTemplateAction({
            workspaceId: WORKSPACE_ID,
            templateId: "meta-template-1",
            components: WHATSAPP_DATA.components,
          })
        ).resolves.toEqual({ success: true, data: { success: true } });
        expect(mockUpdateWhatsAppTemplateMutation).toHaveBeenCalledTimes(1);
      }
    );

    it("lets a manager list and sync templates", async () => {
      memberRole = "manager";
      mockSyncWhatsAppTemplatesMutation.mockResolvedValue({
        synced: 1,
        errors: 0,
      });
      const { getUnifiedTemplatesAction, syncTemplatesAction } = await import(
        "./actions"
      );

      await expect(
        syncTemplatesAction({ workspaceId: WORKSPACE_ID })
      ).resolves.toEqual({ success: true, data: { synced: 1, errors: 0 } });
      await expect(
        getUnifiedTemplatesAction({ workspaceId: WORKSPACE_ID })
      ).resolves.toMatchObject({ success: true });
    });

    it("preserves a sync cooldown so the page cannot immediately repeat the blocked refresh", async () => {
      mockSyncWhatsAppTemplatesMutation.mockRejectedValueOnce(
        new WhatsAppTemplateCatalogError({
          code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
          message: "Meta is limiting template refreshes.",
          providerCode: 80008,
          retryAt: "2026-10-06T10:00:00.000Z",
        })
      );
      const { syncTemplatesAction } = await import("./actions");
      await expect(
        syncTemplatesAction({ workspaceId: WORKSPACE_ID })
      ).resolves.toEqual({
        success: false,
        error: "Meta is limiting template refreshes.",
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        providerCode: 80008,
        retryAt: "2026-10-06T10:00:00.000Z",
      });
    });

    it.each(["viewer", "member", "owner"])(
      "refuses the unsupported %s role, even for reads",
      async role => {
        memberRole = role;
        const { syncTemplatesAction } = await import("./actions");

        await expect(
          syncTemplatesAction({ workspaceId: WORKSPACE_ID })
        ).resolves.toEqual({ success: false, error: "Forbidden" });
        expect(mockSyncWhatsAppTemplatesMutation).not.toHaveBeenCalled();
      }
    );
  });
});

export {};
import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";
