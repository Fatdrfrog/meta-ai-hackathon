import assert from "node:assert/strict";
import test from "node:test";

import {
  BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC,
  BULK_DISPATCH_PAYLOAD_KEY_PREFIX,
  BULK_DISPATCH_PAYLOAD_MAX_BYTES,
  getBulkDispatchBucketName,
  isBulkDispatchPayloadStoreConfigured,
  loadBulkCampaignDispatchItemsSlice,
  resolveBulkDispatchPayloadTtlSeconds,
  setBulkDispatchStorageClientForTests,
  storeBulkCampaignDispatchItems,
  type BulkDispatchGcsClient,
} from "./bulk-dispatch-payload-store";

function createMemoryGcsClient() {
  const objects = new Map<string, Buffer>();
  const reads: Array<{ key: string; bytes: number }> = [];
  const writes: Array<{ key: string; options: unknown }> = [];
  const client: BulkDispatchGcsClient = {
    bucket: (bucketName: string) => ({
      file: (path: string) => ({
        save: async (data, _options) => {
          const key = `${bucketName}:${path}`;
          writes.push({ key, options: _options });
          objects.set(
            key,
            Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"),
          );
        },
        download: async () => {
          const key = `${bucketName}:${path}`;
          const value = objects.get(key);
          if (!value) {
            const error = new Error("Not Found") as Error & { code?: number };
            error.code = 404;
            throw error;
          }
          reads.push({ key, bytes: value.byteLength });
          return [value];
        },
      }),
    }),
  };
  return { client, objects, reads, writes };
}

test("resolveBulkDispatchPayloadTtlSeconds keeps base window and extends for retainUntil", () => {
  assert.equal(
    resolveBulkDispatchPayloadTtlSeconds(),
    BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC,
  );
  assert.equal(
    resolveBulkDispatchPayloadTtlSeconds({
      now: new Date("2099-05-14T10:00:00.000Z"),
      retainUntil: "2099-05-15T10:00:00.000Z",
    }),
    BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC + 24 * 60 * 60,
  );
  assert.equal(
    resolveBulkDispatchPayloadTtlSeconds({
      now: new Date("2099-05-14T10:00:00.000Z"),
      retainUntil: "not-a-date",
    }),
    BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC,
  );
});

test("isBulkDispatchPayloadStoreConfigured uses GCS bucket env", () => {
  const previousBulk = process.env.GCS_BULK_DISPATCH_BUCKET;
  const previousCreative = process.env.GCS_CREATIVE_ASSETS_BUCKET;
  delete process.env.GCS_BULK_DISPATCH_BUCKET;
  delete process.env.GCS_CREATIVE_ASSETS_BUCKET;
  assert.equal(isBulkDispatchPayloadStoreConfigured(), false);

  process.env.GCS_CREATIVE_ASSETS_BUCKET = "creative-bucket";
  assert.equal(getBulkDispatchBucketName(), "creative-bucket");
  assert.equal(isBulkDispatchPayloadStoreConfigured(), true);

  process.env.GCS_BULK_DISPATCH_BUCKET = "bulk-bucket";
  assert.equal(getBulkDispatchBucketName(), "bulk-bucket");

  process.env.GCS_BULK_DISPATCH_BUCKET = previousBulk;
  process.env.GCS_CREATIVE_ASSETS_BUCKET = previousCreative;
});

test("store and load slice from GCS staging", async () => {
  const previousBulk = process.env.GCS_BULK_DISPATCH_BUCKET;
  process.env.GCS_BULK_DISPATCH_BUCKET = "test-bulk-bucket";
  const { client } = createMemoryGcsClient();
  setBulkDispatchStorageClientForTests(client);

  const items = [
    { channel: "whatsapp", workspaceId: "ws-1", recipient: { phone: "1" } },
    { channel: "whatsapp", workspaceId: "ws-1", recipient: { phone: "2" } },
    { channel: "whatsapp", workspaceId: "ws-1", recipient: { phone: "3" } },
  ] as never;

  const stored = await storeBulkCampaignDispatchItems({
    workspaceId: "ws-1",
    items,
  });
  assert.match(
    stored.payloadKey,
    new RegExp(`^${BULK_DISPATCH_PAYLOAD_KEY_PREFIX}/ws-1/.+\\.json$`),
  );
  assert.ok(stored.byteLength > 0);
  assert.ok(stored.byteLength < BULK_DISPATCH_PAYLOAD_MAX_BYTES);

  const slice = await loadBulkCampaignDispatchItemsSlice({
    workspaceId: "ws-1",
    payloadKey: stored.payloadKey,
    offset: 1,
    limit: 1,
  });
  assert.equal(slice.length, 1);
  assert.equal(
    (slice[0] as { recipient: { phone: string } }).recipient.phone,
    "2",
  );

  await assert.rejects(
    () =>
      loadBulkCampaignDispatchItemsSlice({
        workspaceId: "other-ws",
        payloadKey: stored.payloadKey,
        offset: 0,
        limit: 1,
      }),
    /Invalid bulk dispatch payload key/,
  );

  setBulkDispatchStorageClientForTests(null);
  process.env.GCS_BULK_DISPATCH_BUCKET = previousBulk;
});

test("large audiences read bounded immutable chunks and preserve crossing slices", async () => {
  process.env.GCS_BULK_DISPATCH_BUCKET = "test-bulk-bucket";
  const { client, objects, reads, writes } = createMemoryGcsClient();
  setBulkDispatchStorageClientForTests(client);
  const items = Array.from({ length: 5_000 }, (_, index) => ({
    index,
    text: "x".repeat(100),
  }));
  const stored = await storeBulkCampaignDispatchItems({
    workspaceId: "ws-1",
    items,
  });
  const manifest = JSON.parse(
    objects.get(`test-bulk-bucket:${stored.payloadKey}`)!.toString(),
  );
  assert.equal(manifest.version, 2);
  assert.ok(manifest.chunks.length > 1);
  assert.equal(manifest.itemCount, items.length);
  const boundary = manifest.chunks[0].count;
  const slice = await loadBulkCampaignDispatchItemsSlice({
    workspaceId: "ws-1",
    payloadKey: stored.payloadKey,
    offset: boundary - 1,
    limit: 3,
  });
  assert.deepEqual(slice, items.slice(boundary - 1, boundary + 2));
  assert.ok(
    reads.reduce((total, read) => total + read.bytes, 0) <
      stored.byteLength / 4,
  );
  assert.equal(reads.length, 3);
  assert.equal(writes.at(-1)?.key, `test-bulk-bucket:${stored.payloadKey}`);
  for (const write of writes) {
    const options = write.options as {
      preconditionOpts: { ifGenerationMatch: number };
      metadata: { customTime: string };
    };
    assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
    assert.ok(options.metadata.customTime);
  }
  const firstChunk = `${stored.payloadKey}.chunks/0.json`;
  objects.set(`test-bulk-bucket:${firstChunk}`, Buffer.from("[0]"));
  await assert.rejects(
    loadBulkCampaignDispatchItemsSlice({
      workspaceId: "ws-1",
      payloadKey: stored.payloadKey,
      offset: 0,
      limit: 1,
    }),
    /integrity/,
  );
  setBulkDispatchStorageClientForTests(null);
});

test("legacy payload arrays remain readable and invalid bounds do not download", async () => {
  process.env.GCS_BULK_DISPATCH_BUCKET = "test-bulk-bucket";
  const { client, objects, reads } = createMemoryGcsClient();
  setBulkDispatchStorageClientForTests(client);
  const payloadKey = `${BULK_DISPATCH_PAYLOAD_KEY_PREFIX}/ws-1/legacy.json`;
  objects.set(
    `test-bulk-bucket:${payloadKey}`,
    Buffer.from(JSON.stringify([1, 2, 3])),
  );
  assert.deepEqual(
    await loadBulkCampaignDispatchItemsSlice({
      workspaceId: "ws-1",
      payloadKey,
      offset: 1,
      limit: 2,
    }),
    [2, 3],
  );
  reads.length = 0;
  await assert.rejects(
    loadBulkCampaignDispatchItemsSlice({
      workspaceId: "ws-1",
      payloadKey,
      offset: 0.5,
      limit: 1,
    }),
    /bounds/,
  );
  assert.equal(reads.length, 0);
  setBulkDispatchStorageClientForTests(null);
});
