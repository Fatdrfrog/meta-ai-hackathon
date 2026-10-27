const mockConnectDB = jest.fn();
const mockTemplateFind = jest.fn();
const mockListApprovedWhatsAppTemplatesForSend = jest.fn();
const mockCreateSessionClient = jest.fn();
const mockSupabaseAdmin = { client: "server" };

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    find: (...args: unknown[]) => mockTemplateFind(...args),
  },
}));

jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  listApprovedWhatsAppTemplatesForSend: (...args: unknown[]) =>
    mockListApprovedWhatsAppTemplatesForSend(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin;
  },
}));

// Scenario sends run in the worker and in webhooks, where there is no user
// session and the session client is anon.
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateSessionClient(...args),
}));

import { resolveScenarioTemplateLanguage } from "@/lib/airi/reply/runtime/auto-reply-template-utils";

describe("resolveScenarioTemplateLanguage live refresh", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTemplateFind.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [],
        }),
      }),
    });
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      {
        id: "template-ru",
        name: "order_update",
        language: "ru",
        status: "APPROVED",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Заказ готов" }],
      },
    ]);
  });

  it("reads live template variants with the server client when the cache misses", async () => {
    const resolution = await resolveScenarioTemplateLanguage({
      workspaceId: "workspace-1",
      templateName: "order_update",
      requestedLanguage: "ru",
    });

    expect(mockListApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
      "workspace-1",
      { supabase: mockSupabaseAdmin }
    );
    expect(mockCreateSessionClient).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({
      resolvedLanguage: "ru",
      matchedVariant: true,
    });
  });

  it("lets the canonical catalog deadline own slow reads rather than falling back after five seconds", async () => {
    jest.useFakeTimers();
    try {
      mockListApprovedWhatsAppTemplatesForSend.mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(
              () =>
                resolve([
                  {
                    id: "ru",
                    name: "order_update",
                    language: "ru",
                    status: "APPROVED",
                    components: [{ type: "BODY", text: "Ready" }],
                  },
                ]),
              6_000
            )
          )
      );
      const pending = resolveScenarioTemplateLanguage({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        templateName: "order_update",
        requestedLanguage: "ru",
        nodeConfiguredLanguage: "en",
      });
      await jest.advanceTimersByTimeAsync(6_000);
      expect(await pending).toMatchObject({
        resolvedLanguage: "ru",
        matchedVariant: true,
      });
      expect(mockListApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
        "workspace-1",
        { supabase: mockSupabaseAdmin, sourceId: "source-1" }
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("re-reads a cached carousel template whose card images are Meta CDN links", async () => {
    const card = (link: string) => ({
      components: [
        { type: "HEADER", format: "IMAGE", example: { header_handle: [link] } },
        { type: "BODY", text: "Card" },
      ],
    });
    mockTemplateFind.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            {
              language: "ru",
              components: [
                { type: "BODY", text: "Уважаемый {{1}}" },
                {
                  type: "CAROUSEL",
                  cards: [card("https://scontent.whatsapp.net/v/old.png")],
                },
              ],
            },
          ],
        }),
      }),
    });
    const liveComponents = [
      { type: "BODY", text: "Уважаемый {{1}}" },
      {
        type: "CAROUSEL",
        cards: [card("https://scontent.whatsapp.net/v/fresh.png")],
      },
    ];
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      {
        id: "template-ru",
        name: "fall_offer",
        language: "ru",
        status: "APPROVED",
        category: "MARKETING",
        components: liveComponents,
      },
    ]);

    const resolution = await resolveScenarioTemplateLanguage({
      workspaceId: "workspace-1",
      templateName: "fall_offer",
      requestedLanguage: "ru",
    });

    expect(mockListApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);
    expect(resolution.templateComponents).toEqual(liveComponents);
  });
});
