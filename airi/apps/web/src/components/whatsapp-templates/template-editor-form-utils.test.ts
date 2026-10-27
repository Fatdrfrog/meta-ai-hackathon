import { readWhatsAppTemplateNamedParamExamples } from "@/lib/whatsapp/templates/parameter-format";
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import type { TemplateCarouselCardFormValue } from "./template-carousel-model";
import {
  buildWhatsAppTemplateComponentsFromFormValues,
  getFirstTemplateFormErrorMessage,
  getTemplateFormVariableFormatIssues,
  getWhatsAppTemplateHeaderMediaExample,
  hasTemplateHeaderFormattingMarkers,
  isTemplateFormTextHeaderActive,
  normalizeTemplateNameInput,
} from "./template-editor-form-utils";

describe("template-editor-form-utils", () => {
  it("preserves location headers without turning stale text or media into approval samples", () => {
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "location_demo",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        hasHeader: true,
        headerFormat: "LOCATION",
        headerText: "A previous text header",
        headerMediaExample: "https://example.com/previous.png",
        bodyText: "Explore the sample pin",
      })
    ).toEqual([
      { type: "HEADER", format: "LOCATION" },
      { type: "BODY", text: "Explore the sample pin" },
    ]);
  });

  it("builds media header examples instead of dropping media headers", () => {
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "promo_video",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        hasHeader: true,
        headerFormat: "VIDEO",
        headerMediaExample: "https://example.com/demo.mp4",
        bodyText: "Watch this demo",
      })
    ).toEqual([
      {
        type: "HEADER",
        format: "VIDEO",
        example: {
          header_handle: ["https://example.com/demo.mp4"],
        },
      },
      {
        type: "BODY",
        text: "Watch this demo",
      },
    ]);
  });

  it("reads existing media header examples into form defaults", () => {
    expect(
      getWhatsAppTemplateHeaderMediaExample([
        {
          type: "HEADER",
          format: "IMAGE",
          example: {
            header_handle: ["4::meta-header-handle"],
          },
        },
      ])
    ).toBe("4::meta-header-handle");
  });

  it("builds full URL examples for dynamic URL template buttons", () => {
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "promo_link",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        bodyText: "Apply today",
        hasButtons: true,
        buttons: [
          {
            type: "URL",
            text: "Apply",
            url: "https://road2battlefield.com/{{lead_id}}",
          },
        ],
      })
    ).toEqual([
      {
        type: "BODY",
        text: "Apply today",
      },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "URL",
            text: "Apply",
            url: "https://road2battlefield.com/{{lead_id}}",
            example: ["https://road2battlefield.com/lead_id_example"],
          },
        ],
      },
    ]);
  });

  it("builds authentication templates as copy-code OTP definitions", () => {
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "login_code",
        targetPlatform: "whatsapp",
        language: "en",
        category: "AUTHENTICATION",
        hasHeader: true,
        headerFormat: "TEXT",
        headerText: "Ignored header",
        bodyText: "{{1}} is your verification code.",
        hasFooter: true,
        footerText: "Ignored footer",
        hasButtons: true,
        buttons: [{ type: "URL", text: "Ignored", url: "https://example.com" }],
      })
    ).toEqual([
      {
        type: "BODY",
        add_security_recommendation: true,
      },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "OTP",
            otp_type: "COPY_CODE",
          },
        ],
      },
    ]);
  });

  it("uses preset authentication options instead of submitted prose and keeps the phone preview readable", () => {
    const values = {
      name: "verify_code",
      targetPlatform: "whatsapp" as const,
      category: "AUTHENTICATION" as const,
      language: "ru",
      bodyText: "Promotional prose {{1}}",
      authSecurityRecommendation: false,
      authCodeExpirationMinutes: 5,
    };
    expect(buildWhatsAppTemplateComponentsFromFormValues(values)).toEqual([
      { type: "BODY", add_security_recommendation: false },
      { type: "FOOTER", code_expiration_minutes: 5 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
    ]);
    const preview = buildWhatsAppTemplateComponentsFromFormValues(values, {
      forPreview: true,
    });
    expect(preview[0]).toMatchObject({
      type: "BODY",
      text: expect.stringContaining("{{1}}"),
    });
    expect(preview[0]).not.toHaveProperty("text", values.bodyText);
  });

  it("builds request-contact-info template buttons without custom text", () => {
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "request_phone",
        targetPlatform: "whatsapp",
        language: "en",
        category: "UTILITY",
        bodyText: "Please share your contact details.",
        hasButtons: true,
        buttons: [
          {
            type: "REQUEST_CONTACT_INFO",
            text: "Ignored by Meta",
          },
        ],
      })
    ).toEqual([
      {
        type: "BODY",
        text: "Please share your contact details.",
      },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "REQUEST_CONTACT_INFO",
          },
        ],
      },
    ]);
  });

  it("normalizes non-string Flow button IDs instead of crashing", () => {
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "flow_template",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        bodyText: "Open the flow",
        hasButtons: true,
        buttons: [
          {
            type: "FLOW",
            text: "Start",
            flow_id: 12345,
            flow_action: "navigate",
            navigate_screen: 100,
          } as never,
        ],
      })
    ).toEqual([
      {
        type: "BODY",
        text: "Open the flow",
      },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Start",
            flow_id: "12345",
            flow_action: "navigate",
            navigate_screen: "100",
          },
        ],
      },
    ]);
  });

  it("finds nested react-hook-form error messages", () => {
    expect(
      getFirstTemplateFormErrorMessage({
        buttons: [
          {
            text: {
              message: "Button text is required",
            },
          },
        ],
      })
    ).toBe("Button text is required");
  });

  it("builds marketing carousel components and skips template header footer buttons", () => {
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "promo_carousel",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        hasHeader: true,
        headerFormat: "TEXT",
        headerText: "Ignored",
        hasFooter: true,
        footerText: "Ignored footer",
        hasButtons: true,
        buttons: [{ type: "QUICK_REPLY", text: "Nope" }],
        hasCarousel: true,
        carouselHeaderFormat: "IMAGE",
        bodyText: "Pick a card",
        carouselCards: [
          {
            clientId: "card-1",
            headerFormat: "IMAGE",
            headerMediaExample: "https://cdn.example.com/one.png",
            bodyText: "First",
            buttons: [
              {
                clientId: "btn-1",
                type: "QUICK_REPLY",
                text: "Select",
              },
            ],
          },
          {
            clientId: "card-2",
            headerFormat: "IMAGE",
            headerMediaExample: "https://cdn.example.com/two.png",
            bodyText: "Second",
            buttons: [
              {
                clientId: "btn-2",
                type: "QUICK_REPLY",
                text: "Select",
              },
            ],
          },
        ],
      })
    ).toEqual([
      {
        type: "BODY",
        text: "Pick a card",
      },
      {
        type: "CAROUSEL",
        cards: [
          {
            components: [
              {
                type: "HEADER",
                format: "IMAGE",
                example: {
                  header_handle: ["https://cdn.example.com/one.png"],
                },
              },
              {
                type: "BODY",
                text: "First",
              },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Select" }],
              },
            ],
          },
          {
            components: [
              {
                type: "HEADER",
                format: "IMAGE",
                example: {
                  header_handle: ["https://cdn.example.com/two.png"],
                },
              },
              {
                type: "BODY",
                text: "Second",
              },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Select" }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps incomplete carousel cards in the live preview payload", () => {
    const components = buildWhatsAppTemplateComponentsFromFormValues(
      {
        name: "promo_carousel",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        hasCarousel: true,
        carouselHeaderFormat: "IMAGE",
        bodyText: "Pick a card",
        carouselCards: [
          {
            clientId: "card-1",
            headerFormat: "IMAGE",
            headerMediaExample: "",
            bodyText: "",
            buttons: [{ clientId: "btn-1", type: "QUICK_REPLY", text: "" }],
          },
          {
            clientId: "card-2",
            headerFormat: "IMAGE",
            headerMediaExample: "",
            bodyText: "",
            buttons: [{ clientId: "btn-2", type: "QUICK_REPLY", text: "" }],
          },
        ],
      },
      { includeIncompleteCarousel: true }
    );

    const carousel = components.find(
      component => component.type === "CAROUSEL"
    );
    expect(carousel).toMatchObject({
      type: "CAROUSEL",
      cards: [{}, {}],
    });
    expect(
      buildWhatsAppTemplateComponentsFromFormValues({
        name: "promo_carousel",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        hasCarousel: true,
        bodyText: "Pick a card",
        carouselCards: [
          {
            clientId: "card-1",
            headerFormat: "IMAGE",
            headerMediaExample: "",
            bodyText: "",
            buttons: [{ clientId: "btn-1", type: "QUICK_REPLY", text: "" }],
          },
          {
            clientId: "card-2",
            headerFormat: "IMAGE",
            headerMediaExample: "",
            bodyText: "",
            buttons: [{ clientId: "btn-2", type: "QUICK_REPLY", text: "" }],
          },
        ],
      })
    ).toEqual([{ type: "BODY", text: "Pick a card" }]);
  });

  it("extracts carousel body variables from the truncated card text", () => {
    const overflow = `${"x".repeat(WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH)}{{2}}`;
    const components = buildWhatsAppTemplateComponentsFromFormValues({
      name: "promo_carousel",
      targetPlatform: "whatsapp",
      language: "en",
      category: "MARKETING",
      hasCarousel: true,
      bodyText: "Pick a card",
      carouselCards: [
        {
          clientId: "card-1",
          headerFormat: "IMAGE",
          headerMediaExample: "https://cdn.example.com/one.png",
          bodyText: `Hello {{1}} ${overflow}`,
          buttons: [{ clientId: "btn-1", type: "QUICK_REPLY", text: "Select" }],
        },
        {
          clientId: "card-2",
          headerFormat: "IMAGE",
          headerMediaExample: "https://cdn.example.com/two.png",
          bodyText: "Second",
          buttons: [{ clientId: "btn-2", type: "QUICK_REPLY", text: "Select" }],
        },
      ],
    });
    const carousel = components.find(
      component => component.type === "CAROUSEL"
    );
    const body =
      carousel?.type === "CAROUSEL"
        ? carousel.cards[0]?.components.find(item => item.type === "BODY")
        : undefined;
    expect(body).toMatchObject({
      type: "BODY",
      text: expect.stringMatching(/^Hello \{\{1\}\} /),
    });
    expect(body && "text" in body ? body.text.length : 0).toBe(
      WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH
    );
    expect(
      body && "example" in body ? body.example?.body_text : undefined
    ).toEqual([["Sample 1"]]);
  });

  describe("named variables", () => {
    function namedCarouselCard(
      index: number,
      bodyText: string
    ): TemplateCarouselCardFormValue {
      return {
        clientId: `card-${index}`,
        headerFormat: "IMAGE",
        headerMediaExample: `4::card-${index}`,
        bodyText,
        buttons: [
          { clientId: `btn-${index}`, type: "QUICK_REPLY", text: "Select" },
        ],
      };
    }

    it("writes named header and body samples by name, in text order", () => {
      expect(
        buildWhatsAppTemplateComponentsFromFormValues({
          name: "order_ready",
          targetPlatform: "whatsapp",
          language: "en",
          category: "UTILITY",
          hasHeader: true,
          headerFormat: "TEXT",
          headerText: "Order {{order_id}} update",
          bodyText: "Hi {{first_name}}, order {{order_id}} is ready.",
        })
      ).toEqual([
        {
          type: "HEADER",
          format: "TEXT",
          text: "Order {{order_id}} update",
          example: {
            header_text_named_params: [
              { param_name: "order_id", example: "Sample order_id" },
            ],
          },
        },
        {
          type: "BODY",
          text: "Hi {{first_name}}, order {{order_id}} is ready.",
          example: {
            body_text_named_params: [
              { param_name: "first_name", example: "John" },
              { param_name: "order_id", example: "12345" },
            ],
          },
        },
      ]);
    });

    it("prefers the samples Meta already holds over generated ones", () => {
      const [body] = buildWhatsAppTemplateComponentsFromFormValues({
        name: "order_ready",
        targetPlatform: "whatsapp",
        language: "en",
        category: "UTILITY",
        bodyText: "Hi {{first_name}}, order {{order_id}} is ready.",
        variableExamples: { first_name: "Pablo", unused: "Ignored" },
      });

      expect(body).toEqual({
        type: "BODY",
        text: "Hi {{first_name}}, order {{order_id}} is ready.",
        example: {
          body_text_named_params: [
            { param_name: "first_name", example: "Pablo" },
            { param_name: "order_id", example: "12345" },
          ],
        },
      });
    });

    it("writes named carousel card samples and leaves link variables positional", () => {
      const components = buildWhatsAppTemplateComponentsFromFormValues({
        name: "promo_carousel",
        targetPlatform: "whatsapp",
        language: "en",
        category: "MARKETING",
        hasCarousel: true,
        bodyText: "Dear {{name}}, pick a card",
        variableExamples: { brand: "Premiata" },
        carouselCards: [
          {
            ...namedCarouselCard(1, "Italian style from {{brand}}"),
            buttons: [
              {
                clientId: "btn-url",
                type: "URL",
                text: "Open",
                url: "https://shop.example.com/{{1}}",
              },
            ],
          },
          namedCarouselCard(2, "No variables here"),
        ],
      });
      const carousel = components.find(
        component => component.type === "CAROUSEL"
      );
      if (carousel?.type !== "CAROUSEL") throw new Error("Expected carousel");

      expect(carousel.cards[0]?.components).toEqual([
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["4::card-1"] },
        },
        {
          type: "BODY",
          text: "Italian style from {{brand}}",
          example: {
            body_text_named_params: [
              { param_name: "brand", example: "Premiata" },
            ],
          },
        },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "Open",
              url: "https://shop.example.com/{{1}}",
              example: ["https://shop.example.com/1_example"],
            },
          ],
        },
      ]);
      expect(carousel.cards[1]?.components[1]).toEqual({
        type: "BODY",
        text: "No variables here",
      });
    });

    it("round-trips the named samples of a template loaded from Meta", () => {
      const metaComponents: WhatsAppComponent[] = [
        {
          type: "BODY",
          text: "Уважаемый {{name}},\nВ сети бутиков Boutique поступила коллекция Fall 2026.",
          example: {
            body_text_named_params: [
              { param_name: "name", example: "Александр" },
            ],
          },
        },
      ];

      expect(
        buildWhatsAppTemplateComponentsFromFormValues({
          name: "boutique_fall_2026",
          targetPlatform: "whatsapp",
          language: "ru",
          category: "MARKETING",
          bodyText:
            metaComponents[0]?.type === "BODY" ? metaComponents[0].text : "",
          variableExamples:
            readWhatsAppTemplateNamedParamExamples(metaComponents),
        })
      ).toEqual(metaComponents);
    });

    it("keeps numbered templates on positional samples", () => {
      const [body] = buildWhatsAppTemplateComponentsFromFormValues({
        name: "order_ready",
        targetPlatform: "whatsapp",
        language: "en",
        category: "UTILITY",
        bodyText: "Hi {{1}}, order {{2}} is ready.",
        variableExamples: { 1: "Pablo" },
      });

      expect(body).toEqual({
        type: "BODY",
        text: "Hi {{1}}, order {{2}} is ready.",
        example: { body_text: [["John", "12345"]] },
      });
    });

    it("flags numbered variables next to named ones across header, body, and cards", () => {
      expect(
        getTemplateFormVariableFormatIssues({
          name: "order_ready",
          targetPlatform: "whatsapp",
          category: "UTILITY",
          hasHeader: true,
          headerFormat: "TEXT",
          headerText: "Order {{1}} update",
          bodyText: "Hi {{first_name}}, thanks.",
        })
      ).toEqual([{ path: ["headerText"], issue: "mixed" }]);

      expect(
        getTemplateFormVariableFormatIssues({
          name: "promo_carousel",
          targetPlatform: "whatsapp",
          category: "MARKETING",
          hasCarousel: true,
          bodyText: "Dear {{name}}, pick a card",
          carouselCards: [
            namedCarouselCard(1, "Card {{1}} one"),
            namedCarouselCard(2, "Card {{brand}} two"),
          ],
        })
      ).toEqual([{ path: ["carouselCards", 0, "bodyText"], issue: "mixed" }]);
    });

    it("flags names with characters Meta rejects", () => {
      expect(
        getTemplateFormVariableFormatIssues({
          name: "order_ready",
          targetPlatform: "whatsapp",
          category: "UTILITY",
          bodyText: "Hi {{First_Name}}, order {{order_2}} is ready.",
        })
      ).toEqual([{ path: ["bodyText"], issue: "invalidName" }]);
    });

    it("ignores sections the form does not submit and link variables", () => {
      expect(
        getTemplateFormVariableFormatIssues({
          name: "promo_carousel",
          targetPlatform: "whatsapp",
          category: "MARKETING",
          hasHeader: true,
          headerFormat: "TEXT",
          headerText: "Hidden {{1}} header",
          hasButtons: true,
          buttons: [
            {
              type: "URL",
              text: "Open",
              url: "https://shop.example.com/{{1}}",
            },
          ],
          hasCarousel: true,
          bodyText: "Dear {{name}}, pick a card",
          carouselCards: [
            namedCarouselCard(1, "Card one"),
            namedCarouselCard(2, "Card two"),
          ],
        })
      ).toEqual([]);
    });
  });

  describe("text header rules", () => {
    const base = {
      name: "header_demo",
      targetPlatform: "whatsapp" as const,
      category: "MARKETING" as const,
      hasHeader: true,
      headerFormat: "TEXT" as const,
      headerText: "Hi {{1}} there",
    };

    it("counts a header only while the template sends it as text", () => {
      expect(isTemplateFormTextHeaderActive(base)).toBe(true);
      expect(
        isTemplateFormTextHeaderActive({ ...base, hasHeader: false })
      ).toBe(false);
      expect(
        isTemplateFormTextHeaderActive({ ...base, headerFormat: "IMAGE" })
      ).toBe(false);
      expect(
        isTemplateFormTextHeaderActive({ ...base, headerFormat: "LOCATION" })
      ).toBe(false);
      expect(
        isTemplateFormTextHeaderActive({ ...base, hasCarousel: true })
      ).toBe(false);
      expect(
        isTemplateFormTextHeaderActive({ ...base, category: "AUTHENTICATION" })
      ).toBe(false);
    });

    it("spots Markdown markers but not underscores in variable names", () => {
      expect(hasTemplateHeaderFormattingMarkers("*Sale* today")).toBe(true);
      expect(hasTemplateHeaderFormattingMarkers("Big ~sale~")).toBe(true);
      expect(hasTemplateHeaderFormattingMarkers("Use `code`")).toBe(true);
      expect(hasTemplateHeaderFormattingMarkers("order_id")).toBe(true);
      expect(hasTemplateHeaderFormattingMarkers("Hi {{first_name}}!")).toBe(
        false
      );
      expect(hasTemplateHeaderFormattingMarkers("Welcome, {{1}}!")).toBe(false);
    });
  });

  it("types template names the way WhatsApp Manager does", () => {
    expect(normalizeTemplateNameInput("Order Confirmation")).toBe(
      "order_confirmation"
    );
    expect(normalizeTemplateNameInput("Spring  Sale")).toBe("spring__sale");
    expect(normalizeTemplateNameInput("promo-2026!")).toBe("promo-2026!");
  });
});
