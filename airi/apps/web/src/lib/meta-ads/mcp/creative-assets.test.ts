const mockCreativeAssetFind = jest.fn();
const mockResolveCreativeAssetDisplayUrl = jest.fn();

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    find: (...args: unknown[]) => mockCreativeAssetFind(...args),
  },
}));

jest.mock("@/lib/higgsfield/creative-asset-serialization", () => ({
  resolveCreativeAssetDisplayUrl: (...args: unknown[]) =>
    mockResolveCreativeAssetDisplayUrl(...args),
}));

import {
  buildMetaAdsMcpCreativeAssetContext,
  loadMetaAdsMcpCreativeAssetReferences,
  materializeMetaAdsMcpCreativeAssetArguments,
} from "./creative-assets";

const IMAGE_ASSET_ID = "507f1f77bcf86cd799439011";
const VIDEO_ASSET_ID = "507f1f77bcf86cd799439012";
const UPPERCASE_IMAGE_ASSET_ID = IMAGE_ASSET_ID.toUpperCase();

function mockAssetQuery(assets: Array<Record<string, unknown>>): {
  select: jest.Mock;
  lean: jest.Mock;
} {
  const lean = jest.fn().mockResolvedValue(assets);
  const select = jest.fn().mockReturnValue({ lean });
  mockCreativeAssetFind.mockReturnValue({ select });
  return { select, lean };
}

describe("Meta Ads MCP creative assets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads only completed workspace media as durable Airi references", async () => {
    const query = mockAssetQuery([
      {
        _id: IMAGE_ASSET_ID,
        workspaceId: "workspace-1",
        kind: "image",
        status: "complete",
        fileName: "launch.jpg",
        mimeType: "image/jpeg",
        fileSize: 1200,
        prompt: "Product launch visual",
      },
    ]);

    const references = await loadMetaAdsMcpCreativeAssetReferences({
      workspaceId: "workspace-1",
      assetIds: [IMAGE_ASSET_ID, IMAGE_ASSET_ID],
    });

    expect(mockCreativeAssetFind).toHaveBeenCalledWith({
      _id: { $in: [IMAGE_ASSET_ID] },
      workspaceId: "workspace-1",
      status: "complete",
      kind: { $in: ["image", "video"] },
    });
    expect(query.select).toHaveBeenCalledWith(
      "_id workspaceId kind status fileName mimeType fileSize prompt url storageProvider bucket path"
    );
    expect(references).toEqual([
      {
        id: IMAGE_ASSET_ID,
        kind: "image",
        name: "launch.jpg",
        mimeType: "image/jpeg",
        fileSize: 1200,
        prompt: "Product launch visual",
        uri: `airi://creative-assets/${IMAGE_ASSET_ID}`,
      },
    ]);
    expect(buildMetaAdsMcpCreativeAssetContext(references)).toContain(
      `airi://creative-assets/${IMAGE_ASSET_ID}`
    );
  });

  it("bounds persisted asset text before adding it to the model context", async () => {
    mockAssetQuery([
      {
        _id: IMAGE_ASSET_ID,
        workspaceId: "workspace-1",
        kind: "image",
        status: "complete",
        fileName: `launch-${"n".repeat(500)}.jpg`,
        mimeType: `image/${"m".repeat(500)}`,
        fileSize: 1200,
        prompt: "p".repeat(2_000),
      },
    ]);

    const [reference] = await loadMetaAdsMcpCreativeAssetReferences({
      workspaceId: "workspace-1",
      assetIds: [IMAGE_ASSET_ID],
    });

    expect(reference.name).toHaveLength(240);
    expect(reference.mimeType).toHaveLength(128);
    expect(reference.prompt).toHaveLength(500);
    expect(reference.uri).toBe(`airi://creative-assets/${IMAGE_ASSET_ID}`);
  });

  it("materializes nested asset handles to fresh URLs immediately before execution", async () => {
    const image = {
      _id: IMAGE_ASSET_ID,
      workspaceId: "workspace-1",
      kind: "image",
      status: "complete",
      fileName: "launch.jpg",
      mimeType: "image/jpeg",
      fileSize: 1200,
      url: "gcs://assets/launch.jpg",
      storageProvider: "gcs",
      bucket: "assets",
      path: "launch.jpg",
    };
    const video = {
      _id: VIDEO_ASSET_ID,
      workspaceId: "workspace-1",
      kind: "video",
      status: "complete",
      fileName: "launch.mp4",
      mimeType: "video/mp4",
      fileSize: 2400,
      url: "gcs://assets/launch.mp4",
      storageProvider: "gcs",
      bucket: "assets",
      path: "launch.mp4",
    };
    mockAssetQuery([image, video]);
    mockResolveCreativeAssetDisplayUrl
      .mockResolvedValueOnce("https://signed.example/launch.jpg")
      .mockResolvedValueOnce("https://signed.example/launch.mp4");

    const result = await materializeMetaAdsMcpCreativeAssetArguments({
      workspaceId: "workspace-1",
      arguments: {
        object_story_spec: {
          link_data: {
            image_url: `airi://creative-assets/${IMAGE_ASSET_ID}`,
          },
        },
        videos: [{ source_url: `airi://creative-assets/${VIDEO_ASSET_ID}` }],
        untouched: "airi://creative-assets/not-an-object-id",
      },
    });

    expect(result).toEqual({
      object_story_spec: {
        link_data: { image_url: "https://signed.example/launch.jpg" },
      },
      videos: [{ source_url: "https://signed.example/launch.mp4" }],
      untouched: "airi://creative-assets/not-an-object-id",
    });
  });

  it("rejects an unavailable or cross-workspace asset before any provider call", async () => {
    mockAssetQuery([]);

    await expect(
      materializeMetaAdsMcpCreativeAssetArguments({
        workspaceId: "workspace-1",
        arguments: {
          image_url: `airi://creative-assets/${IMAGE_ASSET_ID}`,
        },
      })
    ).rejects.toThrow("not available in this workspace");

    expect(mockResolveCreativeAssetDisplayUrl).not.toHaveBeenCalled();
  });

  it("rejects more than eight distinct assets instead of leaving unresolved URIs", async () => {
    const assetIds = Array.from(
      { length: 9 },
      (_, index) =>
        `507f1f77bcf86cd7994390${String(index + 11).padStart(2, "0")}`
    );

    await expect(
      materializeMetaAdsMcpCreativeAssetArguments({
        workspaceId: "workspace-1",
        arguments: {
          imageUrls: assetIds.map(id => `airi://creative-assets/${id}`),
        },
      })
    ).rejects.toThrow(/up to 8/i);

    expect(mockCreativeAssetFind).not.toHaveBeenCalled();
    expect(mockResolveCreativeAssetDisplayUrl).not.toHaveBeenCalled();
  });

  it("canonicalizes uppercase ObjectIds before querying and ordering results", async () => {
    mockAssetQuery([
      {
        _id: IMAGE_ASSET_ID,
        workspaceId: "workspace-1",
        kind: "image",
        status: "complete",
        fileName: "launch.jpg",
      },
    ]);

    const references = await loadMetaAdsMcpCreativeAssetReferences({
      workspaceId: "workspace-1",
      assetIds: [UPPERCASE_IMAGE_ASSET_ID],
    });

    expect(mockCreativeAssetFind).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: [IMAGE_ASSET_ID] },
      })
    );
    expect(references).toEqual([
      expect.objectContaining({
        id: IMAGE_ASSET_ID,
        uri: `airi://creative-assets/${IMAGE_ASSET_ID}`,
      }),
    ]);
  });
});
