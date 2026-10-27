const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockReserveStorage = jest.fn(async (..._args: unknown[]) => ({
  _id: "reservation",
  status: "reserved",
}));
const mockSettleStorage = jest.fn();
jest.mock("@icecore/airi-runtime/storage-quota", () => {
  const actual = jest.requireActual("@icecore/airi-runtime/storage-quota");
  return {
    ...actual,
    storeSupabaseWorkspaceBuffer: (params: object) =>
      actual.storeSupabaseWorkspaceBuffer({
        ...params,
        quota: {
          reserve: (...args: unknown[]) => mockReserveStorage(...args),
          settle: (...args: unknown[]) => mockSettleStorage(...args),
        },
      }),
  };
});

import {
  CreativeAssetValidationError,
  downloadAndStoreCreativeAsset,
} from "./creative-asset-storage";

const originalFetch = global.fetch;
const originalEnv = process.env;

const storageClient = {
  storage: {
    from: jest.fn(() => ({
      upload: (...args: unknown[]) => mockUpload(...args),
      getPublicUrl: (...args: unknown[]) => mockGetPublicUrl(...args),
    })),
  },
};

describe("creative asset Supabase storage", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockUpload.mockResolvedValue({ error: null });
    mockGetPublicUrl.mockReturnValue({
      data: { publicUrl: "https://storage.example.com/asset.png" },
    });
  });

  it("rejects oversized remote Higgsfield assets before reading or uploading", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(20 * 1024 * 1024 + 1),
        },
      })
    ) as typeof fetch;

    await expect(
      downloadAndStoreCreativeAsset({
        storageClient,
        workspaceId: "workspace-1",
        assetId: "asset-1",
        kind: "image",
        mediaUrl: "https://cdn.higgsfield.ai/asset.png",
      })
    ).rejects.toBeInstanceOf(CreativeAssetValidationError);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects unallowlisted remote media hosts before fetching", async () => {
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      downloadAndStoreCreativeAsset({
        storageClient,
        workspaceId: "workspace-1",
        assetId: "asset-1",
        kind: "image",
        mediaUrl: "https://example.com/asset.png",
      })
    ).rejects.toBeInstanceOf(CreativeAssetValidationError);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("allows Alibaba DashScope OSS result hosts used by HappyHorse/Wan", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(Buffer.from("video"), {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "5",
        },
      })
    ) as typeof fetch;

    await expect(
      downloadAndStoreCreativeAsset({
        storageClient,
        workspaceId: "workspace-1",
        assetId: "asset-1",
        kind: "video",
        mediaUrl:
          "https://dashscope-463f.oss-accelerate.aliyuncs.com/video.mp4",
        storeBuffer: async () => ({
          storageProvider: "gcs" as const,
          url: "gs://bucket/path.mp4",
          bucket: "bucket",
          path: "path.mp4",
          mimeType: "video/mp4",
          fileName: "video.mp4",
          fileSize: 5,
        }),
      })
    ).resolves.toEqual(
      expect.objectContaining({
        storageProvider: "gcs",
        mimeType: "video/mp4",
      })
    );
    expect(global.fetch).toHaveBeenCalled();
  });

  it("stops streaming remote media once the size limit is exceeded", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 21; index += 1) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "content-type": "image/png",
        },
      })
    ) as typeof fetch;

    await expect(
      downloadAndStoreCreativeAsset({
        storageClient,
        workspaceId: "workspace-1",
        assetId: "asset-1",
        kind: "image",
        mediaUrl: "https://cdn.higgsfield.ai/asset.png",
      })
    ).rejects.toBeInstanceOf(CreativeAssetValidationError);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
