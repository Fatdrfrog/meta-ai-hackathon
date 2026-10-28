const mockImportCreate = jest.fn();
const mockImportUpdate = jest.fn();
const mockImportFindOne = jest.fn();
const mockImportFind = jest.fn();
const mockProductDistinct = jest.fn();
const mockAssetFindOne = jest.fn();
const mockStart = jest.fn();
const mockListImportProducts = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    create: (...args: unknown[]) => mockImportCreate(...args),
    updateOne: (...args: unknown[]) => mockImportUpdate(...args),
    findOne: (...args: unknown[]) => mockImportFindOne(...args),
    find: (...args: unknown[]) => mockImportFind(...args),
  },
}));
jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: {
    distinct: (...args: unknown[]) => mockProductDistinct(...args),
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
  listShownProductVideoImports,
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

describe("listShownProductVideoImports", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  const hoursAgo = (hours: number) =>
    new Date(now.getTime() - hours * 60 * 60 * 1000);
  const listQuery = (result: unknown) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  });

  it("shows running imports, ones with products to check, and a day of failures", async () => {
    const found = listQuery([
      { _id: "running", status: "processing", stage: "cutting" },
      { _id: "queued", status: "queued" },
      {
        _id: "to-check",
        status: "ready",
        productTotal: 4,
        finishedAt: hoursAgo(50),
      },
      {
        _id: "checked",
        status: "ready",
        productTotal: 4,
        finishedAt: hoursAgo(2),
      },
      {
        _id: "nothing-found",
        status: "ready",
        productTotal: 0,
        finishedAt: hoursAgo(2),
      },
      {
        _id: "nothing-found-long-ago",
        status: "ready",
        productTotal: 0,
        finishedAt: hoursAgo(30),
      },
      {
        _id: "failed",
        status: "failed",
        errorCode: "video_too_long",
        finishedAt: hoursAgo(3),
      },
      {
        _id: "failed-long-ago",
        status: "failed",
        finishedAt: hoursAgo(25),
      },
    ]);
    mockImportFind.mockReturnValue(found);
    mockProductDistinct.mockResolvedValue(["to-check"]);

    const shown = await listShownProductVideoImports("workspace-1", now);

    expect(shown.map(entry => entry.id)).toEqual([
      "running",
      "queued",
      "to-check",
      "nothing-found",
      "failed",
    ]);
    expect(shown[4]).toMatchObject({
      status: "failed",
      errorCode: "video_too_long",
    });
    // The last week of this workspace, newest first.
    expect(mockImportFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      createdAt: { $gte: new Date("2026-10-21T12:00:00.000Z") },
    });
    expect(found.sort).toHaveBeenCalledWith({ createdAt: -1 });
    // Draft products are looked for only among finished imports.
    expect(mockProductDistinct).toHaveBeenCalledWith("importId", {
      workspaceId: "workspace-1",
      importId: {
        $in: ["to-check", "checked", "nothing-found", "nothing-found-long-ago"],
      },
      status: "draft",
    });
  });

  it("shows a few at most, and asks for no drafts when nothing has finished", async () => {
    mockImportFind.mockReturnValue(
      listQuery(
        Array.from({ length: 7 }, (_, index) => ({
          _id: `running-${index}`,
          status: "processing",
        }))
      )
    );

    const shown = await listShownProductVideoImports("workspace-1", now);

    expect(shown).toHaveLength(5);
    expect(mockProductDistinct).not.toHaveBeenCalled();
  });
});
