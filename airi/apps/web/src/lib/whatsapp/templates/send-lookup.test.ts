const mockListTemplates = jest.fn();
const mockConnectDB = jest.fn();
const mockTemplateFind = jest.fn();

jest.mock("@/lib/whatsapp/templates/service", () => ({
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    find: (...args: unknown[]) => mockTemplateFind(...args),
  },
}));

import {
  findApprovedWhatsAppTemplateForSend,
  listApprovedWhatsAppTemplatesForSend,
  readApprovedWhatsAppTemplatesForSend,
  resolveApprovedWhatsAppTemplateForSend,
} from "@/lib/whatsapp/templates/send-lookup";

function mockCachedTemplates(
  templates: Array<{
    templateId: string;
    name: string;
    language: string;
    status: "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "LIMIT_EXCEEDED";
    category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
    components?: Array<{ type: string; text?: string }>;
  }>
) {
  mockTemplateFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve(templates),
    }),
  });
}

describe("template-send-lookup", () => {
  it.each([
    ["kk_KZ", "kk", true],
    ["kz", "kk", true],
    ["kz-KZ", "kk", true],
    ["ru_RU", "ru", true],
    ["en-us", "en_US", true],
    [" EN_us ", " en_US ", true],
    ["zz-ZZ", "zz_zz", true],
    ["en", "en_US", false],
    ["en_US", "en_GB", false],
    ["pt_BR", "pt_PT", false],
    ["ru", "kk", false],
  ])(
    "preserves send language matching from %s to %s: %s",
    async (requested, catalog, matches) => {
      const template = {
        id: "template-1",
        name: "promo_offer",
        language: catalog,
        status: "APPROVED" as const,
        category: "MARKETING" as const,
      };

      await expect(
        findApprovedWhatsAppTemplateForSend({
          workspaceId: "workspace-1",
          templateName: "promo_offer",
          languageCode: requested,
          templates: [template],
        })
      ).resolves.toEqual(matches ? template : null);
    }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCachedTemplates([]);
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          id: "template-1",
          name: "promo_offer",
          language: "en_US",
          status: "APPROVED",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hi" }],
        },
        {
          id: "template-2",
          name: "promo_offer",
          language: "kk",
          status: "APPROVED",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Salem" }],
        },
      ],
    });
  });

  it("lists live approved templates with the caller limit", async () => {
    await expect(
      listApprovedWhatsAppTemplatesForSend("workspace-1", { limit: 300 })
    ).resolves.toEqual([
      expect.objectContaining({ id: "template-1" }),
      expect.objectContaining({ id: "template-2" }),
    ]);

    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
      limit: 300,
    });
  });

  it("passes the exact source through approved live template lookup", async () => {
    await expect(
      listApprovedWhatsAppTemplatesForSend("workspace-1", {
        limit: 300,
        sourceId: "source-2",
      })
    ).resolves.toHaveLength(2);

    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
      limit: 300,
      sourceId: "source-2",
    });
  });

  it("passes a server source reader through for callers without a user session", async () => {
    const serverClient = { from: jest.fn() };

    await expect(
      listApprovedWhatsAppTemplatesForSend("workspace-1", {
        supabase: serverClient,
      })
    ).resolves.toHaveLength(2);

    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
      supabase: serverClient,
    });
  });

  it("prefers Mongo APPROVED snapshots and skips live Graph", async () => {
    mockCachedTemplates([
      {
        templateId: "cached-kk",
        name: "promo_offer",
        language: "kk",
        status: "APPROVED",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Cached" }],
      },
    ]);

    await expect(
      resolveApprovedWhatsAppTemplateForSend({
        workspaceId: "workspace-1",
        templateName: "promo_offer",
        languageCode: "kk_KZ",
      })
    ).resolves.toEqual({
      template: expect.objectContaining({
        id: "cached-kk",
        language: "kk",
        components: [{ type: "BODY", text: "Cached" }],
      }),
      sameNameLanguages: ["kk"],
      source: "cache",
    });

    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("uses client fallback when cache misses and live fetch is not needed", async () => {
    await expect(
      resolveApprovedWhatsAppTemplateForSend({
        workspaceId: "workspace-1",
        templateName: "promo_offer",
        languageCode: "ru",
        allowLiveFetch: false,
        fallbackCategory: "MARKETING",
        fallbackComponents: [{ type: "BODY", text: "From client" }],
      })
    ).resolves.toEqual({
      template: expect.objectContaining({
        name: "promo_offer",
        language: "ru",
        category: "MARKETING",
        components: [{ type: "BODY", text: "From client" }],
      }),
      sameNameLanguages: [],
      source: "client",
    });

    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("falls back to live Graph when the Mongo cache misses", async () => {
    await expect(
      findApprovedWhatsAppTemplateForSend({
        workspaceId: "workspace-1",
        templateName: "promo_offer",
        languageCode: "kk_KZ",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "template-2",
        language: "kk",
      })
    );

    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
    });
  });

  it("returns null when the template language is not approved", async () => {
    await expect(
      findApprovedWhatsAppTemplateForSend({
        workspaceId: "workspace-1",
        templateName: "promo_offer",
        languageCode: "ru",
      })
    ).resolves.toBeNull();
  });

  describe("catalog freshness", () => {
    const staleCatalog = {
      source: "cache" as const,
      stale: true,
      fetchedAt: "2026-10-07T08:00:00.000Z",
      wabaId: "waba-1",
      refreshOutcome: "cooldown" as const,
      retryAt: "2026-10-07T10:00:00.000Z",
      warning: "Showing the last verified Meta template catalog.",
    };

    beforeEach(() => {
      mockListTemplates.mockResolvedValue({
        templates: [
          {
            id: "template-1",
            name: "promo_offer",
            language: "en_US",
            status: "APPROVED",
            category: "MARKETING",
          },
          {
            id: "template-3",
            name: "draft_offer",
            language: "en_US",
            status: "PENDING",
            category: "MARKETING",
          },
        ],
        catalog: staleCatalog,
      });
    });

    it("reads approved templates with the catalog they came from", async () => {
      await expect(
        readApprovedWhatsAppTemplatesForSend("workspace-1", {
          sourceId: "source-2",
        })
      ).resolves.toEqual({
        templates: [expect.objectContaining({ id: "template-1" })],
        catalog: staleCatalog,
      });

      expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
        status: "APPROVED",
        sourceId: "source-2",
      });
    });

    it("reports the live catalog behind a live lookup, found or not", async () => {
      await expect(
        resolveApprovedWhatsAppTemplateForSend({
          workspaceId: "workspace-1",
          templateName: "promo_offer",
          languageCode: "ru",
        })
      ).resolves.toEqual({
        template: null,
        sameNameLanguages: ["en_US"],
        source: "none",
        catalog: staleCatalog,
      });
      await expect(
        resolveApprovedWhatsAppTemplateForSend({
          workspaceId: "workspace-1",
          templateName: "promo_offer",
          languageCode: "en_US",
        })
      ).resolves.toMatchObject({ source: "live", catalog: staleCatalog });
    });

    it("reports no catalog when the Mongo snapshot answers", async () => {
      mockCachedTemplates([
        {
          templateId: "cached-en",
          name: "promo_offer",
          language: "en_US",
          status: "APPROVED",
          category: "MARKETING",
        },
      ]);

      const resolved = await resolveApprovedWhatsAppTemplateForSend({
        workspaceId: "workspace-1",
        templateName: "promo_offer",
        languageCode: "en_US",
      });

      expect(resolved.source).toBe("cache");
      expect(resolved).not.toHaveProperty("catalog");
      expect(mockListTemplates).not.toHaveBeenCalled();
    });
  });
});

export {};
