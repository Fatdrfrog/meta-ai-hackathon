import assert from "node:assert/strict";
import test from "node:test";

test("critical cache operations fail closed without production Redis", async () => {
  process.env.NODE_ENV = "production";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const { cache } = await import("./cache");

  assert.deepEqual(await cache.readWithStatus("missing"), {
    status: "unavailable",
  });
  assert.equal(
    await cache.writeWithStatus("missing", "value", 60),
    "unavailable",
  );
  assert.equal(
    await cache.consumeIfMatches("missing", "binding"),
    "unavailable",
  );
  assert.equal(
    await cache.publishIfLockOwned({
      lockKey: "lock",
      ownerToken: "owner",
      valueKey: "value",
      value: "payload",
      ttlSeconds: 60,
    }),
    "unavailable",
  );
});
