import {
  canonicalGcsUri,
  parseCanonicalGcsUri,
  resolveCreativeAssetGcsObjectRef,
} from "@icecore/airi-runtime/media-api";
import {
  mapScenarioNodeMedia,
  readScenarioActionAttachment,
  type ScenarioActionAttachment,
} from "@icecore/scenario-contracts";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

export function canonicalizeScenarioAssetUrl(params: {
  url?: string | null;
  bucket?: string | null;
  path?: string | null;
}): string | null {
  const ref = resolveCreativeAssetGcsObjectRef(params);
  if (ref) {
    return canonicalGcsUri(ref.bucket, ref.path);
  }
  const url = readTrimmedString(params.url);
  return url || null;
}

export function canonicalizeScenarioActionAttachment<
  T extends ScenarioActionAttachment,
>(attachment: T): T {
  const url = canonicalizeScenarioAssetUrl(attachment);
  if (!url) return attachment;
  const parsed = parseCanonicalGcsUri(url);
  return {
    ...attachment,
    url,
    ...(parsed
      ? {
          bucket: parsed.bucket,
          path: parsed.path,
        }
      : {}),
  };
}

export function canonicalizeScenarioNodeMediaForPersistence(
  data: Record<string, unknown>
): Record<string, unknown> {
  const next = mapScenarioNodeMedia(data, (value, location) => {
    // Only attachments are canonicalized; legacy image URLs are rebuilt below.
    if (
      location.kind === "action_image_url" ||
      location.kind === "action_media_asset"
    ) {
      return value;
    }
    const attachment = readScenarioActionAttachment(value);
    return attachment
      ? canonicalizeScenarioActionAttachment(attachment)
      : value;
  });
  if (!Array.isArray(next.actionAttachments)) return next;
  return {
    ...next,
    actionImageUrls: next.actionAttachments
      .map((item: unknown) => readScenarioActionAttachment(item)?.url)
      .filter((url): url is string => Boolean(url)),
  };
}
