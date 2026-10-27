/**
 * Tests for WhatsApp outbound send - BSUID recipient resolution.
 *
 * We mock the graph client so no HTTP calls are made, and focus on
 * how the recipient resolution layer behaves for BSUID-only targets
 * when the WHATSAPP_BSUID_SEND_ENABLED flag is off (default).
 *
 * IMPORTANT: @/lib/whatsapp snapshots WHATSAPP_BSUID_SEND_ENABLED at
 * module load time (a top-level const), so we use jest.resetModules()
 * + dynamic import() to guarantee the flag is evaluated after we
 * set/clear the env var. This keeps the suite deterministic regardless
 * of the runner's ambient environment.
 */

import {
  buildWhatsAppTemplateSendComponentsFromTemplate,
  normalizeWhatsAppTemplateSendComponents,
} from "@/lib/whatsapp/templates/message-types";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

type MockPostJsonResponse = Record<string, unknown> & {
  messages?: Array<{ id: string; timestamp?: string }>;
  id?: string;
};

type WhatsAppPostBodyForTest = Record<string, unknown> & {
  interactive: Record<string, unknown> & {
    action: Record<string, unknown>;
    type: string;
  };
  template: Record<string, unknown> & {
    components: unknown;
  };
  text: {
    body: string;
    preview_url?: boolean;
  };
};

const mockPostJson = jest.fn(
  async (): Promise<MockPostJsonResponse> => ({
    messages: [{ id: "wamid.test123", timestamp: "1711100000" }],
  })
);

jest.mock("@icecore/shared/lib/meta/api", () => ({
  MetaGraphRequestError: class extends Error {
    status = 500;
  },
  getWhatsAppGraphClient: () => ({
    postJson: mockPostJson,
    request: jest.fn(),
  }),
  parseGraphResponse: jest.fn(),
}));

jest.mock("@/lib/whatsapp-format", () => ({
  htmlToWhatsAppFormat: (text: string) => text,
}));

function getLatestMockPostBody() {
  const calls = mockPostJson.mock.calls as Array<unknown[]>;
  const call = calls.at(-1);
  expect(call).toBeDefined();
  const options = call?.[1] as { body: WhatsAppPostBodyForTest } | undefined;
  expect(options?.body).toBeDefined();
  return options!.body;
}

function getLatestMockPostPath() {
  const calls = mockPostJson.mock.calls as Array<unknown[]>;
  const call = calls.at(-1);
  expect(call).toBeDefined();
  return call?.[0];
}

/** Re-import @/lib/whatsapp after jest.resetModules() so the module
 *  re-reads WHATSAPP_BSUID_SEND_ENABLED from process.env. */
async function importWhatsapp() {
  return import("@/lib/whatsapp");
}

describe("whatsapp outbound send - BSUID gating", () => {
  const prevFlag = process.env.WHATSAPP_BSUID_SEND_ENABLED;

  beforeEach(() => {
    delete process.env.WHATSAPP_BSUID_SEND_ENABLED;
    jest.resetModules();
    mockPostJson.mockClear();
  });

  afterEach(() => {
    if (prevFlag !== undefined) {
      process.env.WHATSAPP_BSUID_SEND_ENABLED = prevFlag;
    } else {
      delete process.env.WHATSAPP_BSUID_SEND_ENABLED;
    }
  });

  it("blocks text message send to a BSUID-only recipient when flag is off", async () => {
    const { sendWhatsappMessage } = await importWhatsapp();
    await expect(
      sendWhatsappMessage(
        "phone-number-id",
        "access-token",
        {
          kind: "bsuid",
          value: "US.1349.xyz",
        },
        "Hello"
      )
    ).rejects.toThrow(/BSUID/);
  });

  it("blocks media send to a BSUID-only recipient when flag is off", async () => {
    const { sendWhatsappMedia } = await importWhatsapp();
    await expect(
      sendWhatsappMedia(
        "phone-number-id",
        "access-token",
        { kind: "bsuid", value: "US.1349.xyz" },
        { type: "image", link: "https://example.com/image.jpg" }
      )
    ).rejects.toThrow(/BSUID/);
  });

  it("blocks contacts send to a BSUID-only recipient when flag is off", async () => {
    const { sendWhatsappContacts } = await importWhatsapp();
    await expect(
      sendWhatsappContacts(
        "phone-number-id",
        "access-token",
        { kind: "bsuid", value: "US.1349.xyz" },
        [{ name: { formatted_name: "Admissions" } }]
      )
    ).rejects.toThrow(/BSUID/);
  });

  it("blocks location send to a BSUID-only recipient when flag is off", async () => {
    const { sendWhatsappLocation } = await importWhatsapp();
    await expect(
      sendWhatsappLocation(
        "phone-number-id",
        "access-token",
        { kind: "bsuid", value: "US.1349.xyz" },
        { latitude: 43.238949, longitude: 76.889709 }
      )
    ).rejects.toThrow(/BSUID/);
  });

  it("blocks template send to a BSUID-only recipient when flag is off", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    await expect(
      sendWhatsappTemplate(
        "phone-number-id",
        "access-token",
        { kind: "bsuid", value: "US.1349.xyz" },
        "hello_template",
        "en"
      )
    ).rejects.toThrow(/BSUID/);
  });

  it("allows text message send to a phone recipient regardless of flag", async () => {
    const { sendWhatsappMessage } = await importWhatsapp();
    await sendWhatsappMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "Hello"
    );

    expect(mockPostJson).toHaveBeenCalledTimes(1);
    const body = getLatestMockPostBody();
    expect(body.to).toBe("77012345678");
  });

  it("sends contacts messages using the Cloud API contacts payload", async () => {
    const { sendWhatsappContacts } = await importWhatsapp();
    await sendWhatsappContacts(
      "phone-number-id",
      "access-token",
      "77012345678",
      [
        {
          name: {
            formatted_name: "Admissions Team",
            first_name: "Admissions",
          },
          phones: [{ phone: "77012345678", type: "WORK" }],
          emails: [{ email: "hello@example.com", type: "WORK" }],
          org: { company: "EduDemo", title: "Admissions" },
          urls: [{ url: "https://example.com", type: "WORK" }],
        },
      ],
      "wamid.reply"
    );

    expect(getLatestMockPostBody()).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "77012345678",
      type: "contacts",
      context: { message_id: "wamid.reply" },
      contacts: [
        {
          name: {
            formatted_name: "Admissions Team",
            first_name: "Admissions",
          },
          phones: [{ phone: "77012345678", type: "WORK" }],
          emails: [{ email: "hello@example.com", type: "WORK" }],
          org: { company: "EduDemo", title: "Admissions" },
          urls: [{ url: "https://example.com", type: "WORK" }],
        },
      ],
    });
  });

  it("sends location messages using the Cloud API location payload", async () => {
    const { sendWhatsappLocation } = await importWhatsapp();
    await sendWhatsappLocation(
      "phone-number-id",
      "access-token",
      "77012345678",
      {
        latitude: 43.238949,
        longitude: 76.889709,
        name: "EduDemo Campus",
        address: "Almaty",
      },
      "wamid.reply"
    );

    expect(getLatestMockPostBody()).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "77012345678",
      type: "location",
      context: { message_id: "wamid.reply" },
      location: {
        latitude: 43.238949,
        longitude: 76.889709,
        name: "EduDemo Campus",
        address: "Almaty",
      },
    });
  });

  it("rejects invalid outbound location coordinates", async () => {
    const { sendWhatsappLocation } = await importWhatsapp();
    await expect(
      sendWhatsappLocation("phone-number-id", "access-token", "77012345678", {
        latitude: 91,
        longitude: 76.889709,
      })
    ).rejects.toThrow(/valid coordinates/);
  });

  it("sends text messages as contextual replies when a target wamid is provided", async () => {
    const { sendWhatsappMessage } = await importWhatsapp();

    await sendWhatsappMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "You're welcome",
      "wamid.reply-target-1"
    );

    expect(getLatestMockPostBody()).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "77012345678",
      type: "text",
      text: { body: "You're welcome" },
      context: { message_id: "wamid.reply-target-1" },
    });
  });

  it("asks WhatsApp to render a native link preview for http links", async () => {
    const { sendWhatsappMessage } = await importWhatsapp();

    await sendWhatsappMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "Read this: https://www.airi.chat/blog"
    );

    expect(getLatestMockPostBody().text).toEqual({
      body: "Read this: https://www.airi.chat/blog",
      preview_url: true,
    });
  });

  it("does not request a native link preview when there is no http link", async () => {
    const { sendWhatsappMessage } = await importWhatsapp();

    await sendWhatsappMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "Email us at support@airi.chat"
    );

    expect(getLatestMockPostBody().text).toEqual({
      body: "Email us at support@airi.chat",
    });
  });

  it("rejects authentication template sends to BSUID even with requirePhoneRecipient", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    await expect(
      sendWhatsappTemplate(
        "phone-number-id",
        "access-token",
        { kind: "bsuid", value: "US.1349" },
        "auth_template",
        "en",
        undefined,
        { requirePhoneRecipient: true }
      )
    ).rejects.toThrow(/requires a phone number/);
  });

  it("preserves the structured Meta error thrown by template sends", async () => {
    const { MetaGraphRequestError } = await import(
      "@icecore/shared/lib/meta/api"
    );
    const metaError = new MetaGraphRequestError({
      message: "Business eligibility payment issue",
      status: 400,
      statusText: "Bad Request",
      url: "https://graph.facebook.com/messages",
      details: {
        error: {
          message: "Business eligibility payment issue",
          type: "OAuthException",
          code: 131042,
        },
      },
      metaError: {
        message: "Business eligibility payment issue",
        type: "OAuthException",
        code: 131042,
      },
    });
    Object.assign(metaError, {
      details: {
        error: {
          message: "Business eligibility payment issue",
          type: "OAuthException",
          code: 131042,
        },
      },
    });
    mockPostJson.mockRejectedValueOnce(metaError);

    const { sendWhatsappTemplate } = await importWhatsapp();

    await expect(
      sendWhatsappTemplate(
        "phone-number-id",
        "access-token",
        "77012345678",
        "promo",
        "en"
      )
    ).rejects.toBe(metaError);
  });

  it("redacts public-demo recipients, parameters and provider echoes from logs", async () => {
    const { MetaGraphRequestError } = await import(
      "@icecore/shared/lib/meta/api"
    );
    const metaError = new MetaGraphRequestError({
      message: "Rejected private customer",
      status: 400,
      statusText: "Bad Request",
      url: "https://graph.facebook.com/messages",
      details: {},
    });
    Object.assign(metaError, {
      details: {
        error: {
          code: 131026,
          message: "Rejected private customer",
          error_data: { details: "77012345678 private@company.com" },
          error_user_title: "Private Customer",
          error_user_msg: "private@company.com",
        },
      },
    });
    mockPostJson.mockRejectedValueOnce(metaError);
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sendWhatsappTemplate } = await importWhatsapp();
      await expect(
        sendWhatsappTemplate(
          "phone-number-id",
          "private-token",
          "77012345678",
          "demo",
          "en",
          [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Private Customer private@company.com" },
              ],
            },
          ],
          { requirePhoneRecipient: true, redactTemplatePayloadInLogs: true }
        )
      ).rejects.toBe(metaError);
      const diagnostics = JSON.stringify(errorLog.mock.calls);
      for (const value of [
        "77012345678",
        "private@company.com",
        "Private Customer",
        "private-token",
      ])
        expect(diagnostics).not.toContain(value);
      expect(errorLog).toHaveBeenCalledWith(
        "[WhatsApp] template_send_failed",
        expect.objectContaining({ templateName: "demo", code: 131026 })
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("sendWhatsappMedia Cloud API payloads", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  it.each([
    [
      "image",
      { type: "image", id: "media_image", caption: "caption" },
      { id: "media_image", caption: "caption" },
    ],
    [
      "video",
      { type: "video", id: "media_video", caption: "caption" },
      { id: "media_video", caption: "caption" },
    ],
    ["audio", { type: "audio", id: "media_audio" }, { id: "media_audio" }],
    [
      "document",
      {
        type: "document",
        id: "media_document",
        caption: "caption",
        fileName: "document.pdf",
      },
      {
        id: "media_document",
        caption: "caption",
        filename: "document.pdf",
      },
    ],
    [
      "sticker",
      { type: "sticker", id: "media_sticker" },
      { id: "media_sticker" },
    ],
  ] as const)(
    "sends %s media by uploaded Meta media id",
    async (mediaType, media, expectedObject) => {
      const { sendWhatsappMedia } = await importWhatsapp();

      await sendWhatsappMedia(
        "phone-number-id",
        "access-token",
        { kind: "phone", value: "77012345678" },
        media
      );

      const body = getLatestMockPostBody();
      expect(body).toMatchObject({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "77012345678",
        type: mediaType,
        [mediaType]: expectedObject,
      });
    }
  );

  it("does not add captions or filenames to sticker payloads", async () => {
    const { sendWhatsappMedia } = await importWhatsapp();

    await sendWhatsappMedia(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        type: "sticker",
        id: "media_sticker",
        caption: "ignored",
        fileName: "ignored.webp",
      }
    );

    const body = getLatestMockPostBody();
    expect(body.sticker).toEqual({ id: "media_sticker" });
  });

  it("sets audio.voice for WhatsApp voice notes", async () => {
    const { sendWhatsappMedia } = await importWhatsapp();

    await sendWhatsappMedia(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        type: "audio",
        link: "https://cdn.example/note.ogg",
        voice: true,
      }
    );

    const body = getLatestMockPostBody();
    expect(body).toMatchObject({
      type: "audio",
      audio: {
        link: "https://cdn.example/note.ogg",
        voice: true,
      },
    });
  });

  it("sends media messages as contextual replies when a target wamid is provided", async () => {
    const { sendWhatsappMedia } = await importWhatsapp();

    await sendWhatsappMedia(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        type: "document",
        id: "media_document",
        fileName: "invoice.pdf",
      },
      "wamid.reply-target-2"
    );

    expect(getLatestMockPostBody()).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "77012345678",
      type: "document",
      document: { id: "media_document", filename: "invoice.pdf" },
      context: { message_id: "wamid.reply-target-2" },
    });
  });
});

describe("sendWhatsapp interactive media headers", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  it("adds document headers to reply button messages", async () => {
    const { sendWhatsappInteractiveReplyButtons } = await importWhatsapp();

    await sendWhatsappInteractiveReplyButtons(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "Pick one",
      [{ id: "catalog", title: "Catalog" }],
      {
        type: "document",
        link: "https://cdn.example.com/catalog.pdf",
        fileName: "catalog.pdf",
      }
    );

    expect(getLatestMockPostBody()).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "77012345678",
      type: "interactive",
      interactive: {
        type: "button",
        header: {
          type: "document",
          document: {
            link: "https://cdn.example.com/catalog.pdf",
            filename: "catalog.pdf",
          },
        },
      },
    });
  });

  it("adds video headers to interactive list messages", async () => {
    const { sendWhatsappInteractiveList } = await importWhatsapp();

    await sendWhatsappInteractiveList(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "Pick one",
      "View",
      [{ id: "tour", title: "Tour" }],
      {
        type: "video",
        link: "https://cdn.example.com/tour.mp4",
      }
    );

    expect(getLatestMockPostBody()).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "77012345678",
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "video",
          video: {
            link: "https://cdn.example.com/tour.mp4",
          },
        },
      },
    });
  });
});

describe("sendWhatsapp service message payloads", () => {
  it("preserves structured Meta rejection evidence for interactive service delivery", async () => {
    jest.resetModules();
    mockPostJson.mockClear();
    const { MetaGraphRequestError } = await import(
      "@icecore/shared/lib/meta/api"
    );
    const rejection = new MetaGraphRequestError({
      message: "Something went wrong",
      status: 500,
      statusText: "Server Error",
      url: "https://graph.facebook.com/v25.0/phone/messages",
      details: { error: { code: 131000 } },
    });
    mockPostJson.mockRejectedValueOnce(rejection);
    const { sendWhatsappInteractiveReplyButtonsMessage } =
      await importWhatsapp();
    await expect(
      sendWhatsappInteractiveReplyButtonsMessage(
        "phone-number-id",
        "access-token",
        "15551234567",
        { bodyText: "Choose", buttons: [{ id: "yes", title: "Yes" }] }
      )
    ).rejects.toBe(rejection);
  });
  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  it("sends reply buttons with one text header and footer", async () => {
    const { sendWhatsappInteractiveReplyButtonsMessage } =
      await importWhatsapp();

    await sendWhatsappInteractiveReplyButtonsMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Choose one",
        header: { type: "text", text: "Available actions" },
        footerText: "Airi",
        buttons: [
          { id: "first", title: "First" },
          { id: "second", title: "Second" },
        ],
      }
    );

    expect(getLatestMockPostBody().interactive).toEqual({
      type: "button",
      header: { type: "text", text: "Available actions" },
      body: { text: "Choose one" },
      footer: { text: "Airi" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "first", title: "First" } },
          { type: "reply", reply: { id: "second", title: "Second" } },
        ],
      },
    });
  });

  it("sends list sections with a text header and footer", async () => {
    const { sendWhatsappInteractiveListMessage } = await importWhatsapp();

    await sendWhatsappInteractiveListMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Choose a product",
        headerText: "Catalog",
        footerText: "Prices include tax",
        buttonText: "Products",
        sections: [
          {
            title: "Popular",
            rows: [
              {
                id: "basic",
                title: "Basic",
                description: "For small teams",
              },
            ],
          },
          {
            title: "Advanced",
            rows: [{ id: "pro", title: "Pro" }],
          },
        ],
      }
    );

    expect(getLatestMockPostBody().interactive).toEqual({
      type: "list",
      header: { type: "text", text: "Catalog" },
      body: { text: "Choose a product" },
      footer: { text: "Prices include tax" },
      action: {
        button: "Products",
        sections: [
          {
            title: "Popular",
            rows: [
              {
                id: "basic",
                title: "Basic",
                description: "For small teams",
              },
            ],
          },
          {
            title: "Advanced",
            rows: [{ id: "pro", title: "Pro" }],
          },
        ],
      },
    });
  });

  it("sends a URL CTA with a media header and footer", async () => {
    const { sendWhatsappInteractiveCtaUrlMessage } = await importWhatsapp();

    await sendWhatsappInteractiveCtaUrlMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Open the guide",
        buttonUrl: "https://example.com/guide",
        buttonLabel: "Open",
        header: {
          type: "image",
          link: "https://cdn.example.com/guide.png",
        },
        footerText: "Airi",
      }
    );

    expect(getLatestMockPostBody().interactive).toEqual({
      type: "cta_url",
      header: {
        type: "image",
        image: { link: "https://cdn.example.com/guide.png" },
      },
      body: { text: "Open the guide" },
      footer: { text: "Airi" },
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Open",
          url: "https://example.com/guide",
        },
      },
    });
  });

  it("sends one media carousel request with quick replies", async () => {
    const { sendWhatsappInteractiveMediaCarousel } = await importWhatsapp();

    await sendWhatsappInteractiveMediaCarousel(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Compare these",
        cards: [
          {
            media: {
              type: "image",
              link: "https://cdn.example.com/one.png",
            },
            bodyText: "First",
            interaction: {
              kind: "quick_replies",
              buttons: [{ id: "one", title: "Choose" }],
            },
          },
          {
            media: {
              type: "video",
              link: "https://cdn.example.com/two.mp4",
            },
            bodyText: "Second",
            interaction: {
              kind: "quick_replies",
              buttons: [{ id: "two", title: "Choose" }],
            },
          },
        ],
      }
    );

    expect(getLatestMockPostBody().interactive).toEqual({
      type: "carousel",
      body: { text: "Compare these" },
      action: {
        cards: [
          {
            card_index: 0,
            type: "cta_url",
            header: {
              type: "image",
              image: { link: "https://cdn.example.com/one.png" },
            },
            body: { text: "First" },
            action: {
              buttons: [
                {
                  type: "quick_reply",
                  quick_reply: { id: "one", title: "Choose" },
                },
              ],
            },
          },
          {
            card_index: 1,
            type: "cta_url",
            header: {
              type: "video",
              video: { link: "https://cdn.example.com/two.mp4" },
            },
            body: { text: "Second" },
            action: {
              buttons: [
                {
                  type: "quick_reply",
                  quick_reply: { id: "two", title: "Choose" },
                },
              ],
            },
          },
        ],
      },
    });
    expect(mockPostJson).toHaveBeenCalledTimes(1);
  });

  it("defensively clips over-limit carousel card copy for direct callers", async () => {
    const { sendWhatsappInteractiveMediaCarousel } = await importWhatsapp();

    await sendWhatsappInteractiveMediaCarousel(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Compare these",
        cards: [
          {
            media: {
              type: "image",
              link: "https://cdn.example.com/one.png",
            },
            bodyText: "x".repeat(161),
            interaction: {
              kind: "quick_replies",
              buttons: [{ id: "one", title: "Choose" }],
            },
          },
          {
            media: {
              type: "image",
              link: "https://cdn.example.com/two.png",
            },
            bodyText: "Second",
            interaction: {
              kind: "quick_replies",
              buttons: [{ id: "two", title: "Choose" }],
            },
          },
        ],
      }
    );

    expect(mockPostJson).toHaveBeenCalledWith(
      "phone-number-id/messages",
      expect.objectContaining({
        body: expect.objectContaining({
          interactive: expect.objectContaining({
            action: expect.objectContaining({
              cards: expect.arrayContaining([
                expect.objectContaining({
                  body: { text: "x".repeat(160) },
                }),
              ]),
            }),
          }),
        }),
      })
    );
  });

  it("sends a native location request", async () => {
    const { sendWhatsappLocationRequest } = await importWhatsapp();

    await sendWhatsappLocationRequest(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "Share your pickup location"
    );

    expect(getLatestMockPostBody().interactive).toEqual({
      type: "location_request_message",
      body: { text: "Share your pickup location" },
      action: { name: "send_location" },
    });
  });

  it("sends a voice-call button with its documented parameters", async () => {
    const { sendWhatsappVoiceCall } = await importWhatsapp();

    await sendWhatsappVoiceCall(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Call us now",
        buttonLabel: "Call on WhatsApp",
        ttlMinutes: 100,
        payload: "scenario:action-1",
      }
    );

    expect(getLatestMockPostBody().interactive).toEqual({
      type: "voice_call",
      body: { text: "Call us now" },
      action: {
        name: "voice_call",
        parameters: {
          display_text: "Call on WhatsApp",
          ttl_minutes: 100,
          payload: "scenario:action-1",
        },
      },
    });
  });
});

describe("sendWhatsappTypingIndicator", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  it("marks the inbound message as read and requests a text typing indicator", async () => {
    const { sendWhatsappTypingIndicator } = await importWhatsapp();

    await sendWhatsappTypingIndicator(
      "phone-number-id",
      "access-token",
      "ws_wamid.inbound-1"
    );

    expect(mockPostJson).toHaveBeenCalledWith("phone-number-id/messages", {
      token: "access-token",
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.inbound-1",
        typing_indicator: { type: "text" },
      },
    });
  });
});

describe("normalizeWhatsappRecipient", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("preserves international phone digits", async () => {
    const { normalizeWhatsappRecipient } = await importWhatsapp();
    expect(normalizeWhatsappRecipient("+1 555 123 4567")).toBe("15551234567");
  });

  it("returns empty string for non-phone BSUID input", async () => {
    const { normalizeWhatsappRecipient } = await importWhatsapp();
    // BSUIDs contain letters, normalizeWhatsAppPhone returns undefined -> empty
    expect(normalizeWhatsappRecipient("US.1349.xyz")).toBe("");
  });
});

describe("WhatsApp send preparation and reservation boundary", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  async function send(
    kind: "template" | "text",
    recipient: string | { kind: "phone"; value: string },
    beforeSend?: () => Promise<void>
  ) {
    const { sendWhatsappMessage, sendWhatsappTemplate } =
      await importWhatsapp();
    return kind === "template"
      ? sendWhatsappTemplate(
          "phone-number-id",
          "access-token",
          recipient,
          "hello_template",
          "en",
          undefined,
          { beforeSend }
        )
      : sendWhatsappMessage(
          "phone-number-id",
          "access-token",
          recipient,
          "Hello",
          undefined,
          { beforeSend }
        );
  }

  describe.each(["template", "text"] as const)("%s sends", kind => {
    it.each([
      "+7 706 704 0359",
      "77067040359",
      "87067040359",
      { kind: "phone" as const, value: "77067040359" },
    ])(
      "preserves canonical Kazakhstan recipient digits for %j",
      async recipient => {
        await send(kind, recipient);

        expect(getLatestMockPostBody().to).toBe("77067040359");
        expect(getLatestMockPostBody()).not.toHaveProperty("recipient");
      }
    );

    it("awaits one reservation after preparation without serializing the hook", async () => {
      let reserved = false;
      const beforeSend = jest.fn(async () => {
        await Promise.resolve();
        reserved = true;
      });
      mockPostJson.mockImplementationOnce(async () => {
        expect(reserved).toBe(true);
        return { messages: [{ id: "wamid.reserved" }] };
      });

      await expect(
        send(kind, "15551234567", beforeSend)
      ).resolves.toMatchObject({ messageId: "wamid.reserved" });

      expect(beforeSend).toHaveBeenCalledTimes(1);
      expect(mockPostJson).toHaveBeenCalledTimes(1);
      expect(getLatestMockPostBody()).not.toHaveProperty("beforeSend");
    });

    it("preserves reservation rejection identity and does not send", async () => {
      const blocked = new Error("contact_frequency_limit");
      const beforeSend = jest.fn(async () => {
        throw blocked;
      });

      await expect(send(kind, "15551234567", beforeSend)).rejects.toBe(blocked);

      expect(beforeSend).toHaveBeenCalledTimes(1);
      expect(mockPostJson).not.toHaveBeenCalled();
    });

    it("rejects an invalid recipient before reserving a contact", async () => {
      const beforeSend = jest.fn(async () => {});

      await expect(send(kind, "", beforeSend)).rejects.toThrow(/recipient/);

      expect(beforeSend).not.toHaveBeenCalled();
      expect(mockPostJson).not.toHaveBeenCalled();
    });

    it.each(["network error", "missing message id"])(
      "does not reserve or send twice after %s",
      async failure => {
        const beforeSend = jest.fn(async () => {});
        if (failure === "network error") {
          mockPostJson.mockRejectedValueOnce(new Error("Connection lost"));
        } else {
          mockPostJson.mockResolvedValueOnce({ messages: [] });
        }

        await expect(send(kind, "15551234567", beforeSend)).rejects.toThrow();

        expect(beforeSend).toHaveBeenCalledTimes(1);
        expect(mockPostJson).toHaveBeenCalledTimes(1);
      }
    );
  });

  it("rejects invalid template pricing before reserving a contact", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    const beforeSend = jest.fn(async () => {});

    await expect(
      sendWhatsappTemplate(
        "phone-number-id",
        "access-token",
        "15551234567",
        "hello_template",
        "en",
        undefined,
        { perMessageBidMultiplier: 1.5, beforeSend }
      )
    ).rejects.toThrow(/only supported/);

    expect(beforeSend).not.toHaveBeenCalled();
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("preserves structured Meta errors from service text sends for provider classification", async () => {
    const { MetaGraphRequestError } = await import(
      "@icecore/shared/lib/meta/api"
    );
    const providerError = Object.assign(
      new MetaGraphRequestError({
        message: "Payment required",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/phone-number-id/messages",
        details: { error: { code: 131042 } },
      }),
      { metaError: { code: 131042 } }
    );
    mockPostJson.mockRejectedValueOnce(providerError);
    const beforeSend = jest.fn(async () => {});

    await expect(send("text", "15551234567", beforeSend)).rejects.toBe(
      providerError
    );

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(mockPostJson).toHaveBeenCalledTimes(1);
  });
});

describe("sendWhatsappRequestContactInfo", () => {
  const prevFlag = process.env.WHATSAPP_BSUID_SEND_ENABLED;

  beforeEach(() => {
    delete process.env.WHATSAPP_BSUID_SEND_ENABLED;
    jest.resetModules();
    mockPostJson.mockClear();
  });

  afterEach(() => {
    if (prevFlag !== undefined) {
      process.env.WHATSAPP_BSUID_SEND_ENABLED = prevFlag;
    } else {
      delete process.env.WHATSAPP_BSUID_SEND_ENABLED;
    }
  });

  it("blocks REQUEST_CONTACT_INFO send to BSUID when flag is off", async () => {
    const { sendWhatsappRequestContactInfo } = await importWhatsapp();
    await expect(
      sendWhatsappRequestContactInfo("phone-number-id", "access-token", {
        kind: "bsuid",
        value: "US.1349.xyz",
      })
    ).rejects.toThrow(/BSUID/);
  });

  it("sends REQUEST_CONTACT_INFO to the documented BSUID recipient field", async () => {
    process.env.WHATSAPP_BSUID_SEND_ENABLED = "true";
    jest.resetModules();
    const { sendWhatsappRequestContactInfo } = await importWhatsapp();
    await sendWhatsappRequestContactInfo(
      "phone-number-id",
      "access-token",
      { kind: "bsuid", value: "US.1349.xyz" },
      "Share your phone number"
    );

    expect(mockPostJson).toHaveBeenCalledTimes(1);
    const body = getLatestMockPostBody();
    expect(body.to).toBeUndefined();
    expect(body.recipient).toBe("US.1349.xyz");
    expect(body.type).toBe("interactive");
    expect(body.interactive).toEqual({
      type: "request_contact_info",
      body: { text: "Share your phone number" },
      action: { name: "request_contact_info" },
    });
  });

  it("sends service text to a BSUID through the recipient field", async () => {
    process.env.WHATSAPP_BSUID_SEND_ENABLED = "true";
    jest.resetModules();
    const { sendWhatsappMessage } = await importWhatsapp();

    await sendWhatsappMessage(
      "phone-number-id",
      "access-token",
      { kind: "bsuid", value: "US.1349.xyz" },
      "Hello"
    );

    const body = getLatestMockPostBody();
    expect(body.to).toBeUndefined();
    expect(body.recipient).toBe("US.1349.xyz");
  });

  it("sends service media to a BSUID through the recipient field", async () => {
    process.env.WHATSAPP_BSUID_SEND_ENABLED = "true";
    jest.resetModules();
    const { sendWhatsappMedia } = await importWhatsapp();

    await sendWhatsappMedia(
      "phone-number-id",
      "access-token",
      { kind: "bsuid", value: "US.1349.xyz" },
      { type: "image", link: "https://cdn.example/image.png" }
    );

    const body = getLatestMockPostBody();
    expect(body.to).toBeUndefined();
    expect(body.recipient).toBe("US.1349.xyz");
  });
});

describe("sendWhatsapp catalog commerce messages", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  it("sends a catalog message with an optional thumbnail product", async () => {
    const { sendWhatsappCatalogMessage } = await importWhatsapp();

    await sendWhatsappCatalogMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Browse our catalog",
        footerText: "Ice Core",
        thumbnailProductRetailerId: "sku-1",
      }
    );

    const body = getLatestMockPostBody();
    expect(body.type).toBe("interactive");
    expect(body.interactive).toEqual({
      type: "catalog_message",
      body: { text: "Browse our catalog" },
      footer: { text: "Ice Core" },
      action: {
        name: "catalog_message",
        parameters: {
          thumbnail_product_retailer_id: "sku-1",
        },
      },
    });
  });

  it("sends single-product and multi-product interactive payloads", async () => {
    const {
      sendWhatsappSingleProductMessage,
      sendWhatsappMultiProductMessage,
    } = await importWhatsapp();

    await sendWhatsappSingleProductMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        catalogId: "catalog-1",
        productRetailerId: "sku-1",
        bodyText: "This is the item",
      }
    );

    let body = getLatestMockPostBody();
    expect(body.interactive.type).toBe("product");
    expect(body.interactive.action).toEqual({
      catalog_id: "catalog-1",
      product_retailer_id: "sku-1",
    });

    await sendWhatsappMultiProductMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        catalogId: "catalog-1",
        headerText: "Recommended",
        bodyText: "Pick products",
        sections: [
          {
            title: "Main",
            productRetailerIds: ["sku-1", "sku-2"],
          },
        ],
      }
    );

    body = getLatestMockPostBody();
    expect(body.interactive.type).toBe("product_list");
    expect(body.interactive.action.sections).toEqual([
      {
        title: "Main",
        product_items: [
          { product_retailer_id: "sku-1" },
          { product_retailer_id: "sku-2" },
        ],
      },
    ]);
  });

  it("sends product carousel messages with catalog product cards", async () => {
    const { sendWhatsappProductCarouselMessage } = await importWhatsapp();

    await sendWhatsappProductCarouselMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Compare options",
        catalogId: "catalog-1",
        productRetailerIds: ["sku-1", "sku-2"],
      }
    );

    const body = getLatestMockPostBody();
    expect(body.interactive.type).toBe("product_carousel");
    expect(body.interactive.action.cards).toEqual([
      {
        card_index: 0,
        type: "product",
        product_retailer_id: "sku-1",
        catalog_id: "catalog-1",
      },
      {
        card_index: 1,
        type: "product",
        product_retailer_id: "sku-2",
        catalog_id: "catalog-1",
      },
    ]);
  });

  it("sends a wa.me catalog link as a text message", async () => {
    const { sendWhatsappCatalogLinkMessage } = await importWhatsapp();

    await sendWhatsappCatalogLinkMessage(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        businessPhoneNumber: "77011112233",
        bodyText: "Open our catalog:",
      }
    );

    const body = getLatestMockPostBody();
    expect(body.type).toBe("text");
    expect(body.text.body).toContain("https://wa.me/c/77011112233");
  });
});

describe("sendWhatsappTemplate payload normalization", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  it("sends template messages through Cloud API by default", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    const result = await sendWhatsappTemplate(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "hello_template",
      "en"
    );

    expect(getLatestMockPostPath()).toBe("phone-number-id/messages");
    expect(result.deliveryProduct).toBe("cloud_api");
  });

  it("sends marketing template messages through the Marketing Messages endpoint when requested", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    const sendOptions = {
      deliveryProduct: "marketing_messages",
      bizOpaqueCallbackData: "campaign:abc",
    } satisfies NonNullable<Parameters<typeof sendWhatsappTemplate>[6]>;
    const result = await sendWhatsappTemplate(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "promo_template",
      "en",
      [
        {
          type: "body",
          parameters: [{ type: "text", text: "Airi" }],
        },
      ],
      sendOptions
    );

    const body = getLatestMockPostBody();
    expect(getLatestMockPostPath()).toBe("phone-number-id/marketing_messages");
    expect(result.deliveryProduct).toBe("marketing_messages");
    expect(body.biz_opaque_callback_data).toBe("campaign:abc");
    expect(body.product_policy).toBeUndefined();
  });

  it("includes per_message_bid_multiplier only on Marketing Messages sends", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    await sendWhatsappTemplate(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "promo_template",
      "en",
      undefined,
      {
        deliveryProduct: "marketing_messages",
        perMessageBidMultiplier: 1.5,
      }
    );

    const body = getLatestMockPostBody();
    expect(getLatestMockPostPath()).toBe("phone-number-id/marketing_messages");
    expect(body.per_message_bid_multiplier).toBe(1.5);
    expect(body).not.toHaveProperty("bid_spec");
    expect(body).not.toHaveProperty("optimization_spec");
  });

  it("rejects per-message bid multipliers on Cloud API template sends", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();

    await expect(
      sendWhatsappTemplate(
        "phone-number-id",
        "access-token",
        { kind: "phone", value: "77012345678" },
        "hello_template",
        "en",
        undefined,
        {
          perMessageBidMultiplier: 1.5,
        }
      )
    ).rejects.toThrow(/only supported/);

    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("includes messaging_account_id only when a send context provides one", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    await sendWhatsappTemplate(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "hello_template",
      "en",
      undefined,
      {
        messagingAccountId: "messaging-1",
      }
    );

    expect(getLatestMockPostBody().messaging_account_id).toBe("messaging-1");

    mockPostJson.mockClear();
    await sendWhatsappTemplate(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "hello_template",
      "en"
    );

    expect(getLatestMockPostBody()).not.toHaveProperty("messaging_account_id");
    expect(getLatestMockPostBody()).not.toHaveProperty(
      "paid_messaging_account_id"
    );
  });

  it("rejects accepted-looking responses without a Meta message id", async () => {
    mockPostJson.mockResolvedValueOnce({ messages: [] });

    const { sendWhatsappTemplate } = await importWhatsapp();
    await expect(
      sendWhatsappTemplate(
        "phone-number-id",
        "access-token",
        { kind: "phone", value: "77012345678" },
        "hello_template",
        "en"
      )
    ).rejects.toThrow(/messages\[0\]\.id/);
  });

  it("normalizes button index to the string format Meta expects", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    await sendWhatsappTemplate(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "flow_template",
      "kk",
      [
        {
          type: "button",
          sub_type: "flow",
          index: 0,
          parameters: [
            {
              type: "action",
              action: {
                flow_token: "flow_1234567890_abcd1234",
              },
            },
          ],
        },
      ]
    );

    const body = getLatestMockPostBody();
    expect(body.template.components).toEqual([
      {
        type: "button",
        sub_type: "flow",
        index: "0",
        parameters: [
          {
            type: "action",
            action: {
              flow_token: "flow_1234567890_abcd1234",
            },
          },
        ],
      },
    ]);
  });

  it("replaces empty text parameters before sending to Meta", async () => {
    const { sendWhatsappTemplate } = await importWhatsapp();
    await sendWhatsappTemplate(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "header_template",
      "kk",
      [
        {
          type: "header",
          parameters: [
            {
              type: "text",
              text: "",
            },
          ],
        },
      ]
    );

    const body = getLatestMockPostBody();
    expect(body.template.components).toEqual([
      {
        type: "header",
        parameters: [
          {
            type: "text",
            text: "-",
          },
        ],
      },
    ]);
  });
});

describe("WhatsApp template send component builder", () => {
  it("builds non-empty header text parameters from template variables", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "HEADER",
        format: "TEXT",
        text: "Hello {{first_name}}",
      },
    ];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      values: {},
    });

    expect(result).toEqual({
      components: [
        {
          type: "header",
          parameters: [
            {
              type: "text",
              parameter_name: "first_name",
              text: "-",
            },
          ],
        },
      ],
      issues: [],
    });
  });

  it("includes parameter_name for named template body variables", () => {
    const templateComponents = [
      {
        type: "BODY",
        text: "Hello {{name}}",
        example: {
          body_text_named_params: [
            {
              param_name: "name",
              example: "Aisulu",
            },
          ],
        },
      },
    ] as unknown as WhatsAppComponent[];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      values: {
        name: "Customer",
      },
    });

    expect(result).toEqual({
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              parameter_name: "name",
              text: "Customer",
            },
          ],
        },
      ],
      issues: [],
    });
  });

  it("builds media header parameters from HTTP header examples", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "HEADER",
        format: "IMAGE",
        example: {
          header_handle: ["https://example.com/medal.png"],
        },
      },
    ];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
    });

    expect(result).toEqual({
      components: [
        {
          type: "header",
          parameters: [
            {
              type: "image",
              image: {
                link: "https://example.com/medal.png",
              },
            },
          ],
        },
      ],
      issues: [],
    });
  });

  it("builds carousel send components from marketing carousel templates", () => {
    const templateComponents: WhatsAppComponent[] = [
      { type: "BODY", text: "Pick a style, {{1}}" },
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
              { type: "BODY", text: "Card {{1}}" },
              {
                type: "BUTTONS",
                buttons: [
                  {
                    type: "URL",
                    text: "Open",
                    url: "https://example.com/{{1}}",
                  },
                ],
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
              { type: "BODY", text: "Second" },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Later" }],
              },
            ],
          },
        ],
      },
    ];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      values: { "1": "Samat" },
    });

    expect(result).toEqual({
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "Samat" }],
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
                      image: { link: "https://cdn.example.com/one.png" },
                    },
                  ],
                },
                {
                  type: "body",
                  parameters: [{ type: "text", text: "Samat" }],
                },
                {
                  type: "button",
                  sub_type: "url",
                  index: "0",
                  parameters: [{ type: "text", text: "Samat" }],
                },
              ],
            },
            {
              card_index: 1,
              components: [
                {
                  type: "header",
                  parameters: [
                    {
                      type: "image",
                      image: { link: "https://cdn.example.com/two.png" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      issues: [],
    });
  });

  it("infers copy-code authentication button parameters from OTP template components", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "{{1}} is your verification code.",
      },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "OTP",
            otp_type: "COPY_CODE",
            text: "Copy code",
          },
        ],
      },
    ];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      values: { "1": "123456" },
    });

    expect(result).toEqual({
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "123456" }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "123456" }],
        },
      ],
      issues: [],
    });
  });

  it("reports media headers that need an explicit send parameter", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "HEADER",
        format: "IMAGE",
        example: {
          header_handle: ["4::meta-media-handle"],
        },
      },
    ];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
    });

    expect(result).toEqual({
      components: undefined,
      issues: [
        {
          type: "missing_header_media",
          format: "IMAGE",
        },
      ],
    });
  });

  it("builds carousel header media from HTTP handles and reports opaque handles", () => {
    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents: [
        { type: "BODY", text: "Pick a card" },
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
                { type: "BODY", text: "One" },
              ],
            },
            {
              components: [
                {
                  type: "HEADER",
                  format: "IMAGE",
                  example: { header_handle: ["4::meta-card-two"] },
                },
                { type: "BODY", text: "Two" },
              ],
            },
          ],
        },
      ],
    });

    expect(result.issues).toEqual([
      { type: "missing_header_media", format: "IMAGE" },
    ]);
    expect(result.components).toEqual([
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
                    image: { link: "https://cdn.example.com/one.png" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("normalizes empty text and payload parameters", () => {
    expect(
      normalizeWhatsAppTemplateSendComponents([
        {
          type: "button",
          sub_type: "quick_reply",
          index: 1,
          parameters: [
            {
              type: "payload",
              payload: "   ",
            },
          ],
        },
      ])
    ).toEqual([
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        parameters: [
          {
            type: "payload",
            payload: "-",
          },
        ],
      },
    ]);
  });

  it("builds quick-reply button payloads when a payload factory is provided", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Kazakh" },
          { type: "URL", text: "Website", url: "https://example.com" },
        ],
      },
    ];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      createQuickReplyPayload: ({ index }) => `payload-${index}`,
    });

    expect(result).toEqual({
      components: [
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [
            {
              type: "payload",
              payload: "payload-0",
            },
          ],
        },
      ],
      issues: [],
    });
  });

  it("lets callers override variable resolution while keeping normalization", () => {
    const templateComponents: WhatsAppComponent[] = [
      {
        type: "BODY",
        text: "Hello {{1}}",
      },
    ];

    const result = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      resolveVariableValue: ({ variable }) =>
        variable === "1" ? "Custom value" : null,
    });

    expect(result).toEqual({
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: "Custom value",
            },
          ],
        },
      ],
      issues: [],
    });
  });
});

describe("WhatsApp media upload helper", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    mockPostJson.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uploads dropped WebP files with the sticker MIME inferred from filename", async () => {
    mockPostJson.mockResolvedValueOnce({ id: "media_sticker" });

    const { uploadWhatsAppMediaFile } = await import(
      "@/lib/whatsapp/media-upload"
    );
    const result = await uploadWhatsAppMediaFile({
      phoneNumberId: "112166395136463",
      accessToken: "access-token",
      file: new File([new Uint8Array([1, 2, 3])], "sticker.webp", {
        type: "",
      }),
      fallbackMimeType: "application/octet-stream",
    });

    expect(result).toEqual({
      id: "media_sticker",
      mimeType: "image/webp",
      sizeBytes: 3,
    });
    const body = getLatestMockPostBody() as unknown as FormData;
    expect(body.get("messaging_product")).toBe("whatsapp");
    expect(body.get("type")).toBe("image/webp");
  });

  it("uploads PDF documents with Meta's document MIME type", async () => {
    mockPostJson.mockResolvedValueOnce({ id: "media_pdf" });

    const { uploadWhatsAppMediaFile } = await import(
      "@/lib/whatsapp/media-upload"
    );
    const result = await uploadWhatsAppMediaFile({
      phoneNumberId: "112166395136463",
      accessToken: "access-token",
      file: new File([new Uint8Array([1, 2, 3])], "contract.pdf", {
        type: "application/pdf",
      }),
    });

    expect(result).toEqual({
      id: "media_pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    });
    const body = getLatestMockPostBody() as unknown as FormData;
    expect(body.get("messaging_product")).toBe("whatsapp");
    expect(body.get("type")).toBe("application/pdf");
  });

  it("uploads voicemail announcements with Meta's Calling use case", async () => {
    mockPostJson.mockResolvedValueOnce({ id: "media_voicemail" });

    const { uploadWhatsAppVoicemailAnnouncementFile } = await import(
      "@/lib/whatsapp/media-upload"
    );
    const result = await uploadWhatsAppVoicemailAnnouncementFile({
      phoneNumberId: "112166395136463",
      accessToken: "access-token",
      description: "Default announcement",
      file: new File([new Uint8Array([1, 2, 3])], "announcement.ogg", {
        type: "audio/ogg",
      }),
    });

    expect(result).toEqual({
      id: "media_voicemail",
      mimeType: "audio/ogg",
      sizeBytes: 3,
    });
    const body = getLatestMockPostBody() as unknown as FormData;
    expect(body.get("messaging_product")).toBe("whatsapp");
    expect(body.get("use_case")).toBe("call_voicemail_announcement");
    expect(body.get("description")).toBe("Default announcement");
    expect(body.get("type")).toBeNull();
  });

  it("rejects unsupported provided MIME types before calling Meta", async () => {
    const { uploadWhatsAppMediaFile } = await import(
      "@/lib/whatsapp/media-upload"
    );

    await expect(
      uploadWhatsAppMediaFile({
        phoneNumberId: "112166395136463",
        accessToken: "access-token",
        file: new File([new Uint8Array([1, 2])], "animated.gif", {
          type: "image/gif",
        }),
      })
    ).rejects.toThrow(/not supported/i);

    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("rejects oversized WhatsApp uploads before calling Meta", async () => {
    const { uploadWhatsAppMediaFile } = await import(
      "@/lib/whatsapp/media-upload"
    );

    await expect(
      uploadWhatsAppMediaFile({
        phoneNumberId: "112166395136463",
        accessToken: "access-token",
        file: new File([new Uint8Array(100 * 1024 + 1)], "sticker.webp", {
          type: "image/webp",
        }),
      })
    ).rejects.toThrow(/too large/i);

    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("uploads downloaded template media with the multipart contract Meta expects", async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": "3",
          },
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    mockPostJson.mockResolvedValueOnce({ id: "media_123" });

    const { uploadWhatsAppMediaFromUrl } = await import(
      "@/lib/whatsapp/media-upload"
    );
    const result = await uploadWhatsAppMediaFromUrl({
      phoneNumberId: "112166395136463",
      accessToken: "access-token",
      mediaUrl: "https://scontent.whatsapp.net/example.mp4",
      kind: "video",
      fallbackMimeType: "video/mp4",
    });

    expect(result).toEqual({
      id: "media_123",
      mimeType: "video/mp4",
      sizeBytes: 3,
    });
    expect(mockPostJson).toHaveBeenCalledWith(
      "112166395136463/media",
      expect.objectContaining({
        token: "access-token",
        body: expect.any(FormData),
      })
    );
  });

  it("allows downloaded template video media at exactly 16MB", async () => {
    const templateVideoLimitBytes = 16 * 1024 * 1024;
    const fetchMock = jest.fn(
      async () =>
        new Response(new Uint8Array(templateVideoLimitBytes), {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(templateVideoLimitBytes),
          },
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    mockPostJson.mockResolvedValueOnce({ id: "media_16mb" });

    const { uploadWhatsAppMediaFromUrl } = await import(
      "@/lib/whatsapp/media-upload"
    );
    const result = await uploadWhatsAppMediaFromUrl({
      phoneNumberId: "112166395136463",
      accessToken: "access-token",
      mediaUrl: "https://scontent.whatsapp.net/example.mp4",
      kind: "video",
      fallbackMimeType: "video/mp4",
    });

    expect(result).toEqual({
      id: "media_16mb",
      mimeType: "video/mp4",
      sizeBytes: templateVideoLimitBytes,
    });
    expect(mockPostJson).toHaveBeenCalledWith(
      "112166395136463/media",
      expect.objectContaining({
        token: "access-token",
        body: expect.any(FormData),
      })
    );
  });

  it("normalizes WhatsApp CDN header media links to uploaded media ids before sending templates", async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": "3",
          },
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    mockPostJson
      .mockResolvedValueOnce({ id: "media_456" })
      .mockResolvedValueOnce({
        messages: [{ id: "wamid.template", timestamp: "1711100000" }],
      });

    const { sendWhatsappTemplate } = await importWhatsapp();
    const beforeSend = jest.fn(async () => {
      expect(mockPostJson).toHaveBeenCalledTimes(1);
      expect(getLatestMockPostPath()).toBe("112166395136463/media");
    });
    await sendWhatsappTemplate(
      "112166395136463",
      "access-token",
      "77001234567",
      "video_template",
      "en",
      [
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
      ],
      { beforeSend }
    );

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(mockPostJson).toHaveBeenNthCalledWith(
      1,
      "112166395136463/media",
      expect.objectContaining({
        token: "access-token",
        body: expect.any(FormData),
      })
    );
    const sendBody = getLatestMockPostBody();
    expect(sendBody.template.components).toEqual([
      {
        type: "header",
        parameters: [
          {
            type: "video",
            video: {
              id: "media_456",
            },
          },
        ],
      },
    ]);
  });

  it("does not reserve a contact when template header media preparation fails", async () => {
    global.fetch = jest.fn(async () => new Response(null, { status: 404 }));
    const beforeSend = jest.fn(async () => {});
    const { sendWhatsappTemplate } = await importWhatsapp();

    await expect(
      sendWhatsappTemplate(
        "phone-number-id",
        "access-token",
        "15551234567",
        "video_template",
        "en",
        [
          {
            type: "header",
            parameters: [
              {
                type: "video",
                video: { link: "https://scontent.whatsapp.net/missing.mp4" },
              },
            ],
          },
        ],
        { beforeSend }
      )
    ).rejects.toThrow();

    expect(beforeSend).not.toHaveBeenCalled();
    expect(mockPostJson).not.toHaveBeenCalled();
  });
});
