import {
  sendWhatsAppServiceMessage,
  type SendWhatsAppServiceMessageInput,
} from "@/lib/airi/reply/delivery/whatsapp-service-message-send";
import type { WhatsAppServiceMessageTransport } from "@/lib/airi/reply/delivery/whatsapp-service-message";

jest.mock("@/lib/scenarios/scenario-asset-resolve", () => ({
  resolveScenarioActionAttachmentHttpsUrl: jest.fn(
    async ({
      attachment,
    }: {
      attachment: Record<string, unknown> & { url: string };
    }) => {
      if (String(attachment.url).startsWith("gcs://")) {
        return {
          ...attachment,
          url: "https://signed.example/from-gcs.jpg",
        };
      }
      return attachment;
    }
  ),
}));

const providerResult = {
  messageId: "wamid.service-1",
  date: 1_721_000_000,
  status: undefined,
  messageStatus: undefined,
};

function createTransport() {
  return {
    sendWhatsappMessage: jest.fn(async () => providerResult),
    sendWhatsappMedia: jest.fn(async () => providerResult),
    sendWhatsappInteractiveReplyButtonsMessage: jest.fn(
      async () => providerResult
    ),
    sendWhatsappInteractiveListMessage: jest.fn(async () => providerResult),
    sendWhatsappInteractiveCtaUrlMessage: jest.fn(async () => providerResult),
    sendWhatsappInteractiveMediaCarousel: jest.fn(async () => providerResult),
    sendWhatsappInteractiveFlow: jest.fn(async () => providerResult),
    sendWhatsappContacts: jest.fn(async () => providerResult),
    sendWhatsappLocation: jest.fn(async () => providerResult),
    sendWhatsappLocationRequest: jest.fn(async () => providerResult),
    sendWhatsappRequestContactInfo: jest.fn(async () => providerResult),
    sendWhatsappVoiceCall: jest.fn(async () => providerResult),
    sendWhatsappCatalogMessage: jest.fn(async () => providerResult),
    sendWhatsappSingleProductMessage: jest.fn(async () => providerResult),
    sendWhatsappMultiProductMessage: jest.fn(async () => providerResult),
    sendWhatsappProductCarouselMessage: jest.fn(async () => providerResult),
  } satisfies WhatsAppServiceMessageTransport;
}

function baseInput(
  command: SendWhatsAppServiceMessageInput["command"]
): SendWhatsAppServiceMessageInput {
  return {
    phoneNumberId: "phone-number-id",
    accessToken: "access-token",
    recipient: { kind: "phone", value: "77012345678" },
    workspaceId: "workspace-1",
    command,
  };
}

describe("sendWhatsAppServiceMessage", () => {
  it("claims delivery after media preparation and before the single provider call", async () => {
    const transport = createTransport();
    const beforeSend = jest.fn(async () => {
      expect(transport.sendWhatsappMedia).not.toHaveBeenCalled();
    });
    await sendWhatsAppServiceMessage(
      {
        ...baseInput({
          kind: "media",
          attachment: {
            url: "gcs://bucket/path/file.jpg",
            mediaType: "image",
          },
        }),
        beforeSend,
      },
      transport
    );
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(transport.sendWhatsappMedia).toHaveBeenCalledTimes(1);
  });

  it("never calls a provider if the durable delivery claim is refused", async () => {
    const transport = createTransport();
    const blocked = new Error("delivery already claimed");
    await expect(
      sendWhatsAppServiceMessage(
        {
          ...baseInput({
            kind: "reply_buttons",
            body: "Choose",
            options: [{ id: "yes", label: "Yes" }],
          }),
          beforeSend: async () => {
            throw blocked;
          },
        },
        transport
      )
    ).rejects.toBe(blocked);
    expect(
      transport.sendWhatsappInteractiveReplyButtonsMessage
    ).not.toHaveBeenCalled();
  });
  it("resolves gcs carousel media to signed HTTPS before Meta send", async () => {
    const transport = createTransport();
    await sendWhatsAppServiceMessage(
      baseInput({
        kind: "media_carousel",
        body: "Pick",
        cards: [
          {
            id: "c1",
            media: {
              url: "gcs://bucket/path/card.jpg",
              mediaType: "image",
              bucket: "bucket",
              path: "path/card.jpg",
            },
            interaction: {
              kind: "quick_replies",
              options: [{ id: "o1", label: "Yes" }],
            },
          },
          {
            id: "c2",
            media: {
              url: "https://cdn.example.com/other.jpg",
              mediaType: "image",
            },
            interaction: {
              kind: "quick_replies",
              options: [{ id: "o2", label: "No" }],
            },
          },
        ],
      }),
      transport
    );

    expect(transport.sendWhatsappInteractiveMediaCarousel).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({
        cards: [
          expect.objectContaining({
            media: expect.objectContaining({
              link: "https://signed.example/from-gcs.jpg",
            }),
          }),
          expect.objectContaining({
            media: expect.objectContaining({
              link: "https://cdn.example.com/other.jpg",
            }),
          }),
        ],
      })
    );
  });

  it("signs an interactive media header and leaves a text header as sent", async () => {
    const transport = createTransport();
    const result = await sendWhatsAppServiceMessage(
      baseInput({
        kind: "cta_url",
        body: "Open the catalog",
        header: {
          kind: "media",
          attachment: {
            url: "gcs://bucket/path/header.jpg",
            mediaType: "image",
            bucket: "bucket",
            path: "path/header.jpg",
          },
        },
        buttonLabel: "Open",
        url: "https://shop.example.com",
      }),
      transport
    );

    expect(result.preparedCommand).toMatchObject({
      header: {
        kind: "media",
        attachment: {
          url: "https://signed.example/from-gcs.jpg",
          mediaType: "image",
        },
      },
    });
    expect(transport.sendWhatsappInteractiveCtaUrlMessage).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.objectContaining({
        header: { type: "image", link: "https://signed.example/from-gcs.jpg" },
      })
    );

    const textHeader = {
      kind: "reply_buttons" as const,
      body: "Choose",
      header: { kind: "text" as const, text: "Menu" },
      options: [{ id: "one", label: "One" }],
    };
    const unchanged = await sendWhatsAppServiceMessage(
      baseInput(textHeader),
      createTransport()
    );
    expect(unchanged.preparedCommand).toEqual(textHeader);
  });

  it("exposes preparedCommand with signed HTTPS for primaryMedia consumers", async () => {
    const result = await sendWhatsAppServiceMessage(
      baseInput({
        kind: "media",
        attachment: {
          url: "gcs://bucket/path/card.jpg",
          mediaType: "image",
          bucket: "bucket",
          path: "path/card.jpg",
        },
      }),
      createTransport()
    );

    expect(result.preparedCommand).toMatchObject({
      kind: "media",
      attachment: { url: "https://signed.example/from-gcs.jpg" },
    });
  });
});
