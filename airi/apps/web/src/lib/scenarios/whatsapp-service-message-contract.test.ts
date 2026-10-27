import {
  buildWhatsAppSessionChoicePayload,
  compileWhatsAppServiceMessage,
  createDefaultScenarioWhatsAppServiceMessage,
  extractScenarioWhatsAppServiceBranchOptions,
  normalizeScenarioWhatsAppServiceMessage,
  validateScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";

function fixed(text = "Hello") {
  return { mode: "fixed" as const, text };
}

function config(
  message: ScenarioWhatsAppServiceMessage["message"]
): ScenarioWhatsAppServiceMessage {
  return { version: 1, message };
}

describe("WhatsApp service message contract", () => {
  it("creates one editable default per format", () => {
    expect(createDefaultScenarioWhatsAppServiceMessage("text")).toEqual({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "" },
        previewUrl: true,
      },
    });
    expect(
      createDefaultScenarioWhatsAppServiceMessage("reply_buttons").message
    ).toMatchObject({ kind: "reply_buttons", options: [] });
    expect(
      createDefaultScenarioWhatsAppServiceMessage("media_carousel").message
    ).toMatchObject({ kind: "media_carousel", cards: [] });
  });

  it("normalizes supported values and fails closed for future versions", () => {
    const supported = config({
      kind: "text",
      body: fixed("  Keep spacing while editing  "),
      previewUrl: false,
    });

    expect(normalizeScenarioWhatsAppServiceMessage(supported)).toEqual({
      status: "supported",
      value: supported,
    });
    expect(
      normalizeScenarioWhatsAppServiceMessage({
        version: 2,
        message: { kind: "text", body: fixed() },
      })
    ).toEqual({ status: "unsupported_version", version: 2 });
  });

  it("validates body, option, URL, media, location, and voice-call constraints", () => {
    const invalid = [
      config({ kind: "text", body: fixed(" "), previewUrl: true }),
      config({
        kind: "reply_buttons",
        body: fixed(),
        options: [
          { id: "same", label: "A" },
          { id: "same", label: "B" },
          { id: "c", label: "C" },
          { id: "d", label: "D" },
        ],
      }),
      config({
        kind: "cta_url",
        body: fixed(),
        buttonLabel: "Open",
        urlSource: { kind: "fixed", url: "javascript:alert(1)" },
      }),
      config({
        kind: "media",
        attachment: {
          url: "https://cdn.test/song.mp3",
          mediaType: "audio",
        },
        body: fixed("audio cannot have a caption"),
      }),
      config({
        kind: "location",
        location: { latitude: 91, longitude: 181 },
      }),
      config({
        kind: "voice_call",
        body: fixed(),
        buttonLabel: "Call",
        ttlMinutes: 0,
        payload: "track",
      }),
    ];

    const codes = invalid.flatMap(value =>
      validateScenarioWhatsAppServiceMessage(value).map(item => item.code)
    );

    expect(codes).toEqual(
      expect.arrayContaining([
        "body_required",
        "reply_button_count_invalid",
        "interactive_id_duplicate",
        "url_invalid",
        "media_caption_unsupported",
        "location_coordinates_invalid",
        "voice_call_ttl_invalid",
      ])
    );
  });

  it("reports an empty text header as required rather than too long", () => {
    const diagnostics = validateScenarioWhatsAppServiceMessage(
      config({
        kind: "reply_buttons",
        body: fixed(),
        header: { kind: "text", text: "   " },
        options: [{ id: "continue", label: "Continue" }],
      })
    );

    expect(diagnostics).toContainEqual({
      code: "header_required",
      path: "message.header.text",
    });
    expect(diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "header_too_long" })
    );
  });

  it.each([
    {
      name: "null list section",
      value: {
        version: 1,
        message: {
          kind: "list",
          body: fixed(),
          buttonLabel: "Choose",
          sections: [null],
        },
      },
    },
    {
      name: "non-array list rows",
      value: {
        version: 1,
        message: {
          kind: "list",
          body: fixed(),
          buttonLabel: "Choose",
          sections: [{ id: "section", rows: "invalid" }],
        },
      },
    },
    {
      name: "null carousel card",
      value: {
        version: 1,
        message: {
          kind: "media_carousel",
          body: fixed(),
          cards: [null, null],
        },
      },
    },
    {
      name: "non-array commerce sections",
      value: {
        version: 1,
        message: {
          kind: "commerce",
          commerce: {
            mode: "multi_product",
            catalogId: "catalog-1",
            headerText: "Products",
            bodyText: "Choose",
            sections: "invalid",
          },
        },
      },
    },
    {
      name: "missing product carousel ids",
      value: {
        version: 1,
        message: {
          kind: "commerce",
          commerce: {
            mode: "product_carousel",
            catalogId: "catalog-1",
            bodyText: "Choose",
          },
        },
      },
    },
  ])("fails closed without throwing for a malformed $name", ({ value }) => {
    expect(() => validateScenarioWhatsAppServiceMessage(value)).not.toThrow();
    expect(validateScenarioWhatsAppServiceMessage(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "message_kind_invalid" }),
      ])
    );
    expect(
      compileWhatsAppServiceMessage({
        config: value as ScenarioWhatsAppServiceMessage,
        recipientKind: "phone",
      })
    ).toMatchObject({ ok: false });
  });

  it("requires globally unique carousel quick-reply ids and a uniform button shape", () => {
    const value = config({
      kind: "media_carousel",
      body: fixed(),
      cards: [
        {
          id: "one",
          media: { url: "https://cdn.test/one.jpg", mediaType: "image" },
          interaction: {
            kind: "quick_replies",
            options: [{ id: "same", label: "Pick" }],
          },
        },
        {
          id: "two",
          media: { url: "https://cdn.test/two.mp4", mediaType: "video" },
          interaction: {
            kind: "url",
            buttonLabel: "Open",
            url: "https://example.com",
          },
        },
      ],
    });

    expect(
      validateScenarioWhatsAppServiceMessage(value).map(item => item.code)
    ).toEqual(expect.arrayContaining(["carousel_button_shape_mismatch"]));
  });

  it("rejects carousel card copy above the transport limit", () => {
    const value = config({
      kind: "media_carousel",
      body: fixed("Compare"),
      cards: [
        {
          id: "one",
          media: { url: "https://cdn.test/one.jpg", mediaType: "image" },
          bodyText: "x".repeat(161),
          interaction: {
            kind: "quick_replies",
            options: [{ id: "one-pick", label: "Pick" }],
          },
        },
        {
          id: "two",
          media: { url: "https://cdn.test/two.jpg", mediaType: "image" },
          bodyText: "Within limit",
          interaction: {
            kind: "quick_replies",
            options: [{ id: "two-pick", label: "Pick" }],
          },
        },
      ],
    });

    expect(validateScenarioWhatsAppServiceMessage(value)).toContainEqual({
      code: "body_too_long",
      path: "message.cards.0.bodyText",
    });
    expect(
      compileWhatsAppServiceMessage({
        config: value,
        recipientKind: "phone",
      })
    ).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "body_too_long",
          path: "message.cards.0.bodyText",
        },
      ],
    });
  });

  it.each([
    {
      name: "catalog body",
      commerce: {
        mode: "catalog" as const,
        catalogId: "catalog-1",
        bodyText: "x".repeat(1025),
      },
      diagnostic: {
        code: "body_too_long",
        path: "message.commerce.bodyText",
      },
    },
    {
      name: "catalog footer",
      commerce: {
        mode: "catalog" as const,
        catalogId: "catalog-1",
        footerText: "x".repeat(61),
      },
      diagnostic: {
        code: "footer_too_long",
        path: "message.commerce.footerText",
      },
    },
    {
      name: "single-product body",
      commerce: {
        mode: "single_product" as const,
        catalogId: "catalog-1",
        productRetailerId: "product-1",
        bodyText: "x".repeat(1025),
      },
      diagnostic: {
        code: "body_too_long",
        path: "message.commerce.bodyText",
      },
    },
    {
      name: "single-product footer",
      commerce: {
        mode: "single_product" as const,
        catalogId: "catalog-1",
        productRetailerId: "product-1",
        footerText: "x".repeat(61),
      },
      diagnostic: {
        code: "footer_too_long",
        path: "message.commerce.footerText",
      },
    },
    {
      name: "multi-product header",
      commerce: {
        mode: "multi_product" as const,
        catalogId: "catalog-1",
        headerText: "x".repeat(61),
        bodyText: "Choose",
        sections: [
          {
            id: "section-1",
            title: "Products",
            productRetailerIds: ["product-1"],
          },
        ],
      },
      diagnostic: {
        code: "header_too_long",
        path: "message.commerce.headerText",
      },
    },
    {
      name: "multi-product body",
      commerce: {
        mode: "multi_product" as const,
        catalogId: "catalog-1",
        headerText: "Products",
        bodyText: "x".repeat(1025),
        sections: [
          {
            id: "section-1",
            title: "Products",
            productRetailerIds: ["product-1"],
          },
        ],
      },
      diagnostic: {
        code: "body_too_long",
        path: "message.commerce.bodyText",
      },
    },
    {
      name: "multi-product footer",
      commerce: {
        mode: "multi_product" as const,
        catalogId: "catalog-1",
        headerText: "Products",
        bodyText: "Choose",
        footerText: "x".repeat(61),
        sections: [
          {
            id: "section-1",
            title: "Products",
            productRetailerIds: ["product-1"],
          },
        ],
      },
      diagnostic: {
        code: "footer_too_long",
        path: "message.commerce.footerText",
      },
    },
    {
      name: "multi-product section title",
      commerce: {
        mode: "multi_product" as const,
        catalogId: "catalog-1",
        headerText: "Products",
        bodyText: "Choose",
        sections: [
          {
            id: "section-1",
            title: "x".repeat(25),
            productRetailerIds: ["product-1"],
          },
        ],
      },
      diagnostic: {
        code: "list_section_title_too_long",
        path: "message.commerce.sections.0.title",
      },
    },
    {
      name: "product-carousel body",
      commerce: {
        mode: "product_carousel" as const,
        catalogId: "catalog-1",
        bodyText: "x".repeat(1025),
        productRetailerIds: ["product-1", "product-2"],
      },
      diagnostic: {
        code: "body_too_long",
        path: "message.commerce.bodyText",
      },
    },
  ])(
    "rejects oversized $name text before commerce compilation",
    ({ commerce, diagnostic }) => {
      const value = config({ kind: "commerce", commerce });

      expect(validateScenarioWhatsAppServiceMessage(value)).toContainEqual(
        diagnostic
      );
      expect(
        compileWhatsAppServiceMessage({
          config: value,
          recipientKind: "phone",
        })
      ).toMatchObject({ ok: false });
    }
  );

  it("rejects too many multi-product sections at the collection path", () => {
    const value = config({
      kind: "commerce",
      commerce: {
        mode: "multi_product",
        catalogId: "catalog-1",
        headerText: "Products",
        bodyText: "Choose",
        sections: Array.from({ length: 11 }, (_, index) => ({
          id: `section-${index}`,
          title: `Section ${index}`,
          productRetailerIds: [index === 0 ? "product-1" : ""],
        })),
      },
    });

    expect(validateScenarioWhatsAppServiceMessage(value)).toContainEqual({
      code: "list_section_count_invalid",
      path: "message.commerce.sections",
    });
    expect(
      compileWhatsAppServiceMessage({
        config: value,
        recipientKind: "phone",
      })
    ).toMatchObject({ ok: false });
  });

  it("extracts canonical option branches with the existing stable payload codec", () => {
    const value = config({
      kind: "list",
      body: fixed(),
      buttonLabel: "Choose",
      sections: [
        {
          id: "products",
          title: "Products",
          rows: [
            { id: "starter", title: "Starter" },
            { id: "pro", title: "Pro", description: "For teams" },
          ],
        },
      ],
    });

    expect(
      extractScenarioWhatsAppServiceBranchOptions({
        config: value,
      })
    ).toEqual([
      {
        id: "starter",
        label: "Starter",
      },
      {
        id: "pro",
        label: "Pro",
      },
    ]);
  });

  it("keeps branch options when a reply button label is still empty", () => {
    const optionId = buildWhatsAppSessionChoicePayload({
      actionNodeId: "action-1",
      choiceId: "draft-choice",
    });
    const value = config({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      options: [
        { id: optionId, label: "Ready" },
        {
          id: buildWhatsAppSessionChoicePayload({
            actionNodeId: "action-1",
            choiceId: "draft",
          }),
          label: "",
        },
      ],
    });

    expect(
      extractScenarioWhatsAppServiceBranchOptions({
        config: value,
      })
    ).toHaveLength(2);
  });
});

describe("compileWhatsAppServiceMessage", () => {
  it("compiles fixed and runtime-resolved AI text into one text command", () => {
    const aiConfig = config({
      kind: "text",
      body: { mode: "ai", instruction: "Answer briefly" },
      previewUrl: true,
    });

    expect(
      compileWhatsAppServiceMessage({
        config: aiConfig,
        resolvedBodyText: "Resolved answer",
        recipientKind: "phone",
      })
    ).toMatchObject({
      ok: true,
      command: {
        kind: "text",
        body: "Resolved answer",
        previewUrl: true,
      },
    });
  });

  it("compiles audio media with deliverAsVoice into a voice command", () => {
    const voiceConfig = config({
      kind: "media",
      attachment: {
        url: "https://cdn.test/note.ogg",
        mediaType: "audio",
        mimeType: "audio/ogg",
        fileName: "note.ogg",
      },
      deliverAsVoice: true,
    });

    expect(
      compileWhatsAppServiceMessage({
        config: voiceConfig,
        recipientKind: "phone",
      })
    ).toMatchObject({
      ok: true,
      command: {
        kind: "media",
        voice: true,
        attachment: {
          url: "https://cdn.test/note.ogg",
          mediaType: "audio",
        },
      },
    });
  });

  it("rejects deliverAsVoice when the audio is not OGG/OPUS", () => {
    const diagnostics = validateScenarioWhatsAppServiceMessage(
      config({
        kind: "media",
        attachment: {
          url: "https://cdn.test/song.mp3",
          mediaType: "audio",
          mimeType: "audio/mpeg",
          fileName: "song.mp3",
        },
        deliverAsVoice: true,
      })
    );

    expect(diagnostics).toContainEqual({
      code: "voice_format_invalid",
      path: "message.attachment",
    });
  });

  it("rejects an AI-resolved body that exceeds the final Meta limit", () => {
    const result = compileWhatsAppServiceMessage({
      config: config({
        kind: "reply_buttons",
        body: { mode: "ai", instruction: "Answer briefly" },
        options: [{ id: "answer", label: "Continue" }],
      }),
      resolvedBodyText: "x".repeat(1025),
      recipientKind: "phone",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "body_too_long", path: "resolvedBodyText" }],
    });
  });

  it("compiles list sections without flattening their Meta payload shape", () => {
    const result = compileWhatsAppServiceMessage({
      config: config({
        kind: "list",
        body: fixed("Pick one"),
        headerText: "Plans",
        footerText: "Monthly billing",
        buttonLabel: "View plans",
        sections: [
          {
            id: "plans",
            title: "Available",
            rows: [{ id: "pro", title: "Pro" }],
          },
        ],
      }),
      recipientKind: "phone",
    });

    expect(result).toMatchObject({
      ok: true,
      command: {
        kind: "list",
        body: "Pick one",
        headerText: "Plans",
        footerText: "Monthly billing",
        buttonLabel: "View plans",
        sections: [
          {
            title: "Available",
            rows: [{ id: "pro", title: "Pro" }],
          },
        ],
      },
    });
  });

  it("compiles appointment slots to one buttons or list command", () => {
    const appointment = config({
      kind: "appointment",
      body: fixed("Choose a time"),
      config: { enabled: true, maxSlots: 10, timeZone: "UTC" },
    });
    const choice = (id: string) => ({
      id,
      text: id.toUpperCase(),
      payload: `wbc:action-1:${id}`,
      description: `${id} details`,
    });

    expect(
      compileWhatsAppServiceMessage({
        config: appointment,
        appointmentChoices: [choice("a"), choice("b"), choice("c")],
        recipientKind: "phone",
      })
    ).toMatchObject({ ok: true, command: { kind: "reply_buttons" } });

    expect(
      compileWhatsAppServiceMessage({
        config: appointment,
        appointmentChoices: [
          choice("a"),
          choice("b"),
          choice("c"),
          choice("d"),
        ],
        recipientKind: "phone",
      })
    ).toMatchObject({ ok: true, command: { kind: "list" } });
  });

  it("requires dynamic managed URL resolution without changing the format", () => {
    const result = compileWhatsAppServiceMessage({
      config: config({
        kind: "cta_url",
        body: fixed(),
        buttonLabel: "Subscribe",
        urlSource: {
          kind: "signup_link",
          signupLinkId: "signup-1",
          fallbackUrl: "https://wa.me/message/fallback",
        },
      }),
      recipientKind: "phone",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "managed_url_unresolved" }],
    });
  });

  it("enforces recipient and source capabilities for contact request and voice call", () => {
    const requestContactPhone = compileWhatsAppServiceMessage({
      config: config({
        kind: "request_contact_info",
        body: fixed("Share contact"),
      }),
      recipientKind: "phone",
    });
    const requestContactBsuid = compileWhatsAppServiceMessage({
      config: config({
        kind: "request_contact_info",
        body: fixed("Share contact"),
      }),
      recipientKind: "bsuid",
    });
    const voiceCall = compileWhatsAppServiceMessage({
      config: config({
        kind: "voice_call",
        body: fixed("Call us"),
        buttonLabel: "Call",
        ttlMinutes: 60,
        payload: "campaign-1",
      }),
      recipientKind: "phone",
      callingReady: false,
    });

    expect(requestContactPhone).toMatchObject({
      ok: true,
      command: { kind: "text", body: "Share contact", previewUrl: false },
    });
    expect(requestContactBsuid).toMatchObject({
      ok: true,
      command: { kind: "request_contact_info", body: "Share contact" },
    });
    expect(voiceCall).toMatchObject({
      ok: false,
      diagnostics: [{ code: "voice_call_unavailable" }],
    });
  });
});
