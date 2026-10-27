import {
  getProviderMessageDisplayOverride,
  isWhatsAppUnavailableInboundSourcePayload,
  INSTAGRAM_STORY_MENTION_DISPLAY_TEXT,
  isProviderLabelText,
  resolveInstagramMessageContent,
  WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT,
} from "@/lib/provider-message-display";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";

describe("unavailable WhatsApp inbound provenance", () => {
  const raw = (overrides = {}) => ({
    provider: "whatsapp",
    eventType: "message",
    payload: {
      direction: "inbound",
      messages: [{ type: "unsupported", errors: [{ code: 131060 }] }],
    },
    ...overrides,
  });
  it("recognizes a saved 131060 inbound without reading display text", () => {
    expect(isWhatsAppUnavailableInboundSourcePayload(raw())).toBe(true);
    expect(
      isWhatsAppUnavailableInboundSourcePayload({
        text: "[WhatsApp message unavailable: open WhatsApp Business app to view]",
      })
    ).toBe(false);
  });
  it("recognizes the per-message nested entry envelope written by the webhook", () => {
    expect(
      isWhatsAppUnavailableInboundSourcePayload(
        raw({
          payload: {
            direction: "inbound",
            entry: {
              changes: [
                {
                  field: "messages",
                  value: {
                    messages: [
                      {
                        type: "unsupported",
                        unsupported: { type: "unknown" },
                        errors: [{ code: 131060 }],
                      },
                    ],
                  },
                },
              ],
            },
          },
        })
      )
    ).toBe(true);
  });
  it("excludes history imports, echoes and other provider errors", () => {
    expect(
      isWhatsAppUnavailableInboundSourcePayload(
        raw({ eventType: "history_message" })
      )
    ).toBe(false);
    expect(
      isWhatsAppUnavailableInboundSourcePayload(
        raw({
          payload: {
            direction: "outbound",
            messages: [{ type: "unsupported", errors: [{ code: 131060 }] }],
          },
        })
      )
    ).toBe(false);
    expect(
      isWhatsAppUnavailableInboundSourcePayload(
        raw({
          payload: {
            direction: "inbound",
            messages: [{ type: "unsupported", errors: [{ code: 131051 }] }],
          },
        })
      )
    ).toBe(false);
  });
});

describe("resolveInstagramMessageContent", () => {
  it("suppresses deleted Instagram messages from automation", () => {
    const content = resolveInstagramMessageContent({
      mid: "m-deleted",
      is_deleted: true,
    });

    expect(content).toEqual({
      text: "Instagram message deleted",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      shouldQueueAiri: false,
      providerEventKind: "instagram_deleted",
    });
  });

  it("suppresses unsupported Instagram media from automation", () => {
    const content = resolveInstagramMessageContent({
      mid: "m-unsupported",
      is_unsupported: true,
    });

    expect(content).toEqual({
      text: "Unsupported Instagram message",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      shouldQueueAiri: false,
      providerEventKind: "instagram_unsupported",
    });
  });

  it("classifies story mentions as image events and suppresses generic replies", () => {
    const content = resolveInstagramMessageContent({
      attachments: [
        {
          type: "story_mention",
          payload: {
            url: "https://lookaside.example/story.jpg",
          },
        },
      ],
    });

    expect(content).toEqual({
      text: INSTAGRAM_STORY_MENTION_DISPLAY_TEXT,
      imageUrl: "https://lookaside.example/story.jpg",
      mediaType: "image",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      providerEventKind: "instagram_story_mention",
    });
  });

  it("links a shared reel's page instead of playing it as a video", () => {
    const content = resolveInstagramMessageContent({
      attachments: [
        {
          type: "ig_reel",
          payload: {
            reel_video_id: "123",
            title: "Caption",
            url: "https://www.instagram.com/reel/DemLJBtNZjn/",
          },
        },
      ],
    });

    expect(content).toEqual({
      text: "Shared Instagram reel\nhttps://www.instagram.com/reel/DemLJBtNZjn/",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      providerEventKind: "instagram_reel_share",
    });
  });

  it("keeps a reel sent as CDN media as a video", () => {
    const content = resolveInstagramMessageContent({
      attachments: [
        {
          type: "ig_reel",
          payload: {
            url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1",
          },
        },
      ],
    });

    expect(content).toEqual({
      text: "Shared Instagram reel",
      imageUrl: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1",
      mediaType: "video",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      providerEventKind: "instagram_reel_share",
    });
  });

  it("classifies shared Instagram content without forcing an image preview", () => {
    const content = resolveInstagramMessageContent({
      attachments: [
        {
          type: "share",
          payload: {
            url: "https://www.instagram.com/p/example/",
          },
        },
      ],
    });

    expect(content).toEqual({
      text: "Shared Instagram content\nhttps://www.instagram.com/p/example/",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      providerEventKind: "instagram_share",
    });
  });

  it("classifies ephemeral media as non-actionable media", () => {
    const content = resolveInstagramMessageContent({
      attachments: [
        {
          type: "ephemeral",
        },
      ],
    });

    expect(content).toEqual({
      text: "Ephemeral Instagram media",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      shouldQueueAiri: false,
      providerEventKind: "instagram_ephemeral",
    });
  });
});

describe("isProviderLabelText", () => {
  it("recognizes the labels the Instagram ingest stores, with a shared link after them", () => {
    const reel = resolveInstagramMessageContent({
      attachments: [
        {
          type: "ig_reel",
          payload: { url: "https://www.instagram.com/reel/abc/" },
        },
      ],
    });
    expect(isProviderLabelText(INSTAGRAM_STORY_MENTION_DISPLAY_TEXT)).toBe(
      true
    );
    expect(isProviderLabelText(reel.text)).toBe(true);
    expect(isProviderLabelText("Where is my order?")).toBe(false);
    expect(isProviderLabelText(null)).toBe(false);
  });
});

describe("getProviderMessageDisplayOverride", () => {
  it.each(["history", "history_echo"])(
    "renders unavailable content from a singular %s message",
    eventType => {
      expect(
        getProviderMessageDisplayOverride({
          provider: "whatsapp",
          eventType,
          payload: { message: { type: "errors", errors: [{ code: 131051 }] } },
        })
      ).toEqual({ text: WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT });
    }
  );

  it("returns only the Instagram label: the stored row keeps its media copy", () => {
    const rawSourcePayload = buildRawSourcePayload({
      provider: "instagram",
      eventType: "message",
      payload: {
        message: {
          attachments: [
            {
              type: "story_mention",
              payload: {
                url: "https://lookaside.example/story.jpg",
              },
            },
          ],
        },
      },
    });

    expect(getProviderMessageDisplayOverride(rawSourcePayload)).toEqual({
      text: INSTAGRAM_STORY_MENTION_DISPLAY_TEXT,
    });
  });

  it("finds WhatsApp unsupported unknown messages when entry is stored as an object", () => {
    const rawSourcePayload = buildRawSourcePayload({
      provider: "whatsapp",
      eventType: "message",
      payload: {
        object: "whatsapp_business_account",
        entry: {
          id: "940525742304249",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.unknown",
                    type: "unsupported",
                    errors: [{ code: 131051 }],
                    unsupported: { type: "unknown" },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    expect(getProviderMessageDisplayOverride(rawSourcePayload)).toEqual({
      text: WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT,
    });
  });

  it("finds WhatsApp unsupported unknown messages when entry is stored as an array", () => {
    const rawSourcePayload = buildRawSourcePayload({
      provider: "whatsapp",
      eventType: "message",
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "940525742304249",
            changes: [
              {
                field: "messages",
                value: {
                  messages: [
                    {
                      id: "wamid.unknown",
                      type: "unsupported",
                      errors: [{ code: "131051" }],
                      unsupported: { type: "unknown" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(getProviderMessageDisplayOverride(rawSourcePayload)).toEqual({
      text: WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT,
    });
  });
});
