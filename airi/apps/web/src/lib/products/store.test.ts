const mockFind = jest.fn();

jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

jest.mock("@/lib/products/photo-urls", () => ({
  withProductPhotoUrls: (work: () => Promise<unknown>) => work(),
  productPhotoUrl: async (
    workspaceId: string,
    ref: { bucket?: string; path?: string } | null | undefined
  ) => (ref?.path ? `https://signed.test/${workspaceId}/${ref.path}` : null),
}));

import { listImportProducts, listPublishedProducts } from "./store";
import { MAX_LISTED_PRODUCTS } from "./types";

function createFindQuery(rows: unknown[]) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listPublishedProducts", () => {
  it("reads published products in shelf order, capped", async () => {
    const query = createFindQuery([]);
    mockFind.mockReturnValue(query);

    await listPublishedProducts("workspace-1");

    expect(mockFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      status: "published",
    });
    expect(query.sort).toHaveBeenCalledWith({ position: 1, _id: 1 });
    expect(query.limit).toHaveBeenCalledWith(MAX_LISTED_PRODUCTS);
    expect(query.select).toHaveBeenCalledWith(
      "name price priceIsFrom updatedAt featuredOption options.photo.thumb"
    );
  });

  it("maps rows to records, with the featured option's small copy signed", async () => {
    mockFind.mockReturnValue(
      createFindQuery([
        {
          _id: "651f1f77bcf86cd799439031",
          name: "Кукла Лол",
          price: 5000,
          priceIsFrom: true,
          featuredOption: 1,
          options: [
            { photo: { thumb: { bucket: "media", path: "p1/a.webp" } } },
            { photo: { thumb: { bucket: "media", path: "p1/thumb.webp" } } },
          ],
          updatedAt: new Date("2026-10-27T09:30:00.000Z"),
        },
        {
          _id: "651f1f77bcf86cd799439032",
          name: "Петух",
          price: null,
          updatedAt: "not a date",
        },
      ])
    );

    expect(await listPublishedProducts("workspace-1")).toEqual([
      {
        id: "651f1f77bcf86cd799439031",
        name: "Кукла Лол",
        price: 5000,
        priceIsFrom: true,
        imageUrl: "https://signed.test/workspace-1/p1/thumb.webp",
        updatedAt: "2026-10-27T09:30:00.000Z",
      },
      {
        id: "651f1f77bcf86cd799439032",
        name: "Петух",
        price: null,
        priceIsFrom: false,
        imageUrl: null,
        updatedAt: null,
      },
    ]);
  });
});

describe("listImportProducts", () => {
  it("lists an import's products in filmed order, with every photo, doubt and clip", async () => {
    const query = createFindQuery([
      {
        _id: "651f1f77bcf86cd799439041",
        status: "draft",
        name: "Кружка",
        englishName: "Frosted cup",
        nameSource: "on_screen",
        price: 500,
        priceQuote: "бес жүз теңге",
        priceSource: "spoken",
        doubts: [
          {
            about: "price",
            text: "Another product's price comes from the same words.",
          },
          // One stored as bare text is about the product.
          "Is it 500 or 5000?",
          7,
          { about: "colour", text: "Unknown subject" },
        ],
        featuredOption: 0,
        clip: {
          fromSeconds: 8.7,
          toSeconds: 12,
          video: { bucket: "media", path: "p/clip.mp4" },
        },
        options: [
          {
            description: "frosted cup with logo",
            photo: {
              method: "restored",
              cutout: { bucket: "media", path: "p/cutout.png" },
              thumb: { bucket: "media", path: "p/thumb.webp" },
              original: { bucket: "media", path: "p/original.jpg" },
              frameTimeSeconds: 9.4,
              straightenedDegrees: -31.2,
            },
            notes: ["Turned to stand level.", 3],
          },
          { description: "cup without lid" },
        ],
      },
      {
        _id: "651f1f77bcf86cd799439042",
        status: "odd",
        name: "Әтеш",
        price: null,
        priceSource: "shouted",
        featuredOption: 5,
        options: [{ photo: { method: "weird" } }],
      },
    ]);
    mockFind.mockReturnValue(query);

    const products = await listImportProducts(
      "workspace-1",
      "651f1f77bcf86cd799439040"
    );

    expect(mockFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      importId: "651f1f77bcf86cd799439040",
    });
    expect(query.sort).toHaveBeenCalledWith({ importIndex: 1, _id: 1 });
    expect(query.select).toHaveBeenCalledWith(
      "status name englishName nameSource price priceIsFrom priceQuote priceSource doubts options featuredOption clip updatedAt"
    );
    expect(products[0]).toEqual({
      id: "651f1f77bcf86cd799439041",
      status: "draft",
      name: "Кружка",
      englishName: "Frosted cup",
      nameSource: "on_screen",
      price: 500,
      priceIsFrom: false,
      priceQuote: "бес жүз теңге",
      priceSource: "spoken",
      doubts: [
        {
          about: "price",
          text: "Another product's price comes from the same words.",
        },
        { about: "product", text: "Is it 500 or 5000?" },
      ],
      clipUrl: "https://signed.test/workspace-1/p/clip.mp4",
      imageUrl: "https://signed.test/workspace-1/p/thumb.webp",
      featuredOption: 0,
      options: [
        {
          description: "frosted cup with logo",
          photoMethod: "restored",
          imageUrl: "https://signed.test/workspace-1/p/thumb.webp",
          photoUrl: "https://signed.test/workspace-1/p/cutout.png",
          originalUrl: "https://signed.test/workspace-1/p/original.jpg",
          videoMomentSeconds: 9.4,
          straightenedDegrees: -31.2,
          notes: ["Turned to stand level."],
        },
        {
          description: "cup without lid",
          photoMethod: "pending",
          imageUrl: null,
          photoUrl: null,
          originalUrl: null,
          videoMomentSeconds: null,
          straightenedDegrees: 0,
          notes: [],
        },
      ],
      updatedAt: null,
    });
    expect(products[1]).toMatchObject({
      status: "draft",
      englishName: null,
      nameSource: null,
      priceSource: null,
      doubts: [],
      clipUrl: null,
      imageUrl: null,
      // A featured option out of range falls back to the first.
      featuredOption: 0,
      options: [{ description: "", photoMethod: "pending", imageUrl: null }],
    });
  });
});
