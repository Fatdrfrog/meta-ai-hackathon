import assert from "node:assert/strict";
import test from "node:test";

import WhatsAppWebhookEvent from "./whatsapp-webhook-event-model";
import {
  compactCompletedWhatsAppWebhookEventPayloads,
  resolveWhatsAppWebhookPayloadRetentionPolicy,
} from "./whatsapp-webhook-event-retention";

const now = new Date("2026-10-02T12:00:00.000Z");
const completedAt = new Date("2026-08-01T12:00:00.000Z");

test("retention policy shares strict environment defaults and explicit override precedence", () => {
  assert.deepEqual(resolveWhatsAppWebhookPayloadRetentionPolicy({ env: {} }), {
    retentionDays: 30,
    limit: 100,
  });
  assert.deepEqual(
    resolveWhatsAppWebhookPayloadRetentionPolicy({
      env: {
        WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DAYS: " 60 ",
        WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_LIMIT: " 250 ",
      },
    }),
    { retentionDays: 60, limit: 250 },
  );
  assert.deepEqual(
    resolveWhatsAppWebhookPayloadRetentionPolicy({
      env: {
        WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DAYS: " ",
        WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_LIMIT: "",
      },
    }),
    { retentionDays: 30, limit: 100 },
  );
  assert.deepEqual(
    resolveWhatsAppWebhookPayloadRetentionPolicy({
      retentionDays: 90,
      limit: 50,
      env: {
        WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DAYS: "invalid",
        WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_LIMIT: "invalid",
      },
    }),
    { retentionDays: 90, limit: 50 },
  );
  assert.throws(
    () =>
      resolveWhatsAppWebhookPayloadRetentionPolicy({
        env: { WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DAYS: "30garbage" },
      }),
    /retentionDays/,
  );
  assert.throws(
    () =>
      resolveWhatsAppWebhookPayloadRetentionPolicy({
        env: { WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_LIMIT: "501" },
      }),
    /limit/,
  );
});

test("webhook routing retains covering indexes without recreating shorter prefixes", () => {
  const indexes = WhatsAppWebhookEvent.schema.indexes();
  // #355 retired the messagingAccountId routing index after zero reads.
  for (const field of ["phoneNumberId", "wabaId"]) {
    assert.ok(
      indexes.some(
        ([keys]) =>
          JSON.stringify(keys) ===
          JSON.stringify({ [field]: 1, field: 1, createdAt: -1 }),
      ),
    );
    assert.ok(
      !indexes.some(
        ([keys]) => JSON.stringify(keys) === JSON.stringify({ [field]: 1 }),
      ),
    );
  }
});

function buildReceipt(overrides: Record<string, unknown> = {}) {
  return new WhatsAppWebhookEvent({
    dedupeKey: "receipt-1",
    field: "messages",
    orderingKey: "phone-1:message:hash",
    status: "completed",
    completedAt,
    payloadCompactedAt: now,
    ...overrides,
  });
}

test("completed compacted receipts remain valid without their raw payload", async () => {
  await buildReceipt().validate();
});

test("recovery states still require the original webhook payload", async () => {
  for (const status of [
    "received",
    "published",
    "queued",
    "processing",
    "failed",
    "dead",
  ]) {
    await assert.rejects(
      buildReceipt({ status }).validate(),
      /payload.*required/,
    );
  }
  await assert.rejects(
    buildReceipt({ payloadCompactedAt: null }).validate(),
    /payload.*required/,
  );
  await assert.rejects(
    buildReceipt({ completedAt: null }).validate(),
    /payload.*required/,
  );
});

test("completed compaction has an indexed scan without expiring durable receipts", () => {
  const indexes = WhatsAppWebhookEvent.schema.indexes();
  const retentionIndex = indexes.find(
    ([, options]) =>
      options.name === "whatsapp_webhook_events_payload_compaction",
  );
  assert.deepEqual(retentionIndex?.[0], { completedAt: 1, _id: 1 });
  assert.deepEqual(retentionIndex?.[1]?.partialFilterExpression, {
    status: "completed",
    payloadCompactedAt: null,
  });
  assert.ok(
    indexes.every(([, options]) => options.expireAfterSeconds === undefined),
  );
});

type StoredEvent = Record<string, any> & { _id: string };

function matches(event: StoredEvent, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = event[key];
    if (condition === null) return value == null;
    if (typeof condition !== "object" || condition instanceof Date) {
      return value === condition;
    }
    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        case "$in":
          return (operand as unknown[]).includes(value);
        case "$lte":
          return value <= (operand as Date);
        case "$type":
          return operand === "date" && value instanceof Date;
        case "$exists":
          return (value !== undefined) === operand;
        case "$ne":
          return value !== operand;
        default:
          throw new Error(`Unexpected query operator: ${operator}`);
      }
    });
  });
}

function createStore(events: StoredEvent[], beforeUpdate?: () => void) {
  const operations: Array<{
    filter: Record<string, any>;
    update: Record<string, any>;
  }> = [];
  let queryCount = 0;
  let queryTimeout: number | null = null;
  const model = {
    find(filter: Record<string, any>) {
      queryCount++;
      let selected = events.filter((event) => matches(event, filter));
      return {
        select(projection: string) {
          assert.equal(projection, "_id");
          return this;
        },
        sort(sort: Record<string, 1 | -1>) {
          assert.deepEqual(sort, { completedAt: 1, _id: 1 });
          selected.sort(
            (a, b) =>
              a.completedAt.getTime() - b.completedAt.getTime() ||
              a._id.localeCompare(b._id),
          );
          return this;
        },
        limit(limit: number) {
          selected = selected.slice(0, limit);
          return this;
        },
        maxTimeMS(timeout: number) {
          queryTimeout = timeout;
          return this;
        },
        async lean() {
          return selected.map(({ _id }) => ({ _id }));
        },
      };
    },
    async updateMany(filter: Record<string, any>, update: Record<string, any>) {
      operations.push({ filter, update });
      beforeUpdate?.();
      let modifiedCount = 0;
      for (const event of events) {
        if (!matches(event, filter)) continue;
        Object.assign(event, update.$set);
        for (const field of Object.keys(update.$unset || {}))
          delete event[field];
        modifiedCount++;
      }
      return { modifiedCount };
    },
  };
  return {
    model,
    operations,
    get queryCount() {
      return queryCount;
    },
    get queryTimeout() {
      return queryTimeout;
    },
  };
}

function storedEvent(
  _id: string,
  overrides: Record<string, unknown> = {},
): StoredEvent {
  return {
    _id,
    dedupeKey: `dedupe-${_id}`,
    status: "completed",
    completedAt,
    payload: { body: "raw customer content" },
    processingCursor: { raw: "recovery cursor" },
    originalPayloadHash: "hash-1",
    attempts: 2,
    duplicateCount: 3,
    ...overrides,
  };
}

test("dry-run defaults to a bounded 30-day preview without writes", async () => {
  const events = [
    storedEvent("old"),
    storedEvent("recent", { completedAt: new Date("2026-09-15") }),
  ];
  const store = createStore(events);
  const result = await compactCompletedWhatsAppWebhookEventPayloads({
    model: store.model,
    now,
  });
  assert.deepEqual(result, {
    dryRun: true,
    retentionDays: 30,
    cutoff: "2026-09-02T12:00:00.000Z",
    scanned: 1,
    compacted: 0,
  });
  assert.equal(store.operations.length, 0);
  assert.equal(store.queryTimeout, 10_000);
  assert.equal(events[0].payload.body, "raw customer content");
});

test("compacts only old completed payloads and preserves dedupe receipts and recovery state", async () => {
  const events = [
    storedEvent("old"),
    storedEvent("boundary", {
      completedAt: new Date("2026-09-02T12:00:00.000Z"),
    }),
  ];
  for (const status of [
    "received",
    "published",
    "queued",
    "processing",
    "failed",
    "dead",
  ]) {
    events.push(storedEvent(status, { status }));
  }
  events.push(storedEvent("recent", { completedAt: new Date("2026-09-03") }));
  events.push(storedEvent("missing-completed-at", { completedAt: null }));
  events.push(
    storedEvent("already-compacted", {
      payloadCompactedAt: new Date("2026-09-01"),
      payload: undefined,
    }),
  );
  const untouched = structuredClone(events.slice(2));
  const store = createStore(events);
  const result = await compactCompletedWhatsAppWebhookEventPayloads({
    model: store.model,
    now,
    dryRun: false,
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.compacted, 2);
  for (const event of events.slice(0, 2)) {
    assert.equal(event.payload, undefined);
    assert.equal(event.processingCursor, undefined);
    assert.equal(event.status, "completed");
    assert.equal(event.dedupeKey, `dedupe-${event._id}`);
    assert.equal(event.originalPayloadHash, "hash-1");
    assert.equal(event.attempts, 2);
    assert.equal(event.duplicateCount, 3);
    assert.deepEqual(event.payloadCompactedAt, now);
  }
  assert.deepEqual(events.slice(2), untouched);
  assert.equal(
    (
      await compactCompletedWhatsAppWebhookEventPayloads({
        model: store.model,
        now,
        dryRun: false,
      })
    ).scanned,
    0,
  );
});

test("custom retention and batch size bound work without loading raw payloads", async () => {
  const events = [
    storedEvent("first"),
    storedEvent("second"),
    storedEvent("third"),
  ];
  const store = createStore(events);
  const result = await compactCompletedWhatsAppWebhookEventPayloads({
    model: store.model,
    now,
    dryRun: false,
    retentionDays: 60,
    limit: 1,
  });
  assert.equal(result.cutoff, "2026-08-03T12:00:00.000Z");
  assert.equal(result.scanned, 1);
  assert.equal(result.compacted, 1);
  assert.equal(events[0].payload, undefined);
  assert.ok(events[1].payload);
  assert.ok(events[2].payload);
});

test("compaction atomically skips receipts claimed for replay or completed again after preview", async () => {
  const events = [
    storedEvent("replaying"),
    storedEvent("recompleted"),
    storedEvent("compacted"),
  ];
  const store = createStore(events, () => {
    events[0].status = "failed";
    events[0].completedAt = null;
    events[1].completedAt = now;
    events[2].payloadCompactedAt = now;
  });
  const result = await compactCompletedWhatsAppWebhookEventPayloads({
    model: store.model,
    now,
    dryRun: false,
  });
  assert.equal(result.scanned, 3);
  assert.equal(result.compacted, 0);
  assert.ok(events.every((event) => event.payload));
  assert.deepEqual(store.operations[0].filter, {
    _id: { $in: ["compacted", "recompleted", "replaying"] },
    status: "completed",
    completedAt: { $type: "date", $lte: new Date("2026-09-02T12:00:00.000Z") },
    payloadCompactedAt: null,
    payload: { $exists: true, $ne: null },
  });
});

test("invalid retention policy fails before any database query", async () => {
  const store = createStore([]);
  for (const retentionDays of [0, -1, 1.5, Number.NaN, 3651]) {
    await assert.rejects(
      compactCompletedWhatsAppWebhookEventPayloads({
        model: store.model,
        now,
        retentionDays,
      }),
      /retentionDays/,
    );
  }
  for (const limit of [0, -1, 1.5, Number.NaN, 501]) {
    await assert.rejects(
      compactCompletedWhatsAppWebhookEventPayloads({
        model: store.model,
        now,
        limit,
      }),
      /limit/,
    );
  }
  await assert.rejects(
    compactCompletedWhatsAppWebhookEventPayloads({
      model: store.model,
      now: new Date("invalid"),
    }),
    /now/,
  );
  assert.equal(store.queryCount, 0);
});
