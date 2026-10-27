import { parseWhatsAppTemplateSubmissionComponents } from "./component-schemas";

describe("parseWhatsAppTemplateSubmissionComponents", () => {
  const authentication = [
    { type: "BODY", add_security_recommendation: true },
    { type: "FOOTER", code_expiration_minutes: 5 },
    { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
  ];

  it("accepts Meta authentication definition fields without custom text", () => {
    const parsed = parseWhatsAppTemplateSubmissionComponents(
      authentication,
      "AUTHENTICATION"
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected authentication definition");
    expect(parsed.data).toEqual(authentication);
  });

  it("recognizes an unchanged-category authentication edit by its OTP component", () => {
    expect(
      parseWhatsAppTemplateSubmissionComponents(authentication).success
    ).toBe(true);
  });

  it.each([undefined, "AUTHENTICATION", "MARKETING", "UTILITY"] as const)(
    "rejects Meta authentication readback as a create/update definition in category %s",
    category => {
      expect(
        parseWhatsAppTemplateSubmissionComponents(
          [
            { type: "BODY", text: "{{1}} is your verification code." },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "URL",
                  text: "Copy code",
                  url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}",
                },
              ],
            },
          ],
          category
        ).success
      ).toBe(false);
    }
  );

  it("accepts the minimal authentication preset without optional warnings", () => {
    expect(
      parseWhatsAppTemplateSubmissionComponents(
        [{ type: "BODY" }, authentication[2]],
        "AUTHENTICATION"
      ).success
    ).toBe(true);
  });

  it.each(["ONE_TAP", "ZERO_TAP"])(
    "rejects %s definitions without app identity",
    otpType => {
      expect(
        parseWhatsAppTemplateSubmissionComponents(
          [
            authentication[0],
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "OTP",
                  otp_type: otpType,
                  zero_tap_terms_accepted: true,
                },
              ],
            },
          ],
          "AUTHENTICATION"
        ).success
      ).toBe(false);
    }
  );

  it("requires zero-tap terms and preserves legacy app identity on autofill definitions", () => {
    const buttons = [
      {
        type: "OTP",
        otp_type: "ZERO_TAP",
        package_name: "com.example.app",
        signature_hash: "K8a/AINcGX7",
      },
    ];
    expect(
      parseWhatsAppTemplateSubmissionComponents(
        [authentication[0], { type: "BUTTONS", buttons }],
        "AUTHENTICATION"
      ).success
    ).toBe(false);
    const components = [
      authentication[0],
      {
        type: "BUTTONS",
        buttons: buttons.map(button => ({
          ...button,
          zero_tap_terms_accepted: true,
        })),
      },
    ];
    const parsed = parseWhatsAppTemplateSubmissionComponents(
      components,
      "AUTHENTICATION"
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success)
      throw new Error("Expected legacy autofill app identity");
    expect(parsed.data).toEqual(components);
  });

  it.each(["MARKETING", "UTILITY"] as const)(
    "rejects OTP definitions in %s",
    category => {
      expect(
        parseWhatsAppTemplateSubmissionComponents(authentication, category)
          .success
      ).toBe(false);
    }
  );

  it.each([0, 91, 1.5])("rejects invalid authentication expiry %s", minutes => {
    expect(
      parseWhatsAppTemplateSubmissionComponents(
        [
          authentication[0],
          { type: "FOOTER", code_expiration_minutes: minutes },
          authentication[2],
        ],
        "AUTHENTICATION"
      ).success
    ).toBe(false);
  });

  it.each(
    [
      [{ type: "BODY", text: "Custom {{1}}" }, authentication[2]],
      [
        authentication[0],
        { type: "HEADER", format: "TEXT", text: "Header" },
        authentication[2],
      ],
      [
        authentication[0],
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Open", url: "https://example.com" }],
        },
      ],
      [authentication[0]],
    ].map(components => [components])
  )("rejects invalid authentication components %#", components => {
    expect(
      parseWhatsAppTemplateSubmissionComponents(components, "AUTHENTICATION")
        .success
    ).toBe(false);
  });

  it.each(["ONE_TAP", "ZERO_TAP"])(
    "preserves valid %s API definitions",
    otpType => {
      const components = [
        authentication[0],
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "OTP",
              otp_type: otpType,
              supported_apps: [
                {
                  package_name: "com.example.app",
                  signature_hash: "K8a/AINcGX7",
                },
              ],
              ...(otpType === "ZERO_TAP"
                ? { zero_tap_terms_accepted: true }
                : {}),
            },
          ],
        },
      ];
      const parsed = parseWhatsAppTemplateSubmissionComponents(
        components,
        "AUTHENTICATION"
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error("Expected supported OTP definition");
      expect(parsed.data).toEqual(components);
    }
  );

  it("trims Flow identifier fields before parse", () => {
    const parsed = parseWhatsAppTemplateSubmissionComponents([
      { type: "BODY", text: "Hello" },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open",
            flow_id: "  2244981489363579  ",
            flow_action: "navigate",
            navigate_screen: "START",
          },
        ],
      },
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected valid components");
    const buttons = parsed.data.find(component => component.type === "BUTTONS");
    expect(buttons).toMatchObject({
      type: "BUTTONS",
      buttons: [
        expect.objectContaining({
          type: "FLOW",
          flow_id: "2244981489363579",
        }),
      ],
    });
  });

  it("rejects carousel cards with duplicate component types", () => {
    const parsed = parseWhatsAppTemplateSubmissionComponents([
      { type: "BODY", text: "Pick a card" },
      {
        type: "CAROUSEL",
        cards: [
          {
            components: [
              {
                type: "HEADER",
                format: "IMAGE",
                example: { header_handle: ["https://cdn.example.com/one.png"] },
              },
              {
                type: "HEADER",
                format: "IMAGE",
                example: { header_handle: ["https://cdn.example.com/dup.png"] },
              },
              { type: "BODY", text: "One" },
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
                example: { header_handle: ["https://cdn.example.com/two.png"] },
              },
              { type: "BODY", text: "Two" },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Select" }],
              },
            ],
          },
        ],
      },
    ]);

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected invalid carousel");
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Carousel cards cannot repeat HEADER components",
        }),
      ])
    );
  });

  describe("carousel card button types", () => {
    const carousel = (buttonsByCard: Array<Array<Record<string, string>>>) => [
      { type: "BODY", text: "Pick a card" },
      {
        type: "CAROUSEL",
        cards: buttonsByCard.map((buttons, index) => ({
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: {
                header_handle: [`https://cdn.example.com/${index}.png`],
              },
            },
            { type: "BODY", text: `Card ${index}` },
            { type: "BUTTONS", buttons },
          ],
        })),
      },
    ];
    const quickReply = { type: "QUICK_REPLY", text: "Interested" };
    const url = { type: "URL", text: "Buy", url: "https://shop.example.com" };

    it("accepts mixed types when every card has them in the same order", () => {
      const parsed = parseWhatsAppTemplateSubmissionComponents(
        carousel([
          [quickReply, url],
          [quickReply, url],
        ])
      );

      expect(parsed.success).toBe(true);
    });

    it("rejects cards whose button types differ in order", () => {
      const parsed = parseWhatsAppTemplateSubmissionComponents(
        carousel([
          [quickReply, url],
          [url, quickReply],
        ])
      );

      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Expected invalid carousel");
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Carousel card button types must match",
          }),
        ])
      );
    });
  });

  describe("template variable format", () => {
    it("accepts named text variables next to a numbered link variable", () => {
      const parsed = parseWhatsAppTemplateSubmissionComponents([
        {
          type: "BODY",
          text: "Hi {{first_name}}, your code is {{code_2}}.",
          example: {
            body_text_named_params: [
              { param_name: "first_name", example: "Pablo" },
              { param_name: "code_2", example: "WELCOME20" },
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
              example: ["https://shop.example.com/summer"],
            },
          ],
        },
      ]);

      expect(parsed.success).toBe(true);
    });

    it("rejects numbered variables in a template that uses named ones", () => {
      const parsed = parseWhatsAppTemplateSubmissionComponents([
        { type: "HEADER", format: "TEXT", text: "Order {{1}} update" },
        { type: "BODY", text: "Hi {{first_name}}, thanks." },
      ]);

      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Expected mixed variables to fail");
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({
          path: [0, "text"],
          message: expect.stringContaining("all named"),
        }),
      ]);
    });

    it("rejects named variables with uppercase letters", () => {
      const parsed = parseWhatsAppTemplateSubmissionComponents([
        { type: "BODY", text: "Hi {{First_Name}}, thanks." },
      ]);

      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Expected an invalid name to fail");
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({
          path: [0, "text"],
          message: expect.stringContaining("lowercase letters"),
        }),
      ]);
    });
  });
});
