const mockPollGoogleVideoOperation = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockFind = jest.fn();

jest.mock("@/lib/google/creative-assets", () => ({
  getGoogleGenerativeApiKey: () => "legacy-platform-key",
  downloadGoogleVideoResult: jest.fn(),
  extractGoogleVideoResult: jest.fn(),
  pollGoogleVideoOperation: (...args: unknown[]) =>
    mockPollGoogleVideoOperation(...args),
}));

jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  storeCreativeAssetBuffer: jest.fn(),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    find: (...args: unknown[]) => mockFind(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
  },
}));

import {
  syncGoogleCreativeAsset,
  syncWorkspaceGoogleCreativeAssets,
} from "./creative-asset-sync";

describe("syncGoogleCreativeAsset", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const query = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    mockFind.mockReturnValue(query);
  });

  it("does not read-poll contract-v1 video generations", async () => {
    await syncGoogleCreativeAsset({
      storageClient: {} as never,
      asset: {
        _id: "asset-1",
        workspaceId: "workspace-1",
        kind: "video",
        provider: "google",
        status: "queued",
        providerRequestId: "operations/video-1",
        updatedAt: new Date(0),
        generation: { contractVersion: 1 },
      },
    });

    expect(mockPollGoogleVideoOperation).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("continues polling legacy queued Google video generations", async () => {
    mockPollGoogleVideoOperation.mockResolvedValueOnce({
      name: "operations/video-legacy",
      done: false,
      raw: { name: "operations/video-legacy", done: false },
    });

    await syncGoogleCreativeAsset({
      storageClient: {} as never,
      asset: {
        _id: "asset-legacy",
        workspaceId: "workspace-1",
        kind: "video",
        provider: "google",
        status: "queued",
        providerRequestId: "operations/video-legacy",
        updatedAt: new Date(0),
      },
    });

    expect(mockPollGoogleVideoOperation).toHaveBeenCalledWith(
      "operations/video-legacy",
      "legacy-platform-key"
    );
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith("asset-legacy", {
      status: "in_progress",
      providerPayload: { name: "operations/video-legacy", done: false },
      updatedAt: expect.any(Date),
    });
  });

  it("excludes contract-v1 generations before applying the legacy poll limit", async () => {
    await syncWorkspaceGoogleCreativeAssets({
      storageClient: {} as never,
      workspaceId: "workspace-1",
      limit: 4,
    });

    expect(mockFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "google",
      kind: "video",
      status: { $in: ["queued", "in_progress"] },
      providerRequestId: { $type: "string", $ne: "" },
      "generation.contractVersion": { $ne: 1 },
    });
  });
});
