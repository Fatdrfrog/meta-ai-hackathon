import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "redis";
import { createAtomicRealtimePublisher } from "./realtime-atomic-publisher.js";
import type { RealtimeValkeyClient } from "./realtime-valkey.js";

function requireValkeyUrl(): string {
  const valkeyUrl = process.env.REALTIME_VALKEY_URL;
  if (!valkeyUrl) {
    throw new Error(
      "REALTIME_VALKEY_URL is required for Valkey integration tests",
    );
  }
  return valkeyUrl;
}

function waitForFrame<T>(frames: T[], timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let interval: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = () => {
      if (interval) clearInterval(interval);
      if (deadline) clearTimeout(deadline);
    };
    const markSettled = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    const poll = () => {
      const frame = frames[0];
      if (frame === undefined || settled) return;
      markSettled();
      resolve(frame);
    };
    deadline = setTimeout(() => {
      if (settled) return;
      markSettled();
      reject(new Error("timed out waiting for Valkey subscriber frame"));
    }, timeoutMs);
    interval = setInterval(poll, 10);
    poll();
  });
}

test("real Valkey emits one frame for duplicate atomic publishes", async (t) => {
  const valkeyUrl = requireValkeyUrl();
  const suffix = randomUUID().replace(/-/g, "");
  const dedupeKey = `test:requests:atomic:dedupe:${suffix}`;
  const channel = `test:requests:atomic:channel:${suffix}`;
  const message = JSON.stringify({ id: suffix });
  const publisherClient = createClient({ url: valkeyUrl });
  const subscriberClient = publisherClient.duplicate();
  const frames: string[] = [];

  t.after(async () => {
    await publisherClient.del(dedupeKey).catch(() => undefined);
    await Promise.all([
      subscriberClient.quit().catch(() => undefined),
      publisherClient.quit().catch(() => undefined),
    ]);
  });

  await Promise.all([publisherClient.connect(), subscriberClient.connect()]);
  await subscriberClient.subscribe(channel, (frame) => frames.push(frame));

  const publisher = createAtomicRealtimePublisher(
    publisherClient as unknown as RealtimeValkeyClient,
  );
  assert.deepEqual(
    await publisher.publishOnce({
      dedupeKey,
      ttlSeconds: 60,
      channel,
      message,
    }),
    { kind: "published", subscriberCount: 1 },
  );
  assert.equal(await waitForFrame(frames), message);
  assert.deepEqual(
    await publisher.publishOnce({
      dedupeKey,
      ttlSeconds: 60,
      channel,
      message,
    }),
    { kind: "duplicate" },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(frames, [message]);
});

test("real Valkey Lua publish errors roll back only newly created keys", async (t) => {
  const valkeyUrl = requireValkeyUrl();
  const suffix = randomUUID().replace(/-/g, "");
  const aclUser = `test_atomic_${suffix}`;
  const aclPassword = `test-atomic-${suffix}`;
  const normalKey = `test:requests:atomic:acl:normal:${suffix}`;
  const channel = `test:requests:atomic:acl:channel:${suffix}`;
  const adminClient = createClient({ url: valkeyUrl });
  const restrictedClient = createClient({
    url: valkeyUrl,
    username: aclUser,
    password: aclPassword,
  });

  t.after(async () => {
    if (adminClient.isOpen) {
      await adminClient.del([normalKey]);
      assert.equal(await adminClient.exists(normalKey), 0);
    }
    if (restrictedClient.isOpen) await restrictedClient.quit();
    if (adminClient.isOpen) {
      await adminClient.sendCommand(["ACL", "DELUSER", aclUser]);
      await adminClient.quit();
    }
  });

  await adminClient.connect();
  await adminClient.sendCommand([
    "ACL",
    "SETUSER",
    aclUser,
    "reset",
    "on",
    `>${aclPassword}`,
    "~test:requests:atomic:*",
    "&test:requests:atomic:*",
    "+auth",
    "+ping",
    "+hello",
    "+client",
    "+eval",
    "+set",
    "+del",
    "+exists",
    "+get",
    "-publish",
  ]);
  await restrictedClient.connect();

  const publisher = createAtomicRealtimePublisher(
    restrictedClient as unknown as RealtimeValkeyClient,
  );
  const message = JSON.stringify({ id: suffix });

  assert.deepEqual(
    await publisher.publishOnce({
      dedupeKey: normalKey,
      ttlSeconds: 60,
      channel,
      message,
    }),
    { kind: "publish_failed" },
  );
  assert.equal(await adminClient.exists(normalKey), 0);

  await adminClient.set(normalKey, "normal-sentinel", { PX: 60_000 });
  assert.deepEqual(
    await publisher.publishOnce({
      dedupeKey: normalKey,
      ttlSeconds: 60,
      channel,
      message,
    }),
    { kind: "duplicate" },
  );
  assert.equal(await adminClient.get(normalKey), "normal-sentinel");
});

test("no-frame waiter rejects within its deadline and exits cleanly", async () => {
  const startedAt = Date.now();
  await assert.rejects(waitForFrame([], 25), /timed out waiting for Valkey/);
  assert.ok(Date.now() - startedAt < 250);
});
