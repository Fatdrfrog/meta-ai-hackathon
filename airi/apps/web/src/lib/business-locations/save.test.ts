const mockFind = jest.fn();
const mockBulkWrite = jest.fn();
const mockUpdateMany = jest.fn();
const mockCreate = jest.fn();

jest.mock("@/models/business-location", () => ({
  BusinessLocation: {
    find: (...args: unknown[]) => mockFind(...args),
    bulkWrite: (...args: unknown[]) => mockBulkWrite(...args),
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

import type { ScenarioBusinessLocation } from "@icecore/scenario-contracts";
import {
  BusinessLocationKeyTakenError,
  BusinessLocationsLimitError,
  createBusinessLocation,
  saveBusinessLocations,
  type BusinessLocationSaveRow,
} from "./save";

type StoredRow = { key: string; isActive?: boolean };

function createFindQuery(rows: StoredRow[]) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
}

function storedOffices(
  count: number,
  isActive = true,
  prefix = "stored"
): StoredRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}_${index}`,
    isActive,
  }));
}

function office(
  key: string,
  overrides: Partial<ScenarioBusinessLocation> = {}
): ScenarioBusinessLocation {
  return {
    key,
    name: "Abay",
    country: "KZ",
    city: "Almaty",
    cityKey: "almaty",
    tags: [],
    latitude: 43.24,
    longitude: 76.91,
    sortOrder: 0,
    ...overrides,
  };
}

function row(key: string, { isActive = true } = {}): BusinessLocationSaveRow {
  return { office: office(key), isActive, sortOrder: undefined };
}

function bulkWriteOperations() {
  return mockBulkWrite.mock.calls[0][0] as Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: Record<string, Record<string, unknown>>;
      upsert: boolean;
    };
  }>;
}

const fullOffice = office("almaty_abay", {
  address: "Abay Ave 10",
  phone: "+7 727 000 00 00",
  mapUrl: "https://maps.google.com/?q=43.24,76.91",
  tags: ["flagship"],
  sortOrder: 4,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockReturnValue(createFindQuery([]));
  mockBulkWrite.mockResolvedValue({});
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
    ...doc,
    updatedAt: new Date("2026-10-05T09:30:00.000Z"),
  }));
});

describe("saveBusinessLocations", () => {
  it("upserts each office by workspace and key with the exact update", async () => {
    mockFind.mockReturnValue(createFindQuery([{ key: "almaty_abay" }]));

    await saveBusinessLocations({
      workspaceId: "workspace-1",
      userId: "user-1",
      rows: [
        { office: fullOffice, isActive: true, sortOrder: 4 },
        row("almaty_dostyk", { isActive: false }),
      ],
    });

    expect(mockFind).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
    expect(mockFind.mock.results[0].value.select).toHaveBeenCalledWith(
      "key isActive"
    );
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    expect(mockBulkWrite.mock.calls[0][1]).toEqual({
      ordered: false,
      throwOnValidationError: true,
    });
    expect(bulkWriteOperations()).toEqual([
      {
        updateOne: {
          filter: { workspaceId: "workspace-1", key: "almaty_abay" },
          update: {
            $set: {
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
              isActive: true,
              sortOrder: 4,
              updatedBy: "user-1",
            },
            $setOnInsert: { createdBy: "user-1" },
          },
          upsert: true,
        },
      },
      {
        updateOne: {
          filter: { workspaceId: "workspace-1", key: "almaty_dostyk" },
          update: {
            $set: {
              name: "Abay",
              country: "KZ",
              city: "Almaty",
              cityKey: "almaty",
              tags: [],
              latitude: 43.24,
              longitude: 76.91,
              isActive: false,
              updatedBy: "user-1",
            },
            $unset: { address: "", phone: "", mapUrl: "" },
            $setOnInsert: { createdBy: "user-1" },
          },
          upsert: true,
        },
      },
    ]);
  });

  it("unsets only the optional fields an office no longer has", async () => {
    await saveBusinessLocations({
      workspaceId: "workspace-1",
      userId: "user-1",
      rows: [
        {
          office: office("almaty_abay", { address: "Abay Ave 10" }),
          isActive: true,
          sortOrder: undefined,
        },
      ],
    });

    const [{ updateOne }] = bulkWriteOperations();
    expect(updateOne.update.$set).toEqual(
      expect.objectContaining({ address: "Abay Ave 10" })
    );
    expect(updateOne.update.$set).not.toHaveProperty("sortOrder");
    expect(updateOne.update.$unset).toEqual({ phone: "", mapUrl: "" });
  });

  it("never writes a path in both $set and $setOnInsert", async () => {
    await saveBusinessLocations({
      workspaceId: "workspace-1",
      userId: "user-1",
      rows: [{ office: fullOffice, isActive: true, sortOrder: 4 }],
    });

    const [{ updateOne }] = bulkWriteOperations();
    const setPaths = Object.keys(updateOne.update.$set);
    for (const path of Object.keys(updateOne.update.$setOnInsert)) {
      expect(setPaths).not.toContain(path);
    }
  });

  it("counts created and updated offices against the catalog as it is", async () => {
    mockFind.mockReturnValue(
      createFindQuery([
        { key: "almaty_abay", isActive: true },
        { key: "almaty_closed", isActive: false },
      ])
    );

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [row("almaty_abay"), row("almaty_closed"), row("astana_new")],
      })
    ).resolves.toEqual({ created: 1, updated: 2, deactivated: 0 });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("deactivates the workspace's other active offices when asked", async () => {
    mockFind.mockReturnValue(createFindQuery(storedOffices(3)));
    mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [row("stored_0"), row("astana_new")],
        deactivateMissing: true,
      })
    ).resolves.toEqual({ created: 1, updated: 1, deactivated: 2 });

    expect(mockUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        key: { $nin: ["stored_0", "astana_new"] },
        isActive: true,
      },
      { $set: { isActive: false, updatedBy: "user-1" } }
    );
    expect(mockBulkWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateMany.mock.invocationCallOrder[0]
    );
  });

  it("refuses more than 500 active offices after the merge, before writing", async () => {
    mockFind.mockReturnValue(createFindQuery(storedOffices(499)));

    const error = await saveBusinessLocations({
      workspaceId: "workspace-1",
      userId: "user-1",
      rows: [row("new_1"), row("new_2")],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BusinessLocationsLimitError);
    expect(error).toMatchObject({ code: "office_limit", limit: 500 });
    expect(mockBulkWrite).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("counts an updated office once and an inactive one not at all", async () => {
    mockFind.mockReturnValue(createFindQuery(storedOffices(500)));

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [
          row("stored_0"),
          row("stored_1", { isActive: false }),
          row("new_active"),
          row("new_inactive", { isActive: false }),
        ],
      })
    ).resolves.toEqual({ created: 2, updated: 2, deactivated: 0 });
  });

  it("counts only the request's active offices when the rest are deactivated", async () => {
    mockFind.mockReturnValue(createFindQuery(storedOffices(500)));
    const rows = [row("new_1"), row("new_2")];

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows,
      })
    ).rejects.toMatchObject({ code: "office_limit", limit: 500 });

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows,
        deactivateMissing: true,
      })
    ).resolves.toEqual(expect.objectContaining({ created: 2 }));
  });

  it("refuses more than 2000 records in all, inactive ones included", async () => {
    mockFind.mockReturnValue(
      createFindQuery([
        ...storedOffices(10),
        ...storedOffices(1990, false, "closed"),
      ])
    );

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [row("new_inactive", { isActive: false })],
        deactivateMissing: true,
      })
    ).rejects.toMatchObject({ code: "record_limit", limit: 2000 });
    expect(mockBulkWrite).not.toHaveBeenCalled();

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [row("closed_0")],
      })
    ).resolves.toEqual({ created: 0, updated: 1, deactivated: 0 });
  });

  // Two managers saving at once can leave a catalog past a limit.
  it("lets a catalog past a limit be edited and brought back down", async () => {
    mockFind.mockReturnValue(
      createFindQuery([
        ...storedOffices(600),
        ...storedOffices(1401, false, "closed"),
      ])
    );
    const save = (rows: BusinessLocationSaveRow[]) =>
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows,
      });

    await expect(save([row("stored_0", { isActive: false })])).resolves.toEqual(
      { created: 0, updated: 1, deactivated: 0 }
    );
    await expect(save([row("stored_1")])).resolves.toEqual({
      created: 0,
      updated: 1,
      deactivated: 0,
    });
    await expect(save([row("closed_0")])).rejects.toMatchObject({
      code: "office_limit",
    });
    await expect(
      save([row("new_inactive", { isActive: false })])
    ).rejects.toMatchObject({ code: "record_limit" });
  });

  it("reports the active limit before the record limit", async () => {
    mockFind.mockReturnValue(
      createFindQuery([
        ...storedOffices(500),
        ...storedOffices(1500, false, "closed"),
      ])
    );

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [row("new_active")],
      })
    ).rejects.toMatchObject({ code: "office_limit" });
  });

  it("reads a stored row without isActive as active", async () => {
    mockFind.mockReturnValue(
      createFindQuery(storedOffices(500).map(({ key }) => ({ key })))
    );

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [row("new_active")],
      })
    ).rejects.toMatchObject({ code: "office_limit" });
  });

  it("passes a failed bulk write on to the caller", async () => {
    const failure = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
    });
    mockBulkWrite.mockRejectedValue(failure);

    await expect(
      saveBusinessLocations({
        workspaceId: "workspace-1",
        userId: "user-1",
        rows: [row("almaty_abay")],
        deactivateMissing: true,
      })
    ).rejects.toBe(failure);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("createBusinessLocation", () => {
  it("creates the office in the workspace and returns its record", async () => {
    await expect(
      createBusinessLocation({
        workspaceId: "workspace-1",
        userId: "user-1",
        office: fullOffice,
        isActive: true,
        sortOrder: 4,
      })
    ).resolves.toEqual({
      ...fullOffice,
      isActive: true,
      sortOrder: 4,
      updatedAt: "2026-10-05T09:30:00.000Z",
    });

    expect(mockFind).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      ...fullOffice,
      isActive: true,
      sortOrder: 4,
      createdBy: "user-1",
      updatedBy: "user-1",
    });
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("stores sort order 0 when none was sent", async () => {
    await createBusinessLocation({
      workspaceId: "workspace-1",
      userId: "user-1",
      ...row("almaty_abay", { isActive: false }),
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sortOrder: 0, isActive: false })
    );
  });

  it("refuses a key the workspace already has, inactive or not", async () => {
    mockFind.mockReturnValue(
      createFindQuery([{ key: "almaty_abay", isActive: false }])
    );

    const error = await createBusinessLocation({
      workspaceId: "workspace-1",
      userId: "user-1",
      ...row("almaty_abay"),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BusinessLocationKeyTakenError);
    expect(error).toMatchObject({ key: "almaty_abay" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("turns a duplicate-key race into a taken key", async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
    );

    await expect(
      createBusinessLocation({
        workspaceId: "workspace-1",
        userId: "user-1",
        ...row("almaty_abay"),
      })
    ).rejects.toBeInstanceOf(BusinessLocationKeyTakenError);
  });

  it("passes any other failure on", async () => {
    const failure = new Error("connection reset");
    mockCreate.mockRejectedValue(failure);

    await expect(
      createBusinessLocation({
        workspaceId: "workspace-1",
        userId: "user-1",
        ...row("almaty_abay"),
      })
    ).rejects.toBe(failure);
  });

  it("checks both limits for the one new office", async () => {
    mockFind.mockReturnValue(createFindQuery(storedOffices(500)));
    await expect(
      createBusinessLocation({
        workspaceId: "workspace-1",
        userId: "user-1",
        ...row("new_active"),
      })
    ).rejects.toMatchObject({ code: "office_limit", limit: 500 });
    await expect(
      createBusinessLocation({
        workspaceId: "workspace-1",
        userId: "user-1",
        ...row("new_inactive", { isActive: false }),
      })
    ).resolves.toEqual(expect.objectContaining({ key: "new_inactive" }));

    mockFind.mockReturnValue(
      createFindQuery(storedOffices(2000, false, "closed"))
    );
    await expect(
      createBusinessLocation({
        workspaceId: "workspace-1",
        userId: "user-1",
        ...row("new_inactive", { isActive: false }),
      })
    ).rejects.toMatchObject({ code: "record_limit", limit: 2000 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
