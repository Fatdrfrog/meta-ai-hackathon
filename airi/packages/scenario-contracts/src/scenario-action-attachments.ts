export type ScenarioActionAttachmentMediaType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker";

export type ScenarioActionAttachment = {
  url: string;
  mediaType: ScenarioActionAttachmentMediaType;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  bucket?: string;
  path?: string;
};

/**
 * The stored value as an attachment when it names a URL and a media type;
 * other fields are returned as stored.
 */
export function readScenarioActionAttachment(
  value: unknown,
): ScenarioActionAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const mediaType =
    typeof record.mediaType === "string" ? record.mediaType.trim() : "";
  if (!url || !mediaType) return null;
  return value as ScenarioActionAttachment;
}

export type ScenarioGenericActionAttachment = Omit<
  ScenarioActionAttachment,
  "mediaType"
> & {
  mediaType: Extract<
    ScenarioActionAttachmentMediaType,
    "image" | "video" | "document"
  >;
};
