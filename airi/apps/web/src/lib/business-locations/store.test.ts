const mockBusinessLocationFind = jest.fn();

jest.mock("@/models/business-location", () => ({
  BusinessLocation: {
    find: (...args: unknown[]) => mockBusinessLocationFind(...args),
  },
}));

import { listBusinessLocations, loadActiveBusinessLocations } from "./store";

function createFindQuery(rows: unknown[]) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
}

const storedAbay = {
  _id: "651f1f77bcf86cd799439021",
  key: "almaty_abay",
  name: "Abay",
  country: "kz",
  city: "Almaty",
  cityKey: "almaty",
  address: "Abay Ave 10",
  phone: "+7 727 000 00 00",
  mapUrl: "https://maps.google.com/?q=43.24,76.91",
  tags: ["Flagship"],
  latitude: 43.24,
  longitude: 76.91,
  sortOrder: 0,
};

const storedTashkent = {
  _id: "651f1f77bcf86cd799439022",
  key: "tashkent_center",
  name: "Tashkent Center",
  country: "UZ",
  city: "Tashkent",
  tags: [],
  latitude: 41.311081,
  longitude: 69.240562,
  sortOrder: 1,
};

describe("loadActiveBusinessLocations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads the workspace's active offices in catalog order", async () => {
    const query = createFindQuery([storedAbay, storedTashkent]);
    mockBusinessLocationFind.mockReturnValue(query);

    await expect(loadActiveBusinessLocations("workspace-1")).resolves.toEqual([
      {
        key: "almaty_abay",
        name: "Abay",
        country: "KZ",
        city: "Almaty",
        cityKey: "almaty",
        address: "Abay Ave 10",
        phone: "+7 727 000 00 00",
        mapUrl: "https://maps.google.com/?q=43.24,76.91",
        tags: ["flagship"],
        latitude: 43.24,
        longitude: 76.91,
        sortOrder: 0,
      },
      {
        key: "tashkent_center",
        name: "Tashkent Center",
        country: "UZ",
        city: "Tashkent",
        cityKey: "tashkent",
        tags: [],
        latitude: 41.311081,
        longitude: 69.240562,
        sortOrder: 1,
      },
    ]);

    expect(mockBusinessLocationFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      isActive: true,
    });
    expect(query.sort).toHaveBeenCalledWith({ sortOrder: 1, key: 1 });
    expect(query.limit).toHaveBeenCalledWith(500);
    expect(String(query.select.mock.calls[0][0]).split(" ").sort()).toEqual(
      [
        "key",
        "name",
        "country",
        "city",
        "address",
        "phone",
        "mapUrl",
        "tags",
        "latitude",
        "longitude",
        "sortOrder",
      ].sort()
    );
  });

  it("leaves out rows routing could not use and keeps the rest in order", async () => {
    mockBusinessLocationFind.mockReturnValue(
      createFindQuery([
        { ...storedAbay, key: "bad key" },
        { ...storedAbay, key: "no_country", country: "Kazakhstan" },
        { ...storedAbay, key: "null_island", latitude: 0, longitude: 0 },
        { ...storedAbay, key: "no_latitude", latitude: null },
        { ...storedAbay, key: "no_name", name: "  " },
        storedTashkent,
      ])
    );

    const offices = await loadActiveBusinessLocations("workspace-1");

    expect(offices.map(office => office.key)).toEqual(["tashkent_center"]);
  });

  it("returns no offices for an empty catalog", async () => {
    mockBusinessLocationFind.mockReturnValue(createFindQuery([]));

    await expect(loadActiveBusinessLocations("workspace-1")).resolves.toEqual(
      []
    );
  });
});

describe("listBusinessLocations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads every office of the workspace, active first, with its state", async () => {
    const updatedAt = new Date("2026-10-05T09:30:00.000Z");
    const query = createFindQuery([
      { ...storedAbay, isActive: true, updatedAt },
      { ...storedTashkent, isActive: false, updatedAt },
    ]);
    mockBusinessLocationFind.mockReturnValue(query);

    await expect(listBusinessLocations("workspace-1")).resolves.toEqual([
      expect.objectContaining({
        key: "almaty_abay",
        country: "KZ",
        cityKey: "almaty",
        isActive: true,
        updatedAt: "2026-10-05T09:30:00.000Z",
      }),
      expect.objectContaining({
        key: "tashkent_center",
        isActive: false,
        updatedAt: "2026-10-05T09:30:00.000Z",
      }),
    ]);

    expect(mockBusinessLocationFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(query.sort).toHaveBeenCalledWith({
      isActive: -1,
      sortOrder: 1,
      key: 1,
    });
    expect(query.limit).toHaveBeenCalledWith(2000);
    expect(String(query.select.mock.calls[0][0]).split(" ").sort()).toEqual(
      [
        "key",
        "name",
        "country",
        "city",
        "address",
        "phone",
        "mapUrl",
        "tags",
        "latitude",
        "longitude",
        "sortOrder",
        "isActive",
        "updatedAt",
      ].sort()
    );
  });

  it("reads a row without isActive as active and an unusable date as null", async () => {
    mockBusinessLocationFind.mockReturnValue(
      createFindQuery([
        storedAbay,
        { ...storedTashkent, updatedAt: new Date("not a date") },
      ])
    );

    const offices = await listBusinessLocations("workspace-1");

    expect(
      offices.map(({ key, isActive, updatedAt }) => ({
        key,
        isActive,
        updatedAt,
      }))
    ).toEqual([
      { key: "almaty_abay", isActive: true, updatedAt: null },
      { key: "tashkent_center", isActive: true, updatedAt: null },
    ]);
  });

  it("leaves out rows no reader could use, inactive ones included", async () => {
    mockBusinessLocationFind.mockReturnValue(
      createFindQuery([
        { ...storedAbay, key: "bad key", isActive: false },
        { ...storedAbay, key: "null_island", latitude: 0, longitude: 0 },
        { ...storedTashkent, isActive: false },
      ])
    );

    const offices = await listBusinessLocations("workspace-1");

    expect(offices.map(office => [office.key, office.isActive])).toEqual([
      ["tashkent_center", false],
    ]);
  });
});
