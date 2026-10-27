import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  addWhatsAppTemplateButton,
  applyWhatsAppTemplateEditorFormValues,
  buildWhatsAppTemplateEditorSave,
  editableWhatsAppTemplateEditorFormSchema,
  editableWhatsAppTemplateButtonSchema,
  getEditableWhatsAppTemplateButtons,
  getEnglishWhatsAppTemplateEditorError,
  getTemplateButtonFieldErrors,
  getWhatsAppTemplateBodyText,
  getWhatsAppTemplateEditorBodyText,
  getWhatsAppTemplateHeaderMediaFormat,
  isWhatsAppTemplateCarousel,
  isWhatsAppTemplateEditorErrorKey,
  listDuplicateEditableQuickReplyLabels,
  normalizeWhatsAppTemplateComponentsForMeta,
  translateWhatsAppTemplateEditorError,
  updateWhatsAppTemplateButton,
  WHATSAPP_TEMPLATE_EDITOR_ERROR_KEYS,
  editableWhatsAppTemplateButtonsSchema,
} from "./template-editor-utils";

const validateEditableWhatsAppTemplateButtons = (buttons: unknown) =>
  editableWhatsAppTemplateButtonsSchema.safeParse(buttons);

describe("listDuplicateEditableQuickReplyLabels", () => {
  it("names each reply text used twice, ignoring case and spacing", () => {
    expect(
      listDuplicateEditableQuickReplyLabels([
        { type: "quick_reply", label: " Yes" },
        { type: "quick_reply", label: "No" },
        { type: "quick_reply", label: "yes  " },
        { type: "url", label: "No" },
        { type: "quick_reply", label: " " },
        { type: "quick_reply", label: "" },
      ])
    ).toEqual(["Yes"]);
  });
});

describe("whatsapp-template-editor-utils", () => {
  it("keeps location headers through an edit and excludes them from media uploads", () => {
    const components: WhatsAppComponent[] = [
      { type: "HEADER", format: "LOCATION" },
      { type: "BODY", text: "Original demo body" },
    ];
    expect(getWhatsAppTemplateHeaderMediaFormat(components)).toBeUndefined();
    expect(
      applyWhatsAppTemplateEditorFormValues(components, {
        headerText: "A stale text field",
        bodyText: "Updated demo body",
        footerText: "",
        buttons: [],
      })
    ).toEqual([
      { type: "HEADER", format: "LOCATION" },
      { type: "BODY", text: "Updated demo body" },
    ]);
  });

  it("rejects malformed URL destinations and accepts template URL variables", () => {
    const button = { index: 0, type: "url", label: "Shop" };
    expect(
      editableWhatsAppTemplateButtonSchema.safeParse({
        ...button,
        value: "not a URL",
      }).success
    ).toBe(false);
    expect(
      editableWhatsAppTemplateButtonSchema.safeParse({
        ...button,
        value: "https://example.com/{{1}}",
      }).success
    ).toBe(true);
  });
  it("reads BODY text from the resolved template snapshot", () => {
    const components: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "Template body from Meta",
      },
    ];

    expect(getWhatsAppTemplateBodyText(components)).toBe(
      "Template body from Meta"
    );
  });

  it("prefers saved reply edits over component BODY text for the editor", () => {
    const components: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "Template body",
      },
    ];

    expect(
      getWhatsAppTemplateEditorBodyText({
        replyText: "Saved local edit",
        components,
      })
    ).toBe("Saved local edit");
  });

  it("falls back to component BODY text when there is no saved reply edit", () => {
    const components: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "Template body",
      },
    ];

    expect(
      getWhatsAppTemplateEditorBodyText({
        replyText: "",
        components,
      })
    ).toBe("Template body");
  });

  it("adds reply buttons by default", () => {
    const components = addWhatsAppTemplateButton([]);

    expect(components).toEqual([
      {
        type: "BUTTONS",
        buttons: [{ type: "QUICK_REPLY", text: "" }],
      },
    ]);
  });

  it("requires a picked flow only for flow buttons", () => {
    expect(
      validateEditableWhatsAppTemplateButtons([
        { index: 0, type: "flow", label: "Open flow", flowId: "" },
      ]).success
    ).toBe(false);

    expect(
      validateEditableWhatsAppTemplateButtons([
        { index: 0, type: "quick_reply", label: "Reply" },
      ]).success
    ).toBe(true);
  });

  it("normalizes numeric Meta Flow ids before opening the editor", () => {
    const components: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open flow",
            flow_id: 12345,
            flow_action: "navigate",
            navigate_screen: "LEAD_FORM",
          },
        ],
      },
    ];

    expect(getEditableWhatsAppTemplateButtons(components)).toEqual([
      {
        index: 0,
        label: "Open flow",
        type: "flow",
        flowId: "12345",
        flowAction: "navigate",
        navigateScreen: "LEAD_FORM",
      },
    ]);
  });

  it("preserves request-contact-info buttons without requiring a custom label", () => {
    const components: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [{ type: "REQUEST_CONTACT_INFO" }],
      },
    ];

    expect(getEditableWhatsAppTemplateButtons(components)).toEqual([
      {
        index: 0,
        label: "",
        type: "request_contact_info",
      },
    ]);

    expect(
      validateEditableWhatsAppTemplateButtons([
        { index: 0, type: "request_contact_info", label: "" },
      ]).success
    ).toBe(true);

    expect(
      applyWhatsAppTemplateEditorFormValues([{ type: "BODY", text: "Body" }], {
        headerText: "",
        bodyText: "Body",
        footerText: "",
        buttons: [{ index: 0, type: "request_contact_info", label: "" }],
      })
    ).toEqual([
      { type: "BODY", text: "Body" },
      {
        type: "BUTTONS",
        buttons: [{ type: "REQUEST_CONTACT_INFO" }],
      },
    ]);
  });

  it("applies saved editor form values back to template components", () => {
    const components: WhatsAppComponent[] = [
      { type: "HEADER", format: "TEXT", text: "Old header" },
      { type: "BODY", text: "Old body" },
      { type: "FOOTER", text: "Old footer" },
    ];

    expect(
      applyWhatsAppTemplateEditorFormValues(components, {
        headerText: "New header",
        bodyText: "New body",
        footerText: "New footer",
        buttons: [
          {
            index: 0,
            type: "flow",
            label: "Open",
            flowId: "flow-1",
            flowAction: "navigate",
            navigateScreen: "LEAD_FORM",
          },
        ],
      })
    ).toEqual([
      { type: "HEADER", format: "TEXT", text: "New header" },
      { type: "BODY", text: "New body" },
      { type: "FOOTER", text: "New footer" },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open",
            flow_id: "flow-1",
            flow_action: "navigate",
            navigate_screen: "LEAD_FORM",
          },
        ],
      },
    ]);
  });

  it("rejects template button combinations that violate WhatsApp limits", () => {
    const multipleFlows = validateEditableWhatsAppTemplateButtons([
      {
        index: 0,
        type: "flow",
        label: "Flow one",
        flowId: "flow-1",
        flowAction: "data_exchange",
      },
      {
        index: 1,
        type: "flow",
        label: "Flow two",
        flowId: "flow-2",
        flowAction: "data_exchange",
      },
    ]);
    expect(multipleFlows.success).toBe(false);
    if (multipleFlows.success) throw new Error("Expected invalid buttons");
    expect(multipleFlows.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "whatsappTemplateErrorMaxForm" }),
      ])
    );

    const tooManyUrls = validateEditableWhatsAppTemplateButtons([
      {
        index: 0,
        type: "url",
        label: "One",
        value: "https://one.example",
      },
      {
        index: 1,
        type: "url",
        label: "Two",
        value: "https://two.example",
      },
      {
        index: 2,
        type: "url",
        label: "Three",
        value: "https://three.example",
      },
    ]);
    expect(tooManyUrls.success).toBe(false);
    if (tooManyUrls.success) throw new Error("Expected invalid buttons");
    expect(tooManyUrls.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "whatsappTemplateErrorMaxLinks",
        }),
      ])
    );

    const tooManyPhones = validateEditableWhatsAppTemplateButtons([
      { index: 0, type: "phone", label: "Sales", value: "+15550000001" },
      { index: 1, type: "phone", label: "Support", value: "+15550000002" },
    ]);
    expect(tooManyPhones.success).toBe(false);
    if (tooManyPhones.success) throw new Error("Expected invalid buttons");
    expect(tooManyPhones.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "whatsappTemplateErrorMaxPhone",
        }),
      ])
    );
  });

  it("requires a start screen for navigate Flow template buttons", () => {
    const missingStartScreen = validateEditableWhatsAppTemplateButtons([
      {
        index: 0,
        type: "flow",
        label: "Open",
        flowId: "flow-1",
        flowAction: "navigate",
      },
    ]);

    expect(missingStartScreen.success).toBe(false);
    if (missingStartScreen.success) throw new Error("Expected invalid buttons");
    expect(missingStartScreen.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "whatsappTemplateErrorFormStartScreen",
        }),
      ])
    );

    expect(
      validateEditableWhatsAppTemplateButtons([
        {
          index: 0,
          type: "flow",
          label: "Open",
          flowId: "flow-1",
          flowAction: "navigate",
          navigateScreen: "LEAD_FORM",
        },
      ]).success
    ).toBe(true);
  });

  it("needs no start screen for Flow buttons that load it from the server", () => {
    expect(
      validateEditableWhatsAppTemplateButtons([
        {
          index: 0,
          type: "flow",
          label: "Open",
          flowId: "flow-1",
          flowAction: "data_exchange",
        },
      ]).success
    ).toBe(true);
  });

  it("holds a tray row's form and first screen errors until a save attempt", () => {
    const errors = {
      flowId: { message: "whatsappTemplateErrorFormRequired" },
      navigateScreen: { message: "whatsappTemplateErrorFormStartScreen" },
    };
    expect(getTemplateButtonFieldErrors(errors, false)).toEqual({
      label: undefined,
      value: undefined,
      flowId: undefined,
      navigateScreen: undefined,
      message: undefined,
    });
    expect(
      getTemplateButtonFieldErrors(
        { navigateScreen: errors.navigateScreen },
        true
      )
    ).toEqual({
      label: undefined,
      value: undefined,
      flowId: undefined,
      navigateScreen: "whatsappTemplateErrorFormStartScreen",
      message: "whatsappTemplateErrorFormStartScreen",
    });
    expect(
      getTemplateButtonFieldErrors(
        { ...errors, label: { message: "whatsappTemplateErrorButtonText" } },
        true
      ).message
    ).toBe("whatsappTemplateErrorButtonText");
    expect(getTemplateButtonFieldErrors(undefined, true).message).toBe(
      undefined
    );
  });

  it("validates the editable form before saving Meta-shaped components", () => {
    expect(
      editableWhatsAppTemplateEditorFormSchema.safeParse({
        headerText: "",
        bodyText: "",
        footerText: "",
        buttons: [],
      }).success
    ).toBe(false);

    expect(
      editableWhatsAppTemplateEditorFormSchema.safeParse({
        headerText: "",
        bodyText: "Body",
        footerText: "",
        buttons: [{ index: 0, type: "url", label: "Open", value: "" }],
      }).success
    ).toBe(false);

    expect(
      editableWhatsAppTemplateEditorFormSchema.safeParse({
        headerText: "",
        bodyText: "Body",
        footerText: "",
        buttons: [{ index: 0, type: "phone", label: "Call", value: "" }],
      }).success
    ).toBe(false);
  });

  it("reports every editor problem as a catalog key, never a zod default", () => {
    const messagesOf = (values: Record<string, unknown>) => {
      const parsed = editableWhatsAppTemplateEditorFormSchema.safeParse({
        headerText: "",
        bodyText: "Body",
        footerText: "",
        buttons: [],
        ...values,
      });
      return parsed.success ? [] : parsed.error.issues.map(i => i.message);
    };
    expect(messagesOf({ bodyText: "" })).toEqual([
      "whatsappTemplateErrorBodyRequired",
    ]);
    expect(messagesOf({ bodyText: "x".repeat(1025) })).toEqual([
      "whatsappTemplateErrorBodyTooLong",
    ]);
    expect(messagesOf({ headerText: "x".repeat(61) })).toEqual([
      "whatsappTemplateErrorHeaderTooLong",
    ]);
    expect(messagesOf({ footerText: "x".repeat(61) })).toEqual([
      "whatsappTemplateErrorFooterTooLong",
    ]);
    expect(
      messagesOf({
        buttons: [
          { index: 0, type: "quick_reply", label: "" },
          { index: 1, type: "quick_reply", label: "x".repeat(26) },
          { index: 2, type: "url", label: "Shop", value: "" },
          { index: 3, type: "phone", label: "Call", value: "" },
          { index: 4, type: "flow", label: "Form", flowId: "" },
        ],
      })
    ).toEqual(
      expect.arrayContaining([
        "whatsappTemplateErrorButtonText",
        "whatsappTemplateErrorButtonTextTooLong",
        "whatsappTemplateErrorLinkRequired",
        "whatsappTemplateErrorPhoneRequired",
        "whatsappTemplateErrorFormRequired",
        "whatsappTemplateErrorMaxButtons",
      ])
    );
    expect(
      messagesOf({
        buttons: [{ index: 0, type: "url", label: "Shop", value: "nope" }],
      })
    ).toEqual(["whatsappTemplateErrorLinkInvalid"]);
    const allMessages = [
      ...messagesOf({ bodyText: "" }),
      ...messagesOf({ headerText: "x".repeat(61) }),
    ];
    expect(allMessages.every(isWhatsAppTemplateEditorErrorKey)).toBe(true);
  });

  it("translates editor keys and passes other text through", () => {
    const t = (key: string) => `t:${key}`;
    expect(
      translateWhatsAppTemplateEditorError(
        "whatsappTemplateErrorBodyRequired",
        t
      )
    ).toBe("t:whatsappTemplateErrorBodyRequired");
    expect(translateWhatsAppTemplateEditorError("Server says no", t)).toBe(
      "Server says no"
    );
    expect(translateWhatsAppTemplateEditorError(undefined, t)).toBeUndefined();
    for (const key of WHATSAPP_TEMPLATE_EDITOR_ERROR_KEYS) {
      expect(getEnglishWhatsAppTemplateEditorError(key)).not.toBe(key);
    }
    expect(getEnglishWhatsAppTemplateEditorError("Other")).toBe("Other");
  });

  it("removes blank optional components when saving editor values", () => {
    const components: WhatsAppComponent[] = [
      { type: "HEADER", format: "TEXT", text: "Old header" },
      { type: "BODY", text: "Old body" },
      { type: "FOOTER", text: "Old footer" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Reply" }] },
    ];

    expect(
      applyWhatsAppTemplateEditorFormValues(components, {
        headerText: "  ",
        bodyText: " New body ",
        footerText: "",
        buttons: [],
      })
    ).toEqual([{ type: "BODY", text: "New body" }]);
  });

  it("preserves hidden button metadata that belongs to the official template shape", () => {
    const components: WhatsAppComponent[] = [
      { type: "BODY", text: "Body" },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "URL",
            text: "Open",
            url: "https://example.com/{{1}}",
            example: ["https://example.com/123"],
          },
          {
            type: "FLOW",
            text: "Start",
            flow_id: "flow-1",
            flow_action: "navigate",
            navigate_screen: "FIRST_SCREEN",
          },
        ],
      },
    ];

    expect(normalizeWhatsAppTemplateComponentsForMeta(components)).toEqual(
      components
    );
  });

  it("clears flow_name when a patch selects flowId", () => {
    const components: WhatsAppComponent[] = [
      { type: "BODY", text: "Body" },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open",
            flow_name: "legacy_flow",
            flow_action: "navigate",
            navigate_screen: "START",
          },
        ],
      },
    ];

    expect(
      updateWhatsAppTemplateButton(components, 0, { flowId: "flow-2" })
    ).toEqual([
      { type: "BODY", text: "Body" },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open",
            flow_id: "flow-2",
            flow_action: "navigate",
            navigate_screen: "START",
          },
        ],
      },
    ]);
  });
});

describe("carousel templates in the step editor", () => {
  const card = (text: string) => ({
    components: [
      {
        type: "HEADER" as const,
        format: "IMAGE" as const,
        example: { header_handle: ["https://cdn.test/item.jpg"] },
      },
      { type: "BODY" as const, text },
      {
        type: "BUTTONS" as const,
        buttons: [{ type: "QUICK_REPLY" as const, text: "Interested" }],
      },
    ],
  });
  const carousel: WhatsAppComponent = {
    type: "CAROUSEL",
    cards: [card("Blazer"), card("Coat")],
  };
  const components: WhatsAppComponent[] = [
    { type: "BODY", text: "Fall 2026 is here" },
    carousel,
  ];
  const values = {
    headerText: "",
    bodyText: "Fall 2026 has arrived",
    footerText: "",
    buttons: [],
  };

  it("keeps the cards when the message text is saved", () => {
    expect(isWhatsAppTemplateCarousel(components)).toBe(true);
    expect(normalizeWhatsAppTemplateComponentsForMeta(components)).toEqual(
      components
    );
    expect(applyWhatsAppTemplateEditorFormValues(components, values)).toEqual([
      { type: "BODY", text: "Fall 2026 has arrived" },
      carousel,
    ]);
  });

  it("keeps the card routes when the message text is saved", () => {
    const saved = buildWhatsAppTemplateEditorSave({
      components,
      buttonIds: undefined,
      values,
    });

    expect(saved.buttonIds).toBeUndefined();
    expect(saved.components).toContainEqual(carousel);
  });
});
