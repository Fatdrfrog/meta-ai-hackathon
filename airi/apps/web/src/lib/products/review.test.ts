const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockProductExists = jest.fn();
const mockUpdateMany = jest.fn();
const mockImportExists = jest.fn();
const mockEmit = jest.fn();
const mockWarn = jest.fn();

jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    exists: (...args: unknown[]) => mockProductExists(...args),
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
import { PRODUCT_UNKNOWN_CURRENCY_DOUBT } from "./types";

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
  mockProductExists.mockResolvedValue(null);
});

describe("parseProductChanges", () => {
  it("takes a trimmed name, a price or none, and an option", () => {
    expect(
      parseProductChanges({
        name: "  Шежіре  ",
        price: 16900,
        featuredOption: 1,
      })
    ).toEqual({ name: "Шежіре", price: 16900, featuredOption: 1 });
    expect(parseProductChanges({ price: null })).toEqual({ price: null });
  });

  it("takes cents, and a price's currency as its ISO code", () => {
    expect(parseProductChanges({ price: 12.5, currency: "eur" })).toEqual({
      price: 12.5,
      currency: "EUR",
    });
    expect(parseProductChanges({ price: 1.25, currency: "KWD" })).toEqual({
      price: 1.25,
      currency: "KWD",
    });
  });

  it("takes a price without a currency only whole, as tabs from before currencies send it", () => {
    expect(parseProductChanges({ price: 16900 })).toEqual({ price: 16900 });
    expect(parseProductChanges({ price: 0 })).toEqual({ price: 0 });
    // With cents, it could have more decimals than the product's currency
    // has, such as 4.999 on a USD product.
    for (const price of [4.99, 15.5, 4.999, 0.5])
      expect(parseProductChanges({ price })).toBeNull();
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
      { price: "15500" },
      { price: 1e12 + 1 },
      { price: 4.9999 },
      // More decimals than the currency has.
      { price: 1500.5, currency: "JPY" },
      // A currency only comes with a price, as a code.
      { currency: "EUR" },
      { price: null, currency: "EUR" },
      { price: 5, currency: "€" },
      { price: 5, currency: "EURO" },
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
    const update = query({ ...row, currency: "KZT" });
    mockFindOneAndUpdate.mockReturnValue(update);

    const product = await updateWorkspaceProduct(workspaceId, productId, {
      price: 16900,
      currency: "KZT",
    });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: productId, workspaceId },
      {
        $set: { price: 16900, currency: "KZT" },
        $pull: { doubts: { about: "price" } },
      },
      { new: true, runValidators: true }
    );
    expect(update.select).toHaveBeenCalledWith(
      expect.stringContaining("clip updatedAt importId")
    );
    expect(update.select).toHaveBeenCalledWith(
      expect.stringContaining(" price currency ")
    );
    expect(product).toMatchObject({
      id: productId,
      price: 16900,
      currency: "KZT",
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

  it("sets a price with the currency the owner typed", async () => {
    mockFindOneAndUpdate.mockReturnValue(
      query({ ...row, price: 12.5, currency: "EUR" })
    );

    expect(
      await updateWorkspaceProduct(workspaceId, productId, {
        price: 12.5,
        currency: "EUR",
      })
    ).toMatchObject({ price: 12.5, currency: "EUR" });
    expect(mockFindOneAndUpdate.mock.calls[0]![1]).toEqual({
      $set: { price: 12.5, currency: "EUR" },
      $pull: { doubts: { about: "price" } },
    });
  });

  it("sets a price without a currency only where a tab from before currencies reads prices right", async () => {
    // Such a tab shows a stored 4.99 as "4.99" and sends it back as 499, and
    // calls every price tenge.
    mockFindOneAndUpdate.mockReturnValue(query({ ...row, currency: "KZT" }));

    await expect(
      updateWorkspaceProduct(workspaceId, productId, { price: 16900 })
    ).resolves.toMatchObject({ price: 16900, currency: "KZT" });

    // Only over a whole price, or none, in tenge or in no currency. The
    // product keeps its currency, and the doubts that say it isn't known.
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: productId,
        workspaceId,
        currency: { $in: [null, "KZT"] },
        $expr: {
          $or: [
            { $eq: [{ $ifNull: ["$price", null] }, null] },
            { $eq: ["$price", { $trunc: ["$price", 0] }] },
          ],
        },
      },
      {
        $set: { price: 16900 },
        $pull: {
          doubts: {
            about: "price",
            $nor: [{ text: PRODUCT_UNKNOWN_CURRENCY_DOUBT }],
          },
        },
      },
      { new: true, runValidators: true }
    );
    expect(mockProductExists).not.toHaveBeenCalled();
  });

  it("refuses a price without a currency over one that tab would misread", async () => {
    // A stored 4.99 USD, which the tab sends back as 499 "tenge": the guard
    // matches nothing, though the product is there.
    mockFindOneAndUpdate.mockReturnValue(query(null));
    mockProductExists.mockResolvedValue({ _id: productId });

    expect(
      await updateWorkspaceProduct(workspaceId, productId, { price: 499 })
    ).toBe("conflict");
    expect(mockProductExists).toHaveBeenCalledWith({
      _id: productId,
      workspaceId,
    });
    expect(mockEmit).not.toHaveBeenCalled();

    // A product that isn't there is still not found.
    mockProductExists.mockResolvedValue(null);
    expect(
      await updateWorkspaceProduct(workspaceId, productId, { price: 499 })
    ).toBeNull();

    // A price with its currency is never refused that way.
    mockProductExists.mockClear();
    expect(
      await updateWorkspaceProduct(workspaceId, productId, {
        price: 4.99,
        currency: "USD",
      })
    ).toBeNull();
    expect(mockProductExists).not.toHaveBeenCalled();
  });

  it("the doubts a price without a currency leaves are those about an unknown currency", () => {
    for (const text of [
      "No currency was said or shown for this price.",
      "Check the currency: it was given as “TL”.",
    ])
      expect(text).toMatch(PRODUCT_UNKNOWN_CURRENCY_DOUBT);
    for (const text of [
      "The price differs from the number in the narration.",
      "This price is in KZT, but other prices in the video are in USD.",
      "This price was read from text in the video, not said aloud.",
    ])
      expect(text).not.toMatch(PRODUCT_UNKNOWN_CURRENCY_DOUBT);
  });

  it("taking the price away keeps its currency for the next one", async () => {
    mockFindOneAndUpdate.mockReturnValue(
      query({ ...row, price: null, currency: "KZT" })
    );

    await updateWorkspaceProduct(workspaceId, productId, { price: null });

    expect(mockFindOneAndUpdate.mock.calls[0]![1]).toEqual({
      $set: { price: null },
      $pull: { doubts: { about: "price" } },
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
