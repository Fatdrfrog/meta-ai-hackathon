const mockImportCreate = jest.fn();
const mockImportUpdate = jest.fn();
const mockImportFindOne = jest.fn();
const mockAssetFindOne = jest.fn();
const mockStart = jest.fn();
const mockListImportProducts = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    create: (...args: unknown[]) => mockImportCreate(...args),
    updateOne: (...args: unknown[]) => mockImportUpdate(...args),
    findOne: (...args: unknown[]) => mockImportFindOne(...args),
  },
}));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockAssetFindOne(...args),
  },
}));
jest.mock("@/lib/temporal/product-video-import", () => ({
  startProductVideoImportWorkflow: (...args: unknown[]) => mockStart(...args),
}));
jest.mock("@/lib/products/store", () => ({
  listImportProducts: (...args: unknown[]) => mockListImportProducts(...args),
}));
jest.mock("@/lib/products/photo-urls", () => ({
  withProductPhotoUrls: (work: () => Promise<unknown>) => work(),
  productPhotoUrl: async (
    workspaceId: string,
    ref: { bucket?: string; path?: string } | null | undefined
  ) => (ref?.path ? `https://signed.test/${workspaceId}/${ref.path}` : null),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

import {
  createProductVideoImport,
  findUploadedVideo,
  loadProductVideoImport,
} from "./imports";

const query = (result: unknown) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(result),
});

const video = {
  bucket: "media",
  path: "workspaces/workspace-1/creative-assets/video/a1/shelf.mov",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockImportCreate.mockResolvedValue({ _id: "651f1f77bcf86cd799439071" });
  mockImportUpdate.mockResolvedValue({ matchedCount: 1 });
  mockStart.mockResolvedValue({
    workflowId: "product-video-import:651f1f77bcf86cd799439071",
  });
});

describe("findUploadedVideo", () => {
  it("accepts only this workspace's finished video in GCS", async () => {
    mockAssetFindOne.mockReturnValue(
      query({ ...video, mimeType: "video/quicktime", fileName: null })
    );

    expect(await findUploadedVideo("workspace-1", "a1")).toEqual({
      ...video,
      mimeType: "video/quicktime",
    });
    expect(mockAssetFindOne).toHaveBeenCalledWith({
      _id: "a1",
      workspaceId: "workspace-1",
      kind: "video",
      status: "complete",
      storageProvider: "gcs",
    });

    mockAssetFindOne.mockReturnValue(query({ bucket: null, path: null }));
    expect(await findUploadedVideo("workspace-1", "a1")).toBeNull();
  });
});

describe("createProductVideoImport", () => {
  it("records the import, starts its job and keeps the workflow id", async () => {
    const result = await createProductVideoImport({
      workspaceId: "workspace-1",
      source: "upload",
      video,
      createdBy: "user-1",
    });

    expect(result).toEqual({ importId: "651f1f77bcf86cd799439071" });
    expect(mockImportCreate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      source: "upload",
      video,
      status: "queued",
      createdBy: "user-1",
    });
    expect(mockStart).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      importId: "651f1f77bcf86cd799439071",
    });
    expect(mockImportUpdate).toHaveBeenCalledWith(
      { _id: "651f1f77bcf86cd799439071" },
      {
        $set: {
          workflowId: "product-video-import:651f1f77bcf86cd799439071",
        },
      }
    );
  });

  it("marks the import failed when its job can't start, and says so", async () => {
    mockStart.mockRejectedValue(new Error("Temporal is not configured"));

    await expect(
      createProductVideoImport({
        workspaceId: "workspace-1",
        source: "whatsapp",
        video,
      })
    ).rejects.toThrow("Temporal is not configured");

    expect(mockImportUpdate).toHaveBeenCalledWith(
      { _id: "651f1f77bcf86cd799439071" },
      {
        $set: expect.objectContaining({
          status: "failed",
          errorCode: "failed",
        }),
      }
    );
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe("loadProductVideoImport", () => {
  it("reads progress, dropping values it doesn't know", async () => {
    mockImportFindOne.mockReturnValue(
      query({
        _id: "651f1f77bcf86cd799439071",
        status: "processing",
        stage: "cutting",
        productTotal: 7,
        photoTotal: 12,
        photoDone: 2,
        errorCode: "something-new",
        createdAt: new Date("2026-10-28T09:00:00.000Z"),
      })
    );
    mockListImportProducts.mockResolvedValue([]);

    expect(
      await loadProductVideoImport("workspace-1", "651f1f77bcf86cd799439071")
    ).toEqual({
      import: {
        id: "651f1f77bcf86cd799439071",
        status: "processing",
        stage: "cutting",
        productTotal: 7,
        photoTotal: 12,
        photoDone: 2,
        errorCode: null,
        presenter: null,
        createdAt: "2026-10-28T09:00:00.000Z",
        finishedAt: null,
      },
      products: [],
    });
    expect(mockImportFindOne).toHaveBeenCalledWith({
      _id: "651f1f77bcf86cd799439071",
      workspaceId: "workspace-1",
    });
  });

  it("links the presenter's photos once their cut-out is made", async () => {
    mockImportFindOne.mockReturnValue(
      query({
        _id: "651f1f77bcf86cd799439072",
        status: "ready",
        presenter: {
          momentSeconds: 4.5,
          photo: {
            cutout: { bucket: "media", path: "presenter/cutout.png" },
            thumb: { bucket: "media", path: "presenter/thumb.webp" },
            original: { bucket: "media", path: "presenter/original.jpg" },
          },
        },
      })
    );
    mockListImportProducts.mockResolvedValue([]);

    const loaded = await loadProductVideoImport(
      "workspace-1",
      "651f1f77bcf86cd799439072"
    );

    expect(loaded?.import.presenter).toEqual({
      imageUrl: "https://signed.test/workspace-1/presenter/thumb.webp",
      photoUrl: "https://signed.test/workspace-1/presenter/cutout.png",
      originalUrl: "https://signed.test/workspace-1/presenter/original.jpg",
    });

    // Found in the video, but not cut out yet.
    mockImportFindOne.mockReturnValue(
      query({
        _id: "x",
        status: "processing",
        presenter: { momentSeconds: 4.5 },
      })
    );
    expect(
      (await loadProductVideoImport("workspace-1", "x"))?.import.presenter
    ).toBeNull();
  });

  it("finds nothing in another workspace", async () => {
    mockImportFindOne.mockReturnValue(query(null));
    expect(await loadProductVideoImport("workspace-2", "x")).toBeNull();
    expect(mockListImportProducts).not.toHaveBeenCalled();
  });
});
