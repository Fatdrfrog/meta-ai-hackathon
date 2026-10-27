export type OutboundAttachmentMediaType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "voice"
  | "file";

export interface OutboundAttachment {
  url?: string;
  /**
   * Composer-only local preview (`blob:` URL of the picked file). The stored
   * `url` is private and only signed for display after sending; this field is
   * stripped before the reply is sent.
   */
  previewUrl?: string;
  whatsappMediaId?: string;
  mediaType: OutboundAttachmentMediaType;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}
