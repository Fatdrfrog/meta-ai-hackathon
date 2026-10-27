import assert from "node:assert/strict";
import test from "node:test";

test("cache compareAndDelete only releases the matching owner token", async () => {
  process.env.NODE_ENV = "test";
  const { cache } = await import("./cache");
  const key = `cache-compare-delete-${Date.now()}-${Math.random()}`;

  await cache.set(key, "current-owner", 60);

  assert.equal(await cache.compareAndDelete(key, "stale-owner"), false);
  assert.equal(await cache.get(key), "current-owner");
  assert.equal(await cache.compareAndDelete(key, "current-owner"), true);
  assert.equal(await cache.get(key), null);
});

test("cache acquireLock distinguishes ownership from contention", async () => {
  process.env.NODE_ENV = "test";
  const { cache } = await import("./cache");
  const key = `cache-lock-${Date.now()}-${Math.random()}`;

  assert.equal(await cache.acquireLock(key, "owner-1", 60), "acquired");
  assert.equal(await cache.acquireLock(key, "owner-2", 60), "contended");
  assert.equal(await cache.compareAndDelete(key, "owner-1"), true);
  assert.equal(await cache.acquireLock(key, "owner-2", 60), "acquired");
});

test("cache claimCompletionLock atomically distinguishes completed updates", async () => {
  process.env.NODE_ENV = "test";
  const { cache } = await import("./cache");
  const suffix = `${Date.now()}-${Math.random()}`;
  const completionKey = `cache-completion-${suffix}`;
  const lockKey = `cache-in-progress-${suffix}`;

  assert.equal(
    await cache.claimCompletionLock({
      completionKey,
      lockKey,
      token: "owner-1",
      lockTtlSeconds: 60,
    }),
    "acquired",
  );
  assert.equal(
    await cache.claimCompletionLock({
      completionKey,
      lockKey,
      token: "owner-2",
      lockTtlSeconds: 60,
    }),
    "contended",
  );

  assert.equal(await cache.compareAndDelete(lockKey, "owner-1"), true);
  await cache.set(completionKey, "done", 60);

  assert.equal(
    await cache.claimCompletionLock({
      completionKey,
      lockKey,
      token: "owner-2",
      lockTtlSeconds: 60,
    }),
    "completed",
  );
  assert.equal(await cache.get(lockKey), null);
});

test("cache finalizeCompletionLock atomically publishes completion for its owner", async () => {
  process.env.NODE_ENV = "test";
  const { cache } = await import("./cache");
  const suffix = `${Date.now()}-${Math.random()}`;
  const completionKey = `cache-finalized-${suffix}`;
  const lockKey = `cache-finalizing-${suffix}`;

  assert.equal(
    await cache.claimCompletionLock({
      completionKey,
      lockKey,
      token: "owner-1",
      lockTtlSeconds: 60,
    }),
    "acquired",
  );
  assert.equal(
    await cache.finalizeCompletionLock({
      completionKey,
      completionValue: "done",
      completionTtlSeconds: 60,
      lockKey,
      token: "owner-1",
    }),
    "finalized",
  );
  assert.equal(await cache.get(completionKey), "done");
  assert.equal(await cache.get(lockKey), null);
});

test("cache finalizeCompletionLock cannot finalize or release a newer owner", async () => {
  process.env.NODE_ENV = "test";
  const { cache } = await import("./cache");
  const suffix = `${Date.now()}-${Math.random()}`;
  const completionKey = `cache-stale-finalize-${suffix}`;
  const lockKey = `cache-current-owner-${suffix}`;

  await cache.set(lockKey, "owner-2", 60);

  assert.equal(
    await cache.finalizeCompletionLock({
      completionKey,
      completionValue: "done",
      completionTtlSeconds: 60,
      lockKey,
      token: "owner-1",
    }),
    "not_owner",
  );
  assert.equal(await cache.get(completionKey), null);
  assert.equal(await cache.get(lockKey), "owner-2");
});

test("status cache preserves miss, hit, write, and one-time consumption", async () => {
  process.env.NODE_ENV = "test";
  const { cache } = await import("./cache");
  const suffix = `${Date.now()}-${Math.random()}`;
  const valueKey = `cache-status-${suffix}`;
  const stateKey = `cache-consume-${suffix}`;

  assert.deepEqual(await cache.readWithStatus(valueKey), { status: "miss" });
  assert.equal(
    await cache.writeWithStatus(valueKey, { ok: true }, 60),
    "stored",
  );
  assert.deepEqual(await cache.readWithStatus(valueKey), {
    status: "hit",
    value: { ok: true },
  });
  await cache.set(stateKey, "binding", 60);
  assert.equal(await cache.consumeIfMatches(stateKey, "wrong"), "invalid");
  assert.equal(await cache.consumeIfMatches(stateKey, "binding"), "consumed");
  assert.equal(await cache.consumeIfMatches(stateKey, "binding"), "invalid");
});

test("owner-checked publication cannot write after its lease is lost", async () => {
  process.env.NODE_ENV = "test";
  const { cache } = await import("./cache");
  const suffix = `${Date.now()}-${Math.random()}`;
  const lockKey = `publish-lock-${suffix}`;
  const valueKey = `publish-value-${suffix}`;
  assert.equal(await cache.acquireLock(lockKey, "owner-a", 60), "acquired");
  assert.equal(
    await cache.publishIfLockOwned({
      lockKey,
      ownerToken: "owner-b",
      valueKey,
      value: { generation: "b" },
      ttlSeconds: 300,
    }),
    "lost",
  );
  assert.deepEqual(await cache.readWithStatus(valueKey), { status: "miss" });
  assert.equal(
    await cache.publishIfLockOwned({
      lockKey,
      ownerToken: "owner-a",
      valueKey,
      value: { generation: "a" },
      ttlSeconds: 300,
    }),
    "published",
  );
  assert.deepEqual(await cache.readWithStatus(valueKey), {
    status: "hit",
    value: { generation: "a" },
  });
  assert.equal(await cache.acquireLock(lockKey, "owner-b", 60), "acquired");
});
