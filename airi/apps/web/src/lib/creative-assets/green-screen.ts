import {
  AIRI_GREEN_SCREEN_LEGACY_MODEL_ID,
  AIRI_GREEN_SCREEN_MODEL_ID,
  AIRI_GREEN_SCREEN_RETRY_MODEL_IDS,
} from "@icecore/temporal";

export {
  AIRI_GREEN_SCREEN_LEGACY_MODEL_ID,
  AIRI_GREEN_SCREEN_MODEL_ID,
  AIRI_GREEN_SCREEN_RETRY_MODEL_IDS,
};

type GreenScreenAssetCandidate = {
  source?: unknown;
  provider?: unknown;
  modelId?: unknown;
  sourceAssetId?: unknown;
  status?: unknown;
};

export function isAiriGreenScreenAsset(
  asset: GreenScreenAssetCandidate
): asset is GreenScreenAssetCandidate & { sourceAssetId: string } {
  return (
    asset.source === "edited" &&
    asset.provider === "airi" &&
    asset.modelId === AIRI_GREEN_SCREEN_MODEL_ID &&
    typeof asset.sourceAssetId === "string" &&
    asset.sourceAssetId.trim().length > 0
  );
}

export function isRetryableAiriGreenScreenAsset(
  asset: GreenScreenAssetCandidate
): asset is GreenScreenAssetCandidate & { sourceAssetId: string } {
  return (
    asset.source === "edited" &&
    asset.provider === "airi" &&
    typeof asset.modelId === "string" &&
    AIRI_GREEN_SCREEN_RETRY_MODEL_IDS.includes(
      asset.modelId as (typeof AIRI_GREEN_SCREEN_RETRY_MODEL_IDS)[number]
    ) &&
    typeof asset.sourceAssetId === "string" &&
    asset.sourceAssetId.trim().length > 0
  );
}

export function isBlockingAiriGreenScreenAsset(
  asset: GreenScreenAssetCandidate
): asset is GreenScreenAssetCandidate & { sourceAssetId: string } {
  if (isAiriGreenScreenAsset(asset)) return true;

  return (
    isRetryableAiriGreenScreenAsset(asset) &&
    asset.modelId === AIRI_GREEN_SCREEN_LEGACY_MODEL_ID &&
    asset.status === "failed"
  );
}

export function collectGreenScreenSourceAssetIds(
  assets: GreenScreenAssetCandidate[]
): string[] {
  const sourceIds = new Set<string>();
  for (const asset of assets) {
    if (isBlockingAiriGreenScreenAsset(asset)) {
      sourceIds.add(asset.sourceAssetId.trim());
    }
  }
  return Array.from(sourceIds);
}
