import type { ConversationChannel } from "@icecore/shared/types/sources";
import { readBodyBytesWithinLimit } from "@/lib/api/json-body";
import { CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES } from "@/lib/conversation-attachments";
import { safeCrawlFetch } from "@/lib/crawler/url-safety";
import {
  isInstagramCdnMediaUrl,
  type ProviderMessageMediaType,
} from "@/lib/provider-message-display";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { storeSupabaseWorkspaceBuffer } from "@icecore/airi-runtime/storage-quota";
import { buildWhatsAppMediaProxyUrl } from "@/lib/media/whatsapp-media-url";
import {
  downloadWhatsAppMediaUrl,
  getWhatsAppMediaInfoFromMeta,
} from "@/lib/media/whatsapp-media-graph";
import { CONVERSATION_IMAGES_BUCKET_NAME } from "@/lib/storage-buckets";
import {
  getGenericAttachmentMediaTypeFromMimeType,
  isGenericMediaMimeType,
  normalizeWhatsAppMimeType,
  resolveWhatsAppUploadMimeType,
} from "@/lib/whatsapp/media-types";

interface MediaUploadOptions {
  channel: ConversationChannel;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  buffer?: Buffer;
  contentType?: string;
  filename?: string;
  downloadUrl?: string;
  caption?: string;
}

interface MediaUploadResult {
  publicUrl: string;
  storagePath: string;
  size: number;
  contentType: string;
  filename?: string;
  mediaType?:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "voice"
    | "file";
}

const STORAGE_BUCKET = CONVERSATION_IMAGES_BUCKET_NAME;
// The conversation buckets refuse larger objects (20 MiB ceiling since
// 2026-10-10), so bigger WhatsApp media stays proxied from Meta.
const MAX_PERSISTED_WHATSAPP_MEDIA_BYTES =
  CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES;

const normalizeStorageContentType = (contentType: string | null | undefined) =>
  normalizeWhatsAppMimeType(contentType) || "application/octet-stream";

export async function uploadMedia(
  options: MediaUploadOptions
): Promise<MediaUploadResult> {
  let buffer: Buffer;
  let contentType: string;
  let size: number;

  // Download from URL if provided (Telegram, WhatsApp)
  if (options.downloadUrl) {
    const response = await fetch(options.downloadUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download media from URL: ${response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    const responseContentType = response.headers.get("content-type");
    contentType =
      !isGenericMediaMimeType(responseContentType) || !options.contentType
        ? responseContentType ||
          options.contentType ||
          "application/octet-stream"
        : options.contentType;
    size = buffer.length;
  }
  // Use provided buffer (Widget, Email)
  else if (options.buffer) {
    buffer = options.buffer;
    contentType = options.contentType || "application/octet-stream";
    size = buffer.length;
  } else {
    throw new Error("Either downloadUrl or buffer must be provided");
  }

  contentType = normalizeStorageContentType(contentType);

  // Generate storage path with channel prefix
  // Format: {channel}/{workspaceId}/{conversationId}/{messageId}.{ext}
  const extension = getExtensionFromContentType(contentType, options.filename);
  const storagePath = `${options.channel}/${options.workspaceId}/${options.conversationId}/${options.messageId}.${extension}`;

  await storeSupabaseWorkspaceBuffer({
    storage: supabaseAdmin.storage,
    workspaceId: options.workspaceId,
    bucket: STORAGE_BUCKET,
    path: storagePath,
    buffer,
    mimeType: contentType,
    cacheControl: "public, max-age=31536000, immutable",
  });

  // Get public URL
  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

  return {
    publicUrl,
    storagePath,
    size,
    contentType,
    filename: options.filename,
  };
}

/**
 * Get file extension from content type or filename
 */
function getExtensionFromContentType(
  contentType: string,
  filename?: string
): string {
  // Try to get extension from filename first
  if (filename) {
    const ext = filename.split(".").pop();
    if (ext && ext.length <= 5) {
      return ext.toLowerCase();
    }
  }

  // Fallback to content type mapping
  const typeMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "txt",
  };

  return typeMap[contentType] || "bin";
}

/**
 * Telegram-specific: Download and upload photo
 */
export async function handleTelegramPhoto(
  fileUrl: string,
  workspaceId: string,
  conversationId: string,
  messageId: string
): Promise<MediaUploadResult> {
  return uploadMedia({
    channel: "telegram",
    workspaceId,
    conversationId,
    messageId,
    downloadUrl: fileUrl,
    contentType: "image/jpeg", // Telegram photos are always JPEG
  });
}

function getDefaultTelegramMediaContentType(
  mediaType: NonNullable<MediaUploadResult["mediaType"]>
): string {
  switch (mediaType) {
    case "voice":
      return "audio/ogg";
    case "audio":
      return "audio/mpeg";
    case "video":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

export async function handleTelegramMedia(
  fileUrl: string,
  workspaceId: string,
  conversationId: string,
  messageId: string,
  options: {
    mediaType: NonNullable<MediaUploadResult["mediaType"]>;
    contentType?: string;
    filename?: string;
  }
): Promise<MediaUploadResult> {
  const result = await uploadMedia({
    channel: "telegram",
    workspaceId,
    conversationId,
    messageId,
    downloadUrl: fileUrl,
    contentType:
      options.contentType ||
      getDefaultTelegramMediaContentType(options.mediaType),
    filename: options.filename,
  });

  return {
    ...result,
    mediaType: options.mediaType,
  };
}

/** The webhook waits for the copy, and Meta retries one that runs ~20 s. */
const INSTAGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;
const INSTAGRAM_MEDIA_USER_AGENT =
  "Airi.chat Instagram Media/1.0 (https://airi.chat; support@airi.chat)";

function readContentDispositionFileName(value: string | null) {
  return value?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1]?.trim();
}

/**
 * Instagram-specific: copy webhook media off Meta's CDN, whose links expire
 * within days. The downloaded type decides the kind: Instagram sends clips as
 * `unsupported_type` and story videos as `story_mention`.
 */
export async function handleInstagramMedia(
  mediaUrl: string,
  workspaceId: string,
  conversationId: string,
  messageId: string
): Promise<MediaUploadResult & { mediaType: ProviderMessageMediaType }> {
  if (!isInstagramCdnMediaUrl(mediaUrl)) {
    throw new Error("Instagram media URL is not on Meta's CDN");
  }

  // One deadline for the whole download: safeCrawlFetch's own timeout ends
  // when headers arrive, so this signal is what bounds the body read.
  const deadline = new AbortController();
  const timeoutId = setTimeout(
    () => deadline.abort(),
    INSTAGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS
  );
  try {
    const response = await safeCrawlFetch(mediaUrl, {
      timeoutMs: INSTAGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS,
      userAgent: INSTAGRAM_MEDIA_USER_AGENT,
      signal: deadline.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to download Instagram media: ${response.status}`);
    }
    const { mimeType } = resolveWhatsAppUploadMimeType({
      mimeType: response.headers.get("content-type"),
      fileName: readContentDispositionFileName(
        response.headers.get("content-disposition")
      ),
    });
    if (mimeType === "text/html") {
      throw new Error("Instagram media URL returned a web page");
    }
    const body = await readBodyBytesWithinLimit(
      response,
      CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES,
      { signal: deadline.signal }
    );
    const result = await uploadMedia({
      channel: "instagram",
      workspaceId,
      conversationId,
      messageId,
      buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      contentType: mimeType,
    });
    const kind = getGenericAttachmentMediaTypeFromMimeType(result.contentType);
    return {
      ...result,
      mediaType: !kind || kind === "document" ? "file" : kind,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * WhatsApp-specific: Download and upload media
 * Supports: image, video, audio, document, sticker, voice
 *
 * @param metadata Optional metadata from webhook (mimeType, filename)
 *                 If provided, uses these instead of fetching from Graph API
 */
export async function handleWhatsAppMedia(
  mediaId: string,
  accessToken: string,
  workspaceId: string,
  conversationId: string,
  messageId: string,
  mediaType: "image" | "video" | "audio" | "document" | "sticker" | "voice",
  metadata?: {
    mimeType?: string;
    filename?: string;
  }
): Promise<MediaUploadResult> {
  // Step 1: Get media URL from WhatsApp Graph API
  const mediaInfo = await getWhatsAppMediaInfoFromMeta({
    mediaId,
    accessToken,
  });

  const contentType = normalizeStorageContentType(
    metadata?.mimeType || mediaInfo.mime_type || "application/octet-stream"
  );
  const filename = metadata?.filename;
  const mediaSize =
    typeof mediaInfo.file_size === "number" &&
    Number.isFinite(mediaInfo.file_size)
      ? mediaInfo.file_size
      : 0;

  const proxied = (size: number): MediaUploadResult => {
    console.log(`[WhatsApp Media Handler] Proxying large ${mediaType}:`, {
      mediaId,
      mimeType: contentType,
      filename,
      size,
    });

    return {
      publicUrl: buildWhatsAppMediaProxyUrl(conversationId, mediaId, filename),
      storagePath: "",
      size,
      contentType,
      filename,
      mediaType,
    };
  };

  if (mediaSize > MAX_PERSISTED_WHATSAPP_MEDIA_BYTES) {
    return proxied(mediaSize);
  }

  // Step 2: Download media from WhatsApp CDN (requires auth)
  const downloadResponse = await downloadWhatsAppMediaUrl({
    mediaUrl: mediaInfo.url,
    accessToken,
  });

  if (!downloadResponse.ok) {
    throw new Error(
      `Failed to download WhatsApp media: ${downloadResponse.statusText}`
    );
  }

  const arrayBuffer = await downloadResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  // Meta does not always report file_size; the bytes decide then.
  if (buffer.byteLength > MAX_PERSISTED_WHATSAPP_MEDIA_BYTES) {
    return proxied(buffer.byteLength);
  }

  console.log(`[WhatsApp Media Handler] Processing ${mediaType}:`, {
    mediaId,
    mimeType: contentType,
    filename,
    size: mediaSize,
    usingProvidedMetadata: !!metadata,
  });

  // Step 3: Upload to our storage using unified handler
  const result = await uploadMedia({
    channel: "whatsapp",
    workspaceId,
    conversationId,
    messageId,
    buffer,
    contentType,
    filename,
  });

  return {
    ...result,
    mediaType, // Include the mediaType in the result
  };
}
