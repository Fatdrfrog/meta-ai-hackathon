import type { UnifiedTemplate } from "@icecore/shared/types/templates";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";

import {
  buildWhatsAppTemplateCardModels,
  filterWhatsAppTemplateSelectionItems,
  findSelectedWhatsAppTemplate,
  getWhatsAppTemplateIdentity,
  getWhatsAppTemplateMapKey,
  mergeWhatsAppTemplateSources,
} from "@/lib/whatsapp/templates/selection-utils";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";

function metaTemplate(
  overrides: Partial<WhatsAppTemplate> = {}
): WhatsAppTemplate {
  return {
    id: "meta-1",
    name: "promo",
    language: "en",
    status: "APPROVED",
    category: "MARKETING",
    components: [{ type: "BODY", text: "Hello {{1}}" }],
    ...overrides,
  };
}

function unifiedTemplate(
  overrides: Partial<UnifiedTemplate> = {}
): UnifiedTemplate {
  return {
    id: "db-1",
    workspace_id: "workspace-1",
    name: "promo",
    channel: "both",
    whatsapp_data: {
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hello {{1}}" }],
      metaTemplateId: "meta-1",
    },
    telegram_data: {
      text: "Telegram promo",
    },
    created_at: "2026-05-29T00:00:00.000Z",
    updated_at: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("template-selection-utils", () => {
  it("uses the same name-language key for scenario values and merged templates", () => {
    expect(getWhatsAppTemplateMapKey("promo", "EN")).toBe("promo::en");
    expect(
      getWhatsAppTemplateOptionValue({ name: "promo", language: "en" })
    ).toBe("promo::en");
  });

  it("merges Meta and DB template records into one selectable item", () => {
    const merged = mergeWhatsAppTemplateSources({
      metaTemplates: [metaTemplate()],
      unifiedTemplates: [unifiedTemplate()],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "meta-1",
      metaId: "meta-1",
      dbId: "db-1",
      channel: "both",
      name: "promo",
      language: "en",
    });
  });

  it("preserves DB public media URLs when Meta only returns a media handle", () => {
    const merged = mergeWhatsAppTemplateSources({
      metaTemplates: [
        metaTemplate({
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: { header_handle: ["4::meta-header-handle"] },
            },
            { type: "BODY", text: "Meta body" },
          ],
        }),
      ],
      unifiedTemplates: [
        unifiedTemplate({
          whatsapp_data: {
            language: "en",
            category: "MARKETING",
            status: "APPROVED",
            metaTemplateId: "meta-1",
            components: [
              {
                type: "HEADER",
                format: "IMAGE",
                example: {
                  header_handle: ["https://cdn.example.com/header.png"],
                },
              },
              { type: "BODY", text: "DB body should not win" },
            ],
          },
        }),
      ],
    });

    expect(merged[0]?.components?.[0]).toMatchObject({
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: ["https://cdn.example.com/header.png"] },
    });
    expect(merged[0]?.components?.[1]).toMatchObject({
      type: "BODY",
      text: "Meta body",
    });
  });

  it("filters merged template items by platform and preview text", () => {
    const items = mergeWhatsAppTemplateSources({
      metaTemplates: [metaTemplate()],
      unifiedTemplates: [
        unifiedTemplate({
          id: "telegram-1",
          name: "telegram_only",
          channel: "telegram",
          whatsapp_data: undefined,
          telegram_data: { text: "VIP renewal" },
        }),
      ],
    });

    expect(
      filterWhatsAppTemplateSelectionItems(items, {
        platformFilter: "telegram",
        searchQuery: "renewal",
      }).map(item => item.name)
    ).toEqual(["telegram_only"]);
  });

  it("resolves selected templates by value, id, then name and language", () => {
    const templates = [
      { id: "tpl-1", name: "promo", language: "en" },
      { id: "tpl-2", name: "promo", language: "kk" },
    ];

    expect(
      findSelectedWhatsAppTemplate({
        templates,
        value: "promo::kk",
      })?.id
    ).toBe("tpl-2");
    expect(
      findSelectedWhatsAppTemplate({
        templates,
        templateId: "tpl-1",
      })?.language
    ).toBe("en");
    expect(
      findSelectedWhatsAppTemplate({
        templates,
        name: "promo",
        language: "kk",
      })?.id
    ).toBe("tpl-2");
  });

  it("builds shared card models for the messenger template list", () => {
    const [item] = mergeWhatsAppTemplateSources({
      metaTemplates: [metaTemplate()],
      unifiedTemplates: [unifiedTemplate()],
    });
    const [card] = buildWhatsAppTemplateCardModels([item], {
      missingMetaId: "Missing Meta ID",
      missingDbId: "Missing DB ID",
    });

    expect(card).toMatchObject({
      id: getWhatsAppTemplateIdentity(item),
      copyId: "db-1",
      isEditable: true,
      variableCount: 1,
    });
  });

  it("marks local WhatsApp templates missing from the connected WABA as switchable for any workspace", () => {
    const merged = mergeWhatsAppTemplateSources({
      currentWabaId: "waba-current",
      previousWabaId: "waba-latest-previous",
      wabaHistory: [
        { wabaId: "waba-first", recordedAt: "2026-01-01T00:00:00.000Z" },
        { wabaId: "waba-second", recordedAt: "2026-03-01T00:00:00.000Z" },
        { wabaId: "waba-current", recordedAt: "2026-06-01T00:00:00.000Z" },
      ],
      metaTemplates: [],
      unifiedTemplates: [
        unifiedTemplate({
          id: "db-stamped",
          name: "stamped_old",
          channel: "whatsapp",
          created_at: "2026-04-01T00:00:00.000Z",
          whatsapp_data: {
            language: "en",
            category: "UTILITY",
            status: "PENDING",
            wabaId: "waba-stamped",
            components: [{ type: "BODY", text: "Stamped" }],
          },
        }),
        unifiedTemplate({
          id: "db-inferred",
          name: "inferred_old",
          channel: "whatsapp",
          created_at: "2026-02-01T00:00:00.000Z",
          whatsapp_data: {
            language: "en",
            category: "UTILITY",
            status: "PENDING",
            components: [{ type: "BODY", text: "Inferred" }],
          },
        }),
        unifiedTemplate({
          id: "db-telegram",
          name: "telegram_only",
          channel: "telegram",
          whatsapp_data: undefined,
          telegram_data: { text: "Telegram only" },
        }),
      ],
    });

    const stamped = merged.find(item => item.name === "stamped_old");
    const inferred = merged.find(item => item.name === "inferred_old");
    const telegram = merged.find(item => item.name === "telegram_only");

    expect(stamped).toMatchObject({
      sourceWabaId: "waba-stamped",
      isOnCurrentWaba: false,
      canSwitchToCurrentWaba: true,
    });
    expect(inferred).toMatchObject({
      sourceWabaId: "waba-first",
      isOnCurrentWaba: false,
      canSwitchToCurrentWaba: true,
    });
    expect(telegram).toMatchObject({
      isOnCurrentWaba: true,
      canSwitchToCurrentWaba: false,
    });
  });

  it("does not offer a switch when WhatsApp is not connected", () => {
    const merged = mergeWhatsAppTemplateSources({
      metaTemplates: [],
      unifiedTemplates: [
        unifiedTemplate({
          channel: "whatsapp",
          whatsapp_data: {
            language: "en",
            category: "UTILITY",
            status: "PENDING",
            components: [{ type: "BODY", text: "Hello" }],
          },
        }),
      ],
    });

    expect(merged[0]).toMatchObject({
      canSwitchToCurrentWaba: false,
      isOnCurrentWaba: false,
    });
  });
});
