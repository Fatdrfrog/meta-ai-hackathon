import {
  buildActionPatchForSelector,
  resolveActionSelectorTypeForNode,
  resolveActionSourceIdForSelector,
  resolveDefaultActionSelectorForSource,
  resolveDefaultReplyActionPatch,
  resolvePreferredReplyActionSource,
  resolveActionTemplateOptions,
  resolveActionTemplateValue,
} from "./selector-utils";

describe("saved WhatsApp template presentation", () => {
  const templates = [
    { id: "other", name: "unrelated_first", language: "ru" },
    { id: "saved", name: "saved_template", language: "en_US" },
  ];

  it("does not display an unrelated template for an unavailable saved provider ID", () => {
    const nodeData = {
      kind: "action" as const,
      actionWhatsAppTemplateId: "unavailable-id",
    };
    const options = resolveActionTemplateOptions({
      nodeData,
      whatsAppTemplates: templates,
    });
    expect(
      resolveActionTemplateValue({ nodeData, actionTemplates: options })
    ).toBe("");
  });

  it("resolves a saved provider ID even if name and language were omitted", () => {
    const nodeData = {
      kind: "action" as const,
      actionWhatsAppTemplateId: "saved",
    };
    expect(
      resolveActionTemplateValue({ nodeData, actionTemplates: templates })
    ).toBe("saved_template::en_US");
  });

  it.each([undefined, "", "en-US"])(
    "displays the saved template when its language is %s",
    language => {
      const nodeData = {
        kind: "action" as const,
        actionWhatsAppTemplateName: "saved_template",
        actionWhatsAppTemplateLanguage: language,
      };
      const options = resolveActionTemplateOptions({
        nodeData,
        whatsAppTemplates: templates,
      });
      expect(options).toBe(templates);
      expect(
        resolveActionTemplateValue({ nodeData, actionTemplates: options })
      ).toBe("saved_template::en_US");
    }
  );

  it("keeps an unavailable saved template visible instead of showing the catalog default", () => {
    const nodeData = {
      kind: "action" as const,
      actionWhatsAppTemplateName: "removed_template",
    };
    const options = resolveActionTemplateOptions({
      nodeData,
      whatsAppTemplates: templates,
    });
    const value = resolveActionTemplateValue({
      nodeData,
      actionTemplates: options,
    });
    expect(
      options.find(
        template => `${template.name}::${template.language}` === value
      )?.name
    ).toBe("removed_template");
  });
});

describe("action selector ownership", () => {
  it("hydrates an existing Generative AI owner without changing its selector", () => {
    expect(
      resolveActionSelectorTypeForNode({
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "image_to_video",
          prompt: "Animate this product photo",
        },
      })
    ).toBe("generative_ai");
  });

  it.each([
    ["assign_human", "telegram"],
    ["whatsapp_template", "instagram"],
  ] as const)(
    "keeps %s authoritative when stale %s reply state exists",
    (actionType, actionReplyChannel) => {
      expect(
        resolveActionSelectorTypeForNode({
          kind: "action",
          actionType,
          actionReplyChannel,
        })
      ).toBe(actionType);
    }
  );

  it.each([
    {
      label: "supported",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Canonical" },
        },
      },
    },
    {
      label: "future",
      actionWhatsAppServiceMessage: {
        version: 99,
        message: { kind: "future" },
      },
    },
  ])(
    "keeps a $label canonical owner ahead of stale selector fields",
    ({ actionWhatsAppServiceMessage }) => {
      expect(
        resolveActionSelectorTypeForNode({
          kind: "action",
          actionType: "whatsapp_template",
          actionReplyChannel: "telegram",
          actionWhatsAppServiceMessage,
        } as never)
      ).toBe("whatsapp_service_message");
    }
  );
});

describe("action source defaults", () => {
  it("uses the service builder as the WhatsApp source default", () => {
    expect(resolveActionSourceIdForSelector("whatsapp_service_message")).toBe(
      "whatsapp"
    );
    expect(
      resolveDefaultActionSelectorForSource({
        sourceId: "whatsapp",
        currentSelectorType: "telegram_builder",
      })
    ).toBe("whatsapp_service_message");
  });

  it("prefers WhatsApp, then the first connected source", () => {
    expect(resolvePreferredReplyActionSource(["instagram", "telegram"])).toBe(
      "instagram"
    );
    expect(
      resolvePreferredReplyActionSource(["instagram", "whatsapp", "telegram"])
    ).toBe("whatsapp");
    expect(resolvePreferredReplyActionSource([])).toBe("whatsapp");

    expect(resolveDefaultReplyActionPatch(["telegram"])).toMatchObject({
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionTelegramQuickReplies: [],
    });
    expect(resolveDefaultReplyActionPatch(["whatsapp"])).toMatchObject({
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text" },
      },
    });
  });
});

describe("canonical WhatsApp service selector", () => {
  it("preserves the canonical payload when reselecting the service builder", () => {
    const serviceMessage = {
      version: 1 as const,
      message: {
        kind: "text" as const,
        body: { mode: "fixed" as const, text: "Welcome" },
      },
    };

    expect(
      buildActionPatchForSelector({
        nodeData: {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: serviceMessage,
        },
        selectorType: "whatsapp_service_message",
      })
    ).toMatchObject({
      actionType: "reply",
      actionReplyChannel: undefined,
      actionWhatsAppServiceMessage: serviceMessage,
    });
  });

  it("creates a canonical text owner for a new service action", () => {
    expect(
      buildActionPatchForSelector({
        nodeData: undefined,
        selectorType: "whatsapp_service_message",
      })
    ).toMatchObject({
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text" },
      },
    });
  });

  it.each([
    ["telegram_builder", "telegram"],
    ["instagram_reply", "instagram"],
    ["email_reply", "email"],
    ["web_widget_reply", "web_widget"],
    ["whatsapp_template", undefined],
    ["assign_human", undefined],
  ] as const)(
    "clears the service owner when switching to %s",
    (selectorType, expectedChannel) => {
      const patch = buildActionPatchForSelector({
        nodeData: {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "text",
              body: { mode: "fixed", text: "Service message" },
            },
          },
          actionFlowConfig: {
            templateId: "stale-flow",
            metaFlowId: "stale-flow",
            ctaText: "Open",
            screens: [],
          },
        },
        selectorType,
      });

      expect(patch).toHaveProperty("actionWhatsAppServiceMessage", undefined);
      expect(patch).toHaveProperty("actionFlowConfig", undefined);
      expect(patch.actionReplyChannel).toBe(expectedChannel);
    }
  );
});

describe("Generative AI selector ownership", () => {
  it("initializes the canonical default and clears stale reply and template owners", () => {
    expect(
      buildActionPatchForSelector({
        nodeData: {
          kind: "action",
          actionType: "whatsapp_template",
          actionReplyText: "Stale reply",
          actionReplyInstruction: "Stale instruction",
          actionWhatsAppTemplateId: "template-1",
          actionWhatsAppTemplateName: "launch",
          actionWhatsAppTemplateLanguage: "en",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Stale template" },
          ],
        },
        selectorType: "generative_ai",
      })
    ).toEqual(
      expect.objectContaining({
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "",
        },
        actionReplyText: undefined,
        actionReplyInstruction: undefined,
        actionWhatsAppTemplateId: undefined,
        actionWhatsAppTemplateName: undefined,
        actionWhatsAppTemplateLanguage: undefined,
        actionWhatsAppTemplateComponents: undefined,
      })
    );
  });

  it.each([
    "whatsapp_service_message",
    "whatsapp_template",
    "assign_human",
    "telegram_builder",
  ] as const)(
    "clears the Generative AI owner when switching to %s",
    selectorType => {
      const patch = buildActionPatchForSelector({
        nodeData: {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "Create a launch clip",
          },
        },
        selectorType,
      });

      expect(patch).toHaveProperty("actionGenerativeAIConfig", undefined);
    }
  );
});
