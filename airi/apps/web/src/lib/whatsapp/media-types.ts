import {
  type WhatsAppOfficialMediaType,
  WHATSAPP_IMAGE_MIME_TYPES,
  WHATSAPP_STICKER_MIME_TYPES,
  WHATSAPP_AUDIO_MIME_TYPES,
  WHATSAPP_VIDEO_MIME_TYPES,
  WHATSAPP_DOCUMENT_MIME_TYPES,
  WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES,
  WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES,
} from "@icecore/whatsapp/mediaTypes";
import type { OutboundAttachmentMediaType } from "@/types/outbound-attachment";
import type { WhatsAppHeaderFormat } from "@icecore/shared/types/whatsapp";

type WhatsAppMimeSource = "provided" | "filename" | "fallback";

interface WhatsAppUploadMimeResolution {
  mimeType: string;
  source: WhatsAppMimeSource;
}

interface WhatsAppMediaClassification extends WhatsAppUploadMimeResolution {
  mediaType: WhatsAppOfficialMediaType | null;
  isSupported: boolean;
}

export type WhatsAppActionAttachmentMediaType = Extract<
  WhatsAppOfficialMediaType,
  "image" | "video" | "document"
>;

export type WhatsAppTemplateHeaderMediaFormat = Extract<
  WhatsAppHeaderFormat,
  "IMAGE" | "VIDEO" | "DOCUMENT"
>;

export type WhatsAppTemplateHeaderMediaKind = Extract<
  WhatsAppOfficialMediaType,
  "image" | "video" | "document"
>;

export const GENERIC_MEDIA_MIME_TYPES = [
  "application/octet-stream",
  "binary/octet-stream",
] as const;

const GENERIC_MIME_TYPES = new Set<string>(GENERIC_MEDIA_MIME_TYPES);
const WHATSAPP_IMAGE_FILE_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;
const WHATSAPP_STICKER_FILE_EXTENSIONS = [".webp"] as const;
const WHATSAPP_AUDIO_FILE_EXTENSIONS = [
  ".aac",
  ".amr",
  ".mp3",
  ".m4a",
  ".ogg",
] as const;

/** Accept list for WhatsApp voice notes (OGG/OPUS only). */
export const WHATSAPP_VOICE_NOTE_ACCEPT = "audio/ogg,.ogg";

/**
 * Voice notes require .ogg encoded with OPUS. We can only check MIME/extension
 * client-side (same bar as voicemail announcement uploads).
 */
export function isWhatsAppVoiceEligibleFile(params: {
  mimeType?: string | null;
  fileName?: string | null;
  url?: string | null;
}): boolean {
  const mime = normalizeWhatsAppMimeType(params.mimeType) || "";
  if (mime === "audio/ogg" || mime.startsWith("audio/ogg;")) return true;
  const name = (params.fileName || params.url || "").trim().toLowerCase();
  return name.endsWith(".ogg");
}
export const WHATSAPP_VIDEO_FILE_EXTENSIONS = [
  ".mp4",
  ".3gp",
  ".3gpp",
] as const;

const WHATSAPP_DOCUMENT_FILE_EXTENSIONS = [
  ".txt",
  ".pdf",
  ".doc",
  ".xls",
  ".ppt",
  ".docx",
  ".pptx",
  ".xlsx",
] as const;

const GENERIC_ACTION_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
] as const;

const GENERIC_ACTION_ATTACHMENT_FILE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".mp4",
  ".webm",
  ".mov",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
] as const;

const TELEGRAM_ATTACHMENT_FILE_EXTENSIONS = [
  ".txt",
  ".pdf",
  ".doc",
  ".xls",
  ".ppt",
  ".docx",
  ".pptx",
  ".xlsx",
  ".csv",
  ".zip",
  ".rar",
] as const;

const GENERIC_ATTACHMENT_EXTENSION_MATCHERS = {
  image: /\.(png|jpe?g|gif|webp|bmp|svg|avif)([?#]|$)/i,
  video: /\.(mp4|3gp|3gpp|mov|webm|mkv|avi|m4v)([?#]|$)/i,
  audio: /\.(mp3|ogg|wav|m4a|aac|flac|opus|weba|webm)([?#]|$)/i,
  document: /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar)([?#]|$)/i,
} as const satisfies Record<
  Extract<
    OutboundAttachmentMediaType,
    "image" | "video" | "audio" | "document"
  >,
  RegExp
>;

export const WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS: Record<
  WhatsAppOfficialMediaType,
  readonly string[]
> = {
  image: WHATSAPP_IMAGE_FILE_EXTENSIONS,
  video: WHATSAPP_VIDEO_FILE_EXTENSIONS,
  audio: WHATSAPP_AUDIO_FILE_EXTENSIONS,
  document: WHATSAPP_DOCUMENT_FILE_EXTENSIONS,
  sticker: WHATSAPP_STICKER_FILE_EXTENSIONS,
};

export const WHATSAPP_OFFICIAL_MEDIA_ACCEPT_TYPES = [
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.image,
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.sticker,
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.video,
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.audio,
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.document,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.image,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.sticker,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.video,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.audio,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.document,
] as const;

export const WHATSAPP_OFFICIAL_MEDIA_ACCEPT =
  WHATSAPP_OFFICIAL_MEDIA_ACCEPT_TYPES.join(",");

export const WHATSAPP_ACTION_ATTACHMENT_MIME_TYPES = [
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.image,
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.video,
  ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.document,
] as const;

export const WHATSAPP_ACTION_ATTACHMENT_ACCEPT_TYPES = [
  ...WHATSAPP_ACTION_ATTACHMENT_MIME_TYPES,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.image,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.video,
  ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.document,
] as const;

export const WHATSAPP_ACTION_ATTACHMENT_ACCEPT =
  WHATSAPP_ACTION_ATTACHMENT_ACCEPT_TYPES.join(",");

export const GENERIC_ACTION_ATTACHMENT_ACCEPT_TYPES = [
  ...GENERIC_ACTION_ATTACHMENT_MIME_TYPES,
  ...GENERIC_ACTION_ATTACHMENT_FILE_EXTENSIONS,
] as const;

export const GENERIC_ACTION_ATTACHMENT_ACCEPT =
  GENERIC_ACTION_ATTACHMENT_ACCEPT_TYPES.join(",");

export const SCENARIO_ACTION_ASSET_ALLOWED_MIME_TYPES = Array.from(
  new Set([
    ...GENERIC_ACTION_ATTACHMENT_MIME_TYPES,
    ...WHATSAPP_OFFICIAL_MEDIA_ACCEPT_TYPES.filter(
      type => !type.startsWith(".")
    ),
  ])
).sort();

export const TELEGRAM_CONVERSATION_ATTACHMENT_ACCEPT_TYPES = [
  "image/*",
  "video/*",
  "audio/*",
  "text/plain",
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ...TELEGRAM_ATTACHMENT_FILE_EXTENSIONS,
] as const;

export const TELEGRAM_CONVERSATION_ATTACHMENT_ACCEPT =
  TELEGRAM_CONVERSATION_ATTACHMENT_ACCEPT_TYPES.join(",");

export type InstagramDmMediaType = "image" | "video" | "audio" | "document";

/** Formats the Instagram Messaging API accepts for DM attachments. */
export const INSTAGRAM_DM_MEDIA_MIME_TYPES: Record<
  InstagramDmMediaType,
  readonly string[]
> = {
  image: ["image/png", "image/jpeg", "image/gif"],
  video: [
    "video/mp4",
    "video/ogg",
    "video/x-msvideo",
    "video/avi",
    "video/quicktime",
    "video/webm",
  ],
  audio: [
    "audio/aac",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
  ],
  document: ["application/pdf"],
};

const INSTAGRAM_DM_FILENAME_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
};

/** Meta allows 8 MB images and 25 MB for the rest. */
export const INSTAGRAM_DM_MEDIA_MAX_BYTES: Record<
  InstagramDmMediaType,
  number
> = {
  image: 8 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};

export const INSTAGRAM_DM_CONVERSATION_ATTACHMENT_ACCEPT_TYPES = [
  ...INSTAGRAM_DM_MEDIA_MIME_TYPES.image,
  ...INSTAGRAM_DM_MEDIA_MIME_TYPES.video,
  ...INSTAGRAM_DM_MEDIA_MIME_TYPES.audio,
  ...INSTAGRAM_DM_MEDIA_MIME_TYPES.document,
  ...Object.keys(INSTAGRAM_DM_FILENAME_MIME_TYPES),
] as const;

export const INSTAGRAM_DM_CONVERSATION_ATTACHMENT_ACCEPT =
  INSTAGRAM_DM_CONVERSATION_ATTACHMENT_ACCEPT_TYPES.join(",");

export function classifyInstagramDmUploadMedia(params: {
  mimeType?: string | null;
  fileName?: string | null;
}): { mediaType: InstagramDmMediaType | null; mimeType: string } {
  const providedMimeType = normalizeWhatsAppMimeType(params.mimeType);
  const extension = getMediaFileExtension(params.fileName);
  const mimeType =
    providedMimeType && !isGenericMediaMimeType(providedMimeType)
      ? providedMimeType
      : (extension && INSTAGRAM_DM_FILENAME_MIME_TYPES[extension]) || "";
  const mediaType =
    (Object.keys(INSTAGRAM_DM_MEDIA_MIME_TYPES) as InstagramDmMediaType[]).find(
      type => INSTAGRAM_DM_MEDIA_MIME_TYPES[type].includes(mimeType)
    ) ?? null;
  return { mediaType, mimeType };
}

export const WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_TYPES_BY_FORMAT: Record<
  WhatsAppTemplateHeaderMediaFormat,
  readonly string[]
> = {
  IMAGE: WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.image,
  VIDEO: WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.video,
  DOCUMENT: [
    ...WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.document,
    ...WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.document,
  ],
};

export const WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_BY_FORMAT: Record<
  WhatsAppTemplateHeaderMediaFormat,
  string
> = {
  IMAGE: WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_TYPES_BY_FORMAT.IMAGE.join(","),
  VIDEO: WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_TYPES_BY_FORMAT.VIDEO.join(","),
  DOCUMENT:
    WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_TYPES_BY_FORMAT.DOCUMENT.join(","),
};

export const WHATSAPP_TEMPLATE_HEADER_FORMAT_MEDIA_TYPES: Record<
  WhatsAppTemplateHeaderMediaFormat,
  WhatsAppTemplateHeaderMediaKind
> = {
  IMAGE: "image",
  VIDEO: "video",
  DOCUMENT: "document",
};

export const WHATSAPP_TEMPLATE_HEADER_DEFAULT_FILE_EXTENSIONS: Record<
  WhatsAppTemplateHeaderMediaFormat,
  string
> = {
  IMAGE: "png",
  VIDEO: "mp4",
  DOCUMENT: "pdf",
};

export const WHATSAPP_TEMPLATE_HEADER_MEDIA_FALLBACK_MIME_TYPES: Record<
  WhatsAppTemplateHeaderMediaKind,
  string
> = {
  image: WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.image[0],
  video: WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.video[0],
  document: WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.document[1],
};

export const WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES = [
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "voice",
] as const;

export type WhatsAppWebhookMediaMessageType =
  (typeof WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES)[number];

const IMAGE_MIME_TYPES = new Set<string>(WHATSAPP_IMAGE_MIME_TYPES);
const STICKER_MIME_TYPES = new Set<string>(WHATSAPP_STICKER_MIME_TYPES);
const VIDEO_MIME_TYPES = new Set<string>(WHATSAPP_VIDEO_MIME_TYPES);
const AUDIO_MIME_TYPES = new Set<string>(WHATSAPP_AUDIO_MIME_TYPES);
const DOCUMENT_MIME_TYPES = new Set<string>(WHATSAPP_DOCUMENT_MIME_TYPES);
const GENERIC_ACTION_ATTACHMENT_MIME_TYPE_SET = new Set<string>(
  GENERIC_ACTION_ATTACHMENT_MIME_TYPES
);
const SCENARIO_ACTION_ASSET_ALLOWED_MIME_TYPE_SET = new Set<string>(
  SCENARIO_ACTION_ASSET_ALLOWED_MIME_TYPES
);

const FILENAME_MIME_TYPES: Record<string, string> = {
  [WHATSAPP_IMAGE_FILE_EXTENSIONS[0]]: WHATSAPP_IMAGE_MIME_TYPES[0],
  [WHATSAPP_IMAGE_FILE_EXTENSIONS[1]]: WHATSAPP_IMAGE_MIME_TYPES[0],
  [WHATSAPP_IMAGE_FILE_EXTENSIONS[2]]: WHATSAPP_IMAGE_MIME_TYPES[1],
  [WHATSAPP_STICKER_FILE_EXTENSIONS[0]]: WHATSAPP_STICKER_MIME_TYPES[0],
  [WHATSAPP_VIDEO_FILE_EXTENSIONS[0]]: WHATSAPP_VIDEO_MIME_TYPES[0],
  [WHATSAPP_VIDEO_FILE_EXTENSIONS[1]]: WHATSAPP_VIDEO_MIME_TYPES[1],
  [WHATSAPP_VIDEO_FILE_EXTENSIONS[2]]: WHATSAPP_VIDEO_MIME_TYPES[1],
  [WHATSAPP_AUDIO_FILE_EXTENSIONS[0]]: WHATSAPP_AUDIO_MIME_TYPES[0],
  [WHATSAPP_AUDIO_FILE_EXTENSIONS[1]]: WHATSAPP_AUDIO_MIME_TYPES[1],
  [WHATSAPP_AUDIO_FILE_EXTENSIONS[2]]: WHATSAPP_AUDIO_MIME_TYPES[2],
  [WHATSAPP_AUDIO_FILE_EXTENSIONS[3]]: WHATSAPP_AUDIO_MIME_TYPES[3],
  [WHATSAPP_AUDIO_FILE_EXTENSIONS[4]]: WHATSAPP_AUDIO_MIME_TYPES[4],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[0]]: WHATSAPP_DOCUMENT_MIME_TYPES[0],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[1]]: WHATSAPP_DOCUMENT_MIME_TYPES[1],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[2]]: WHATSAPP_DOCUMENT_MIME_TYPES[2],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[3]]: WHATSAPP_DOCUMENT_MIME_TYPES[3],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[4]]: WHATSAPP_DOCUMENT_MIME_TYPES[4],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[5]]: WHATSAPP_DOCUMENT_MIME_TYPES[5],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[6]]: WHATSAPP_DOCUMENT_MIME_TYPES[6],
  [WHATSAPP_DOCUMENT_FILE_EXTENSIONS[7]]: WHATSAPP_DOCUMENT_MIME_TYPES[7],
};

const GENERIC_ACTION_FILENAME_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
};

export function normalizeWhatsAppMimeType(
  value: string | null | undefined
): string | null {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase();
  return mimeType || null;
}

export function normalizeMediaMimeType(
  value: string | null | undefined
): string {
  return normalizeWhatsAppMimeType(value) || "";
}

export function isGenericMediaMimeType(
  value: string | null | undefined
): boolean {
  const mimeType = normalizeWhatsAppMimeType(value);
  return !mimeType || GENERIC_MIME_TYPES.has(mimeType);
}

export function getMediaFileExtension(
  fileName: string | null | undefined
): string | null {
  const normalized = fileName?.trim().toLowerCase();
  if (!normalized) return null;

  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0) return null;

  return normalized.slice(dotIndex);
}

function inferMimeTypeFromFilename(fileName: string | null | undefined) {
  const extension = getMediaFileExtension(fileName);
  return extension ? FILENAME_MIME_TYPES[extension] || null : null;
}

function inferGenericActionMimeTypeFromFilename(
  fileName: string | null | undefined
): string {
  const extension = getMediaFileExtension(fileName);
  return extension ? GENERIC_ACTION_FILENAME_MIME_TYPES[extension] || "" : "";
}

export function resolveWhatsAppUploadMimeType(params: {
  mimeType?: string | null;
  fileName?: string | null;
}): WhatsAppUploadMimeResolution {
  const providedMimeType = normalizeWhatsAppMimeType(params.mimeType);
  if (providedMimeType && !isGenericMediaMimeType(providedMimeType)) {
    return {
      mimeType: providedMimeType,
      source: "provided",
    };
  }

  const filenameMimeType = inferMimeTypeFromFilename(params.fileName);
  if (filenameMimeType) {
    return {
      mimeType: filenameMimeType,
      source: "filename",
    };
  }

  return {
    mimeType: providedMimeType || "application/octet-stream",
    source: "fallback",
  };
}

export function resolveGenericActionAttachmentMimeType(params: {
  mimeType?: string | null;
  fileName?: string | null;
}): string {
  const providedMimeType = normalizeMediaMimeType(params.mimeType);
  const inferredMimeType = inferGenericActionMimeTypeFromFilename(
    params.fileName
  );

  if (
    providedMimeType &&
    GENERIC_ACTION_ATTACHMENT_MIME_TYPE_SET.has(providedMimeType)
  ) {
    return providedMimeType;
  }
  if (
    inferredMimeType &&
    GENERIC_ACTION_ATTACHMENT_MIME_TYPE_SET.has(inferredMimeType)
  ) {
    return inferredMimeType;
  }

  return providedMimeType || inferredMimeType;
}

export function isGenericActionAttachmentMimeType(
  mimeType: string | null | undefined
): boolean {
  const normalized = normalizeWhatsAppMimeType(mimeType);
  return Boolean(
    normalized && GENERIC_ACTION_ATTACHMENT_MIME_TYPE_SET.has(normalized)
  );
}

export function isScenarioActionAssetMimeTypeAllowed(
  mimeType: string | null | undefined
): boolean {
  const normalized = normalizeWhatsAppMimeType(mimeType);
  return Boolean(
    normalized && SCENARIO_ACTION_ASSET_ALLOWED_MIME_TYPE_SET.has(normalized)
  );
}

export function isMimeTypeAllowedByPattern(params: {
  mimeType: string;
  allowedPatterns: Iterable<string>;
}): boolean {
  const mimeType = normalizeWhatsAppMimeType(params.mimeType);
  if (!mimeType) return false;

  for (const rawPattern of params.allowedPatterns) {
    const pattern = normalizeWhatsAppMimeType(rawPattern);
    if (!pattern) continue;
    if (pattern === mimeType) return true;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (mimeType.startsWith(prefix)) return true;
    }
  }

  return false;
}

export function getWhatsAppOfficialMediaType(
  mimeType: string | null | undefined
): WhatsAppOfficialMediaType | null {
  const normalized = normalizeWhatsAppMimeType(mimeType);
  if (!normalized) return null;

  if (IMAGE_MIME_TYPES.has(normalized)) return "image";
  if (STICKER_MIME_TYPES.has(normalized)) return "sticker";
  if (VIDEO_MIME_TYPES.has(normalized)) return "video";
  if (AUDIO_MIME_TYPES.has(normalized)) return "audio";
  if (DOCUMENT_MIME_TYPES.has(normalized)) return "document";

  return null;
}

export function isMediaMimeType(
  mimeType: string | null | undefined,
  mediaType: Extract<OutboundAttachmentMediaType, "image" | "video" | "audio">
): boolean {
  const normalized = normalizeWhatsAppMimeType(mimeType);
  return Boolean(normalized && normalized.startsWith(`${mediaType}/`));
}

export function isPdfMedia(params: {
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  const mimeType = normalizeWhatsAppMimeType(params.mimeType);
  return (
    mimeType === "application/pdf" ||
    getMediaFileExtension(params.fileName) === ".pdf"
  );
}

export function isGenericAttachmentUrlForMediaType(
  url: string | null | undefined,
  mediaType: Extract<
    OutboundAttachmentMediaType,
    "image" | "video" | "audio" | "document"
  >
): boolean {
  const value = url?.trim();
  if (!value) return false;
  return GENERIC_ATTACHMENT_EXTENSION_MATCHERS[mediaType].test(value);
}

export function getGenericAttachmentMediaTypeFromMimeType(
  mimeType: string | null | undefined
): Extract<
  OutboundAttachmentMediaType,
  "image" | "video" | "audio" | "document"
> | null {
  const normalized = normalizeWhatsAppMimeType(mimeType);
  if (!normalized || isGenericMediaMimeType(normalized)) return null;
  if (isMediaMimeType(normalized, "image")) return "image";
  if (isMediaMimeType(normalized, "video")) return "video";
  if (isMediaMimeType(normalized, "audio")) return "audio";
  return "document";
}

export function detectGenericOutboundAttachmentMediaType(params: {
  mimeType?: string | null;
  fileName?: string | null;
}): OutboundAttachmentMediaType {
  const lowerMime = normalizeMediaMimeType(params.mimeType);
  const lowerName = params.fileName?.trim().toLowerCase() || "attachment";

  if (isMediaMimeType(lowerMime, "image")) return "image";
  if (isMediaMimeType(lowerMime, "video")) return "video";
  if (isMediaMimeType(lowerMime, "audio")) {
    if (/^voice[-_]/i.test(lowerName)) return "voice";
    return "audio";
  }

  if (isGenericAttachmentUrlForMediaType(lowerName, "image")) return "image";
  if (isGenericAttachmentUrlForMediaType(lowerName, "video")) {
    if (lowerName.endsWith(".webm") && /^voice[-_]/i.test(lowerName)) {
      return "voice";
    }
    return "video";
  }
  if (isGenericAttachmentUrlForMediaType(lowerName, "audio")) return "audio";

  return "document";
}

export function inferScenarioActionAttachmentMediaTypeFromUrl(
  url: string | null | undefined
): Extract<OutboundAttachmentMediaType, "image" | "video" | "document"> {
  if (isGenericAttachmentUrlForMediaType(url, "image")) return "image";
  if (isGenericAttachmentUrlForMediaType(url, "video")) return "video";
  return "document";
}

export function isSupportedWhatsAppTemplateVideoHeader(params: {
  fileName?: string | null;
  mimeType?: string | null;
}): boolean {
  const extension = getMediaFileExtension(params.fileName);
  const mimeType = normalizeWhatsAppMimeType(params.mimeType);

  if (extension) {
    return (
      WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.video.includes(
        extension as (typeof WHATSAPP_OFFICIAL_MEDIA_FILE_EXTENSIONS.video)[number]
      ) &&
      (!mimeType || VIDEO_MIME_TYPES.has(mimeType))
    );
  }

  return Boolean(mimeType && VIDEO_MIME_TYPES.has(mimeType));
}

export function isWhatsAppTemplateHeaderMediaMimeType(params: {
  kind: WhatsAppTemplateHeaderMediaKind;
  mimeType: string | null | undefined;
}): boolean {
  return getWhatsAppOfficialMediaType(params.mimeType) === params.kind;
}

export function isWhatsAppWebhookMediaMessageType(
  value: string | null | undefined
): value is WhatsAppWebhookMediaMessageType {
  return (WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES as readonly string[]).includes(
    value || ""
  );
}

export function getWhatsAppOfficialMediaMaxBytes(
  mediaType: WhatsAppOfficialMediaType
): number {
  return WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES[mediaType];
}

export function classifyWhatsAppUploadMedia(params: {
  mimeType?: string | null;
  fileName?: string | null;
}): WhatsAppMediaClassification {
  const resolution = resolveWhatsAppUploadMimeType(params);
  const mediaType = getWhatsAppOfficialMediaType(resolution.mimeType);

  return {
    ...resolution,
    mediaType,
    isSupported: Boolean(mediaType),
  };
}
