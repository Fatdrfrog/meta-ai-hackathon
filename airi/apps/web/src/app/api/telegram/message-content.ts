import type {
  TelegramAnimation,
  TelegramAudio,
  TelegramDocument,
  TelegramMessage,
  TelegramSticker,
  TelegramVideo,
  TelegramVideoNote,
  TelegramVoice,
} from "@/types/telegram";
import { readNonEmptyStringOrUndefined as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

type TelegramPersistedMediaType =
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "voice";

export type TelegramMediaMetadata = {
  mediaType: TelegramPersistedMediaType;
  fileId: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
};

export function extractTelegramMediaMetadata(
  message: TelegramMessage
): TelegramMediaMetadata | null {
  const document = message.document as TelegramDocument | undefined;
  if (document) {
    return {
      mediaType: "document",
      fileId: document.file_id,
      mimeType: normalizeOptionalString(document.mime_type),
      fileName: normalizeOptionalString(document.file_name),
      fileSize:
        typeof document.file_size === "number" ? document.file_size : undefined,
    };
  }

  const video = message.video as TelegramVideo | undefined;
  if (video) {
    return {
      mediaType: "video",
      fileId: video.file_id,
      mimeType: normalizeOptionalString(video.mime_type),
      fileSize:
        typeof video.file_size === "number" ? video.file_size : undefined,
    };
  }

  const animation = message.animation as TelegramAnimation | undefined;
  if (animation) {
    return {
      mediaType: "video",
      fileId: animation.file_id,
      mimeType: normalizeOptionalString(animation.mime_type),
      fileName: normalizeOptionalString(animation.file_name),
      fileSize:
        typeof animation.file_size === "number"
          ? animation.file_size
          : undefined,
    };
  }

  const videoNote = message.video_note as TelegramVideoNote | undefined;
  if (videoNote) {
    return {
      mediaType: "video",
      fileId: videoNote.file_id,
      fileSize:
        typeof videoNote.file_size === "number"
          ? videoNote.file_size
          : undefined,
    };
  }

  const audio = message.audio as TelegramAudio | undefined;
  if (audio) {
    return {
      mediaType: "audio",
      fileId: audio.file_id,
      mimeType: normalizeOptionalString(audio.mime_type),
      fileName: normalizeOptionalString(audio.file_name),
      fileSize:
        typeof audio.file_size === "number" ? audio.file_size : undefined,
    };
  }

  const voice = message.voice as TelegramVoice | undefined;
  if (voice) {
    return {
      mediaType: "voice",
      fileId: voice.file_id,
      mimeType: normalizeOptionalString(voice.mime_type),
      fileSize:
        typeof voice.file_size === "number" ? voice.file_size : undefined,
    };
  }

  const sticker = message.sticker as TelegramSticker | undefined;
  if (sticker) {
    return {
      mediaType: "sticker",
      fileId: sticker.file_id,
      fileSize:
        typeof sticker.file_size === "number" ? sticker.file_size : undefined,
    };
  }

  return null;
}

export function hasTelegramPersistableContent(
  message: TelegramMessage
): boolean {
  const hasText =
    typeof message.text === "string" && message.text.trim().length > 0;
  if (hasText) return true;

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return true;
  }

  const hasCaption =
    typeof message.caption === "string" && message.caption.trim().length > 0;
  if (hasCaption) return true;

  return Boolean(extractTelegramMediaMetadata(message));
}
