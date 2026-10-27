import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "redis";
import { createRealtimeOutboxScanOwnership } from "./realtime-outbox-replayer.js";
import type { RealtimeValkeyClient } from "./realtime-valkey.js";

const url = process.env.REALTIME_VALKEY_URL;
const local = (() => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      ["redis:", "rediss:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
})();

test(
  "real Valkey fences scan ownership, expiry takeover and stale-owner release",
  { skip: !local },
  async () => {
    const client = createClient({ url });
    await client.connect();
    const a = createRealtimeOutboxScanOwnership(
      client as unknown as RealtimeValkeyClient,
      "integration-owner-a",
    );
    const b = createRealtimeOutboxScanOwnership(
      client as unknown as RealtimeValkeyClient,
      "integration-owner-b",
    );
    try {
      assert.equal(await a.acquireOrRenew(), true);
      assert.equal(await b.acquireOrRenew(), false);
      assert.equal(await a.acquireOrRenew(), true);
      assert.ok((await client.pTTL("realtime:outbox:scan-owner:v1")) > 25_000);
      await client.pExpire("realtime:outbox:scan-owner:v1", 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await b.acquireOrRenew(), true);
      await a.release();
      assert.equal(await a.acquireOrRenew(), false);
      await b.release();
      assert.equal(await a.acquireOrRenew(), true);
    } finally {
      await a.release();
      await b.release();
      await client.quit();
    }
  },
);
