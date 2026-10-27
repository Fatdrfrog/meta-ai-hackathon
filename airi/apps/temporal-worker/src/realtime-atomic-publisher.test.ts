import assert from "node:assert/strict";
import test from "node:test";
import {
  createAtomicRealtimePublisher,
  type AtomicPublishInput,
} from "./realtime-atomic-publisher.js";
import type { RealtimeValkeyClient } from "./realtime-valkey.js";

type StoredKey = { value: string; expiresAt: number };

class FakeValkey {
  readonly keys = new Map<string, StoredKey>();
  readonly published: Array<{ channel: string; message: string }> = [];
  readonly scripts: string[] = [];
  publishError = false;
  disconnectAfterSuccessfulScript = false;
  scriptReply: unknown | undefined;

  has(key: string): boolean {
    const stored = this.keys.get(key);
    if (!stored) return false;
    if (stored.expiresAt <= Date.now()) {
      this.keys.delete(key);
      return false;
    }
    return true;
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    this.scripts.push(script);
    const [key] = options.keys;
    const [ttl, channel, message] = options.arguments;
    assert.ok(key);
    assert.ok(ttl);
    assert.ok(channel);
    assert.ok(message);

    if (this.scriptReply !== undefined) return this.scriptReply;

    if (this.has(key)) return [-1, 0];

    const ttlMs = Number.parseInt(ttl, 10) * 1_000;
    this.keys.set(key, { value: "1", expiresAt: Date.now() + ttlMs });

    if (this.publishError) {
      this.keys.delete(key);
      return [-2, 0];
    }

    this.published.push({ channel, message });
    if (this.disconnectAfterSuccessfulScript) {
      throw new Error("connection dropped after script execution");
    }

    return [1, 2];
  }
}

const publishInput: AtomicPublishInput = {
  dedupeKey: "test:atomic:normal",
  ttlSeconds: 60,
  channel: "conversation:workspace:conversation",
  message: '{"id":"event-1"}',
};

function createPublisher(fake = new FakeValkey()) {
  return {
    fake,
    publisher: createAtomicRealtimePublisher(
      fake as unknown as RealtimeValkeyClient,
    ),
  };
}

test("atomically publishes a normal frame once and reports duplicates", async () => {
  const { fake, publisher } = createPublisher();

  assert.deepEqual(await publisher.publishOnce(publishInput), {
    kind: "published",
    subscriberCount: 2,
  });
  assert.deepEqual(await publisher.publishOnce(publishInput), {
    kind: "duplicate",
  });
  assert.equal(fake.has(publishInput.dedupeKey), true);
  assert.equal(fake.published.length, 1);
  assert.match(fake.scripts[0] || "", /redis\.pcall\("PUBLISH"/);
  assert.match(fake.scripts[0] || "", /redis\.call\("DEL", KEYS\[1\]\)/);
});

test("rolls back a newly created normal key when Lua reports a publish failure", async () => {
  const { fake, publisher } = createPublisher();
  fake.publishError = true;

  assert.deepEqual(await publisher.publishOnce(publishInput), {
    kind: "publish_failed",
  });
  assert.equal(fake.has(publishInput.dedupeKey), false);
});

test("retains a normal key after an ambiguous post-success client disconnect", async () => {
  const { fake, publisher } = createPublisher();
  fake.disconnectAfterSuccessfulScript = true;

  assert.deepEqual(await publisher.publishOnce(publishInput), {
    kind: "ambiguous",
  });
  assert.equal(fake.has(publishInput.dedupeKey), true);
});

test("treats every non-contract Lua tuple as ambiguous", async () => {
  const malformedReplies: readonly unknown[] = [
    [1, -1],
    [1, 1.5],
    [1, Number.POSITIVE_INFINITY],
    [1, Number.NaN],
    [1, Number.MAX_SAFE_INTEGER + 1],
    [-1, 1],
    [-2, 1],
    ["1", 2],
    [1, "2"],
    [1, 2, 3],
    [0, 0],
    [],
    null,
  ];

  for (const scriptReply of malformedReplies) {
    const { fake, publisher } = createPublisher();
    fake.scriptReply = scriptReply;
    assert.deepEqual(await publisher.publishOnce(publishInput), {
      kind: "ambiguous",
    });
  }
});
