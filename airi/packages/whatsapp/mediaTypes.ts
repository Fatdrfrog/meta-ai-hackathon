export const WHATSAPP_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export const WHATSAPP_STICKER_MIME_TYPES = ["image/webp"] as const;

export const WHATSAPP_AUDIO_MIME_TYPES = [
  "audio/aac",
  "audio/amr",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
] as const;

export type WhatsAppOfficialMediaType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker";

export const WHATSAPP_VIDEO_MIME_TYPES = ["video/mp4", "video/3gpp"] as const;

export const WHATSAPP_DOCUMENT_MIME_TYPES = [
  "text/plain",
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES: Record<
  WhatsAppOfficialMediaType,
  readonly string[]
> = {
  image: WHATSAPP_IMAGE_MIME_TYPES,
  video: WHATSAPP_VIDEO_MIME_TYPES,
  audio: WHATSAPP_AUDIO_MIME_TYPES,
  document: WHATSAPP_DOCUMENT_MIME_TYPES,
  sticker: WHATSAPP_STICKER_MIME_TYPES,
};

export const WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES: Record<
  WhatsAppOfficialMediaType,
  number
> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  // Meta allows animated stickers up to 500 KB, but the upload metadata does
  // not tell us whether a WebP is animated. Enforce the static sticker limit.
  sticker: 100 * 1024,
};

export const WHATSAPP_TEMPLATE_VIDEO_HEADER_MAX_BYTES =
  WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES.video;
