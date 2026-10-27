import {
  sanitizeWhatsAppFlowConfig,
  serializeWhatsAppFlowEditableContent,
  serializeWhatsAppFlowText,
  toEditableWhatsAppFlowConfig,
} from "./whatsapp-flow-config";

describe("serializeWhatsAppFlowText", () => {
  it("returns plain text for structural flow fields", () => {
    expect(serializeWhatsAppFlowText("<p>Медаль ілгіш</p>", "plain_text")).toBe(
      "Медаль ілгіш"
    );
  });

  it("normalizes screen ids to Meta-safe alphabetic ids and rewrites routes", () => {
    const sanitized = sanitizeWhatsAppFlowConfig({
      templateId: "flow_template",
      ctaText: "Open",
      screens: [
        {
          id: "LEAD_FORM",
          title: "Lead",
          fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
        },
        {
          id: "screen_2",
          title: "Size",
          fields: [{ id: "size", label: "Size", fieldType: "TextInput" }],
        },
        {
          id: "screen_3",
          title: "Links",
          fields: [{ id: "site", label: "Site", fieldType: "TextInput" }],
        },
      ],
      screenRoutes: {
        LEAD_FORM: ["screen_2"],
        screen_2: ["screen_3"],
      },
      flowBranchRules: {
        screen_2: {
          size: {
            opt_a: "screen_3",
          },
        },
      },
    });

    expect(sanitized?.screens.map(screen => screen.id)).toEqual([
      "LEAD_FORM",
      "screen_TWO",
      "screen_THREE",
    ]);
    expect(sanitized?.screenRoutes).toEqual({
      LEAD_FORM: ["screen_TWO"],
      screen_TWO: ["screen_THREE"],
    });
    expect(sanitized?.flowBranchRules).toEqual({
      screen_TWO: {
        size: {
          opt_a: "screen_THREE",
        },
      },
    });
  });
});

describe("sanitizeWhatsAppFlowConfig", () => {
  it("strips html tags from structural flow text and preserves whatsapp formatting for message text", () => {
    const sanitized = sanitizeWhatsAppFlowConfig({
      templateId: "flow_template",
      ctaText: "<p>Ашу</p>",
      bodyText: "<p><strong>Сәлем</strong></p>",
      footerText: "<p>Толтырыңыз</p>",
      screens: [
        {
          id: "screen_1",
          title: "<p>Бұйымды таңдаңыз</p>",
          fields: [
            {
              id: "field_1",
              label: "<p>Бұйымдар</p>",
              fieldType: "RadioButtonsGroup",
              options: [
                { id: "opt_1", title: "<p>Медаль ілгіш</p>" },
                { id: "opt_2", title: "Тарих толқынсыз шежіресі" },
              ],
            },
          ],
        },
      ],
    });

    expect(sanitized).not.toBeNull();
    expect(sanitized?.ctaText).toBe("Ашу");
    expect(sanitized?.bodyText).toBe("*Сәлем*");
    expect(sanitized?.footerText).toBe("Толтырыңыз");
    expect(sanitized?.screens[0]?.title).toBe("Бұйымды таңдаңыз");
    expect(sanitized?.screens[0]?.fields[0]?.label).toBe("Бұйымдар");
    expect(sanitized?.screens[0]?.fields[0]?.options?.[0]?.title).toBe(
      "Медаль ілгіш"
    );
  });

  it("normalizes and preserves a complete server-owned provider reference", () => {
    const sanitized = sanitizeWhatsAppFlowConfig({
      templateId: "flow_template",
      ctaText: "Open",
      screens: [{ id: "screen_1", title: "Start", fields: [] }],
      providerReference: {
        flowId: " provider-flow-id ",
        sourceId: " source-1 ",
        wabaId: " waba-1 ",
        flowName: " Provider Flow ",
        providerStatus: "PUBLISHED",
        jsonVersion: " 7.3 ",
        dataApiVersion: " 3.0 ",
      },
    });

    expect(sanitized?.providerReference).toEqual({
      flowId: "provider-flow-id",
      sourceId: "source-1",
      wabaId: "waba-1",
      flowName: "Provider Flow",
      providerStatus: "PUBLISHED",
      jsonVersion: "7.3",
      dataApiVersion: "3.0",
    });
  });

  it("drops malformed provider references and excludes them from editable config", () => {
    const malformed = sanitizeWhatsAppFlowConfig({
      templateId: "flow_template",
      ctaText: "Open",
      screens: [{ id: "screen_1", title: "Start", fields: [] }],
      providerReference: {
        flowId: "provider-flow-id",
        sourceId: "",
        wabaId: "waba-1",
        providerStatus: "PUBLISHED",
      },
    });

    expect(malformed?.providerReference).toBeUndefined();
    const editable = toEditableWhatsAppFlowConfig({
      templateId: "flow_template",
      ctaText: "Open",
      screens: [{ id: "screen_1", title: "Start", fields: [] }],
      providerReference: {
        flowId: "provider-flow-id",
        sourceId: "source-1",
        wabaId: "waba-1",
        providerStatus: "PUBLISHED",
      },
    });
    expect("providerReference" in editable).toBe(false);
  });

  it("keeps a valid form answers key and drops one that is not a key", () => {
    const base = {
      templateId: "flow_template",
      ctaText: "Open",
      screens: [{ id: "screen_1", title: "Start", fields: [] }],
    };

    expect(
      sanitizeWhatsAppFlowConfig({ ...base, answersKey: " order " })?.answersKey
    ).toBe("order");
    for (const answersKey of ["Order", "1order", "order form", "", 7]) {
      const sanitized = sanitizeWhatsAppFlowConfig({ ...base, answersKey });
      expect([answersKey, sanitized && "answersKey" in sanitized]).toEqual([
        answersKey,
        false,
      ]);
    }
  });
});

describe("serializeWhatsAppFlowEditableContent", () => {
  const config = {
    templateId: "flow_template",
    ctaText: "Open",
    screens: [
      {
        id: "screen_1",
        title: "Start",
        fields: [
          { id: "size", label: "Size", fieldType: "TextInput" as const },
        ],
      },
    ],
  };

  it("leaves the form answers key out of the Flow content digest", () => {
    expect(
      serializeWhatsAppFlowEditableContent({ ...config, answersKey: "order" })
    ).toBe(serializeWhatsAppFlowEditableContent(config));
    expect(
      serializeWhatsAppFlowEditableContent({
        ...config,
        ctaText: "Start",
        answersKey: "order",
      })
    ).not.toBe(serializeWhatsAppFlowEditableContent(config));
  });

  it("keeps the answers key in the editable config the node stores", () => {
    const withKey = { ...config, answersKey: "order" };
    serializeWhatsAppFlowEditableContent(withKey);
    expect(withKey.answersKey).toBe("order");
    expect(toEditableWhatsAppFlowConfig(withKey).answersKey).toBe("order");
  });
});
