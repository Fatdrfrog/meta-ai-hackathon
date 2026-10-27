/**
 * Maps app language codes to MongoDB text search languages.
 * Unsupported languages use "none" to disable stemming/stop-words.
 */
export function toMongoTextLanguage(language?: string | null): string {
  const normalized = (language || "").trim().toLowerCase().replace("_", "-");

  if (!normalized) return "none";
  if (normalized === "none") return "none";
  if (normalized === "ru" || normalized.startsWith("ru-")) return "russian";
  if (
    normalized === "en" ||
    normalized.startsWith("en-") ||
    normalized === "english"
  ) {
    return "english";
  }

  // "kz"/"kk", "uz", and most other languages are not supported by Mongo text stemming.
  return "none";
}
