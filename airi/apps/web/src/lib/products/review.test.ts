const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockImportExists = jest.fn();
const mockEmit = jest.fn();
const mockWarn = jest.fn();

jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
  },
}));
jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    exists: (...args: unknown[]) => mockImportExists(...args),
  },
}));
jest.mock("@/lib/realtime/server", () => ({
  emitProductsChangedRealtimeEvent: (...args: unknown[]) => mockEmit(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));
jest.mock("@/lib/products/photo-urls", () => ({
  withProductPhotoUrls: (work: () => Promise<unknown>) => work(),
  productPhotoUrl: async (
    workspaceId: string,
    ref: { bucket?: string; path?: string } | null | undefined
  ) => (ref?.path ? `https://signed.test/${workspaceId}/${ref.path}` : null),
}));

import {
  parseProductChanges,
  parseProductReview,
  reviewImportProducts,
  updateWorkspaceProduct,
} from "./review";

const workspaceId = "workspace-1";
const productId = "651f1f77bcf86cd799439041";
const importId = "651f1f77bcf86cd799439040";

const query = (result: unknown) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(result),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
});

describe("parseProductChanges", () => {
  it("takes a trimmed name, a whole price or none, and an option", () => {
    expect(
      parseProductChanges({
        name: "  Шежіре  ",
        price: 16900,
        featuredOption: 1,
      })
    ).toEqual({ name: "Шежіре", price: 16900, featuredOption: 1 });
    expect(parseProductChanges({ price: null })).toEqual({ price: null });
  });

  it("refuses anything else, and an empty change", () => {
    for (const body of [
      null,
      [],
      {},
      { name: "   " },
      { name: "x".repeat(161) },
      { name: 5 },
      { price: -1 },
      { price: 15.5 },
      { price: "15500" },
      { price: 1_000_000_001 },
      { featuredOption: -1 },
      { featuredOption: 0.5 },
      { name: "ok", price: "bad" },
    ])
      expect(parseProductChanges(body)).toBeNull();
  });
});

describe("parseProductReview", () => {
  it("takes known statuses for a few distinct product ids", () => {
    expect(
      parseProductReview({
        productIds: [productId, productId],
        status: "published",
      })
    ).toEqual({ productIds: [productId], status: "published" });
    expect(
      parseProductReview({ productIds: [productId], status: "draft" })
    ).toEqual({ productIds: [productId], status: "draft" });
  });

  it("refuses unknown statuses, bad ids, none, and too many", () => {
    for (const body of [
      null,
      { productIds: [productId], status: "deleted" },
      { productIds: ["nope"], status: "published" },
      { productIds: [], status: "published" },
      { productIds: productId, status: "published" },
      {
        productIds: Array.from({ length: 61 }, () => productId),
        status: "published",
      },
    ])
      expect(parseProductReview(body)).toBeNull();
  });
});

describe("updateWorkspaceProduct", () => {
  const row = {
    _id: productId,
    importId,
    status: "draft",
    name: "Шежіре",
    price: 16900,
    doubts: [{ about: "product", text: "The name said doesn't match." }],
    options: [{ description: "round panel" }, { description: "star plaque" }],
    featuredOption: 1,
    clip: { video: { bucket: "media", path: "clips/p1.mp4" } },
  };

  it("sets the price, settles the doubts about it, and says so on every device", async () => {
    const update = query(row);
    mockFindOneAndUpdate.mockReturnValue(update);

    const product = await updateWorkspaceProduct(workspaceId, productId, {
      price: 16900,
    });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: productId, workspaceId },
      { $set: { price: 16900 }, $pull: { doubts: { about: "price" } } },
      { new: true, runValidators: true }
    );
    expect(update.select).toHaveBeenCalledWith(
      expect.stringContaining("clip updatedAt importId")
    );
    expect(product).toMatchObject({
      id: productId,
      price: 16900,
      doubts: [{ about: "product", text: "The name said doesn't match." }],
      featuredOption: 1,
      clipUrl: "https://signed.test/workspace-1/clips/p1.mp4",
    });
    expect(mockEmit).toHaveBeenCalledWith({
      workspaceId,
      importId,
      reason: "review",
      productId,
    });
  });

  it("a name keeps the price's doubts", async () => {
    mockFindOneAndUpdate.mockReturnValue(query(row));

    await updateWorkspaceProduct(workspaceId, productId, { name: "Шежіре" });

    expect(mockFindOneAndUpdate.mock.calls[0]![1]).toEqual({
      $set: { name: "Шежіре" },
    });
  });

  it("checks the option to show exists, and finds nothing in another workspace", async () => {
    mockFindOne.mockReturnValue(query({ options: [{}, {}] }));
    expect(
      await updateWorkspaceProduct(workspaceId, productId, {
        featuredOption: 2,
      })
    ).toBe("invalid");
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();

    mockFindOne.mockReturnValue(query(null));
    expect(
      await updateWorkspaceProduct(workspaceId, productId, {
        featuredOption: 0,
      })
    ).toBeNull();

    mockFindOneAndUpdate.mockReturnValue(query(null));
    expect(
      await updateWorkspaceProduct(workspaceId, productId, { price: 1 })
    ).toBeNull();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("a lost event doesn't fail the change", async () => {
    mockFindOneAndUpdate.mockReturnValue(query(row));
    mockEmit.mockRejectedValue(new Error("pubsub down"));

    await expect(
      updateWorkspaceProduct(workspaceId, productId, { price: 1 })
    ).resolves.toMatchObject({ id: productId });
    expect(mockWarn).toHaveBeenCalledWith(
      "[Products] review event failed",
      expect.objectContaining({ event: "products.review_emit_failed" })
    );
  });
});

describe("reviewImportProducts", () => {
  it("publishes the import's own products, recording who and when", async () => {
    mockImportExists.mockResolvedValue({ _id: importId });
    mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    const changed = await reviewImportProducts(
      workspaceId,
      importId,
      {
        productIds: [productId, "651f1f77bcf86cd799439042"],
        status: "published",
      },
      "user-1"
    );

    expect(changed).toBe(2);
    expect(mockImportExists).toHaveBeenCalledWith({
      _id: importId,
      workspaceId,
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId,
        importId,
        _id: { $in: [productId, "651f1f77bcf86cd799439042"] },
        status: { $ne: "published" },
      },
      {
        $set: {
          status: "published",
          publishedAt: expect.any(Date),
          publishedBy: "user-1",
        },
      }
    );
    expect(mockEmit).toHaveBeenCalledWith({
      workspaceId,
      importId,
      reason: "review",
      productId: null,
    });
  });

  it("skipping or undoing takes a product off the shelf", async () => {
    mockImportExists.mockResolvedValue({ _id: importId });
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    expect(
      await reviewImportProducts(
        workspaceId,
        importId,
        { productIds: [productId], status: "draft" },
        "user-1"
      )
    ).toBe(0);
    expect(mockUpdateMany.mock.calls[0]![1]).toEqual({
      $set: { status: "draft" },
      $unset: { publishedAt: "", publishedBy: "" },
    });
    // Nothing changed, so there's nothing to tell.
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("finds no import in another workspace", async () => {
    mockImportExists.mockResolvedValue(null);

    expect(
      await reviewImportProducts(
        workspaceId,
        importId,
        { productIds: [productId], status: "published" },
        "user-1"
      )
    ).toBeNull();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
