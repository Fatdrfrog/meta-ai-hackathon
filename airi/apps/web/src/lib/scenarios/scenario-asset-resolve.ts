import "server-only";

import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import {
  resolveCreativeAssetGcsObjectRef,
  type MediaApiCreativeAssetKind,
} from "@icecore/airi-runtime/media-api";
import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import {
  canonicalizeScenarioActionAttachment,
  canonicalizeScenarioAssetUrl,
} from "@/lib/scenarios/scenario-asset-refs";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

/**
 * Resolve-only helpers for scenario media (no Media API client).
 *
 * Used by:
 * - delivery edge (`whatsapp-service-message-media` / outbound)
 * - UI enrichment (`scenario-asset-media-enrichment`)
 *
 * Worker wires GCS signer; web wires Media API. Upload stays in
 * `scenario-asset-storage`.
 */

export {
  canonicalizeScenarioActionAttachment,
  canonicalizeScenarioAssetUrl,
};

export function resolveScenarioAssetMediaKind(
  mimeType: string
): MediaApiCreativeAssetKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "text";
}

export async function resolveScenarioAssetHttpsUrl(params: {
  workspaceId?: string | null;
  url?: string | null;
  bucket?: string | null;
  path?: string | null;
}): Promise<string | null> {
  const url = readTrimmedString(params.url);
  const ref = resolveCreativeAssetGcsObjectRef(params);

  if (!ref) {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    return url || null;
  }

  const read = await createCreativeAssetReadUrl({
    provider: "gcs",
    bucket: ref.bucket,
    path: ref.path,
    workspaceId: readTrimmedString(params.workspaceId) || undefined,
  });
  return read.url;
}

export async function resolveScenarioActionAttachmentHttpsUrl(params: {
  workspaceId?: string | null;
  attachment: ScenarioActionAttachment;
}): Promise<ScenarioActionAttachment> {
  const httpsUrl = await resolveScenarioAssetHttpsUrl({
    workspaceId: params.workspaceId,
    url: params.attachment.url,
    bucket: params.attachment.bucket,
    path: params.attachment.path,
  });
  if (!httpsUrl || httpsUrl === params.attachment.url) {
    return params.attachment;
  }
  return {
    ...params.attachment,
    url: httpsUrl,
  };
}
