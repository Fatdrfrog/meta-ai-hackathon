import connectDB from "@/lib/mongoose";
import {
  CreativeAsset,
  CREATIVE_ASSET_PLATFORM_QUOTA_INDEX,
  CREATIVE_ASSET_PLATFORM_QUOTA_LEGACY_INDEX_NAME,
  CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX,
  CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX,
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_LEGACY_INDEX_NAME,
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX,
  CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX,
  CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX,
} from "@/models/creative-asset";
import {
  VideoGenerationNsfwVerdict,
  VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX,
  VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX,
} from "@/models/video-generation-nsfw-verdict";

type CreativeAssetGenerationIndexCache = {
  ready: boolean;
  promise: Promise<void> | null;
};

const globalForCreativeAssetGenerationIndexes =
  globalThis as typeof globalThis & {
    __creativeAssetGenerationIndexCache?: CreativeAssetGenerationIndexCache;
  };

const creativeAssetGenerationIndexCache =
  globalForCreativeAssetGenerationIndexes.__creativeAssetGenerationIndexCache ?? {
    ready: false,
    promise: null,
  };

globalForCreativeAssetGenerationIndexes.__creativeAssetGenerationIndexCache =
  creativeAssetGenerationIndexCache;

function isMissingIndexError(error: unknown): boolean {
  const indexError = error as { code?: unknown; codeName?: unknown };
  return indexError.code === 27 || indexError.codeName === "IndexNotFound";
}

export async function createCreativeAssetGenerationIndexes(): Promise<void> {
  await CreativeAsset.collection.createIndex(
    CREATIVE_ASSET_PLATFORM_QUOTA_INDEX.key,
    { background: true, ...CREATIVE_ASSET_PLATFORM_QUOTA_INDEX.options }
  );
  await CreativeAsset.collection.createIndex(
    CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX.key,
    { background: true, ...CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX.options }
  );
  await CreativeAsset.collection.createIndex(
    CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX.key,
    { background: true, ...CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX.options }
  );
  await CreativeAsset.collection.createIndex(
    CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX.key,
    {
      background: true,
      ...CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX.options,
    }
  );
  await VideoGenerationNsfwVerdict.collection.createIndex(
    VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX.key,
    {
      background: true,
      ...VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX.options,
    }
  );
  await VideoGenerationNsfwVerdict.collection.createIndex(
    VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.key,
    {
      background: true,
      ...VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.options,
    }
  );
  await CreativeAsset.collection.createIndex(
    CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX.key,
    { background: true, ...CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX.options }
  );
  try {
    await CreativeAsset.collection.dropIndex(
      CREATIVE_ASSET_VIDEO_ORCHESTRATION_LEGACY_INDEX_NAME
    );
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
  }
  try {
    await CreativeAsset.collection.dropIndex(
      CREATIVE_ASSET_PLATFORM_QUOTA_LEGACY_INDEX_NAME
    );
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
  }
  await CreativeAsset.collection.createIndex(
    CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX.key,
    { background: true, ...CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX.options }
  );
}

export async function ensureCreativeAssetGenerationIndexes(): Promise<void> {
  if (creativeAssetGenerationIndexCache.ready) return;
  if (creativeAssetGenerationIndexCache.promise) {
    return creativeAssetGenerationIndexCache.promise;
  }

  creativeAssetGenerationIndexCache.promise = (async () => {
    await connectDB();
    await createCreativeAssetGenerationIndexes();
    creativeAssetGenerationIndexCache.ready = true;
  })()
    .catch(error => {
      creativeAssetGenerationIndexCache.promise = null;
      throw error;
    })
    .finally(() => {
      if (creativeAssetGenerationIndexCache.ready) {
        creativeAssetGenerationIndexCache.promise = null;
      }
    });

  return creativeAssetGenerationIndexCache.promise;
}
