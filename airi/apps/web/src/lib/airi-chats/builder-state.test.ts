import { airiChatMessageBodySchema } from "./request-schemas";
import {
  normalizeActiveAiriBuilder,
  normalizeAiriBuilderUiState,
} from "./builder-state";

describe("Airi chat builder state schemas", () => {
  it("parses a valid WhatsApp template builder context", () => {
    const parsed = airiChatMessageBodySchema.parse({
      content: "Make this template friendlier",
      activeBuilder: {
        kind: "whatsapp_template",
        revision: 4,
        dirty: true,
        templateDraft: {
          kind: "whatsapp_template",
          name: "customer_reengagement",
          language: "en",
          category: "MARKETING",
          components: [
            {
              type: "BODY",
              text: "Hi {{1}}, want help choosing a plan?",
            },
          ],
        },
      },
    });

    expect(parsed.activeBuilder).toEqual(
      expect.objectContaining({
        kind: "whatsapp_template",
        revision: 4,
      })
    );
  });

  it("preserves WhatsApp template media headers in builder context", () => {
    const parsed = airiChatMessageBodySchema.parse({
      content: "Use this image in the header",
      activeBuilder: {
        kind: "whatsapp_template",
        revision: 5,
        templateDraft: {
          kind: "whatsapp_template",
          name: "image_offer",
          language: "en",
          category: "MARKETING",
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: {
                header_handle: ["https://cdn.example.com/header.png"],
              },
            },
            {
              type: "BODY",
              text: "Hi {{1}}, take a look at this offer.",
            },
          ],
        },
      },
    });

    const normalized = normalizeActiveAiriBuilder(parsed.activeBuilder);

    expect(normalized).toEqual(
      expect.objectContaining({
        kind: "whatsapp_template",
        templateDraft: expect.objectContaining({
          components: expect.arrayContaining([
            expect.objectContaining({
              type: "HEADER",
              format: "IMAGE",
              example: {
                header_handle: ["https://cdn.example.com/header.png"],
              },
            }),
          ]),
        }),
      })
    );
  });

  it("parses and normalizes a valid WhatsApp Flow builder context", () => {
    const parsed = airiChatMessageBodySchema.parse({
      content: "Add a consent field",
      activeBuilder: {
        kind: "whatsapp_flow",
        revision: 2,
        flowConfig: {
          templateId: "lead_generation",
          ctaText: "Start",
          bodyText: "Please complete this form.",
          flowUiLocale: "en",
          screens: [
            {
              id: "lead-form",
              title: "Lead Form",
              fields: [
                {
                  id: "name",
                  label: "Full Name",
                  fieldType: "TextInput",
                  required: true,
                },
              ],
            },
          ],
        },
      },
    });

    const normalized = normalizeActiveAiriBuilder(parsed.activeBuilder);

    expect(normalized).toEqual(
      expect.objectContaining({
        kind: "whatsapp_flow",
        revision: 2,
        flowConfig: expect.objectContaining({
          ctaText: "Start",
          flowUiLocale: "en",
          screens: [
            expect.objectContaining({
              id: "lead_form",
            }),
          ],
        }),
      })
    );
  });

  it("rejects oversized or invalid builder context", () => {
    expect(() =>
      airiChatMessageBodySchema.parse({
        content: "Update this template",
        activeBuilder: {
          kind: "whatsapp_template",
          revision: 1,
          templateDraft: {
            kind: "whatsapp_template",
            name: "too_large",
            language: "en",
            category: "MARKETING",
            components: [
              {
                type: "BODY",
                text: "x".repeat(1025),
              },
            ],
          },
        },
      })
    ).toThrow();

    expect(() =>
      airiChatMessageBodySchema.parse({
        content: "Update this flow",
        activeBuilder: {
          kind: "whatsapp_flow",
          revision: 1,
          flowConfig: {
            templateId: "lead_generation",
            ctaText: "Start",
            flowUiLocale: "not-a-locale",
            screens: [
              {
                id: "LEAD_FORM",
                title: "Lead Form",
                fields: [
                  {
                    id: "name",
                    label: "Full Name",
                    fieldType: "TextInput",
                  },
                ],
              },
            ],
          },
        },
      })
    ).toThrow();
  });

  it("normalizes persisted builder UI state", () => {
    expect(
      normalizeAiriBuilderUiState({
        open: true,
        panelSize: 36,
      })
    ).toEqual({
      open: true,
      panelSize: 36,
    });

    expect(
      normalizeAiriBuilderUiState({
        open: "true",
        panelSize: 99,
      })
    ).toEqual({ open: false });
  });
});
