import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";

import {
  COMPANY_STORAGE_LIMIT_BYTES,
  StorageQuotaStore,
  storageObjectId,
} from "./storage-quota";

const uri = process.env.STORAGE_QUOTA_TEST_URI;
if (
  uri &&
  !/^mongodb:\/\/127\.0\.0\.1:\d+\/airi_storage_quota_test\?/.test(uri)
) {
  throw new Error(
    "STORAGE_QUOTA_TEST_URI must name the isolated local replica-set fixture",
  );
}
describe("company storage quota on Mongo", { skip: !uri }, () => {
  const connection = mongoose.createConnection();
  const store = new StorageQuotaStore(connection);

  before(async () => {
    await connection.openUri(uri!);
    await connection.dropDatabase();
    await store.ensureIndexes();
  });
  after(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  const object = (companyId: string, path: string, bytes: number) => ({
    companyId,
    workspaceId: `${companyId}-workspace`,
    provider: "gcs" as const,
    bucket: "test",
    path,
    bytes,
  });

  test("uninitialized inventory blocks storage writes", async () => {
    await assert.rejects(
      store.reserve(object("missing", "a", 1)),
      /inventory/i,
    );
  });

  test("record mode bootstraps one unready company and bounds concurrent new bytes", async () => {
    const recording = new StorageQuotaStore(connection, "record");
    const bytes = COMPANY_STORAGE_LIMIT_BYTES / 4;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        recording.reserve(object("recording", `recorded-${index}`, bytes)),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      4,
    );
    for (const result of results)
      if (result.status === "rejected")
        assert.equal(result.reason.code, "company_storage_limit_exceeded");
    const usage = await recording.usage("recording");
    assert.equal(usage?.ready, false);
    assert.equal(usage?.chargedBytes, COMPANY_STORAGE_LIMIT_BYTES);
    assert.equal(usage?.inventoryCompletedAt, undefined);
    await assert.rejects(
      store.reserve(object("recording", "strict", 1)),
      /inventory/i,
    );
  });

  test("concurrent first uploads reuse a recorded identity without resetting its account", async () => {
    const recording = new StorageQuotaStore(connection, "record");
    const input = object("record-replay", "same-new-object", 8);
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => recording.reserve(input)),
    );
    assert.equal(new Set(claims.map((claim) => claim._id)).size, 1);
    await recording.settle(claims[0]!._id, 8);
    await store.beginInventory(input.companyId);
    await store.inventoryObject(input);
    assert.equal((await store.usage(input.companyId))?.chargedBytes, 8);
    assert.equal((await store.usage(input.companyId))?.storedBytes, 8);
    assert.equal((await store.usage(input.companyId))?.ready, false);
  });

  test("record mode cannot bypass an activated company limit", async () => {
    await store.beginInventory("ready-recording", 10);
    await store.inventoryObject(object("ready-recording", "existing", 9));
    await store.finishInventory("ready-recording");
    const recording = new StorageQuotaStore(connection, "record");
    await assert.rejects(
      recording.reserve(object("ready-recording", "new", 2)),
      /limit/i,
    );
    assert.equal((await recording.usage("ready-recording"))?.chargedBytes, 9);
  });

  test("inventory merges recorded grants without resetting capacity or losing their ceiling", async () => {
    const recording = new StorageQuotaStore(connection, "record");
    const input = {
      ...object("recorded-grant", "signed-grant", 100),
      provider: "supabase" as const,
      grantByteCeiling: 100,
    };
    const claim = await recording.reserve(input);
    await store.beginInventory(input.companyId);
    const physical = { ...input, bytes: 4, grantByteCeiling: undefined };
    await store.inventoryObject(physical);
    await store.inventoryObject(physical);
    await store.inventoryObject(object(input.companyId, "legacy", 7));
    await store.finishInventory(input.companyId);
    assert.equal((await store.read(claim._id))?.status, "stored");
    assert.equal((await store.read(claim._id))?.grantByteCeiling, 100);
    assert.equal((await store.usage(input.companyId))?.chargedBytes, 107);
    assert.equal((await store.usage(input.companyId))?.storedBytes, 11);
  });

  test("inventory keeps terminal recorded identities and rejects changed settled objects", async () => {
    const recording = new StorageQuotaStore(connection, "record");
    const input = object("recorded-tombstone", "deleted-recorded", 8);
    const claim = await recording.reserve(input);
    await recording.settle(claim._id, 8);
    await recording.tombstone(claim._id);
    await store.beginInventory(input.companyId);
    await store.inventoryObject({ ...input, bytes: 0 });
    assert.equal((await store.read(claim._id))?.status, "tombstoned");
    assert.equal((await store.usage(input.companyId))?.chargedBytes, 8);
    await assert.rejects(
      store.inventoryObject({ ...input, bytes: 2 }),
      /tombstone/i,
    );
    await assert.rejects(
      store.inventoryObject({ ...input, workspaceId: "foreign", bytes: 0 }),
      /identity/i,
    );
    const settled = object(input.companyId, "settled-recorded", 4);
    const settledClaim = await recording.reserve(settled);
    await recording.settle(settledClaim._id, 4);
    await assert.rejects(
      store.inventoryObject({ ...settled, bytes: 5 }),
      /identity/i,
    );
    assert.equal((await store.usage(input.companyId))?.ready, false);
  });

  test("inventory charges an original retained GCS generation once and distinct older generations separately", async () => {
    const recording = new StorageQuotaStore(connection, "record");
    const input = object("retained-recording", "deleted-generations", 8);
    const claim = await recording.reserve(input);
    await recording.settle(claim._id, 8);
    await recording.tombstone(claim._id, { generation: "original", bytes: 8 });
    await recording.tombstone(claim._id);
    await store.beginInventory(input.companyId);
    await store.inventoryObject({ ...input, bytes: 0 });
    await store.inventoryObject({ ...input, generation: "original" });
    await store.inventoryObject({ ...input, generation: "original" });
    assert.equal((await store.usage(input.companyId))?.chargedBytes, 8);
    assert.equal((await store.usage(input.companyId))?.storedBytes, 8);
    await store.inventoryObject({
      ...input,
      generation: "older-but-same-size",
    });
    await store.inventoryObject({
      ...input,
      generation: "older-but-same-size",
    });
    await store.finishInventory(input.companyId);
    assert.equal((await store.usage(input.companyId))?.chargedBytes, 16);
    assert.equal((await store.usage(input.companyId))?.storedBytes, 16);
    assert.equal((await store.read(claim._id))?.status, "tombstoned");
  });

  test("unknown retained generation cannot be guessed from its byte count", async () => {
    const recording = new StorageQuotaStore(connection, "record");
    const input = object("ambiguous-retained", "deleted-unknown", 8);
    const claim = await recording.reserve(input);
    await recording.settle(claim._id, 8);
    await recording.tombstone(claim._id);
    await store.beginInventory(input.companyId);
    await store.inventoryObject({ ...input, bytes: 0 });
    await assert.rejects(
      store.inventoryObject({ ...input, generation: "unknown" }),
      /retained generation.*unknown/i,
    );
    assert.equal((await store.usage(input.companyId))?.ready, false);
    assert.equal((await store.usage(input.companyId))?.chargedBytes, 8);
  });

  test("deletion pins the observed pending generation and rejects a later different generation", async () => {
    const recording = new StorageQuotaStore(connection, "record");
    const input = object("pending-retained", "pending-delete", 8);
    const claim = await recording.reserve(input);
    await recording.tombstone(claim._id, { generation: "observed", bytes: 8 });
    assert.equal((await recording.usage(input.companyId))?.storedBytes, 8);
    await assert.rejects(
      recording.tombstone(claim._id, { generation: "changed", bytes: 8 }),
      /generation.*changed/i,
    );
    await store.inventoryObject({ ...input, generation: "observed" });
    assert.equal((await store.usage(input.companyId))?.chargedBytes, 8);
  });

  test("parallel company reservations cannot overspend", async () => {
    await store.beginInventory("parallel", 10);
    await store.finishInventory("parallel");
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        store.reserve(object("parallel", String(index), 3)),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      3,
    );
    assert.equal((await store.usage("parallel"))?.chargedBytes, 9);
  });

  test("concurrent retries and repeated settlement charge one physical object", async () => {
    await store.beginInventory("retry", 10);
    await store.finishInventory("retry");
    const input = object("retry", "same", 6);
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => store.reserve(input)),
    );
    assert.equal(new Set(claims.map((claim) => claim._id)).size, 1);
    await Promise.all(claims.map((claim) => store.settle(claim._id, 6)));
    assert.equal((await store.usage("retry"))?.chargedBytes, 6);
    assert.equal((await store.read(storageObjectId(input)))?.status, "stored");
  });

  test("expired and absent uploads remain charged; orphan reconciliation settles once", async () => {
    await store.beginInventory("orphan", 10);
    await store.finishInventory("orphan");
    const claim = await store.reserve({
      ...object("orphan", "abandoned", 8),
      expiresAt: new Date(0),
    });
    await store.reconcile(claim._id, { exists: false });
    assert.equal((await store.usage("orphan"))?.chargedBytes, 8);
    assert.equal((await store.read(claim._id))?.status, "reserved");
    await store.reconcile(claim._id, { exists: true, bytes: 8 });
    assert.equal((await store.read(claim._id))?.status, "stored");
    assert.equal((await store.usage("orphan"))?.chargedBytes, 8);
  });

  test("inventory counts unreferenced objects and replay does not refill capacity", async () => {
    await store.beginInventory("legacy", 10);
    const item = object("legacy", "legacy-orphan", 7);
    await store.inventoryObject(item);
    await store.inventoryObject(item);
    await store.finishInventory("legacy");
    await assert.rejects(store.reserve(object("legacy", "new", 4)), /limit/i);
    await assert.rejects(store.beginInventory("legacy", 10), /already active/i);
    assert.equal((await store.usage("legacy"))?.chargedBytes, 7);
  });

  test("size mismatch and workspace transfer cannot reuse an existing reservation", async () => {
    await store.beginInventory("identity", 10);
    await store.finishInventory("identity");
    const item = object("identity", "immutable", 5);
    await store.reserve(item);
    await assert.rejects(store.reserve({ ...item, bytes: 4 }), /identity/i);
    await assert.rejects(
      store.reserve({ ...item, companyId: "other" }),
      /identity/i,
    );
  });

  test("unexpected physical excess remains accounted and blocks later admissions", async () => {
    await store.beginInventory("excess", 10);
    await store.finishInventory("excess");
    const claim = await store.reserve(object("excess", "object", 4));
    await store.settle(claim._id, 12);
    assert.equal((await store.usage("excess"))?.chargedBytes, 12);
    await assert.rejects(store.reserve(object("excess", "next", 1)), /limit/i);
  });

  test("a deleted object identity is terminal and retains its physical allocation", async () => {
    await store.beginInventory("deleted", 10);
    await store.finishInventory("deleted");
    const input = object("deleted", "deleted-object", 8);
    const claim = await store.reserve(input);
    await store.settle(claim._id, 8);
    await store.tombstone(claim._id);
    await store.tombstone(claim._id);
    await assert.rejects(store.reserve(input), /deleted/i);
    await assert.rejects(store.settle(claim._id, 8), /deleted/i);
    await assert.rejects(
      store.reconcile(claim._id, { exists: true, bytes: 0 }),
      /deleted/i,
    );
    assert.equal((await store.read(claim._id))?.status, "tombstoned");
    assert.equal((await store.usage("deleted"))?.chargedBytes, 8);
    assert.equal((await store.usage("deleted"))?.storedBytes, 8);
  });

  test("asset persistence cannot race a terminal storage identity", async () => {
    await store.beginInventory("finalize", 10);
    await store.finishInventory("finalize");
    const claim = await store.reserve(object("finalize", "finalize-object", 8));
    await store.settle(claim._id, 8);
    await store.tombstone(claim._id);
    let persisted = false;
    await assert.rejects(
      store.settle(claim._id, 8, async () => {
        persisted = true;
      }),
      /deleted/i,
    );
    assert.equal(persisted, false);
  });

  test("asset publication and settlement commit or roll back together", async () => {
    await store.beginInventory("atomic-publish", 10);
    await store.finishInventory("atomic-publish");
    const claim = await store.reserve(
      object("atomic-publish", "atomic-publish-object", 8),
    );
    const assets = connection.db!.collection("fixture_assets");
    await assert.rejects(
      store.settle(claim._id, 8, async (session) => {
        await assets.insertOne({ storageId: claim._id }, { session });
        throw new Error("publication failed");
      }),
      /publication failed/,
    );
    assert.equal(await assets.countDocuments({ storageId: claim._id }), 0);
    assert.equal((await store.read(claim._id))?.status, "reserved");
    await store.settle(claim._id, 8, async (session) => {
      await assets.insertOne({ storageId: claim._id }, { session });
    });
    assert.equal(await assets.countDocuments({ storageId: claim._id }), 1);
    assert.equal((await store.read(claim._id))?.status, "stored");
  });

  test("Supabase grant ceilings remain charged after a smaller physical object is observed", async () => {
    await store.beginInventory("grant-floor", 100);
    await store.finishInventory("grant-floor");
    const input = {
      ...object("grant-floor", "signed", 100),
      provider: "supabase" as const,
      grantByteCeiling: 100,
    };
    const record = await store.reserve(input);
    await store.settle(record._id, 4);
    const usage = await store.usage("grant-floor");
    assert.equal(usage?.chargedBytes, 100);
    assert.equal(usage?.storedBytes, 4);
    await assert.rejects(
      store.reserve(object("grant-floor", "other", 1)),
      /limit/i,
    );
  });
});
