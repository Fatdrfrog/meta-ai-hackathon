const mockFind = jest.fn();

jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

import { listPublishedProducts } from "./store";
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
    expect(query.select).toHaveBeenCalledWith("name price updatedAt");
  });

  it("maps rows to records, with no price and no date as null", async () => {
    mockFind.mockReturnValue(
      createFindQuery([
        {
          _id: "651f1f77bcf86cd799439031",
          name: "Кукла Лол",
          price: 5000,
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
        imageUrl: null,
        updatedAt: "2026-10-27T09:30:00.000Z",
      },
      {
        id: "651f1f77bcf86cd799439032",
        name: "Петух",
        price: null,
        imageUrl: null,
        updatedAt: null,
      },
    ]);
  });
});
