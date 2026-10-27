import "server-only";
import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import { withCreativeAssetDisplayReadUrlCache } from "@/lib/google/creative-asset-read-url-cache";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import type { StoredFileRef } from "@/lib/products/types";

/**
 * Runs `work` with product photo links served from the read-URL cache: the
 * panel only displays them, and a link that stays the same across refreshes
 * isn't downloaded again.
 */
export function withProductPhotoUrls<T>(work: () => Promise<T>): Promise<T> {
  ensureMediaApiCreativeAssetReadUrlPort();
  return withCreativeAssetDisplayReadUrlCache(work);
}

/** A signed link to a product photo, or null when it has none or signing fails. */
export async function productPhotoUrl(
  workspaceId: string,
  ref: Partial<StoredFileRef> | null | undefined
): Promise<string | null> {
  if (!ref?.bucket || !ref.path) return null;
  try {
    const { url } = await createCreativeAssetReadUrl({
      provider: "gcs",
      bucket: ref.bucket,
      path: ref.path,
      workspaceId,
    });
    return url;
  } catch {
    // The shelf still lists the product, with its initial instead of a photo.
    return null;
  }
}
