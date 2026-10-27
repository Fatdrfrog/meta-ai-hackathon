import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  buildWhatsAppTemplateSendComponentsFromTemplate,
  normalizeWhatsAppTemplateSendComponents,
} from "./message-types";

// Meta rejects text parameters with line breaks, tabs or more than four
// spaces in a row (#132018).
describe("template parameter text", () => {
  const templateComponents: WhatsAppComponent[] = [
    { type: "HEADER", format: "TEXT", text: "Hi {{1}}" },
    { type: "BODY", text: "Dear {{1}}, your order {{order}} is ready" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "URL", text: "Track", url: "https://shop.test/t/{{1}}" },
        { type: "QUICK_REPLY", text: "Stop" },
      ],
    },
    {
      type: "CAROUSEL",
      cards: [
        {
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: { header_handle: ["https://cdn.test/card.png"] },
            },
            { type: "BODY", text: "For {{1}}" },
          ],
        },
      ],
    },
  ];

  it("puts names and values pasted across lines on one line", () => {
    const { components } = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      values: {
        "1": "  Айгуль\r\n\tСапарова  ",
        order: "A-1\n\nB-2      C-3",
      },
      createQuickReplyPayload: () => '{"step": "stop\nnow"}',
    });

    expect(components).toEqual([
      {
        type: "header",
        parameters: [{ type: "text", text: "Айгуль Сапарова" }],
      },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Айгуль Сапарова" },
          { type: "text", parameter_name: "order", text: "A-1 B-2 C-3" },
        ],
      },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "Айгуль Сапарова" }],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        // Tap payloads are ours, not customer text: they stay as built.
        parameters: [{ type: "payload", payload: '{"step": "stop\nnow"}' }],
      },
      {
        type: "carousel",
        cards: [
          {
            card_index: 0,
            components: [
              {
                type: "header",
                parameters: [
                  {
                    type: "image",
                    image: { link: "https://cdn.test/card.png" },
                  },
                ],
              },
              {
                type: "body",
                parameters: [{ type: "text", text: "Айгуль Сапарова" }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps up to four spaces and sends the fallback for blank values", () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const { components } = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents: [{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}}" }],
      values: {
        "1": "a    b",
        "2": " \n\t ",
        "3": "",
        "4": `x${lineSeparator}y`,
      },
      resolveVariableValue: ({ variable, values }) => values[variable] ?? "",
    });

    expect(components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "a    b" },
          { type: "text", text: "-" },
          { type: "text", text: "-" },
          { type: "text", text: "x y" },
        ],
      },
    ]);
  });

  it("cleans components a caller built itself, as every send normalizes them", () => {
    expect(
      normalizeWhatsAppTemplateSendComponents([
        {
          type: "body",
          parameters: [
            { type: "text", text: "Line one\nline two" },
            {
              type: "currency",
              currency: {
                fallback_value: "$10\t000",
                code: "USD",
                amount_1000: 10_000_000,
              },
            },
            { type: "date_time", date_time: { fallback_value: "\n" } },
          ],
        },
        {
          type: "carousel",
          cards: [
            {
              card_index: 0,
              components: [
                {
                  type: "body",
                  parameters: [{ type: "text", text: "Card\r\ntext" }],
                },
              ],
            },
          ],
        },
      ])
    ).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Line one line two" },
          {
            type: "currency",
            currency: {
              fallback_value: "$10 000",
              code: "USD",
              amount_1000: 10_000_000,
            },
          },
          { type: "date_time", date_time: { fallback_value: "-" } },
        ],
      },
      {
        type: "carousel",
        cards: [
          {
            card_index: 0,
            components: [
              {
                type: "body",
                parameters: [{ type: "text", text: "Card text" }],
              },
            ],
          },
        ],
      },
    ]);
  });
});
