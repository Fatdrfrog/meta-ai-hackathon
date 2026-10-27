const mockConnectDB = jest.fn(async () => undefined);
const mockCreateIndex = jest.fn(async () => "ok");
const mockDropIndex = jest.fn(async () => undefined);

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: mockConnectDB,
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    collection: {
      createIndex: mockCreateIndex,
      dropIndex: mockDropIndex,
    },
  },
  CREATIVE_ASSET_PLATFORM_QUOTA_INDEX: {
    key: { workspaceId: 1, "generation.recoveryMode": 1, provider: 1 },
    options: { name: "platform-quota-v2" },
  },
  CREATIVE_ASSET_PLATFORM_QUOTA_LEGACY_INDEX_NAME: "platform-quota",
  CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX: {
    key: { workspaceId: 1, "generation.requestIdempotencyKey": 1 },
    options: { name: "video-idempotency", unique: true },
  },
  CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX: {
    key: { workspaceId: 1, "generation.safetyProviderRequestIds": 1 },
    options: { name: "video-safety-alias" },
  },
  CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX: {
    key: {
      workspaceId: 1,
      "generation.safetyAncestors.assetId": 1,
      "generation.safetyAncestors.attemptToken": 1,
    },
    options: { name: "video-safety-ancestor" },
  },
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX: {
    key: { "generation.orchestration.state": 1, updatedAt: 1, _id: 1 },
    options: { name: "video-orchestration-v2" },
  },
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_LEGACY_INDEX_NAME:
    "video-orchestration-legacy",
  CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX: {
    key: { updatedAt: 1, _id: 1 },
    options: { name: "video-nsfw-cleanup" },
  },
}));

jest.mock("@/models/video-generation-nsfw-verdict", () => ({
  VideoGenerationNsfwVerdict: {
    collection: { createIndex: mockCreateIndex },
  },
  VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX: {
    key: {
      workspaceId: 1,
      provider: 1,
      sourceAssetId: 1,
      sourceAttemptToken: 1,
    },
    options: { name: "video-nsfw-source-attempt" },
  },
  VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX: {
    key: { sweepCompletedAt: 1, firstReceivedAt: 1, _id: 1 },
    options: {
      name: "video-nsfw-pending-sweep",
      partialFilterExpression: { sweepCompletedAt: null },
    },
  },
}));

describe("ensureCreativeAssetGenerationIndexes", () => {
  beforeEach(() => {
    delete (
      globalThis as typeof globalThis & {
        __creativeAssetGenerationIndexCache?: unknown;
      }
    ).__creativeAssetGenerationIndexCache;
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCreateIndex.mockResolvedValue("ok");
    mockDropIndex.mockResolvedValue(undefined);
  });

  it("coalesces concurrent runtime index gates", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureCreativeAssetGenerationIndexes } = await import(
        "./creative-asset-generation-indexes"
      );

      await Promise.all([
        ensureCreativeAssetGenerationIndexes(),
        ensureCreativeAssetGenerationIndexes(),
        ensureCreativeAssetGenerationIndexes(),
      ]);
      await ensureCreativeAssetGenerationIndexes();

      expect(mockConnectDB).toHaveBeenCalledTimes(1);
      expect(mockCreateIndex).toHaveBeenCalledTimes(8);
      expect(mockCreateIndex).toHaveBeenCalledWith(
        { workspaceId: 1, "generation.safetyProviderRequestIds": 1 },
        { background: true, name: "video-safety-alias" }
      );
      expect(mockCreateIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          "generation.safetyAncestors.assetId": 1,
          "generation.safetyAncestors.attemptToken": 1,
        },
        { background: true, name: "video-safety-ancestor" }
      );
      expect(mockCreateIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          provider: 1,
          sourceAssetId: 1,
          sourceAttemptToken: 1,
        },
        { background: true, name: "video-nsfw-source-attempt" }
      );
      expect(mockCreateIndex).toHaveBeenCalledWith(
        { sweepCompletedAt: 1, firstReceivedAt: 1, _id: 1 },
        {
          background: true,
          name: "video-nsfw-pending-sweep",
          partialFilterExpression: { sweepCompletedAt: null },
        }
      );
      expect(mockDropIndex).toHaveBeenCalledTimes(2);
    });
  });

  it("retries after a failed runtime index gate", async () => {
    mockCreateIndex.mockRejectedValueOnce(new Error("index unavailable"));

    await jest.isolateModulesAsync(async () => {
      const { ensureCreativeAssetGenerationIndexes } = await import(
        "./creative-asset-generation-indexes"
      );

      await expect(ensureCreativeAssetGenerationIndexes()).rejects.toThrow(
        "index unavailable"
      );
      await expect(
        ensureCreativeAssetGenerationIndexes()
      ).resolves.toBeUndefined();

      expect(mockConnectDB).toHaveBeenCalledTimes(2);
    });
  });

  it("treats an already-removed legacy index as migrated", async () => {
    mockDropIndex.mockRejectedValueOnce({
      code: 27,
      codeName: "IndexNotFound",
    });

    await jest.isolateModulesAsync(async () => {
      const { ensureCreativeAssetGenerationIndexes } = await import(
        "./creative-asset-generation-indexes"
      );
      await expect(
        ensureCreativeAssetGenerationIndexes()
      ).resolves.toBeUndefined();
    });
  });
});
