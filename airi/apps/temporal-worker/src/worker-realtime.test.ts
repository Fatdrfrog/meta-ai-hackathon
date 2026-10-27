import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkerRealtimeTrigger,
  hasWorkerDirectRealtimeConfig,
} from "./worker-realtime.js";
import type { RealtimeValkeyClient } from "./realtime-valkey.js";

function buildMappedEvent() {
  return {
    eventId: "event-1",
    version: 1 as const,
    name: "conversation.message.created" as const,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    createdAt: "2026-07-04T00:00:00.000Z",
    dedupeKey:
      "conversation.message.created:workspace-1:conversation-1:message-1:new-message",
    payload: {
      legacyEvent: "new-message",
      conversationId: "conversation-1",
      messageId: "message-1",
      data: { _id: "message-1", workspaceId: "workspace-1" },
    },
    channel: "conversation:workspace-1:conversation-1",
  };
}

type FakeOutcome = "published" | "publish_failed" | "ambiguous";

class FakeAtomicValkey {
  readonly proofKeys = new Set<string>();
  readonly forwarded: unknown[] = [];
  readonly evalCalls: Array<{ key: string; message: string }> = [];
  deleteCalls = 0;
  outcome: FakeOutcome = "published";

  async eval(
    _script: string,
    input: { keys: readonly string[]; arguments: readonly string[] },
  ): Promise<readonly [number, number]> {
    const key = input.keys[0];
    const message = input.arguments[2];
    assert.equal(typeof key, "string");
    assert.equal(typeof message, "string");
    this.evalCalls.push({ key, message });

    if (this.proofKeys.has(key)) return [-1, 0];
    if (this.outcome === "publish_failed") return [-2, 0];

    this.proofKeys.add(key);
    this.forwarded.push(JSON.parse(message));
    if (this.outcome === "ambiguous") {
      throw new Error("connection dropped after atomic execution");
    }
    return [1, 2];
  }

  async del(): Promise<number> {
    this.deleteCalls += 1;
    return 1;
  }

  async set(): Promise<"OK"> {
    return "OK";
  }

  async publish(): Promise<number> {
    return 2;
  }
}

function directEnv(): NodeJS.ProcessEnv {
  return {
    MEMORYSTORE_VALKEY_HOST: "10.0.0.1",
    WORKER_REALTIME_DIRECT_VALKEY_ENABLED: "true",
  };
}

function logger() {
  return { info: () => undefined, error: () => undefined };
}

test("detects direct realtime Valkey config", () => {
  assert.equal(hasWorkerDirectRealtimeConfig({}), false);
  assert.equal(
    hasWorkerDirectRealtimeConfig({ MEMORYSTORE_VALKEY_HOST: "10.0.0.1" }),
    false,
  );
  assert.equal(hasWorkerDirectRealtimeConfig(directEnv()), true);
  assert.equal(
    hasWorkerDirectRealtimeConfig({
      MEMORYSTORE_VALKEY_URL: "redis://x",
      WORKER_REALTIME_DIRECT_VALKEY_ENABLED: "1",
    }),
    true,
  );
});

test("keeps the legacy raw fallback when direct Valkey is not configured", async () => {
  const rawFallbackCalls: unknown[][] = [];
  const trigger = createWorkerRealtimeTrigger({
    env: {},
    fallbackTrigger: async (...args) => {
      rawFallbackCalls.push(args);
      return { ok: true, fallback: "raw" };
    },
  });

  const result = await trigger("tenant-workspace-1", "requests.update", {
    _id: "conversation-1",
  });

  assert.deepEqual(result, { ok: true, fallback: "raw" });
  assert.deepEqual(rawFallbackCalls, [
    ["tenant-workspace-1", "requests.update", { _id: "conversation-1" }],
  ]);
});

test("publishes one exact mapped frame atomically when direct Valkey succeeds", async () => {
  const valkey = new FakeAtomicValkey();
  const event = buildMappedEvent();
  let mapCalls = 0;
  const rawFallbackCalls: unknown[][] = [];
  const trigger = createWorkerRealtimeTrigger({
    env: directEnv(),
    logger: logger(),
    mapEvent: async () => {
      mapCalls += 1;
      return event;
    },
    connectPublisher: async () => valkey as unknown as RealtimeValkeyClient,
    fallbackTrigger: async (...args) => {
      rawFallbackCalls.push(args);
      return { ok: true, fallback: "raw" };
    },
  });

  const result = await trigger("tenant-workspace-1", "requests.update", {
    _id: "conversation-1",
  });

  assert.deepEqual(result, { ok: true, subscriberCount: 2 });
  assert.equal(mapCalls, 1);
  assert.equal(rawFallbackCalls.length, 0);
  assert.equal(valkey.evalCalls.length, 1);
  assert.deepEqual(valkey.forwarded, [
    { type: "event", channel: event.channel, event },
  ]);
  assert.equal(valkey.deleteCalls, 0);
});

test("suppresses a duplicate direct event without a raw fallback", async () => {
  const valkey = new FakeAtomicValkey();
  const event = buildMappedEvent();
  valkey.proofKeys.add(`realtime:published:${event.dedupeKey}`);
  let rawFallbackCalls = 0;
  const trigger = createWorkerRealtimeTrigger({
    env: directEnv(),
    logger: logger(),
    mapEvent: async () => event,
    connectPublisher: async () => valkey as unknown as RealtimeValkeyClient,
    fallbackTrigger: async () => {
      rawFallbackCalls += 1;
      return { ok: true, fallback: "raw" };
    },
  });

  const result = await trigger("tenant-workspace-1", "requests.update", {});

  assert.deepEqual(result, { ok: true, duplicate: true });
  assert.equal(valkey.forwarded.length, 0);
  assert.equal(rawFallbackCalls, 0);
  assert.equal(valkey.deleteCalls, 0);
});

for (const outcome of ["publish_failed", "ambiguous"] as const) {
  test(`falls back with the exact mapped event after ${outcome}`, async () => {
    const valkey = new FakeAtomicValkey();
    valkey.outcome = outcome;
    const event = buildMappedEvent();
    const rawFallbackCalls: unknown[][] = [];
    const mappedFallbackEvents: unknown[] = [];
    const trigger = createWorkerRealtimeTrigger({
      env: directEnv(),
      logger: logger(),
      mapEvent: async () => event,
      connectPublisher: async () => valkey as unknown as RealtimeValkeyClient,
      fallbackTrigger: async (...args) => {
        rawFallbackCalls.push(args);
        return { ok: true, fallback: "raw" };
      },
      emitMappedEvent: async (mappedEvent) => {
        mappedFallbackEvents.push(mappedEvent);
        return { ok: true, fallback: "mapped" };
      },
    });

    const result = await trigger("tenant-workspace-1", "requests.update", {
      _id: "conversation-1",
    });

    assert.deepEqual(result, { ok: true, fallback: "mapped" });
    assert.equal(mappedFallbackEvents.length, 1);
    assert.strictEqual(mappedFallbackEvents[0], event);
    assert.equal(rawFallbackCalls.length, 0);
    assert.equal(valkey.deleteCalls, 0);
  });
}

test("falls back with the exact mapped event when direct Valkey connection rejects", async () => {
  const valkey = new FakeAtomicValkey();
  const event = buildMappedEvent();
  let mapCalls = 0;
  const rawFallbackCalls: unknown[][] = [];
  const mappedFallbackEvents: unknown[] = [];
  const trigger = createWorkerRealtimeTrigger({
    env: directEnv(),
    logger: logger(),
    mapEvent: async () => {
      mapCalls += 1;
      return event;
    },
    connectPublisher: async () => {
      throw new Error("Valkey connection rejected");
    },
    fallbackTrigger: async (...args) => {
      rawFallbackCalls.push(args);
      return { ok: true, fallback: "raw" };
    },
    emitMappedEvent: async (mappedEvent) => {
      mappedFallbackEvents.push(mappedEvent);
      return { ok: true, fallback: "mapped" };
    },
  });

  const result = await trigger("tenant-workspace-1", "requests.update", {
    _id: "conversation-1",
  });

  assert.deepEqual(result, { ok: true, fallback: "mapped" });
  assert.equal(mapCalls, 1);
  assert.strictEqual(mappedFallbackEvents[0], event);
  assert.equal(mappedFallbackEvents.length, 1);
  assert.equal(rawFallbackCalls.length, 0);
  assert.equal(valkey.evalCalls.length, 0);
  assert.equal(valkey.deleteCalls, 0);
});

test("uses the legacy raw fallback when mapping fails before an event exists", async () => {
  const rawFallbackCalls: unknown[][] = [];
  const trigger = createWorkerRealtimeTrigger({
    env: directEnv(),
    logger: logger(),
    mapEvent: async () => {
      throw new Error("mapping failed");
    },
    connectPublisher: async () => {
      throw new Error("must not connect after mapping failure");
    },
    fallbackTrigger: async (...args) => {
      rawFallbackCalls.push(args);
      return { ok: true, fallback: "raw" };
    },
  });

  const result = await trigger("tenant-workspace-1", "requests.update", {
    _id: "conversation-1",
  });

  assert.deepEqual(result, { ok: true, fallback: "raw" });
  assert.equal(rawFallbackCalls.length, 1);
});
