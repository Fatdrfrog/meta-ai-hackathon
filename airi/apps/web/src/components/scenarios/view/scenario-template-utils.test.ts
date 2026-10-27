import type { ScenarioNodeData } from "@/components/scenarios/types";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import type { ScenarioWhatsAppTemplate } from "../types";
import {
  bulkTemplateSendBlockReasonMessageKey,
  createScenarioTokenLabelResolver,
  describeUnsupportedScenarioTemplateTokens,
  describeWhatsAppTemplateButtonDrift,
  getScenarioTokenFallbackLabel,
  insertScenarioTemplateToken,
  insertScenarioTemplateTokenAt,
  parseExactScenarioVariableSnippet,
  resolveScenarioNodeDataWithLiveWhatsAppTemplate,
  resolveScenarioTokenLabel,
  resolveScenarioVariableChipLabel,
  resolveScenarioWhatsAppTemplateComponents,
  SCENARIO_TOKEN_FIELD_META,
  SCENARIO_TOKEN_FIELDS,
} from "./scenario-template-utils";
import {
  isSupportedScenarioTemplateToken,
  listUnsupportedScenarioTemplateTokens,
} from "@icecore/scenario-contracts";
import { resolveReplyModeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  findMatchingScenarioWhatsAppTemplate,
  resolveBulkWhatsAppTemplateSendBlockReason,
} from "@/lib/scenarios/whatsapp-template-selection";

function createTemplate(
  overrides: Partial<ScenarioWhatsAppTemplate> = {}
): ScenarioWhatsAppTemplate {
  return {
    id: "tpl-live",
    name: "medal_pick_1",
    language: "kk",
    components: [
      {
        type: "BODY",
        text: "Жанды мәтін",
      } as WhatsAppComponent,
    ],
    ...overrides,
  };
}

describe("resolveReplyModeFromNodeData", () => {
  it("treats an undefined service-message clear marker as absent", () => {
    expect(
      resolveReplyModeFromNodeData({
        kind: "action",
        actionReplyMode: "ai",
        actionWhatsAppServiceMessage: undefined,
      })
    ).toBe("ai");
  });

  it.each([
    {
      label: "an invalid",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "future_kind" },
      },
    },
    {
      label: "a future-version",
      actionWhatsAppServiceMessage: {
        version: 2,
        message: {
          kind: "text",
          body: { mode: "ai", instruction: "Future AI body" },
        },
      },
    },
  ])(
    "does not reopen stale AI mode beside $label canonical service owner",
    ({ actionWhatsAppServiceMessage }) => {
      const nodeData = {
        kind: "action",
        actionReplyMode: "ai",
        actionReplyInstruction: "Stale AI instruction",
        actionWhatsAppServiceMessage,
      } as unknown as ScenarioNodeData;

      expect(resolveReplyModeFromNodeData(nodeData)).toBe("fixed");
    }
  );
});

describe("scenario-template-utils live template resolution", () => {
  it("keeps the saved template snapshot when local edits already exist", () => {
    const nodeData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateId: "tpl-live",
      actionWhatsAppTemplateName: "medal_pick_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        {
          type: "BODY",
          text: "????????????",
        } as WhatsAppComponent,
      ],
    } satisfies Partial<ScenarioNodeData>;
    const liveTemplate = createTemplate();

    expect(
      findMatchingScenarioWhatsAppTemplate({
        nodeData,
        whatsAppTemplates: [liveTemplate],
      })
    ).toEqual(liveTemplate);

    expect(
      resolveScenarioWhatsAppTemplateComponents({
        nodeData,
        whatsAppTemplates: [liveTemplate],
      })
    ).toEqual(nodeData.actionWhatsAppTemplateComponents);
  });

  it("falls back to the saved snapshot when the live template is unavailable", () => {
    const savedComponents = [
      {
        type: "BODY",
        text: "Stored fallback",
      } as WhatsAppComponent,
    ];
    const nodeData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "missing_template",
      actionWhatsAppTemplateLanguage: "ru",
      actionWhatsAppTemplateComponents: savedComponents,
    } satisfies Partial<ScenarioNodeData>;

    expect(
      resolveScenarioWhatsAppTemplateComponents({
        nodeData,
        whatsAppTemplates: [createTemplate()],
      })
    ).toBe(savedComponents);
  });

  it("returns the original node when saved components already exist", () => {
    const nodeData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateId: "tpl-live",
      actionWhatsAppTemplateName: "medal_pick_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        {
          type: "BODY",
          text: "????",
        } as WhatsAppComponent,
      ],
    } satisfies Partial<ScenarioNodeData>;

    const resolved = resolveScenarioNodeDataWithLiveWhatsAppTemplate({
      nodeData,
      whatsAppTemplates: [createTemplate()],
    });

    expect(resolved).toBe(nodeData);
  });

  it("hydrates from the live template when no saved snapshot exists yet", () => {
    const nodeData: Partial<ScenarioNodeData> = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateId: "tpl-live",
      actionWhatsAppTemplateName: "medal_pick_1",
      actionWhatsAppTemplateLanguage: "kk",
    };

    const resolved = resolveScenarioNodeDataWithLiveWhatsAppTemplate({
      nodeData,
      whatsAppTemplates: [createTemplate()],
    });

    expect(resolved).not.toBe(nodeData);
    expect(resolved.actionWhatsAppTemplateComponents).toEqual(
      createTemplate().components
    );
  });
});

describe("scenario-template-utils dynamic fields", () => {
  it("offers helpful contact, calendar, and countdown tokens", () => {
    expect(SCENARIO_TOKEN_FIELDS.contact.map(field => field.token)).toEqual([
      "first_name",
      "last_name",
      "customer_name",
      "whatsappclient.wa_id",
      "whatsappclient.name",
    ]);
    expect(SCENARIO_TOKEN_FIELDS.calendar).toEqual([
      expect.objectContaining({ token: "calendar.next_free_slot" }),
    ]);
    expect(SCENARIO_TOKEN_FIELDS.countdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "countdown" }),
        expect.objectContaining({ token: "countdown.hours" }),
      ])
    );
    expect(SCENARIO_TOKEN_FIELDS.ads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: "trigger.whatsappReferral.campaignName",
        }),
        expect.objectContaining({
          token: "trigger.whatsappReferral.headline",
        }),
        expect.objectContaining({
          token: "trigger.whatsappReferral.sourcePlatform",
        }),
      ])
    );
    expect(SCENARIO_TOKEN_FIELDS).not.toHaveProperty("links");
    expect(SCENARIO_TOKEN_FIELDS).not.toHaveProperty("images");
    expect(
      listUnsupportedScenarioTemplateTokens(
        "{{trigger.whatsappReferral.campaignName}} {{meta_ad_campaign_name}} {{trigger.message.text}} {{calendar.next_free_slot}} {{countdown}} {{input.name}}"
      )
    ).toEqual([]);
    expect(
      listUnsupportedScenarioTemplateTokens("{{input.bad-key}} {{input.1bad}}")
    ).toEqual(["input.bad-key", "input.1bad"]);
  });

  it("offers and labels only paths the runtime renders", () => {
    const catalogTokens = Object.values(SCENARIO_TOKEN_FIELDS).flatMap(fields =>
      fields.map(field => field.token)
    );
    for (const token of [
      ...catalogTokens,
      ...Object.keys(SCENARIO_TOKEN_FIELD_META),
    ]) {
      expect([token, isSupportedScenarioTemplateToken(token)]).toEqual([
        token,
        true,
      ]);
    }
  });
});

describe("describeUnsupportedScenarioTemplateTokens", () => {
  const t = (key: string, values?: Record<string, string | number | Date>) =>
    `${key}: ${String(values?.tokens ?? "")}`;

  it("flags wrongly cased tokens the runtime renders empty (B4)", () => {
    expect(
      describeUnsupportedScenarioTemplateTokens(
        "Hi {{input.Name}} {{customer.firstname}} {input.Name}",
        t
      )
    ).toBe("variablesUnsupported: input.Name, customer.firstname");
  });

  it("accepts every token the runtime renders", () => {
    expect(
      describeUnsupportedScenarioTemplateTokens(
        "Hi {{input.name}} {{customer.firstName}} {{first_name}} {{countdown}} {whatsappReferral.campaignName}",
        t
      )
    ).toBeNull();
    expect(describeUnsupportedScenarioTemplateTokens("", t)).toBeNull();
  });

  it("names at most six unknown tokens", () => {
    const text = Array.from({ length: 8 }, (_, i) => `{{bad${i}}}`).join(" ");
    expect(describeUnsupportedScenarioTemplateTokens(text, t)).toBe(
      "variablesUnsupported: bad0, bad1, bad2, bad3, bad4, bad5"
    );
  });
});

describe("insertScenarioTemplateToken", () => {
  it("inserts a token with spacing into existing text", () => {
    expect(insertScenarioTemplateToken("Hello", "first_name")).toBe(
      "Hello {{first_name}}"
    );
    expect(insertScenarioTemplateToken("Hello ", "first_name")).toBe(
      "Hello {{first_name}}"
    );
    expect(insertScenarioTemplateToken("", "first_name")).toBe(
      "{{first_name}}"
    );
  });
});

describe("insertScenarioTemplateTokenAt", () => {
  const token = "form.order.size";

  it("puts the token at the caret and the caret after it", () => {
    const text = "Confirm with the customer.";
    const caret = "Confirm ".length;
    expect(
      insertScenarioTemplateTokenAt(text, token, { start: caret, end: caret })
    ).toEqual({
      text: "Confirm {{form.order.size}} with the customer.",
      caret: "Confirm {{form.order.size}}".length,
    });
  });

  it("spaces the token from the words around it", () => {
    expect(
      insertScenarioTemplateTokenAt("Size:please", token, {
        start: 5,
        end: 5,
      }).text
    ).toBe("Size: {{form.order.size}} please");
    expect(
      insertScenarioTemplateTokenAt("Size.", token, { start: 4, end: 4 }).text
    ).toBe("Size {{form.order.size}}.");
  });

  it("replaces a selection and appends when the field was never used", () => {
    expect(
      insertScenarioTemplateTokenAt("Use SIZE here", token, {
        start: 4,
        end: 8,
      }).text
    ).toBe("Use {{form.order.size}} here");
    expect(insertScenarioTemplateTokenAt("Hello", token, null)).toEqual({
      text: "Hello {{form.order.size}}",
      caret: "Hello {{form.order.size}}".length,
    });
    expect(
      insertScenarioTemplateTokenAt("Hi", token, { start: 40, end: 50 }).text
    ).toBe("Hi {{form.order.size}}");
  });
});

describe("scenario token labels", () => {
  it("falls back to humanized catalog labels", () => {
    expect(getScenarioTokenFallbackLabel("first_name")).toBe("First Name");
    expect(getScenarioTokenFallbackLabel("trigger.message.text")).toBe(
      "Last Customer Message"
    );
  });

  it("prefers translated label keys when available", () => {
    expect(
      resolveScenarioTokenLabel("first_name", key =>
        key === "variableFieldFirstName" ? "Name" : key
      )
    ).toBe("Name");
  });

  it("names rich-editor chips in the viewer's language (A20)", () => {
    const t = (key: string) => (key === "variableFieldFirstName" ? "Имя" : key);
    expect(
      resolveScenarioVariableChipLabel("first_name", "First Name", t)
    ).toBe("Имя");
    expect(
      resolveScenarioVariableChipLabel("input.sport", "Which sport", t)
    ).toBe("Which sport");
    expect(resolveScenarioVariableChipLabel("input.sport", "", t)).toBe(
      "Sport"
    );
  });

  it("builds a stable label resolver and parses exact snippets", () => {
    const resolve = createScenarioTokenLabelResolver(key =>
      key === "variableFieldFirstName" ? "Name" : key
    );
    expect(resolve("first_name")).toBe("Name");
    const scoped = createScenarioTokenLabelResolver(
      key => key,
      new Map([["form.order.size", "Size · Order details"]])
    );
    expect(scoped("form.order.size")).toBe("Size · Order details");
    expect(scoped("form.order.note")).toBe("Note");
    expect(parseExactScenarioVariableSnippet("{{first_name}}")).toBe(
      "first_name"
    );
    expect(
      parseExactScenarioVariableSnippet("Hello {{first_name}}")
    ).toBeNull();
  });
});

describe("resolveBulkWhatsAppTemplateSendBlockReason", () => {
  it.each([
    ["kk_KZ", "kk"],
    ["kz", "kk"],
    ["kz-KZ", "kk"],
    ["ru_RU", "ru"],
    ["en-us", "en_US"],
    [" EN_us ", " en_US "],
    ["zz-ZZ", "zz_zz"],
  ])("matches the send lookup language %s to %s", (saved, catalog) => {
    expect(
      resolveBulkWhatsAppTemplateSendBlockReason({
        nodeData: {
          kind: "action",
          actionWhatsAppTemplateName: "medal_pick_1",
          actionWhatsAppTemplateLanguage: saved,
        },
        whatsAppTemplates: [
          createTemplate({ language: catalog, status: "APPROVED" }),
        ],
      })
    ).toBeNull();
  });

  it.each([
    ["en", "en_US"],
    ["en_US", "en_GB"],
    ["pt_BR", "pt_PT"],
    ["ru", "kk"],
  ])("keeps distinct send languages %s and %s stale", (saved, catalog) => {
    expect(
      resolveBulkWhatsAppTemplateSendBlockReason({
        nodeData: {
          kind: "action",
          actionWhatsAppTemplateName: "medal_pick_1",
          actionWhatsAppTemplateLanguage: saved,
        },
        whatsAppTemplates: [
          createTemplate({ language: catalog, status: "APPROVED" }),
        ],
      })
    ).toBe("stale");
  });

  it("uses the live template ID before the legacy name and language", () => {
    const template = createTemplate({ status: "APPROVED" });
    expect(
      findMatchingScenarioWhatsAppTemplate({
        nodeData: {
          kind: "action",
          actionWhatsAppTemplateId: " tpl-live ",
          actionWhatsAppTemplateName: "old_name",
          actionWhatsAppTemplateLanguage: "en_US",
        },
        whatsAppTemplates: [template],
      })
    ).toBe(template);
  });

  it.each([undefined, "", " ", "PENDING", "REJECTED", "PAUSED", "UNKNOWN"])(
    "blocks a live template with unapproved status %j",
    status => {
      expect(
        resolveBulkWhatsAppTemplateSendBlockReason({
          nodeData: {
            kind: "action",
            actionWhatsAppTemplateName: "medal_pick_1",
            actionWhatsAppTemplateLanguage: "kk",
          },
          whatsAppTemplates: [createTemplate({ status })],
        })
      ).toBe("not_approved");
    }
  );

  it("allows approved live templates", () => {
    expect(
      resolveBulkWhatsAppTemplateSendBlockReason({
        nodeData: {
          kind: "action",
          actionWhatsAppTemplateName: "medal_pick_1",
          actionWhatsAppTemplateLanguage: "kk",
        },
        whatsAppTemplates: [createTemplate({ status: "APPROVED" })],
      })
    ).toBeNull();
  });

  it("blocks stale templates missing from the approved catalog", () => {
    expect(
      resolveBulkWhatsAppTemplateSendBlockReason({
        nodeData: {
          kind: "action",
          actionWhatsAppTemplateName: "1",
          actionWhatsAppTemplateLanguage: "ru",
        },
        whatsAppTemplates: [createTemplate({ status: "APPROVED" })],
      })
    ).toBe("stale");
  });

  it("blocks draft and pending generated templates", () => {
    expect(
      resolveBulkWhatsAppTemplateSendBlockReason({
        nodeData: {
          kind: "action",
          generatedTemplateDraft: {
            id: "draft-1",
            name: "new_offer",
            language: "en",
            status: "draft",
          },
        },
        whatsAppTemplates: [],
      })
    ).toBe("draft");

    expect(
      resolveBulkWhatsAppTemplateSendBlockReason({
        nodeData: {
          kind: "action",
          generatedTemplateDraft: {
            id: "draft-2",
            name: "new_offer",
            language: "en",
            status: "pending",
          },
        },
        whatsAppTemplates: [],
      })
    ).toBe("pending_review");
  });

  it("blocks non-approved live statuses", () => {
    expect(
      resolveBulkWhatsAppTemplateSendBlockReason({
        nodeData: {
          kind: "action",
          actionWhatsAppTemplateName: "medal_pick_1",
          actionWhatsAppTemplateLanguage: "kk",
        },
        whatsAppTemplates: [createTemplate({ status: "PENDING" })],
      })
    ).toBe("not_approved");
  });

  it("maps block reasons to i18n keys", () => {
    expect(bulkTemplateSendBlockReasonMessageKey("stale")).toBe(
      "bulkNodeTemplateSendBlockedStale"
    );
    expect(bulkTemplateSendBlockReasonMessageKey("draft")).toBe(
      "bulkNodeTemplateSendBlockedEditing"
    );
  });
});

describe("describeWhatsAppTemplateButtonDrift", () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    `${key}:${String(values?.label)}`;

  it("names the saved form button of a Form submitted route", () => {
    expect(
      describeWhatsAppTemplateButtonDrift(
        { kind: "form_removed", label: "Open form" },
        t
      )
    ).toBe("whatsappTemplateButtonDriftFormRemoved:Open form");
    expect(
      describeWhatsAppTemplateButtonDrift(
        { kind: "form_changed", label: "Open form" },
        t
      )
    ).toBe("whatsappTemplateButtonDriftFormChanged:Open form");
  });
});
