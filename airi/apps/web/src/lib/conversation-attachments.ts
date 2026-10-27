import type {
  OutboundAttachment,
  OutboundAttachmentMediaType,
} from "@/types/outbound-attachment";
import {
  INSTAGRAM_DM_CONVERSATION_ATTACHMENT_ACCEPT,
  INSTAGRAM_DM_MEDIA_MAX_BYTES,
  TELEGRAM_CONVERSATION_ATTACHMENT_ACCEPT,
  WHATSAPP_OFFICIAL_MEDIA_ACCEPT,
  classifyInstagramDmUploadMedia,
  classifyWhatsAppUploadMedia,
  detectGenericOutboundAttachmentMediaType,
  getGenericAttachmentMediaTypeFromMimeType,
  isGenericAttachmentUrlForMediaType,
  isGenericMediaMimeType,
  isMediaMimeType,
  getWhatsAppOfficialMediaMaxBytes,
  normalizeMediaMimeType,
} from "@/lib/whatsapp/media-types";
import { type WhatsAppOfficialMediaType } from "@icecore/whatsapp/mediaTypes";
import { DEFAULT_CONVERSATION_ATTACHMENTS_BUCKET_NAME } from "@/lib/storage-buckets";

type ConversationAttachmentChannel =
  | "whatsapp"
  | "telegram"
  | "instagram"
  | "email"
  | "web_widget"
  | string;

type AttachmentValidationInput = {
  channel?: ConversationAttachmentChannel | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  isInstagramCommentThread?: boolean;
};

type AttachmentValidationSuccess<
  TMediaType extends OutboundAttachmentMediaType = OutboundAttachmentMediaType,
> = {
  ok: true;
  attachment: {
    mediaType: TMediaType;
    mimeType: string;
  };
};

type AttachmentValidationFailure = {
  ok: false;
  error: string;
};

export type ConversationAttachmentValidationResult =
  | AttachmentValidationSuccess
  | AttachmentValidationFailure;

export type WhatsAppConversationAttachmentValidationResult =
  | AttachmentValidationSuccess<WhatsAppOfficialMediaType>
  | AttachmentValidationFailure;

export const CONVERSATION_ATTACHMENT_BUCKET_NAME =
  DEFAULT_CONVERSATION_ATTACHMENTS_BUCKET_NAME;

export const CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export type ConversationAttachmentLookupType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "any";

export type ConversationAttachmentRef = {
  url?: string | null;
  contentType?: string | null;
};

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

function normalizeFileName(fileName: string | null | undefined): string {
  return fileName?.trim() || "attachment";
}

export function normalizeConversationAttachmentLabel(
  value: string | null | undefined
): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isConversationAttachmentLabelOnlyText(
  text: string | null | undefined,
  fileName: string | null | undefined
): boolean {
  const normalizedText = normalizeConversationAttachmentLabel(text);
  const normalizedFileName = normalizeConversationAttachmentLabel(fileName);
  return Boolean(
    normalizedText &&
      normalizedFileName &&
      normalizedText === normalizedFileName
  );
}

export function formatConversationAttachmentFileSize(
  size: number | null | undefined
): string | null {
  if (!size || !Number.isFinite(size)) return null;
  return size > 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(2)} MB`
    : `${(size / 1024).toFixed(1)} KB`;
}

export function isConversationVideoMimeType(mimeType?: string): boolean {
  return isMediaMimeType(mimeType, "video");
}

export function isConversationImageMimeType(mimeType?: string): boolean {
  return isMediaMimeType(mimeType, "image");
}

export function isConversationAudioMimeType(mimeType?: string): boolean {
  return isMediaMimeType(mimeType, "audio");
}

export function getConversationAttachmentUrlByType(
  attachments: ConversationAttachmentRef[] | null | undefined,
  type: ConversationAttachmentLookupType
): { url?: string; contentType?: string } {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return {};
  }

  const validAttachments = attachments.filter(
    attachment =>
      typeof attachment?.url === "string" && attachment.url.trim().length > 0
  );
  if (validAttachments.length === 0) {
    return {};
  }

  const toResult = (attachment: ConversationAttachmentRef) => ({
    url: attachment.url || undefined,
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
  });

  if (type === "any") {
    return toResult(validAttachments[0]);
  }

  const matchesByContentType = validAttachments.find(attachment => {
    const contentType = normalizeMediaMimeType(attachment.contentType);
    if (!contentType || isGenericMediaMimeType(contentType)) {
      return false;
    }
    return getGenericAttachmentMediaTypeFromMimeType(contentType) === type;
  });
  if (matchesByContentType?.url) {
    return toResult(matchesByContentType);
  }

  const matchesByExtension = validAttachments.find(attachment =>
    isGenericAttachmentUrlForMediaType(attachment.url, type)
  );
  if (matchesByExtension?.url) {
    return toResult(matchesByExtension);
  }

  return {};
}

export function getConversationAttachmentChannelIssue(params: {
  channel?: ConversationAttachmentChannel | null;
  isInstagramCommentThread?: boolean;
}): string | null {
  if (params.channel === "whatsapp" || params.channel === "telegram") {
    return null;
  }

  if (params.channel === "instagram") {
    return params.isInstagramCommentThread
      ? "Attachments are not supported for Instagram comment replies."
      : null;
  }

  return "Attachments are not supported for this conversation channel.";
}

export function supportsConversationAttachments(params: {
  channel?: ConversationAttachmentChannel | null;
  isInstagramCommentThread?: boolean;
}): boolean {
  return !getConversationAttachmentChannelIssue(params);
}

export function getConversationAttachmentAccept(params: {
  channel?: ConversationAttachmentChannel | null;
  isInstagramCommentThread?: boolean;
}): string | undefined {
  if (!supportsConversationAttachments(params)) return undefined;
  if (params.channel === "whatsapp") return WHATSAPP_OFFICIAL_MEDIA_ACCEPT;
  if (params.channel === "telegram")
    return TELEGRAM_CONVERSATION_ATTACHMENT_ACCEPT;
  if (params.channel === "instagram")
    return INSTAGRAM_DM_CONVERSATION_ATTACHMENT_ACCEPT;
  return undefined;
}

function getSizeIssue(params: {
  fileName: string;
  fileSize?: number | null;
  maxBytes: number;
  channel: string;
}): string | null {
  if (
    typeof params.fileSize !== "number" ||
    !Number.isFinite(params.fileSize)
  ) {
    return null;
  }

  if (params.fileSize <= 0) return `${params.fileName}: empty file`;
  if (params.fileSize <= params.maxBytes) return null;

  return `${params.fileName}: ${params.channel} attachments are limited to ${formatBytes(params.maxBytes)}.`;
}

export function validateConversationAttachmentFile(
  input: AttachmentValidationInput & { channel: "whatsapp" }
): WhatsAppConversationAttachmentValidationResult;
export function validateConversationAttachmentFile(
  input: AttachmentValidationInput
): ConversationAttachmentValidationResult;
export function validateConversationAttachmentFile(
  input: AttachmentValidationInput
): ConversationAttachmentValidationResult {
  const fileName = normalizeFileName(input.fileName);
  const channelIssue = getConversationAttachmentChannelIssue({
    channel: input.channel,
    isInstagramCommentThread: input.isInstagramCommentThread,
  });
  if (channelIssue) return { ok: false, error: `${fileName}: ${channelIssue}` };

  if (input.channel === "whatsapp") {
    const classification = classifyWhatsAppUploadMedia({
      mimeType: input.mimeType,
      fileName,
    });
    if (!classification.mediaType) {
      return {
        ok: false,
        error: `${fileName}: this file type is not supported for WhatsApp attachments.`,
      };
    }

    const maxBytes = getWhatsAppOfficialMediaMaxBytes(classification.mediaType);
    const sizeIssue = getSizeIssue({
      fileName,
      fileSize: input.fileSize,
      maxBytes,
      channel: "WhatsApp",
    });
    if (sizeIssue) return { ok: false, error: sizeIssue };

    return {
      ok: true,
      attachment: {
        mediaType: classification.mediaType,
        mimeType: classification.mimeType,
      },
    };
  }

  if (input.channel === "instagram") {
    const classification = classifyInstagramDmUploadMedia({
      mimeType: input.mimeType,
      fileName,
    });
    if (!classification.mediaType) {
      return {
        ok: false,
        error: `${fileName}: Instagram accepts PNG, JPEG or GIF images, MP4, MOV, WEBM, AVI or OGG video, AAC, M4A or WAV audio, and PDF files.`,
      };
    }

    // Attachments are stored before Meta fetches them, so the storage cap
    // applies on top of Meta's per-type limit.
    const sizeIssue = getSizeIssue({
      fileName,
      fileSize: input.fileSize,
      maxBytes: Math.min(
        INSTAGRAM_DM_MEDIA_MAX_BYTES[classification.mediaType],
        CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES
      ),
      channel: `Instagram ${classification.mediaType === "document" ? "file" : classification.mediaType}`,
    });
    if (sizeIssue) return { ok: false, error: sizeIssue };

    return {
      ok: true,
      attachment: {
        mediaType: classification.mediaType,
        mimeType: classification.mimeType,
      },
    };
  }

  const mediaType = detectGenericOutboundAttachmentMediaType({
    mimeType: input.mimeType,
    fileName,
  });

  const sizeIssue = getSizeIssue({
    fileName,
    fileSize: input.fileSize,
    maxBytes: CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES,
    channel: "Conversation",
  });
  if (sizeIssue) return { ok: false, error: sizeIssue };

  return {
    ok: true,
    attachment: {
      mediaType,
      mimeType:
        normalizeMediaMimeType(input.mimeType) || "application/octet-stream",
    },
  };
}

export function normalizeConversationOutboundAttachments(params: {
  channel?: ConversationAttachmentChannel | null;
  attachments: OutboundAttachment[];
  isInstagramCommentThread?: boolean;
}):
  | { ok: true; attachments: OutboundAttachment[] }
  | { ok: false; error: string } {
  if (params.attachments.length === 0) {
    return { ok: true, attachments: [] };
  }

  const normalized: OutboundAttachment[] = [];
  for (const attachment of params.attachments) {
    const validation = validateConversationAttachmentFile({
      channel: params.channel,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      isInstagramCommentThread: params.isInstagramCommentThread,
    });
    if (!validation.ok) return validation;

    normalized.push({
      ...attachment,
      mediaType: validation.attachment.mediaType,
      mimeType: validation.attachment.mimeType,
    });
  }

  return { ok: true, attachments: normalized };
}

export function partitionConversationAttachmentFiles(params: {
  channel?: ConversationAttachmentChannel | null;
  files: File[];
  isInstagramCommentThread?: boolean;
}): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];

  for (const file of params.files) {
    const validation = validateConversationAttachmentFile({
      channel: params.channel,
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      isInstagramCommentThread: params.isInstagramCommentThread,
    });

    if (validation.ok) {
      accepted.push(file);
    } else {
      rejected.push(validation.error);
    }
  }

  return { accepted, rejected };
}
