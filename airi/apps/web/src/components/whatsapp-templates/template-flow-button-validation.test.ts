import {
  createTemplateButtonTypeLimitSchema,
  createTemplateButtonsSchema,
  createWhatsAppFlowCreateResponseSchema,
  createWhatsAppFlowNameSchema,
  getFirstZodIssueMessage,
} from "./template-flow-button-validation";

const messages = {
  buttonTextRequired: "Button text is required",
  buttonTextMax: "Button text must be 25 characters or less",
  invalidUrl: "Enter a valid URL",
  urlRequired: "URL is required",
  phoneRequired: "Phone number is required",
  flowRequired: "Flow is required",
  flowNavigateScreenRequired: "Navigate screen is required",
  maxButtons: "Only three buttons are allowed",
  maxOneFlowButton: "Only one Flow button is allowed",
  maxOnePhoneButton: "Only one phone button is allowed",
  maxTwoUrlButtons: "Only two URL buttons are allowed",
  flowNameRequired: "Flow name is required",
  flowNameMax: "Flow name must be 256 characters or less",
  createFlowFailed: "Failed to create Flow",
};

describe("template Flow button validation", () => {
  it("requires a navigate screen for Flow buttons using Zod validation", () => {
    const result = createTemplateButtonsSchema(messages).safeParse([
      {
        type: "FLOW",
        text: "Start",
        flow_id: "flow-1",
        flow_action: "navigate",
        navigate_screen: " ",
      },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(getFirstZodIssueMessage(result.error)).toBe(
        "Navigate screen is required"
      );
    }
  });

  it("allows data exchange Flow buttons without a navigate screen", () => {
    const result = createTemplateButtonsSchema(messages).safeParse([
      {
        type: "FLOW",
        text: "Start",
        flow_id: "flow-1",
        flow_action: "data_exchange",
        navigate_screen: "",
      },
    ]);

    expect(result.success).toBe(true);
  });

  it("allows request-contact-info buttons without button text", () => {
    const result = createTemplateButtonsSchema(messages).safeParse([
      {
        type: "REQUEST_CONTACT_INFO",
      },
    ]);

    expect(result.success).toBe(true);
  });

  it("reports missing URL values on the URL field instead of the button type", () => {
    const result = createTemplateButtonsSchema(messages).safeParse([
      {
        type: "URL",
        text: "Apply",
      },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [0, "url"],
            message: "URL is required",
          }),
        ])
      );
      expect(result.error.issues).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [0, "type"],
            message: expect.stringContaining("QUICK_REPLY"),
          }),
        ])
      );
      expect(getFirstZodIssueMessage(result.error)).toBe("URL is required");
    }
  });

  it("rejects more than one Flow button through the reusable type-limit schema", () => {
    const result = createTemplateButtonTypeLimitSchema(messages).safeParse([
      { type: "FLOW" },
      { type: "FLOW" },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(getFirstZodIssueMessage(result.error)).toBe(
        "Only one Flow button is allowed"
      );
    }
  });

  it("rejects phone and URL button counts over WhatsApp limits", () => {
    const phoneResult = createTemplateButtonTypeLimitSchema(messages).safeParse(
      [{ type: "PHONE_NUMBER" }, { type: "PHONE_NUMBER" }]
    );
    expect(phoneResult.success).toBe(false);
    if (!phoneResult.success) {
      expect(getFirstZodIssueMessage(phoneResult.error)).toBe(
        "Only one phone button is allowed"
      );
    }

    const urlResult = createTemplateButtonTypeLimitSchema(messages).safeParse([
      { type: "URL" },
      { type: "URL" },
      { type: "URL" },
    ]);
    expect(urlResult.success).toBe(false);
    if (!urlResult.success) {
      expect(getFirstZodIssueMessage(urlResult.error)).toBe(
        "Only two URL buttons are allowed"
      );
    }
  });

  it("trims and validates inline Flow creation names", () => {
    const result = createWhatsAppFlowNameSchema(messages).safeParse({
      name: "  Lead capture  ",
    });

    expect(result).toEqual({
      success: true,
      data: { name: "Lead capture" },
    });
  });

  it("rejects malformed Flow creation responses", () => {
    const result = createWhatsAppFlowCreateResponseSchema(messages).safeParse({
      flow: { name: "Lead capture" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(getFirstZodIssueMessage(result.error)).toBe(
        "Failed to create Flow"
      );
    }
  });
});
