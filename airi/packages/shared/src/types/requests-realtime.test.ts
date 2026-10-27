import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSourceWatermarks,
  parseProjectionGeneration,
  parseRequestsRealtimeCommitAckV1,
  parseRequestsRealtimePresenceClientFrameV1,
  parseRequestsRealtimePresenceServerFrameV1,
  parseRequestsRealtimeReadyServerFrameV1,
  parseRequestsRealtimeSubscriptionClientFrameV1,
  parseRequestsRealtimeSubscriptionServerFrameV1,
  parseSourceWatermark,
} from "./requests-realtime";
import type { RequestsRealtimeReadyServerFrameV1 } from "./requests-realtime";
import type { RealtimeServerFrame } from "./realtime";

const workspaceId = "123e4567-e89b-12d3-a456-426614174000";
const conversationId = "507f1f77bcf86cd799439011";
test("Requests ready frames use the closed process-identity contract", () => {
  const ready: RequestsRealtimeReadyServerFrameV1 = {
    type: "ready",
    schemaVersion: 1,
    connectionId: "123e4567-e89b-12d3-a456-426614174000",
    expiresAt: "2026-08-20T00:05:00.000Z",
    gatewayInstanceId: "0123456789abcdef0123456789abcdef",
  };

  assert.deepEqual(parseRequestsRealtimeReadyServerFrameV1(ready), ready);
});

test("Requests ready frames reject malformed identities and instants", () => {
  const ready = {
    type: "ready",
    schemaVersion: 1,
    connectionId: "123e4567-e89b-12d3-a456-426614174000",
    expiresAt: "2026-08-20T00:05:00.000Z",
    gatewayInstanceId: "0123456789abcdef0123456789abcdef",
  };

  for (const invalid of [
    { ...ready, type: "pong" },
    { ...ready, schemaVersion: 2 },
    { ...ready, connectionId: ready.connectionId.toUpperCase() },
    { ...ready, connectionId: "connection-1" },
    { ...ready, gatewayInstanceId: ready.gatewayInstanceId.toUpperCase() },
    { ...ready, gatewayInstanceId: "0".repeat(31) },
    { ...ready, expiresAt: "2026-02-31T00:05:00.000Z" },
    { ...ready, expiresAt: "2026-08-20T00:05:00Z" },
    { ...ready, extra: true },
    { ...ready, connectionId: "x".repeat(4_097) },
  ]) {
    assert.throws(() => parseRequestsRealtimeReadyServerFrameV1(invalid));
  }

  for (const missingKey of [
    "type",
    "schemaVersion",
    "connectionId",
    "expiresAt",
    "gatewayInstanceId",
  ] as const) {
    const invalid: Partial<typeof ready> = { ...ready };
    delete invalid[missingKey];
    assert.throws(() => parseRequestsRealtimeReadyServerFrameV1(invalid));
  }
});

test("Requests ready frames reject accessors without evaluating them", () => {
  let touched = false;
  const ready = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries({
    type: "ready",
    schemaVersion: 1,
    connectionId: "123e4567-e89b-12d3-a456-426614174000",
    expiresAt: "2026-08-20T00:05:00.000Z",
    gatewayInstanceId: "0123456789abcdef0123456789abcdef",
  })) {
    Object.defineProperty(ready, key, {
      enumerable: true,
      get() {
        touched = true;
        return value;
      },
    });
  }

  assert.throws(() => parseRequestsRealtimeReadyServerFrameV1(ready));
  assert.equal(touched, false);
});

test("legacy ready remains the unchanged three-member server frame", () => {
  const legacyReady: RealtimeServerFrame = {
    type: "ready",
    connectionId: "legacy-connection",
    expiresAt: "2026-08-20T00:05:00.000Z",
  };

  assert.deepEqual(legacyReady, {
    type: "ready",
    connectionId: "legacy-connection",
    expiresAt: "2026-08-20T00:05:00.000Z",
  });
});

test("Requests parsers retain unsigned generation and watermark boundaries", () => {
  assert.equal(parseProjectionGeneration("184467"), "184467");
  assert.equal(parseSourceWatermark("8000000000000000"), "8000000000000000");
  assert.equal(
    compareSourceWatermarks("7fffffffffffffff", "8000000000000000"),
    -1,
  );
  assert.throws(() => parseProjectionGeneration("0"));
  assert.throws(() => parseProjectionGeneration("01"));
  assert.throws(() => parseSourceWatermark("8000000000000000 "));
});

test("Requests control frames are closed and bounded", () => {
  const subscription = {
    type: "subscribe",
    schemaVersion: 1,
    workspaceId,
    grantId: "0123456789abcdef0123456789abcdef",
    channels: [
      `workspace:${workspaceId}`,
      `conversation:${workspaceId}:${conversationId}`,
    ],
  };
  assert.deepEqual(
    parseRequestsRealtimeSubscriptionClientFrameV1(subscription),
    subscription,
  );
  assert.throws(() =>
    parseRequestsRealtimeSubscriptionClientFrameV1({
      ...subscription,
      channels: [...subscription.channels, subscription.channels[1]],
    }),
  );
  assert.throws(() =>
    parseRequestsRealtimeSubscriptionClientFrameV1({
      ...subscription,
      extra: true,
    }),
  );
  assert.throws(() =>
    parseRequestsRealtimeSubscriptionClientFrameV1({
      ...subscription,
      padding: "x".repeat(5000),
    }),
  );

  const presence = {
    type: "requests_presence",
    schemaVersion: 1,
    connectionId: "connection_1",
    subscriptionEpoch: 1,
    grantId: "0123456789abcdef0123456789abcdef",
    presenceSequence: 1,
    state: "warming",
  };
  assert.deepEqual(
    parseRequestsRealtimePresenceClientFrameV1(presence),
    presence,
  );
  const exact4096 = { ...presence, connectionId: "" };
  exact4096.connectionId = "x".repeat(
    4_096 - Buffer.byteLength(JSON.stringify(exact4096)),
  );
  assert.equal(Buffer.byteLength(JSON.stringify(exact4096)), 4_096);
  assert.deepEqual(
    parseRequestsRealtimePresenceClientFrameV1(exact4096),
    exact4096,
  );
  assert.throws(() =>
    parseRequestsRealtimePresenceClientFrameV1({
      ...exact4096,
      connectionId: `${exact4096.connectionId}x`,
    }),
  );
  for (const state of [
    "hidden",
    "warming",
    "visible-warm",
    "inactive",
  ] as const) {
    assert.equal(
      parseRequestsRealtimePresenceClientFrameV1({ ...presence, state }).state,
      state,
    );
  }
  for (const outcome of [
    "displayed",
    "unread-only",
    "covered-no-visible-change",
  ] as const) {
    const parsed = parseRequestsRealtimeCommitAckV1({
      schemaVersion: 1,
      kind: "preview",
      latencyTraceId: "0123456789abcdef0123456789abcdef",
      outcome,
      receiptToCommitMs: 0,
    });
    assert.equal(parsed.kind, "preview");
    if (parsed.kind === "preview") assert.equal(parsed.outcome, outcome);
  }
  assert.throws(() =>
    parseRequestsRealtimePresenceClientFrameV1({ ...presence, unknown: true }),
  );
  assert.throws(() =>
    parseRequestsRealtimePresenceClientFrameV1({
      ...presence,
      connectionId: "x".repeat(5000),
    }),
  );

  const presenceAck = { ...presence, type: "requests_presence_ack" };
  assert.deepEqual(
    parseRequestsRealtimePresenceServerFrameV1(presenceAck),
    presenceAck,
  );
  for (const state of [
    "hidden",
    "warming",
    "visible-warm",
    "inactive",
  ] as const) {
    assert.equal(
      parseRequestsRealtimePresenceServerFrameV1({ ...presenceAck, state })
        .state,
      state,
    );
  }

  const subscriptionAck = {
    type: "subscribed",
    schemaVersion: 1,
    connectionId: "connection_1",
    subscriptionEpoch: 1,
    grantId: subscription.grantId,
    channels: subscription.channels,
  };
  assert.deepEqual(
    parseRequestsRealtimeSubscriptionServerFrameV1(subscriptionAck),
    subscriptionAck,
  );
  const exactSubscriptionAck = { ...subscriptionAck, connectionId: "" };
  exactSubscriptionAck.connectionId = "x".repeat(
    4_096 - Buffer.byteLength(JSON.stringify(exactSubscriptionAck)),
  );
  assert.equal(Buffer.byteLength(JSON.stringify(exactSubscriptionAck)), 4_096);
  assert.deepEqual(
    parseRequestsRealtimeSubscriptionServerFrameV1(exactSubscriptionAck),
    exactSubscriptionAck,
  );
  assert.throws(() =>
    parseRequestsRealtimeSubscriptionServerFrameV1({
      ...exactSubscriptionAck,
      connectionId: `${exactSubscriptionAck.connectionId}x`,
    }),
  );
  assert.equal(
    parseRequestsRealtimeSubscriptionServerFrameV1({
      ...subscriptionAck,
      type: "unsubscribed",
    }).type,
    "unsubscribed",
  );
  assert.equal(
    parseRequestsRealtimeSubscriptionClientFrameV1({
      ...subscription,
      type: "unsubscribe",
    }).type,
    "unsubscribe",
  );

  const ack = {
    schemaVersion: 1,
    kind: "canonical",
    canonicalTraceId: "0123456789abcdef0123456789abcdef",
    targetProjectionGeneration: "184467",
    appliedProjectionGeneration: "184468",
    appliedState: "row",
    receiptToCommitMs: 0,
  };
  assert.deepEqual(parseRequestsRealtimeCommitAckV1(ack), ack);
  const removed = parseRequestsRealtimeCommitAckV1({
    ...ack,
    appliedState: "removed",
  });
  assert.equal(removed.kind, "canonical");
  if (removed.kind === "canonical")
    assert.equal(removed.appliedState, "removed");
  assert.throws(() =>
    parseRequestsRealtimeCommitAckV1({ ...ack, receiptToCommitMs: 30_001 }),
  );
  assert.throws(() =>
    parseRequestsRealtimeCommitAckV1({
      schemaVersion: 1,
      kind: "canonical",
      latencyTraceId: "0123456789abcdef0123456789abcdef",
      outcome: "displayed",
      receiptToCommitMs: 0,
    }),
  );
  assert.throws(() =>
    parseRequestsRealtimeCommitAckV1({
      schemaVersion: 1,
      kind: "preview",
      canonicalTraceId: "0123456789abcdef0123456789abcdef",
      targetProjectionGeneration: "1",
      appliedProjectionGeneration: "1",
      appliedState: "row",
      receiptToCommitMs: 0,
    }),
  );
  assert.deepEqual(
    parseRequestsRealtimeCommitAckV1({
      schemaVersion: 1,
      kind: "preview",
      latencyTraceId: "0123456789abcdef0123456789abcdef",
      outcome: "displayed",
      receiptToCommitMs: 30_000,
    }),
    {
      schemaVersion: 1,
      kind: "preview",
      latencyTraceId: "0123456789abcdef0123456789abcdef",
      outcome: "displayed",
      receiptToCommitMs: 30_000,
    },
  );
});

test("Requests close acknowledgement keys before getters or serialization", () => {
  let touched = false;
  const unsafe = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(unsafe, "unexpected", {
    enumerable: true,
    get: () => {
      touched = true;
      return true;
    },
  });
  Object.defineProperty(unsafe, "kind", {
    enumerable: true,
    get: () => {
      touched = true;
      return "preview";
    },
  });
  assert.throws(() => parseRequestsRealtimeCommitAckV1(unsafe));
  assert.equal(touched, false);
});
