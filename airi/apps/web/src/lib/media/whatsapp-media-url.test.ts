import {
  parseWhatsAppMediaProxyUrl,
  resolveDurableMessageMediaUrl,
} from "./whatsapp-media-url";

describe("whatsapp media URL helpers", () => {
  it("parses relative and absolute WhatsApp media proxy URLs", () => {
    expect(
      parseWhatsAppMediaProxyUrl(
        "/api/conversations/conv%201/whatsapp-media/media%201?filename=image.png"
      )
    ).toEqual({
      conversationId: "conv 1",
      mediaId: "media 1",
      fileName: "image.png",
    });

    expect(
      parseWhatsAppMediaProxyUrl(
        "https://www.airi.chat/api/conversations/conv_1/whatsapp-media/media_1"
      )
    ).toEqual({
      conversationId: "conv_1",
      mediaId: "media_1",
      fileName: null,
    });
  });

  it("prefers durable public media URLs over internal proxy URLs", () => {
    expect(
      resolveDurableMessageMediaUrl({
        imageUrl: "/api/conversations/conv_1/whatsapp-media/media_1",
        attachments: [{ url: "https://storage.test/media.png" }],
      })
    ).toBe("https://storage.test/media.png");
  });
});
