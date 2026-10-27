import {
  buildConversationListPreview,
  compactPreviewText,
} from "./message-preview";

// Fixtures use the projected message shape from lib/requests-projection/derive:
// service messages keep only version/kind/bodyText and Flow replies keep a
// bounded answer count, never the send command or responseJson.
describe("buildConversationListPreview service messages", () => {
  it.each([
    [2, "2 answers"],
    [0, "Response sent"],
  ])(
    "renders safe Flow response metadata without raw JSON (%s fields)",
    (responseFieldCount, details) => {
      expect(
        buildConversationListPreview({
          messages: [
            {
              direction: "inbound",
              whatsappFlowReply: {
                flowName: "survey",
                responseFieldCount,
                responseSubmitted: true,
              },
            },
          ],
        })
      ).toMatchObject({
        kind: "structured",
        icon: "flow",
        details,
      });
    }
  );

  it("does not treat a contact-info Flow reply as a Flow response", () => {
    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "inbound",
            text: "Address shared",
            whatsappFlowReply: {
              flowName: "address_message",
              responseFieldCount: 3,
              responseSubmitted: true,
            },
          },
        ],
      })
    ).toEqual({ kind: "plain", text: "Address shared" });
  });

  it("labels media carousels instead of Photo even when mediaType=image", () => {
    const preview = buildConversationListPreview({
      messages: [
        {
          direction: "outbound",
          text: "Haya from Airi.chat!\n\nSee how carousels look like 👇",
          mediaType: "image",
          whatsappServiceMessage: {
            version: 1,
            kind: "media_carousel",
            bodyText: "Haya from Airi.chat!\n\nSee how carousels look like 👇",
          },
        },
      ],
    });

    expect(preview).toEqual({
      kind: "structured",
      tone: "accent",
      icon: "carousel",
      title: "Carousel",
      details: "Haya from Airi.chat! See how carousels look like 👇",
    });
  });

  it("labels reply buttons and location requests", () => {
    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "outbound",
            text: "Pick one",
            whatsappServiceMessage: { version: 1, kind: "reply_buttons" },
          },
        ],
      })
    ).toEqual({
      kind: "structured",
      tone: "accent",
      icon: "buttons",
      title: "Reply buttons",
      details: "Pick one",
    });

    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "outbound",
            text: "Share location",
            whatsappServiceMessage: { version: 1, kind: "location_request" },
          },
        ],
      })
    ).toMatchObject({
      kind: "structured",
      icon: "location",
      title: "Location request",
    });
  });

  it("uses the stored service body when the message text is empty", () => {
    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "outbound",
            text: "",
            whatsappServiceMessage: {
              version: 1,
              kind: "commerce",
              bodyText: "Browse this season",
            },
          },
        ],
      })
    ).toMatchObject({
      kind: "structured",
      icon: "catalog",
      title: "Catalog",
      details: "Browse this season",
    });
  });

  it("keeps canonical ownership ahead of stale legacy Flow and template metadata", () => {
    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "outbound",
            text: "Choose one",
            whatsappServiceMessage: { version: 1, kind: "reply_buttons" },
            whatsappFlow: {
              flowId: "stale-flow",
              flowCta: "Stale Flow",
            },
            whatsappTemplate: {
              name: "stale_template",
              bodyText: "Stale template",
            },
          },
        ],
      })
    ).toMatchObject({
      kind: "structured",
      icon: "buttons",
      title: "Reply buttons",
    });

    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "outbound",
            text: "Future service payload",
            whatsappServiceMessage: {} as never,
            whatsappFlow: {
              flowId: "stale-flow",
              flowCta: "Stale Flow",
            },
          },
        ],
      })
    ).toEqual({
      kind: "plain",
      text: "Future service payload",
    });
  });
});

describe("buildConversationListPreview template Flow sends", () => {
  const medalFlow = {
    flowId: "2244981489363579",
    flowToken: "flow_1",
    flowCta: "Choose",
  };

  it("previews a template as the template though it stores its FLOW button's Flow", () => {
    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "outbound",
            text: "[Template: medal_pick_1]",
            whatsappTemplate: {
              name: "medal_pick_1",
              bodyText: "Choose your medal",
              buttons: [
                { type: "flow", text: "Choose", flowId: medalFlow.flowId },
              ],
            },
            whatsappFlow: medalFlow,
          },
        ],
      })
    ).toEqual({
      kind: "structured",
      tone: "accent",
      icon: "template",
      title: "Choose your medal",
    });
  });

  it("still previews a Flow sent without a template as the Flow", () => {
    expect(
      buildConversationListPreview({
        messages: [
          {
            direction: "outbound",
            text: "Pick your medal",
            whatsappFlow: { ...medalFlow, bodyText: "Pick your medal" },
          },
        ],
      })
    ).toMatchObject({ kind: "structured", icon: "flow", title: "Choose" });
  });
});

describe("compactPreviewText", () => {
  it("collapses whitespace and markup onto one line", () => {
    expect(compactPreviewText("  New\n\n<b>spring</b>   drop  ", 52)).toBe(
      "New spring drop"
    );
  });

  it("cuts long text with an ellipsis inside the limit", () => {
    const text = compactPreviewText("a".repeat(60), 52);
    expect(text).toHaveLength(52);
    expect(text.endsWith("...")).toBe(true);
  });
});
