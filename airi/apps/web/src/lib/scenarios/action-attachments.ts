import type {
  ScenarioActionAttachment,
  ScenarioGenericActionAttachment,
} from "@icecore/scenario-contracts";
import { canonicalizeScenarioActionAttachment } from "@/lib/scenarios/scenario-asset-refs";
import { inferScenarioActionAttachmentMediaTypeFromUrl } from "@/lib/whatsapp/media-types";
import { z } from "zod";
import { isRecord } from "@icecore/shared/lib/value-utils";

export const MAX_WHATSAPP_ACTION_ATTACHMENTS = 1;

const scenarioActionAttachmentMediaTypeSchema = z.enum([
  "image",
  "video",
  "document",
]);

const scenarioActionAttachmentUrlSchema = z
  .string()
  .trim()
  .max(4000)
  .refine(
    value =>
      value.startsWith("gcs://") ||
      value.startsWith("http://") ||
      value.startsWith("https://"),
    { message: "Attachment URL must be http(s) or gcs://" }
  );

export const scenarioActionAttachmentSchema = z.object({
  url: scenarioActionAttachmentUrlSchema,
  mediaType: scenarioActionAttachmentMediaTypeSchema,
  mimeType: z.string().trim().max(200).optional(),
  fileName: z.string().trim().max(240).optional(),
  fileSize: z.number().int().positive().optional(),
  bucket: z.string().trim().max(240).optional(),
  path: z.string().trim().max(1000).optional(),
});

function normalizeText(value: unknown, maxLength = 4000): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

export function inferScenarioActionAttachmentMediaType(
  value: unknown
): ScenarioGenericActionAttachment["mediaType"] {
  return inferScenarioActionAttachmentMediaTypeFromUrl(String(value || ""));
}

export function isScenarioGenericActionAttachment(
  attachment: ScenarioActionAttachment
): attachment is ScenarioGenericActionAttachment {
  return (
    attachment.mediaType === "image" ||
    attachment.mediaType === "video" ||
    attachment.mediaType === "document"
  );
}

function normalizeScenarioActionAttachmentRecord(
  value: unknown
): ScenarioGenericActionAttachment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const url = normalizeText(record.url);
  if (!url) return null;

  const mediaTypeRaw = normalizeText(record.mediaType, 40);
  if (mediaTypeRaw === "audio" || mediaTypeRaw === "sticker") return null;
  const mediaType = scenarioActionAttachmentMediaTypeSchema.safeParse(
    mediaTypeRaw
  ).success
    ? (mediaTypeRaw as ScenarioGenericActionAttachment["mediaType"])
    : inferScenarioActionAttachmentMediaType(url);

  const parsed = scenarioActionAttachmentSchema.safeParse({
    url,
    mediaType,
    mimeType: normalizeText(record.mimeType, 200),
    fileName: normalizeText(record.fileName, 240),
    fileSize:
      typeof record.fileSize === "number" && Number.isFinite(record.fileSize)
        ? Math.round(record.fileSize)
        : undefined,
    bucket: normalizeText(record.bucket, 240),
    path: normalizeText(record.path, 1000),
  });

  return parsed.success
    ? canonicalizeScenarioActionAttachment(parsed.data)
    : null;
}

function getExplicitServiceOnlyAttachmentUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const mediaType = normalizeText(record.mediaType, 40);
  if (mediaType !== "audio" && mediaType !== "sticker") return null;
  return normalizeText(record.url) || null;
}

function legacyUrlToAttachment(
  url: unknown
): ScenarioGenericActionAttachment | null {
  const normalizedUrl = normalizeText(url);
  if (!normalizedUrl) return null;
  const parsed = scenarioActionAttachmentSchema.safeParse({
    url: normalizedUrl,
    mediaType: inferScenarioActionAttachmentMediaType(normalizedUrl),
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeScenarioActionAttachments(params: {
  attachments?: unknown;
  legacyUrls?: unknown;
  generatedAssets?: unknown;
  limit?: number;
}): ScenarioGenericActionAttachment[] {
  const limit = Math.max(0, params.limit ?? MAX_WHATSAPP_ACTION_ATTACHMENTS);
  if (limit === 0) return [];

  const normalized: ScenarioGenericActionAttachment[] = [];
  const seen = new Set<string>();
  const rejectedLegacyUrls = new Set<string>();
  const append = (attachment: ScenarioGenericActionAttachment | null) => {
    if (!attachment || seen.has(attachment.url)) return;
    seen.add(attachment.url);
    normalized.push(attachment);
  };

  if (Array.isArray(params.attachments)) {
    for (const value of params.attachments) {
      const rejectedUrl = getExplicitServiceOnlyAttachmentUrl(value);
      if (rejectedUrl) {
        rejectedLegacyUrls.add(rejectedUrl);
        continue;
      }
      append(normalizeScenarioActionAttachmentRecord(value));
      if (normalized.length >= limit) return normalized;
    }
  }

  if (Array.isArray(params.legacyUrls)) {
    for (const url of params.legacyUrls) {
      const normalizedUrl = normalizeText(url);
      if (normalizedUrl && rejectedLegacyUrls.has(normalizedUrl)) continue;
      append(legacyUrlToAttachment(url));
      if (normalized.length >= limit) return normalized;
    }
  }

  if (Array.isArray(params.generatedAssets)) {
    for (const asset of params.generatedAssets) {
      if (!isRecord(asset) || asset.kind === "audio") continue;
      append(
        normalizeScenarioActionAttachmentRecord({
          url: asset.url,
          mediaType:
            asset.kind === "image" || asset.kind === "video"
              ? asset.kind
              : "document",
          mimeType: asset.mimeType,
          fileName: asset.fileName,
        })
      );
      if (normalized.length >= limit) return normalized;
    }
  }

  return normalized;
}
