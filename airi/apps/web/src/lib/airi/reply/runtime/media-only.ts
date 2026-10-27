import { normalizeAiriLanguage } from "@/lib/airi/shared/language-policy";

type MediaOnlyClarificationLanguage = string | null | undefined;

function normalizeReplyLanguage(
  language: MediaOnlyClarificationLanguage
): "ru" | "kz" | "en" {
  const normalized = normalizeAiriLanguage(language);

  if (normalized === "kz") return "kz";
  if (normalized === "ru") return "ru";
  return "en";
}

function normalizeMediaLabel(
  mediaType: string | null | undefined,
  language: "ru" | "kz" | "en"
): string {
  const normalized = String(mediaType || "")
    .trim()
    .toLowerCase();
  const mediaKind =
    normalized === "video" ||
    normalized.startsWith("video/") ||
    /\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/i.test(normalized)
      ? "video"
      : normalized === "image" || normalized.startsWith("image/")
        ? "image"
        : normalized === "document" ||
            normalized === "file" ||
            normalized === "attachment" ||
            normalized === "application/pdf"
          ? "document"
          : normalized === "audio" ||
              normalized === "voice" ||
              normalized.startsWith("audio/")
            ? "audio"
            : "generic";

  if (language === "kz") {
    switch (mediaKind) {
      case "video":
        return "видеоңыз";
      case "image":
        return "суретіңіз";
      case "document":
        return "құжатыңыз";
      case "audio":
        return "аудиоңыз";
      default:
        return "материалыңыз";
    }
  }

  if (language === "ru") {
    switch (mediaKind) {
      case "video":
        return "видео";
      case "image":
        return "изображение";
      case "document":
        return "документ";
      case "audio":
        return "аудио";
      default:
        return "вложение";
    }
  }

  switch (mediaKind) {
    case "video":
      return "video";
    case "image":
      return "image";
    case "document":
      return "document";
    case "audio":
      return "audio";
    default:
      return "attachment";
  }
}

export function buildMediaOnlyClarification(
  language: MediaOnlyClarificationLanguage,
  mediaType?: string | null
): string {
  const normalizedLanguage = normalizeReplyLanguage(language);
  const mediaLabel = normalizeMediaLabel(mediaType, normalizedLanguage);

  if (normalizedLanguage === "kz") {
    return `Рақмет! Сіздің ${mediaLabel} алынды.\n\nОсы материал бойынша нақты не қызықтыратынын жазыңыз, көмектесуге тырысамын.`;
  }

  if (normalizedLanguage === "ru") {
    return `Спасибо! Ваше ${mediaLabel} получено.\n\nНапишите, пожалуйста, что именно вас интересует по этому материалу, и я постараюсь помочь.`;
  }

  return `Thanks! I received your ${mediaLabel}.\n\nPlease tell me what you'd like to know about it, and I'll do my best to help.`;
}
