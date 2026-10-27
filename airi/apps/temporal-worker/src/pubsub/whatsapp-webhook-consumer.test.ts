import assert from "node:assert/strict";
import test from "node:test";

import {
  DurableWhatsAppWebhookEventFailure,
  processStoredWhatsAppWebhookEvent,
} from "../activities/whatsapp-webhook-processor";
import * as consumer from "./whatsapp-webhook-consumer";
import {
  installUpstashUsageTracking,
  resetUpstashUsageTrackingForTests,
} from "../upstash-usage";
import {
  getWhatsAppWebhookQueueDelayMs,
  shouldAckWhatsAppWebhookPubSubError,
} from "./whatsapp-webhook-consumer";

test("measures queue delay from durable webhook receipt to subscriber delivery", () => {
  assert.equal(
    getWhatsAppWebhookQueueDelayMs(
      "2026-07-10T10:00:00.000Z",
      Date.parse("2026-07-10T10:00:01.500Z"),
    ),
    1_500,
  );
  assert.equal(getWhatsAppWebhookQueueDelayMs("invalid", Date.now()), null);
  assert.equal(
    getWhatsAppWebhookQueueDelayMs(
      "2026-07-10T10:00:02.000Z",
      Date.parse("2026-07-10T10:00:01.500Z"),
    ),
    0,
  );
});

test("acks Pub/Sub wakeups after durable webhook failure is recorded", () => {
  assert.equal(
    shouldAckWhatsAppWebhookPubSubError(
      new DurableWhatsAppWebhookEventFailure({
        eventId: "event-1",
        durableStatus: "failed",
        message: "runtime failed after durable state was saved",
      }),
    ),
    true,
  );
});

test("nacks Pub/Sub wakeups when durable state was not recorded", () => {
  assert.equal(
    shouldAckWhatsAppWebhookPubSubError(new Error("db down")),
    false,
  );
});

function message(eventId = "event-1") {
  let ack = 0;
  let nack = 0;
  return {
    id: `pubsub-${eventId}`,
    publishTime: new Date(Date.now() - 7_000),
    deliveryAttempt: 1,
    data: Buffer.from(
      JSON.stringify({
        eventId,
        dedupeKey: eventId,
        field: "messages",
        orderingKey: "phone-1",
        receivedAt: new Date(Date.now() - 8_000).toISOString(),
      }),
    ),
    ack: () => {
      ack += 1;
    },
    nack: () => {
      nack += 1;
    },
    counts: () => ({ ack, nack }),
  };
}

function recorder() {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    logger: {
      info: (_name: string, value?: Record<string, unknown>) => {
        records.push(value || {});
      },
      warn: (_name: string, value?: Record<string, unknown>) => {
        records.push(value || {});
      },
      error: (
        _name: string,
        _error: unknown,
        value?: Record<string, unknown>,
      ) => {
        records.push(value || {});
      },
    },
  };
}

test("consumer waits for durable completion and acknowledges completed duplicates after restart", async () => {
  assert.equal(typeof consumer.createWhatsAppWebhookPubSubHandler, "function");
  let status = "published";
  let processingLeaseId: string | null = null;
  let effects = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = {
    connectDB: async () => undefined,
    WhatsAppWebhookEvent: {
      findOneAndUpdate: (
        _filter: unknown,
        update: { $set: { processingLeaseId: string } },
      ) => ({
        select: () => ({
          lean: async () => {
            if (status !== "published") return null;
            status = "processing";
            processingLeaseId = update.$set.processingLeaseId;
            return {
              _id: "event-1",
              status,
              attempts: 1,
              maxAttempts: 5,
              payload: { body: { entry: [] } },
            };
          },
        }),
      }),
      findById: () => ({
        select: () => ({
          lean: async () => ({ status, attempts: 1, maxAttempts: 5 }),
        }),
      }),
      updateOne: async (
        filter: { processingLeaseId: string },
        update: { $set: { status: string } },
      ) => {
        assert.equal(filter.processingLeaseId, processingLeaseId);
        status = update.$set.status;
        return { modifiedCount: 1 };
      },
    },
    processWhatsAppWebhookPayload: async () => {
      effects += 1;
      await pending;
      return { ok: true, code: "ok" };
    },
    whatsappWebhookRuntimeDependencies: {},
  };
  const logs = recorder();
  const buildHandler = () =>
    consumer.createWhatsAppWebhookPubSubHandler({
      logName: "test",
      logger: logs.logger,
      processEvent: (input) =>
        processStoredWhatsAppWebhookEvent(input, { runtime: runtime as never }),
    });
  const first = message();
  const processing = buildHandler()(first as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(status, "processing");
  assert.deepEqual(first.counts(), { ack: 0, nack: 0 });
  const activeDuplicate = message();
  await buildHandler()(activeDuplicate as never);
  assert.deepEqual(activeDuplicate.counts(), { ack: 1, nack: 0 });
  assert.equal(logs.records[0]?.runtimeCode, "event_already_claimed");
  release();
  await processing;
  assert.equal(status, "completed");
  assert.deepEqual(first.counts(), { ack: 1, nack: 0 });
  const redelivery = message();
  redelivery.deliveryAttempt = 2;
  await buildHandler()(redelivery as never);
  assert.equal(effects, 1);
  assert.deepEqual(redelivery.counts(), { ack: 1, nack: 0 });
  assert.equal(logs.records.at(-1)?.runtimeCode, "event_completed");
  assert.ok(Number(logs.records.at(-1)?.brokerToCallbackMs) >= 7_000);
  assert.equal(logs.records.at(-1)?.pubsubDeliveryAttempt, 2);
});

test("consumer nacks unrecorded failures and a restarted handler can recover", async () => {
  assert.equal(typeof consumer.createWhatsAppWebhookPubSubHandler, "function");
  const logs = recorder();
  const first = message();
  await consumer.createWhatsAppWebhookPubSubHandler({
    logName: "test",
    logger: logs.logger,
    processEvent: async () => {
      throw new Error("durable store unavailable");
    },
  })(first as never);
  assert.deepEqual(first.counts(), { ack: 0, nack: 1 });
  assert.equal(
    logs.records[0]?.brokerPublishedAt,
    first.publishTime.toISOString(),
  );
  const recovered = message();
  await consumer.createWhatsAppWebhookPubSubHandler({
    logName: "test",
    logger: logs.logger,
    processEvent: async (input) => ({
      eventId: input.eventId,
      status: "completed",
      runtimeCode: "ok",
    }),
  })(recovered as never);
  assert.deepEqual(recovered.counts(), { ack: 1, nack: 0 });
});

test("consumer acks a persisted retry and records broker timing on failure", async () => {
  assert.equal(typeof consumer.createWhatsAppWebhookPubSubHandler, "function");
  const logs = recorder();
  const delivery = message();
  await consumer.createWhatsAppWebhookPubSubHandler({
    logName: "test",
    logger: logs.logger,
    processEvent: async () => {
      throw new DurableWhatsAppWebhookEventFailure({
        eventId: "event-1",
        durableStatus: "failed",
        message: "retry persisted",
      });
    },
  })(delivery as never);
  assert.deepEqual(delivery.counts(), { ack: 1, nack: 0 });
  assert.equal(logs.records[0]?.note, "durable_failure_acked");
  assert.equal(
    logs.records[0]?.brokerPublishedAt,
    delivery.publishTime.toISOString(),
  );
});

test("stop closes the subscription before detaching its listeners", async () => {
  const envName = "WHATSAPP_TEST_CLOSE_ORDER_PUBSUB_ENABLED";
  const previous = process.env[envName];
  process.env[envName] = "true";
  const actions: string[] = [];
  let release!: () => void;
  const draining = new Promise<void>((resolve) => {
    release = resolve;
  });
  const subscription = {
    on: (event: string) => actions.push(`on:${event}`),
    removeListener: (event: string) => actions.push(`remove:${event}`),
    close: async () => {
      actions.push("close:start");
      await draining;
      actions.push("close:end");
    },
  };

  try {
    const stop = await consumer.startWhatsAppWebhookPubSubConsumerWithOptions({
      enabledEnvName: envName,
      projectIdEnvName: "WHATSAPP_TEST_CLOSE_ORDER_PROJECT_ID",
      subscriptionEnvName: "WHATSAPP_TEST_CLOSE_ORDER_SUBSCRIPTION",
      maxMessagesEnvName: "WHATSAPP_TEST_CLOSE_ORDER_MAX_MESSAGES",
      defaultSubscription: "close-order-subscription",
      defaultMaxMessages: 10,
      logName: "whatsapp.test.pubsub.consumer",
      createSubscription: () =>
        ({ projectId: "project-1", subscription }) as never,
    });

    const stopping = stop();
    await Promise.resolve();
    // Listeners stay attached while in-flight handlers drain and ack.
    assert.deepEqual(actions, ["on:message", "on:error", "close:start"]);

    release();
    await stopping;
    assert.deepEqual(actions.slice(2), [
      "close:start",
      "close:end",
      "remove:message",
      "remove:error",
    ]);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

type OrderingState = Awaited<
  ReturnType<
    NonNullable<
      Parameters<
        typeof consumer.createWhatsAppFastLaneHandler
      >[0]["readOrderingState"]
    >
  >
>;

function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function orderingStates(log: string[], ...states: OrderingState[]) {
  const queue = [...states];
  return async () => {
    const state = queue.length > 1 ? queue.shift()! : queue[0]!;
    log.push(`read:${state.state}`);
    return state;
  };
}

function loggedMessage(log: string[], eventId = "event-1") {
  const delivered = message(eventId);
  return {
    ...delivered,
    ack: () => {
      log.push("ack");
      delivered.ack();
    },
    nack: () => {
      log.push("nack");
      delivered.nack();
    },
  };
}

test("fast lane processes a chat's head event once and acks", async () => {
  const log: string[] = [];
  const logs = recorder();
  const handler = consumer.createWhatsAppFastLaneHandler({
    logName: "test",
    logger: logs.logger,
    readOrderingState: orderingStates(log, { state: "head" }),
    processEvent: async (input) => {
      log.push(`process:${input.eventId}:${input.orderingKey}`);
      return { eventId: input.eventId, status: "completed", runtimeCode: "ok" };
    },
    ...fakeClock(),
  });

  const delivered = loggedMessage(log);
  await handler(delivered as never);

  assert.deepEqual(log, ["read:head", "process:event-1:phone-1", "ack"]);
  assert.deepEqual(delivered.counts(), { ack: 1, nack: 0 });
  assert.equal(logs.records[0]?.note, "fast_lane_processed");
  assert.equal(logs.records[0]?.headWaitMs, 0);
});

test("fast lane waits for the chat's earlier message, then processes", async () => {
  const log: string[] = [];
  const clock = fakeClock();
  const logs = recorder();
  const handler = consumer.createWhatsAppFastLaneHandler({
    logName: "test",
    logger: logs.logger,
    readOrderingState: orderingStates(
      log,
      { state: "waiting", predecessorEventId: "event-0" },
      { state: "waiting", predecessorEventId: "event-0" },
      { state: "head" },
    ),
    processEvent: async (input) => {
      log.push("process");
      return { eventId: input.eventId, status: "completed" };
    },
    ...clock,
  });

  await handler(loggedMessage(log) as never);

  assert.deepEqual(log, [
    "read:waiting",
    "read:waiting",
    "read:head",
    "process",
    "ack",
  ]);
  assert.deepEqual(clock.sleeps, [250, 250]);
  assert.equal(logs.records[0]?.headWaitMs, 500);
});

test("fast lane leaves a still-blocked message to the ordered subscription", async () => {
  const log: string[] = [];
  const clock = fakeClock();
  const logs = recorder();
  const handler = consumer.createWhatsAppFastLaneHandler({
    logName: "test",
    logger: logs.logger,
    maxHeadWaitMs: 1_000,
    readOrderingState: orderingStates(log, {
      state: "waiting",
      predecessorEventId: "event-0",
    }),
    processEvent: async () => {
      throw new Error("must not process out of order");
    },
    ...clock,
  });

  const delivered = loggedMessage(log);
  await handler(delivered as never);

  assert.equal(log.includes("process"), false);
  assert.deepEqual(delivered.counts(), { ack: 1, nack: 0 });
  assert.equal(clock.sleeps.length, 4);
  assert.equal(logs.records[0]?.note, "fast_lane_left_to_ordered");
  assert.equal(logs.records[0]?.orderingState, "waiting");
  assert.equal(logs.records[0]?.headWaitMs, 1_000);
});

test("fast lane never processes claimed, settled or missing events", async () => {
  for (const state of [
    { state: "claimed" },
    { state: "settled", status: "completed" },
    { state: "missing" },
  ] as OrderingState[]) {
    const log: string[] = [];
    const logs = recorder();
    const handler = consumer.createWhatsAppFastLaneHandler({
      logName: "test",
      logger: logs.logger,
      readOrderingState: orderingStates(log, state),
      processEvent: async () => {
        throw new Error("must not process");
      },
      ...fakeClock(),
    });

    const delivered = loggedMessage(log);
    await handler(delivered as never);

    assert.deepEqual(log, [`read:${state.state}`, "ack"], state.state);
    assert.equal(logs.records[0]?.note, "fast_lane_left_to_ordered");
    assert.equal(logs.records[0]?.orderingState, state.state);
  }
});

test("fast lane acks every failure because the ordered subscription still delivers", async () => {
  for (const [name, error, durable] of [
    ["unrecorded", new Error("db down"), false],
    [
      "durable",
      new DurableWhatsAppWebhookEventFailure({
        eventId: "event-1",
        durableStatus: "failed",
        message: "runtime failed",
      }),
      true,
    ],
  ] as const) {
    const logs = recorder();
    const handler = consumer.createWhatsAppFastLaneHandler({
      logName: "test",
      logger: logs.logger,
      readOrderingState: async () => ({ state: "head" }),
      processEvent: async () => {
        throw error;
      },
      ...fakeClock(),
    });

    const delivered = message();
    await handler(delivered as never);

    assert.deepEqual(delivered.counts(), { ack: 1, nack: 0 }, name);
    assert.equal(logs.records[0]?.note, "fast_lane_failed", name);
    assert.equal(logs.records[0]?.durable, durable, name);
  }

  const malformed = { ...message(), data: Buffer.from("{") };
  const logs = recorder();
  await consumer.createWhatsAppFastLaneHandler({
    logName: "test",
    logger: logs.logger,
    readOrderingState: async () => {
      throw new Error("must not read");
    },
  })(malformed as never);
  assert.deepEqual(malformed.counts(), { ack: 1, nack: 0 });
  assert.equal(logs.records[0]?.note, "fast_lane_failed");
});

test("ordered consumer holds a message while another path processes it", async () => {
  const log: string[] = [];
  const clock = fakeClock();
  const logs = recorder();
  const handler = consumer.createWhatsAppWebhookPubSubHandler({
    logName: "test",
    logger: logs.logger,
    processEvent: async (input) => {
      log.push("process");
      return {
        eventId: input.eventId,
        status: "skipped",
        runtimeCode: "event_already_claimed",
      };
    },
    waitForForeignClaim: {
      maxWaitMs: 20_000,
      readOrderingState: orderingStates(
        log,
        { state: "claimed" },
        { state: "claimed" },
        { state: "settled", status: "completed" },
      ),
      ...clock,
    },
  });

  await handler(loggedMessage(log) as never);

  assert.deepEqual(log, [
    "process",
    "read:claimed",
    "read:claimed",
    "read:settled",
    "ack",
  ]);
  assert.equal(logs.records[0]?.claimWaitMs, 500);
  assert.equal(logs.records[0]?.claimReleased, true);
});

test("ordered consumer releases a held message after the wait bound", async () => {
  const log: string[] = [];
  const logs = recorder();
  const handler = consumer.createWhatsAppWebhookPubSubHandler({
    logName: "test",
    logger: logs.logger,
    processEvent: async (input) => ({
      eventId: input.eventId,
      status: "skipped",
      runtimeCode: "event_already_claimed",
    }),
    waitForForeignClaim: {
      maxWaitMs: 1_000,
      readOrderingState: orderingStates(log, { state: "claimed" }),
      ...fakeClock(),
    },
  });

  const delivered = loggedMessage(log);
  await handler(delivered as never);

  assert.deepEqual(delivered.counts(), { ack: 1, nack: 0 });
  assert.equal(logs.records[0]?.claimWaitMs, 1_000);
  assert.equal(logs.records[0]?.claimReleased, false);
});

test("ordered consumer acks at once without the fast lane or a foreign claim", async () => {
  for (const [name, result, wait] of [
    ["no fast lane", "event_already_claimed", false],
    ["own completion", "ok", true],
    ["already completed", "event_completed", true],
  ] as const) {
    const log: string[] = [];
    const logs = recorder();
    const handler = consumer.createWhatsAppWebhookPubSubHandler({
      logName: "test",
      logger: logs.logger,
      processEvent: async (input) => ({
        eventId: input.eventId,
        status: result === "ok" ? "completed" : "skipped",
        runtimeCode: result,
      }),
      waitForForeignClaim: wait
        ? {
            maxWaitMs: 20_000,
            readOrderingState: orderingStates(log, { state: "claimed" }),
            ...fakeClock(),
          }
        : undefined,
    });

    const delivered = loggedMessage(log);
    await handler(delivered as never);

    assert.deepEqual(log, ["ack"], name);
    assert.equal(logs.records[0]?.claimWaitMs, null, name);
  }
});

test("consumer start uses the handler its options provide", async () => {
  const envName = "WHATSAPP_TEST_CUSTOM_HANDLER_PUBSUB_ENABLED";
  const previous = process.env[envName];
  process.env[envName] = "true";
  const attached: unknown[] = [];
  const handler = async () => undefined;
  try {
    const stop = await consumer.startWhatsAppWebhookPubSubConsumerWithOptions({
      enabledEnvName: envName,
      projectIdEnvName: "WHATSAPP_TEST_CUSTOM_HANDLER_PROJECT_ID",
      subscriptionEnvName: "WHATSAPP_TEST_CUSTOM_HANDLER_SUBSCRIPTION",
      maxMessagesEnvName: "WHATSAPP_TEST_CUSTOM_HANDLER_MAX_MESSAGES",
      defaultSubscription: "custom-handler-subscription",
      defaultMaxMessages: 20,
      logName: "whatsapp.test.pubsub.consumer",
      createHandler: () => handler,
      createSubscription: () =>
        ({
          projectId: "project-1",
          subscription: {
            on: (event: string, listener: unknown) => {
              if (event === "message") attached.push(listener);
            },
            removeListener: () => undefined,
            close: async () => undefined,
          },
        }) as never,
    });
    assert.deepEqual(attached, [handler]);
    await stop();
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("the fast lane stays off unless its flag is set", async () => {
  const previous = process.env.WHATSAPP_FAST_LANE_PUBSUB_ENABLED;
  delete process.env.WHATSAPP_FAST_LANE_PUBSUB_ENABLED;
  try {
    const stop = await consumer.startWhatsAppFastLanePubSubConsumer();
    await stop();
  } finally {
    if (previous !== undefined) {
      process.env.WHATSAPP_FAST_LANE_PUBSUB_ENABLED = previous;
    }
  }
});

test("both consumers log the Upstash calls made while processing an event", async () => {
  const upstashUrl = "https://example-upstash.test";
  const host = {
    fetch: (async () => new Response("{}")) as typeof fetch,
  };
  installUpstashUsageTracking(upstashUrl, host);
  try {
    const processEvent = async (input: { eventId: string }) => {
      await host.fetch(upstashUrl, { body: "[]" });
      await host.fetch(`${upstashUrl}/pipeline`, {
        body: JSON.stringify([["GET", "a"], ["GET", "b"]]),
      });
      return { eventId: input.eventId, status: "completed", runtimeCode: "ok" };
    };
    const ordered = recorder();
    await consumer.createWhatsAppWebhookPubSubHandler({
      logName: "test",
      logger: ordered.logger,
      processEvent: processEvent as never,
    })(message() as never);
    const lane = recorder();
    await consumer.createWhatsAppFastLaneHandler({
      logName: "test",
      logger: lane.logger,
      readOrderingState: orderingStates([], { state: "head" }),
      processEvent: processEvent as never,
      ...fakeClock(),
    })(loggedMessage([]) as never);

    for (const record of [ordered.records[0], lane.records[0]]) {
      assert.equal(record?.upstashRequests, 2);
      assert.equal(record?.upstashCommands, 3);
      assert.equal(record?.upstashFailures, 0);
    }
    assert.equal(ordered.records[0]?.note, "processed_direct");
    assert.equal(lane.records[0]?.note, "fast_lane_processed");
  } finally {
    resetUpstashUsageTrackingForTests();
  }
});
