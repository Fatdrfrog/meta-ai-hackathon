import assert from "node:assert/strict";
import test from "node:test";
import * as consumerRuntime from "./pubsub-consumer-runtime";

import {
  buildPubSubSubscriptionOptions,
  compactEnv,
  getGoogleCloudProjectId,
  parseEnabledFlag,
} from "./pubsub-consumer-runtime";

const ENV_KEYS = [
  "CUSTOM_PUBSUB_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GCP_PROJECT_ID",
] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
}

function restoreEnv(
  snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>,
) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test("compacts env values and falls back through Google project env names", () => {
  const env = snapshotEnv();
  try {
    process.env.CUSTOM_PUBSUB_PROJECT_ID = " ";
    process.env.GOOGLE_CLOUD_PROJECT = " google-project ";
    process.env.GCP_PROJECT_ID = "gcp-project";

    assert.equal(compactEnv("CUSTOM_PUBSUB_PROJECT_ID"), null);
    assert.equal(
      getGoogleCloudProjectId("CUSTOM_PUBSUB_PROJECT_ID"),
      "google-project",
    );
  } finally {
    restoreEnv(env);
  }
});

test("parses Pub/Sub enable flags without enabling unknown values", () => {
  assert.equal(parseEnabledFlag("true"), true);
  assert.equal(parseEnabledFlag("1"), true);
  assert.equal(parseEnabledFlag("off"), false);
  assert.equal(parseEnabledFlag("unexpected"), false);
});

test("builds subscription flow-control options with a default max message count", () => {
  assert.deepEqual(buildPubSubSubscriptionOptions(undefined, 10).flowControl, {
    maxMessages: 10,
  });
  assert.deepEqual(buildPubSubSubscriptionOptions("25", 10).flowControl, {
    maxMessages: 25,
  });
  assert.deepEqual(buildPubSubSubscriptionOptions("bad", 10).flowControl, {
    maxMessages: 10,
  });
});

test("closes by draining in-flight handlers, then nacking, inside Cloud Run's grace", () => {
  const { closeOptions } = buildPubSubSubscriptionOptions(undefined, 10);

  assert.equal(closeOptions.behavior, "WAIT");
  assert.equal(closeOptions.timeout?.totalOf("second"), 7);
  // Cloud Run sends SIGKILL 10 s after SIGTERM.
  assert.ok(Number(closeOptions.timeout?.totalOf("second")) < 10);
});

test("separates broker publish-to-callback latency from handler work", () => {
  assert.equal(typeof consumerRuntime.getPubSubDeliveryTiming, "function");
  const startedAt = Date.parse("2026-10-13T07:13:19.048Z");
  assert.deepEqual(
    consumerRuntime.getPubSubDeliveryTiming(
      { publishTime: new Date("2026-10-13T07:13:11.766Z"), deliveryAttempt: 2 },
      startedAt,
    ),
    {
      brokerPublishedAt: "2026-10-13T07:13:11.766Z",
      callbackStartedAt: "2026-10-13T07:13:19.048Z",
      brokerToCallbackMs: 7_282,
      brokerPublishTimeInFuture: false,
      pubsubDeliveryAttempt: 2,
      clientReceivedAt: null,
      brokerToReceiptMs: null,
      receiptToCallbackMs: null,
    },
  );
});

test("splits the broker wait at the SDK receipt time", () => {
  const publishTime = new Date("2026-10-17T11:16:19.638Z");
  const startedAt = Date.parse("2026-10-17T11:16:26.829Z");
  const received = Date.parse("2026-10-17T11:16:25.700Z");

  const timing = consumerRuntime.getPubSubDeliveryTiming(
    { publishTime, received },
    startedAt,
  );

  assert.equal(timing.clientReceivedAt, "2026-10-17T11:16:25.700Z");
  assert.equal(timing.brokerToReceiptMs, 6_062);
  assert.equal(timing.receiptToCallbackMs, 1_129);
  assert.equal(
    Number(timing.brokerToReceiptMs) + Number(timing.receiptToCallbackMs),
    timing.brokerToCallbackMs,
  );
});

test("keeps the local receipt hop when the broker clock is ahead", () => {
  const timing = consumerRuntime.getPubSubDeliveryTiming(
    { publishTime: new Date(1_500), received: 1_000 },
    1_200,
  );
  assert.equal(timing.brokerToReceiptMs, null);
  assert.equal(timing.receiptToCallbackMs, 200);

  for (const received of [undefined, Number.NaN, 2_000]) {
    const invalid = consumerRuntime.getPubSubDeliveryTiming(
      { publishTime: new Date(500), received },
      1_200,
    );
    assert.equal(invalid.clientReceivedAt, null);
    assert.equal(invalid.brokerToReceiptMs, null);
    assert.equal(invalid.receiptToCallbackMs, null);
  }
});

test("does not turn missing broker timestamps or clock skew into zero latency", () => {
  assert.equal(typeof consumerRuntime.getPubSubDeliveryTiming, "function");
  for (const publishTime of [undefined, new Date("invalid")]) {
    const timing = consumerRuntime.getPubSubDeliveryTiming(
      { publishTime },
      1_000,
    );
    assert.equal(timing.brokerPublishedAt, null);
    assert.equal(timing.brokerToCallbackMs, null);
    assert.equal(timing.pubsubDeliveryAttempt, null);
  }
  const future = consumerRuntime.getPubSubDeliveryTiming(
    { publishTime: new Date(2_000), deliveryAttempt: 0 },
    1_000,
  );
  assert.equal(future.brokerToCallbackMs, null);
  assert.equal(future.brokerPublishTimeInFuture, true);
});
