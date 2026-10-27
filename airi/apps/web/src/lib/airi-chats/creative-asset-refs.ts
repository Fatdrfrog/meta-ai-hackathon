const AIRI_CREATIVE_ASSET_URI_PREFIX = "airi://creative-assets/";

export function buildAiriCreativeAssetUri(assetId: string): string {
  return `${AIRI_CREATIVE_ASSET_URI_PREFIX}${assetId.trim()}`;
}

export function parseAiriCreativeAssetUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(AIRI_CREATIVE_ASSET_URI_PREFIX)) return null;
  const assetId = trimmed.slice(AIRI_CREATIVE_ASSET_URI_PREFIX.length).trim();
  return assetId || null;
}

export function isAiriCreativeAssetUri(
  value: unknown
): value is `${typeof AIRI_CREATIVE_ASSET_URI_PREFIX}${string}` {
  return Boolean(parseAiriCreativeAssetUri(value));
}
