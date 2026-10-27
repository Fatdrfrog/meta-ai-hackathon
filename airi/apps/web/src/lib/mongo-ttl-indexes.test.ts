import { ensureSingleFieldTtlIndex } from "./mongo-ttl-indexes";

describe("managed TTL indexes", () => {
  function fixture(indexes: Array<Record<string, unknown>> = []) {
    const persisted = [...indexes];
    const collection = {
      collectionName: "scenariotriggerlogs",
      indexes: jest.fn(async () => persisted),
      createIndex: jest.fn(async (key, options) => {
        persisted.push({ key, ...options });
        return options.name;
      }),
    };
    const db = {
      command: jest.fn(async command => {
        const index = persisted.find(item => item.name === command.index.name);
        if (index) index.expireAfterSeconds = command.index.expireAfterSeconds;
        return { ok: 1 };
      }),
    };
    const run = (dryRun = false) =>
      ensureSingleFieldTtlIndex({
        collection,
        db,
        field: "evaluatedAt",
        expireAfterSeconds: 2_592_000,
        dryRun,
      });
    return { collection, db, run };
  }

  it("previews the plain-index conversion without deleting records", async () => {
    const f = fixture([{ name: "evaluatedAt_1", key: { evaluatedAt: 1 } }]);
    await expect(f.run(true)).resolves.toEqual(
      expect.objectContaining({ action: "convert", dryRun: true })
    );
    expect(f.db.command).not.toHaveBeenCalled();
    expect(f.collection.createIndex).not.toHaveBeenCalled();
  });

  it("converts the existing plain index with collMod and verifies retention", async () => {
    const f = fixture([{ name: "evaluatedAt_1", key: { evaluatedAt: 1 } }]);
    await f.run();
    expect(f.db.command).toHaveBeenCalledWith({
      collMod: "scenariotriggerlogs",
      index: { name: "evaluatedAt_1", expireAfterSeconds: 2_592_000 },
    });
    expect(f.collection.indexes).toHaveBeenCalledTimes(2);
    expect(f.collection.createIndex).not.toHaveBeenCalled();
  });

  it("creates a missing TTL index", async () => {
    const f = fixture();
    await f.run();
    expect(f.collection.createIndex).toHaveBeenCalledWith(
      { evaluatedAt: 1 },
      { name: "evaluatedAt_1", expireAfterSeconds: 2_592_000 }
    );
  });

  it("repairs retention drift but leaves a correct TTL index untouched", async () => {
    const f = fixture([
      {
        name: "evaluatedAt_1",
        key: { evaluatedAt: 1 },
        expireAfterSeconds: 60,
      },
    ]);
    await f.run();
    await f.run();
    expect(f.db.command).toHaveBeenCalledTimes(1);
  });

  it.each([
    { unique: true },
    { sparse: true },
    { hidden: true },
    { partialFilterExpression: { status: "done" } },
    { collation: { locale: "en" } },
  ])("rejects unexpected index options %j", async options => {
    const f = fixture([
      { name: "evaluatedAt_1", key: { evaluatedAt: 1 }, ...options },
    ]);
    await expect(f.run()).rejects.toThrow("Unexpected TTL index definition");
    expect(f.db.command).not.toHaveBeenCalled();
  });

  it("rejects a canonical name occupied by a different key", async () => {
    const f = fixture([{ name: "evaluatedAt_1", key: { other: 1 } }]);
    await expect(f.run()).rejects.toThrow("Unexpected TTL index definition");
  });

  it("fails closed if collMod is denied or verification disagrees", async () => {
    const f = fixture([{ name: "evaluatedAt_1", key: { evaluatedAt: 1 } }]);
    f.db.command.mockRejectedValueOnce(new Error("Unauthorized"));
    await expect(f.run()).rejects.toThrow("Unauthorized");
    f.db.command.mockResolvedValueOnce({ ok: 1 });
    await expect(f.run()).rejects.toThrow("TTL index verification failed");
  });

  it.each([NaN, Infinity, -1, 0, 1.5, 2_147_483_648])(
    "rejects invalid TTL %s before database access",
    async expireAfterSeconds => {
      const f = fixture();
      await expect(
        ensureSingleFieldTtlIndex({
          collection: f.collection,
          db: f.db,
          field: "evaluatedAt",
          expireAfterSeconds,
        })
      ).rejects.toThrow("positive 32-bit integer");
      expect(f.collection.indexes).not.toHaveBeenCalled();
    }
  );
});
