import {
  assertScenarioTemplateFlowComponents,
  buildScenarioTemplateComponents,
  buildScenarioTemplateValueMap,
  hasWhatsAppCdnHeaderMediaHandle,
} from "@/lib/airi/reply/runtime/auto-reply-template-utils";
import { buildWhatsAppTemplateButtonPayload } from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

type TemplateValueMapParams = Parameters<
  typeof buildScenarioTemplateValueMap
>[0];

describe("buildScenarioTemplateComponents", () => {
  it("resolves explicit header, body and URL slots independently without guessing", () => {
    const result = buildScenarioTemplateComponents({
      templateComponents: [
        { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
        { type: "BODY", text: "Hello {{1}}, order {{2}}" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "Track",
              url: "https://shop.test/track/{{1}}",
            },
            {
              type: "URL",
              text: "Order",
              url: "https://shop.test/order/{{1}}",
            },
          ],
        },
      ],
      values: { full_name: "Ada", reply: "Never substitute this reply" },
      promptInputs: { order_id: "ORDER-42" },
      bindings: {
        version: 1,
        parameters: {
          "header:1": { source: "literal", value: "Delivery update" },
          "body:1": { source: "context", key: "full_name" },
          "body:2": { source: "prompt_input", key: "order_id" },
          "button:0:1": { source: "literal", value: "TRACK-21" },
          "button:1:1": { source: "prompt_input", key: "order_id" },
        },
      },
    });

    expect(result).toEqual([
      {
        type: "header",
        parameters: [{ type: "text", text: "Delivery update" }],
      },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Ada" },
          { type: "text", text: "ORDER-42" },
        ],
      },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "TRACK-21" }],
      },
      {
        type: "button",
        sub_type: "url",
        index: "1",
        parameters: [{ type: "text", text: "ORDER-42" }],
      },
    ]);
  });

  it("rejects unavailable required input instead of a reply, name or dash fallback", () => {
    expect(() =>
      buildScenarioTemplateComponents({
        templateComponents: [{ type: "BODY", text: "Order {{1}}" }],
        values: { full_name: "Ada", reply: "Guess" },
        bindings: {
          version: 1,
          parameters: { "body:1": { source: "prompt_input", key: "order_id" } },
        },
      })
    ).toThrow(/SCENARIO_TEMPLATE_BINDING_INVALID/);
  });

  it("rejects a localized template whose parameter slots differ from its bindings", () => {
    expect(() =>
      buildScenarioTemplateComponents({
        templateComponents: [
          { type: "BODY", text: "Order {{1}}, arriving {{2}}" },
        ],
        values: { full_name: "Ada" },
        bindings: {
          version: 1,
          parameters: { "body:1": { source: "literal", value: "ORDER-42" } },
        },
      })
    ).toThrow(/SCENARIO_TEMPLATE_BINDING_INVALID/);
  });

  it("fails before returning an empty payload when explicit bindings have no template schema", () => {
    expect(() =>
      buildScenarioTemplateComponents({
        values: {},
        bindings: {
          version: 1,
          parameters: { "body:1": { source: "literal", value: "ORDER-42" } },
        },
      })
    ).toThrow(/SCENARIO_TEMPLATE_BINDING_INVALID: bindings_invalid/);
  });

  it("mirrors an explicit authentication body code into COPY_CODE", () => {
    const result = buildScenarioTemplateComponents({
      templateComponents: [
        { type: "BODY", text: "{{1}} is your code" },
        {
          type: "BUTTONS",
          buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy" }],
        },
      ],
      values: { full_name: "Wrong" },
      bindings: {
        version: 1,
        parameters: { "body:1": { source: "literal", value: "123456" } },
      },
    });
    expect(result).toEqual([
      { type: "body", parameters: [{ type: "text", text: "123456" }] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "123456" }],
      },
    ]);
  });

  it("keeps carousel card and button bindings distinct", () => {
    const result = buildScenarioTemplateComponents({
      templateComponents: [
        {
          type: "CAROUSEL",
          cards: [0, 1].map(() => ({
            components: [
              {
                type: "HEADER" as const,
                format: "IMAGE" as const,
                example: { header_handle: ["https://cdn.test/item.jpg"] },
              },
              { type: "BODY" as const, text: "Item {{1}}" },
              {
                type: "BUTTONS" as const,
                buttons: [
                  {
                    type: "URL" as const,
                    text: "View",
                    url: "https://shop.test/{{1}}",
                  },
                ],
              },
            ],
          })),
        },
      ],
      values: {},
      bindings: {
        version: 1,
        parameters: {
          "card:0:body:1": { source: "literal", value: "First" },
          "card:0:button:0:1": { source: "literal", value: "first-path" },
          "card:1:body:1": { source: "literal", value: "Second" },
          "card:1:button:0:1": { source: "literal", value: "second-path" },
        },
      },
    });
    expect(result).toMatchObject([
      {
        type: "carousel",
        cards: [
          {
            card_index: 0,
            components: [
              { type: "header" },
              { type: "body", parameters: [{ text: "First" }] },
              {
                type: "button",
                index: "0",
                parameters: [{ text: "first-path" }],
              },
            ],
          },
          {
            card_index: 1,
            components: [
              { type: "header" },
              { type: "body", parameters: [{ text: "Second" }] },
              {
                type: "button",
                index: "0",
                parameters: [{ text: "second-path" }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("uses the provided Flow token for flow-button templates", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open flow",
            flow_id: "2244981489363579",
            flow_action: "navigate",
            navigate_screen: "QUESTION_ONE",
          },
        ],
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {},
      flowToken: "flow_stable_token",
    });

    expect(result).toEqual([
      {
        type: "button",
        sub_type: "flow",
        index: "0",
        parameters: [
          {
            type: "action",
            action: {
              flow_token: "flow_stable_token",
            },
          },
        ],
      },
    ]);
  });

  it("builds FLOW button action parameters for flow-button templates", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open flow",
            flow_id: "2244981489363579",
            flow_action: "navigate",
            navigate_screen: "QUESTION_ONE",
          },
        ],
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {},
    });

    expect(result).toEqual([
      {
        type: "button",
        sub_type: "flow",
        index: "0",
        parameters: [
          {
            type: "action",
            action: {
              flow_token: expect.stringMatching(/^flow_\d+_[a-z0-9]+$/),
            },
          },
        ],
      },
    ]);
  });

  it("adds payload parameters for quick-reply template buttons when an action node id is available", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Kazakh" },
          { type: "URL", text: "Website", url: "https://example.com" },
          { type: "QUICK_REPLY", text: "Russian" },
        ],
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {},
      actionNodeId: "action-template",
    });

    expect(result).toEqual([
      {
        type: "button",
        sub_type: "quick_reply",
        index: "0",
        parameters: [
          {
            type: "payload",
            payload: buildWhatsAppTemplateButtonPayload("action-template", 0),
          },
        ],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "2",
        parameters: [
          {
            type: "payload",
            payload: buildWhatsAppTemplateButtonPayload("action-template", 2),
          },
        ],
      },
    ]);
  });

  it("preserves legacy quick-reply template sends when no action node id is available", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {},
    });

    expect(result).toBeUndefined();
  });

  it("reuses canonical media-header template parameters for scenario sends", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "HEADER",
        format: "VIDEO",
        example: {
          header_handle: ["https://scontent.whatsapp.net/example.mp4"],
        },
      },
      {
        type: "BODY",
        text: "Fixed approved body copy",
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {},
    });

    expect(result).toEqual([
      {
        type: "header",
        parameters: [
          {
            type: "video",
            video: {
              link: "https://scontent.whatsapp.net/example.mp4",
            },
          },
        ],
      },
    ]);
  });

  it("fails clearly when a scenario media-header template has no reusable media URL", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "HEADER",
        format: "IMAGE",
        example: {
          header_handle: ["4::meta-media-handle"],
        },
      },
      {
        type: "BODY",
        text: "Fixed approved body copy",
      },
    ];

    expect(() =>
      buildScenarioTemplateComponents({
        templateComponents,
        values: {},
      })
    ).toThrow(/requires image header media/);
  });

  it("uses actionReplyText for explicit body text variables", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "Reply: {{reply}}",
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {
        reply: "Custom template reply",
      },
    });

    expect(result).toEqual([
      {
        type: "body",
        parameters: [
          {
            type: "text",
            text: "Custom template reply",
            parameter_name: "reply",
          },
        ],
      },
    ]);
  });

  it("falls back to actionReplyText when there is exactly one unresolved body variable", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "Reply: {{1}}",
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {
        reply: "Single unresolved fallback",
      },
    });

    expect(result).toEqual([
      {
        type: "body",
        parameters: [
          {
            type: "text",
            text: "Single unresolved fallback",
          },
        ],
      },
    ]);
  });

  it("leaves fixed template body copy untouched when there is no variable slot", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "Fixed approved body copy",
      },
    ];

    const result = buildScenarioTemplateComponents({
      templateComponents,
      values: {
        reply: "Edited text should not override fixed body copy",
      },
    });

    expect(result).toBeUndefined();
  });

  // Meta rejects parameters with line breaks or tabs (#132018).
  it("sends a customer name saved across lines on one line", () => {
    const result = buildScenarioTemplateComponents({
      templateComponents: [{ type: "BODY", text: "Dear {{1}}" }],
      values: { full_name: "Айгуль\n\tСапарова ", name: "Айгуль" },
    });

    expect(result).toEqual([
      {
        type: "body",
        parameters: [{ type: "text", text: "Айгуль Сапарова" }],
      },
    ]);
  });
});

describe("buildScenarioTemplateComponents tap payloads", () => {
  const quickReply = (text: string) => ({
    type: "QUICK_REPLY" as const,
    text,
  });
  const buttons = (
    ...items: Array<
      ReturnType<typeof quickReply> | { type: "URL"; text: string; url: string }
    >
  ): WhatsAppComponent[] => [
    { type: "BODY", text: "Which plan do you want?" },
    { type: "BUTTONS", buttons: items },
  ];
  const payloadsByIndex = (
    result: ReturnType<typeof buildScenarioTemplateComponents>
  ) =>
    Object.fromEntries(
      (result ?? []).flatMap(component =>
        component.type === "button" && component.sub_type === "quick_reply"
          ? [[String(component.index), component.parameters[0]?.payload]]
          : []
      )
    );

  it("sends today's payloads for a step without button ids", () => {
    const step = buttons(
      quickReply("Kazakh"),
      { type: "URL", text: "Website", url: "https://example.com" },
      quickReply("Russian"),
      quickReply("")
    );
    const legacy = buildScenarioTemplateComponents({
      templateComponents: step,
      values: {},
      actionNodeId: "menu",
    });

    expect(payloadsByIndex(legacy)).toEqual({
      "0": "stb:menu:0",
      "2": "stb:menu:2",
      "3": "stb:menu:3",
    });
    expect(
      buildScenarioTemplateComponents({
        templateComponents: step,
        values: {},
        actionNodeId: "menu",
        nodeTemplateComponents: step,
      })
    ).toEqual(legacy);
    // Writing the ids keeps every labelled button's payload. A quick reply
    // without a label has no id, so it has no route and no payload.
    expect(
      payloadsByIndex(
        buildScenarioTemplateComponents({
          templateComponents: step,
          values: {},
          actionNodeId: "menu",
          nodeTemplateComponents: step,
          templateButtonIds: {
            version: 1,
            nextId: 10,
            buttons: [
              { id: 0, index: 0, text: "Kazakh" },
              { id: 2, index: 2, text: "Russian" },
            ],
          },
        })
      )
    ).toEqual({ "0": "stb:menu:0", "2": "stb:menu:2" });
  });

  it("names the step's button when the live template orders buttons differently", () => {
    const result = buildScenarioTemplateComponents({
      templateComponents: buttons(quickReply("Premium"), quickReply("Basic")),
      values: {},
      actionNodeId: "menu",
      nodeTemplateComponents: buttons(
        quickReply("Basic"),
        quickReply("Premium")
      ),
    });

    expect(payloadsByIndex(result)).toEqual({
      "0": "stb:menu:1",
      "1": "stb:menu:0",
    });
  });

  it("sends each button's id once the step has ids", () => {
    // Basic was removed from [Basic, Premium] and Gold was added.
    const step = buttons(quickReply("Premium"), quickReply("Gold"));
    const result = buildScenarioTemplateComponents({
      templateComponents: step,
      values: {},
      actionNodeId: "menu",
      nodeTemplateComponents: step,
      templateButtonIds: {
        version: 1,
        nextId: 11,
        buttons: [
          { id: 1, index: 0, text: "Premium" },
          { id: 10, index: 1, text: "Gold" },
        ],
      },
    });

    expect(payloadsByIndex(result)).toEqual({
      "0": "stb:menu:1",
      "1": "stb:menu:10",
    });
  });

  it("omits a sent quick reply that matches none of the step's buttons", () => {
    const result = buildScenarioTemplateComponents({
      templateComponents: buttons(quickReply("Premium"), quickReply("Gold")),
      values: {},
      actionNodeId: "menu",
      nodeTemplateComponents: buttons(quickReply("Premium")),
      templateButtonIds: {
        version: 1,
        nextId: 10,
        buttons: [{ id: 1, index: 0, text: "Premium" }],
      },
    });

    expect(payloadsByIndex(result)).toEqual({ "0": "stb:menu:1" });
  });

  describe("carousel cards", () => {
    function card(text: string) {
      return {
        components: [
          {
            type: "HEADER" as const,
            format: "IMAGE" as const,
            example: { header_handle: ["https://cdn.test/item.jpg"] },
          },
          { type: "BODY" as const, text },
          { type: "BUTTONS" as const, buttons: [quickReply("Buy")] },
        ],
      };
    }
    const collection: WhatsAppComponent[] = [
      { type: "BODY", text: "Fall 2026" },
      { type: "CAROUSEL", cards: [card("Blazer"), card("Coat")] },
    ];

    it("gives each card's quick reply the step's id for that card", () => {
      const result = buildScenarioTemplateComponents({
        templateComponents: collection,
        values: {},
        actionNodeId: "menu",
        nodeTemplateComponents: collection,
      });

      expect(result).toContainEqual(
        expect.objectContaining({
          type: "carousel",
          cards: ["stb:menu:100", "stb:menu:110"].map((payload, cardIndex) => ({
            card_index: cardIndex,
            components: [
              expect.objectContaining({ type: "header" }),
              {
                type: "button",
                sub_type: "quick_reply",
                index: "0",
                parameters: [{ type: "payload", payload }],
              },
            ],
          })),
        })
      );
    });

    it("never gives a card the id of a message button", () => {
      const result = buildScenarioTemplateComponents({
        templateComponents: [
          { type: "CAROUSEL", cards: [card("Blazer"), card("Blazer")] },
        ],
        values: {},
        actionNodeId: "menu",
        nodeTemplateComponents: buttons(quickReply("Basic")),
        templateButtonIds: {
          version: 1,
          nextId: 10,
          buttons: [{ id: 5, index: 0, text: "Basic" }],
        },
      });

      expect(result).toMatchObject([
        {
          type: "carousel",
          cards: [0, 1].map(cardIndex => ({
            card_index: cardIndex,
            components: [{ type: "header" }],
          })),
        },
      ]);
    });
  });
});

describe("assertScenarioTemplateFlowComponents", () => {
  it("accepts a template whose FLOW button matches the scenario Flow id", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open flow",
            flow_id: "flow-123",
          },
        ],
      },
    ];

    expect(() =>
      assertScenarioTemplateFlowComponents({
        templateName: "flow_template",
        templateComponents,
        linkedFlowId: "flow-123",
      })
    ).not.toThrow();
  });

  it("rejects a flow-backed scenario template when the approved template has no matching FLOW button", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open flow",
            flow_id: "different-flow",
          },
        ],
      },
    ];

    expect(() =>
      assertScenarioTemplateFlowComponents({
        templateName: "flow_template",
        templateComponents,
        linkedFlowId: "expected-flow",
      })
    ).toThrow(/does not contain FLOW button/);
  });

  it("accepts a template whose FLOW button matches the scenario Flow name", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Open flow",
            flow_name: "appointment_booking_v1",
          },
        ],
      },
    ];

    expect(() =>
      assertScenarioTemplateFlowComponents({
        templateName: "flow_template",
        templateComponents,
        linkedFlowName: "appointment_booking_v1",
      })
    ).not.toThrow();
  });
});

describe("hasWhatsAppCdnHeaderMediaHandle", () => {
  it("detects expiring WhatsApp CDN media handles on template headers", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "HEADER",
        format: "VIDEO",
        example: {
          header_handle: ["https://scontent.whatsapp.net/v/t61/video.mp4"],
        },
      },
      {
        type: "BODY",
        text: "Body",
      },
    ];

    expect(hasWhatsAppCdnHeaderMediaHandle(templateComponents)).toBe(true);
  });

  it("ignores reusable non-WhatsApp header media URLs", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "HEADER",
        format: "VIDEO",
        example: {
          header_handle: ["https://cdn.airi.chat/template-video.mp4"],
        },
      },
    ];

    expect(hasWhatsAppCdnHeaderMediaHandle(templateComponents)).toBe(false);
  });

  const carousel = (handles: string[]): WhatsAppComponent[] => [
    { type: "BODY", text: "Dear {{1}}" },
    {
      type: "CAROUSEL",
      cards: handles.map(handle => ({
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: [handle] },
          },
          { type: "BODY", text: "Card" },
        ],
      })),
    },
  ];

  it("detects expiring WhatsApp CDN media handles on carousel card headers", () => {
    expect(
      hasWhatsAppCdnHeaderMediaHandle(
        carousel([
          "https://cdn.airi.chat/card-1.png",
          "https://scontent.whatsapp.net/v/t61/card-2.png",
        ])
      )
    ).toBe(true);
  });

  it("ignores carousel cards whose headers use reusable media URLs", () => {
    expect(
      hasWhatsAppCdnHeaderMediaHandle(
        carousel([
          "https://cdn.airi.chat/card-1.png",
          "https://cdn.airi.chat/card-2.png",
        ])
      )
    ).toBe(false);
  });
});

describe("buildScenarioTemplateValueMap", () => {
  it("exposes actionReplyText under explicit template-friendly keys", () => {
    const result = buildScenarioTemplateValueMap({
      conversation: {
        _id: "conv_1",
        channel: "whatsapp",
      } as unknown as TemplateValueMapParams["conversation"],
      chatDocument: {
        first_name: "Ada",
      } as TemplateValueMapParams["chatDocument"],
      actionReplyText: "Client-facing template text",
    });

    expect(result.reply).toBe("Client-facing template text");
    expect(result.reply_text).toBe("Client-facing template text");
    expect(result.text).toBe("Client-facing template text");
    expect(result.message).toBe("Client-facing template text");
  });

  it("exposes WhatsApp referral fields for scenario template variables", () => {
    const result = buildScenarioTemplateValueMap({
      conversation: {
        _id: "conv_1",
        channel: "whatsapp",
      } as unknown as TemplateValueMapParams["conversation"],
      chatDocument: {
        first_name: "Ada",
      } as TemplateValueMapParams["chatDocument"],
      triggerMessage: {
        whatsappReferral: {
          sourceType: "ad",
          sourceId: "238000111222333",
          sourceUrl: "https://www.instagram.com/p/CampaignPost/",
          headline: "Spring offer",
          body: "Tap to chat",
          ctwaClid: "clid_123",
          ref: "sequence_ref_123",
        },
      } as TemplateValueMapParams["triggerMessage"],
    });

    expect(result.whatsapp_referral_source_type).toBe("ad");
    expect(result.whatsapp_referral_source_id).toBe("238000111222333");
    expect(result.whatsapp_referral_source_platform).toBe("instagram");
    expect(result.whatsapp_referral_headline).toBe("Spring offer");
    expect(result.whatsapp_referral_body).toBe("Tap to chat");
    expect(result.whatsapp_referral_ctwa_clid).toBe("clid_123");
    expect(result.whatsapp_referral_ref).toBe("sequence_ref_123");
    expect(result.ctwa_ref).toBe("sequence_ref_123");
  });
});
