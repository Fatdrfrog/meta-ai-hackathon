import {
  formatConversationAttachmentFileSize,
  getConversationAttachmentUrlByType,
  isConversationAttachmentLabelOnlyText,
  validateConversationAttachmentFile,
} from "@/lib/conversation-attachments";

describe("conversation attachment utilities", () => {
  it("resolves attachment URLs by content type and extension", () => {
    const attachments = [
      {
        url: "https://cdn.example.com/photo",
        contentType: "image/jpeg",
      },
      {
        url: "https://cdn.example.com/terms.pdf?download=1",
        contentType: "",
      },
      {
        url: "https://cdn.example.com/voice.ogg",
        contentType: "application/octet-stream",
      },
    ];

    expect(getConversationAttachmentUrlByType(attachments, "image")).toEqual({
      url: "https://cdn.example.com/photo",
      contentType: "image/jpeg",
    });
    expect(getConversationAttachmentUrlByType(attachments, "document")).toEqual(
      {
        url: "https://cdn.example.com/terms.pdf?download=1",
      }
    );
    expect(getConversationAttachmentUrlByType(attachments, "audio")).toEqual({
      url: "https://cdn.example.com/voice.ogg",
      contentType: "application/octet-stream",
    });
  });

  it("formats attachment labels and file sizes consistently", () => {
    expect(
      isConversationAttachmentLabelOnlyText(" invoice.pdf ", "invoice.pdf")
    ).toBe(true);
    expect(
      isConversationAttachmentLabelOnlyText(
        "Here is invoice.pdf",
        "invoice.pdf"
      )
    ).toBe(false);
    expect(formatConversationAttachmentFileSize(41677)).toBe("40.7 KB");
    expect(formatConversationAttachmentFileSize(2 * 1024 * 1024)).toBe(
      "2.00 MB"
    );
    expect(formatConversationAttachmentFileSize(null)).toBeNull();
  });

  it("uses Meta's conservative WhatsApp sticker limit for WebP uploads", () => {
    expect(
      validateConversationAttachmentFile({
        channel: "whatsapp",
        fileName: "sticker.webp",
        mimeType: "image/webp",
        fileSize: 100 * 1024,
      })
    ).toMatchObject({
      ok: true,
      attachment: {
        mediaType: "sticker",
        mimeType: "image/webp",
      },
    });

    expect(
      validateConversationAttachmentFile({
        channel: "whatsapp",
        fileName: "sticker.webp",
        mimeType: "image/webp",
        fileSize: 100 * 1024 + 1,
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("100 KB"),
    });
  });

  it("allows WhatsApp PDFs up to Meta's document limit", () => {
    expect(
      validateConversationAttachmentFile({
        channel: "whatsapp",
        fileName: "contract.pdf",
        mimeType: "application/pdf",
        fileSize: 100 * 1024 * 1024,
      })
    ).toMatchObject({
      ok: true,
      attachment: {
        mediaType: "document",
        mimeType: "application/pdf",
      },
    });

    expect(
      validateConversationAttachmentFile({
        channel: "whatsapp",
        fileName: "contract.pdf",
        mimeType: "application/pdf",
        fileSize: 100 * 1024 * 1024 + 1,
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("100 MB"),
    });
  });

  describe("Instagram direct messages", () => {
    const validate = (fileName: string, mimeType: string, fileSize = 1024) =>
      validateConversationAttachmentFile({
        channel: "instagram",
        fileName,
        mimeType,
        fileSize,
      });

    it.each([
      ["photo.jpg", "image/jpeg", "image"],
      ["photo.png", "image/png", "image"],
      ["clip.gif", "image/gif", "image"],
      ["clip.mov", "video/quicktime", "video"],
      ["clip.webm", "video/webm", "video"],
      ["voice-1.m4a", "audio/mp4", "audio"],
      ["note.wav", "audio/wav", "audio"],
      ["contract.pdf", "application/pdf", "document"],
      // Browsers can report an empty type; the extension decides then.
      ["voice-2.m4a", "", "audio"],
    ])("accepts %s as %s", (fileName, mimeType, mediaType) => {
      expect(validate(fileName, mimeType)).toMatchObject({
        ok: true,
        attachment: { mediaType },
      });
    });

    it.each([
      ["photo.webp", "image/webp"],
      ["photo.heic", "image/heic"],
      ["song.mp3", "audio/mpeg"],
      ["voice.ogg", "audio/ogg"],
      ["voice.webm", "audio/webm"],
      [
        "contract.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
    ])("rejects %s, which Meta would refuse", (fileName, mimeType) => {
      expect(validate(fileName, mimeType)).toMatchObject({
        ok: false,
        error: expect.stringContaining("Instagram accepts"),
      });
    });

    it("limits images to Meta's 8 MB", () => {
      expect(
        validate("photo.jpg", "image/jpeg", 8 * 1024 * 1024)
      ).toMatchObject({ ok: true });
      expect(
        validate("photo.jpg", "image/jpeg", 8 * 1024 * 1024 + 1)
      ).toMatchObject({
        ok: false,
        error: "photo.jpg: Instagram image attachments are limited to 8 MB.",
      });
    });

    it("caps video, audio and PDF at the 20 MB storage limit", () => {
      expect(
        validate("clip.mp4", "video/mp4", 20 * 1024 * 1024 + 1)
      ).toMatchObject({
        ok: false,
        error: "clip.mp4: Instagram video attachments are limited to 20 MB.",
      });
    });
  });
});
