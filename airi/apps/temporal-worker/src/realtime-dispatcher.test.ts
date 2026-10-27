import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@google-cloud/pubsub";
import { createRealtimePubSubHandler } from "./realtime-dispatcher.js";
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
  };
}

function buildLegacyRowEvent() {
  return {
    eventId: "legacy-row-event-1",
    version: 1 as const,
    name: "conversation.row.changed" as const,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    createdAt: "2026-08-20T00:00:00.000Z",
    dedupeKey: "legacy-row-event-1",
    payload: {
      schemaVersion: 3 as const,
      conversationId: "conversation-1",
      changeType: "updated" as const,
    },
  };
}

class FakeAtomicValkey {
  readonly proofKeys = new Set<string>();
  readonly forwarded: unknown[] = [];
  evalCalls = 0;
  deleteCalls = 0;
  outcome: "published" | "publish_failed" | "ambiguous" = "published";

  async eval(
    _script: string,
    input: { keys: readonly string[]; arguments: readonly string[] },
  ): Promise<readonly [number, number]> {
    this.evalCalls += 1;
    const key = input.keys[0];
    const message = input.arguments[2];
    assert.equal(typeof key, "string");
    assert.equal(typeof message, "string");
    if (this.proofKeys.has(key)) return [-1, 0];
    if (this.outcome === "publish_failed") return [-2, 0];
    this.proofKeys.add(key);
    this.forwarded.push(JSON.parse(message));
    if (this.outcome === "ambiguous") {
      throw new Error("connection dropped after atomic execution");
    }
    return [1, 1];
  }

  async del(key: string): Promise<number> {
    this.deleteCalls += 1;
    this.proofKeys.delete(key);
    return 1;
  }

  async set(key: string): Promise<"OK" | null> {
    if (this.proofKeys.has(key)) return null;
    this.proofKeys.add(key);
    return "OK";
  }

  async publish(_channel: string, message: string): Promise<number> {
    if (this.outcome !== "published") {
      throw new Error(this.outcome);
    }
    this.forwarded.push(JSON.parse(message));
    return 1;
  }
}

function buildMessage(
  event: unknown = buildMappedEvent(),
  channel = "conversation:workspace-1:conversation-1",
) {
  let ackCount = 0;
  let nackCount = 0;
  return {
    data: Buffer.from(
      JSON.stringify({
        channel,
        event,
      }),
      "utf8",
    ),
    id: "pubsub-message-1",
    ack: () => {
      ackCount += 1;
    },
    nack: () => {
      nackCount += 1;
    },
    counts: () => ({ ack: ackCount, nack: nackCount }),
  };
}

function createHandler(valkey: FakeAtomicValkey) {
  return createRealtimePubSubHandler({
    publisher: valkey as unknown as RealtimeValkeyClient,
    logger: { info: () => undefined, error: () => undefined },
  });
}

test("acknowledges published and duplicate Pub/Sub frames while forwarding one exact frame", async () => {
  const valkey = new FakeAtomicValkey();
  const event = buildMappedEvent();
  const handler = createHandler(valkey);
  const first = buildMessage(event);
  const second = buildMessage(event);

  await handler(first as unknown as Message);
  await handler(second as unknown as Message);

  assert.deepEqual(first.counts(), { ack: 1, nack: 0 });
  assert.deepEqual(second.counts(), { ack: 1, nack: 0 });
  assert.deepEqual(valkey.forwarded, [
    {
      type: "event",
      channel: "conversation:workspace-1:conversation-1",
      event,
    },
  ]);
  assert.equal(valkey.evalCalls, 2);
  assert.equal(valkey.deleteCalls, 0);
});

test("records the broker hop on both publication and duplicate redelivery", async () => {
  const valkey = new FakeAtomicValkey();
  const records: Record<string, unknown>[] = [];
  const handler = createRealtimePubSubHandler({
    publisher: valkey as unknown as RealtimeValkeyClient,
    logger: {
      info: (_event, fields) => records.push(fields || {}),
      error: () => undefined,
    },
  });
  const publishTime = new Date(Date.now() - 7_000);
  for (const deliveryAttempt of [1, 2]) {
    const message = { ...buildMessage(), publishTime, deliveryAttempt };
    await handler(message as unknown as Message);
    assert.deepEqual(message.counts(), { ack: 1, nack: 0 });
  }
  assert.equal(valkey.forwarded.length, 1);
  assert.deepEqual(
    records.map((r) => r.note),
    ["message_published", "duplicate_suppressed"],
  );
  for (const record of records) {
    assert.equal(record.brokerPublishedAt, publishTime.toISOString());
    assert.ok(Number(record.brokerToCallbackMs) >= 7_000);
    assert.equal(typeof record.callbackStartedAt, "string");
  }
  assert.deepEqual(
    records.map((r) => r.pubsubDeliveryAttempt),
    [1, 2],
  );
});

test("redelivery after an ambiguous publish and worker restart preserves the atomic proof", async () => {
  const valkey = new FakeAtomicValkey();
  valkey.outcome = "ambiguous";
  const failed = buildMessage();
  await createHandler(valkey)(failed as unknown as Message);
  assert.deepEqual(failed.counts(), { ack: 0, nack: 1 });
  assert.equal(valkey.forwarded.length, 1);

  valkey.outcome = "published";
  const redelivery = buildMessage();
  await createHandler(valkey)(redelivery as unknown as Message);
  assert.deepEqual(redelivery.counts(), { ack: 1, nack: 0 });
  assert.equal(valkey.forwarded.length, 1);
  assert.equal(valkey.deleteCalls, 0);
});

test("failed publication remains recoverable and ordered replay does not repeat prior effects", async () => {
  const valkey = new FakeAtomicValkey();
  valkey.outcome = "publish_failed";
  const first = buildMessage();
  await createHandler(valkey)(first as unknown as Message);
  assert.deepEqual(first.counts(), { ack: 0, nack: 1 });
  assert.equal(valkey.proofKeys.size, 0);

  valkey.outcome = "published";
  const handler = createHandler(valkey);
  const secondEvent = {
    ...buildMappedEvent(),
    eventId: "event-2",
    dedupeKey: "message-2",
  };
  for (const event of [
    buildMappedEvent(),
    secondEvent,
    buildMappedEvent(),
    secondEvent,
  ]) {
    const message = buildMessage(event);
    await handler(message as unknown as Message);
    assert.deepEqual(message.counts(), { ack: 1, nack: 0 });
  }
  assert.deepEqual(
    valkey.forwarded.map(
      (value) => (value as { event: { eventId: string } }).event.eventId,
    ),
    ["event-1", "event-2"],
  );
});

for (const outcome of ["publish_failed", "ambiguous"] as const) {
  test(`nacks ${outcome} atomic outcomes without deleting a proof key`, async () => {
    const valkey = new FakeAtomicValkey();
    valkey.outcome = outcome;
    const message = buildMessage();

    await createHandler(valkey)(message as unknown as Message);

    assert.deepEqual(message.counts(), { ack: 0, nack: 1 });
    assert.equal(valkey.deleteCalls, 0);
  });
}

test("nacks malformed Pub/Sub frames without attempting delivery", async () => {
  const valkey = new FakeAtomicValkey();
  const message = buildMessage();
  message.data = Buffer.from("{bad json", "utf8");

  await createHandler(valkey)(message as unknown as Message);

  assert.deepEqual(message.counts(), { ack: 0, nack: 1 });
  assert.equal(valkey.forwarded.length, 0);
  assert.equal(valkey.deleteCalls, 0);
});

test("publishes projector row changes through the single atomic effect", async () => {
  const valkey = new FakeAtomicValkey();
  const message = buildMessage(buildLegacyRowEvent());

  await createHandler(valkey)(message as unknown as Message);

  assert.deepEqual(message.counts(), { ack: 1, nack: 0 });
  assert.equal(valkey.evalCalls, 1);
});
