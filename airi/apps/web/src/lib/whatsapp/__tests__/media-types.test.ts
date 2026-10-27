import {
  GENERIC_ACTION_ATTACHMENT_ACCEPT,
  WHATSAPP_ACTION_ATTACHMENT_ACCEPT,
  WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_BY_FORMAT,
  WHATSAPP_VOICE_NOTE_ACCEPT,
  WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES,
  classifyWhatsAppUploadMedia,
  detectGenericOutboundAttachmentMediaType,
  getWhatsAppOfficialMediaMaxBytes,
  getWhatsAppOfficialMediaType,
  isSupportedWhatsAppTemplateVideoHeader,
  isWhatsAppVoiceEligibleFile,
  isWhatsAppWebhookMediaMessageType,
  resolveGenericActionAttachmentMimeType,
  resolveWhatsAppUploadMimeType,
} from "@/lib/whatsapp/media-types";
import { WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES } from "@icecore/whatsapp/mediaTypes";

describe("WhatsApp official media type classifier", () => {
  it.each([
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/webp", "sticker"],
    ["video/mp4", "video"],
    ["video/3gpp", "video"],
    ["audio/aac", "audio"],
    ["audio/amr", "audio"],
    ["audio/mpeg", "audio"],
    ["audio/mp4", "audio"],
    ["audio/ogg", "audio"],
    ["text/plain", "document"],
    ["application/pdf", "document"],
    ["application/msword", "document"],
    ["application/vnd.ms-excel", "document"],
    ["application/vnd.ms-powerpoint", "document"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "document",
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "document",
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "document",
    ],
  ] as const)("maps %s to %s", (mimeType, expectedMediaType) => {
    expect(getWhatsAppOfficialMediaType(mimeType)).toBe(expectedMediaType);
    expect(classifyWhatsAppUploadMedia({ mimeType }).mediaType).toBe(
      expectedMediaType
    );
  });

  it("infers official MIME from the filename when browser MIME is missing", () => {
    expect(
      classifyWhatsAppUploadMedia({
        mimeType: "",
        fileName: "sticker.webp",
      })
    ).toMatchObject({
      mimeType: "image/webp",
      source: "filename",
      mediaType: "sticker",
      isSupported: true,
    });

    expect(
      classifyWhatsAppUploadMedia({
        mimeType: "application/octet-stream",
        fileName: "clip.3gp",
      })
    ).toMatchObject({
      mimeType: "video/3gpp",
      source: "filename",
      mediaType: "video",
      isSupported: true,
    });
  });

  it("does not override non-generic unsupported browser MIME types", () => {
    expect(
      classifyWhatsAppUploadMedia({
        mimeType: "image/gif",
        fileName: "animated.png",
      })
    ).toMatchObject({
      mimeType: "image/gif",
      source: "provided",
      mediaType: null,
      isSupported: false,
    });

    expect(
      classifyWhatsAppUploadMedia({
        mimeType: "video/quicktime",
        fileName: "clip.mp4",
      })
    ).toMatchObject({
      mimeType: "video/quicktime",
      source: "provided",
      mediaType: null,
      isSupported: false,
    });
  });

  it("keeps arbitrary files unsupported instead of calling them documents", () => {
    expect(
      resolveWhatsAppUploadMimeType({
        mimeType: "application/octet-stream",
        fileName: "archive.zip",
      })
    ).toMatchObject({
      mimeType: "application/octet-stream",
      source: "fallback",
    });

    expect(
      classifyWhatsAppUploadMedia({
        mimeType: "application/octet-stream",
        fileName: "archive.zip",
      })
    ).toMatchObject({
      mediaType: null,
      isSupported: false,
    });
  });

  it("exposes official media size limits for upload validation", () => {
    expect(getWhatsAppOfficialMediaMaxBytes("image")).toBe(5 * 1024 * 1024);
    expect(getWhatsAppOfficialMediaMaxBytes("video")).toBe(16 * 1024 * 1024);
    expect(getWhatsAppOfficialMediaMaxBytes("audio")).toBe(16 * 1024 * 1024);
    expect(getWhatsAppOfficialMediaMaxBytes("document")).toBe(
      100 * 1024 * 1024
    );
    expect(getWhatsAppOfficialMediaMaxBytes("sticker")).toBe(100 * 1024);
    expect(WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES.sticker).toBe(100 * 1024);
  });

  it("centralizes conversation and scenario action accept contracts", () => {
    expect(WHATSAPP_ACTION_ATTACHMENT_ACCEPT).toContain("application/pdf");
    expect(WHATSAPP_ACTION_ATTACHMENT_ACCEPT).toContain(".3gpp");
    expect(WHATSAPP_ACTION_ATTACHMENT_ACCEPT).not.toContain("audio/ogg");

    expect(GENERIC_ACTION_ATTACHMENT_ACCEPT).toContain("video/quicktime");
    expect(GENERIC_ACTION_ATTACHMENT_ACCEPT).toContain(".pptx");

    expect(WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_BY_FORMAT.IMAGE).toBe(
      "image/jpeg,image/png"
    );
    expect(WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_BY_FORMAT.VIDEO).toBe(
      "video/mp4,video/3gpp"
    );
  });

  it("resolves generic scenario action MIME types from provided values or filenames", () => {
    expect(
      resolveGenericActionAttachmentMimeType({
        mimeType: "application/octet-stream",
        fileName: "deck.pdf",
      })
    ).toBe("application/pdf");

    expect(
      resolveGenericActionAttachmentMimeType({
        mimeType: "",
        fileName: "clip.mov",
      })
    ).toBe("video/quicktime");
  });

  it("detects generic outbound media types from MIME and filename", () => {
    expect(
      detectGenericOutboundAttachmentMediaType({
        mimeType: "audio/webm",
        fileName: "voice-123.webm",
      })
    ).toBe("voice");

    expect(
      detectGenericOutboundAttachmentMediaType({
        mimeType: "application/octet-stream",
        fileName: "photo.webp",
      })
    ).toBe("image");
  });

  it("accepts only OGG files for WhatsApp voice notes", () => {
    expect(WHATSAPP_VOICE_NOTE_ACCEPT).toContain("audio/ogg");
    expect(
      isWhatsAppVoiceEligibleFile({
        mimeType: "audio/ogg",
        fileName: "note.ogg",
      })
    ).toBe(true);
    expect(
      isWhatsAppVoiceEligibleFile({
        mimeType: "audio/mpeg",
        fileName: "song.mp3",
      })
    ).toBe(false);
  });

  it("centralizes WhatsApp template video support rules", () => {
    expect(
      isSupportedWhatsAppTemplateVideoHeader({
        fileName: "clip.3gp",
        mimeType: "video/3gpp",
      })
    ).toBe(true);

    expect(
      isSupportedWhatsAppTemplateVideoHeader({
        fileName: "clip.mov",
        mimeType: "video/quicktime",
      })
    ).toBe(false);
  });

  it("centralizes webhook media message type checks", () => {
    expect(WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES).toContain("voice");
    expect(isWhatsAppWebhookMediaMessageType("document")).toBe(true);
    expect(isWhatsAppWebhookMediaMessageType("text")).toBe(false);
  });
});
