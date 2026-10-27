import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRealtimeClientContract,
  planRealtimeCandidateAckDeadline,
  planRealtimeRotationRetry,
  planRealtimeTokenRefresh,
  realtimeChannelMatchesScope,
  realtimeScopeCanSubscribe,
  type RealtimeScope,
} from "./realtime";

const workspaceScope: RealtimeScope = {
  kind: "workspace",
  workspaceId: "workspace_1",
};
const conversationScope: RealtimeScope = {
  kind: "conversation",
  workspaceId: "workspace_1",
  conversationId: "507f1f77bcf86cd799439011",
};
const workspaceChannel = "workspace:workspace_1";
const conversationChannel = "conversation:workspace_1:507f1f77bcf86cd799439011";

test("workspace authorization accepts only its exact workspace channel", () => {
  assert.equal(
    realtimeScopeCanSubscribe(workspaceChannel, workspaceScope),
    true,
  );
  assert.equal(
    realtimeScopeCanSubscribe(conversationChannel, workspaceScope),
    false,
  );
  assert.equal(
    realtimeScopeCanSubscribe(
      "conversation:workspace_2:507f1f77bcf86cd799439011",
      workspaceScope,
    ),
    false,
  );
  assert.equal(
    realtimeScopeCanSubscribe(
      "conversation:workspace_1:507f1f77bcf86cd799439011:prefix",
      workspaceScope,
    ),
    false,
  );
});

test("conversation authorization remains exact", () => {
  assert.equal(
    realtimeScopeCanSubscribe(conversationChannel, conversationScope),
    true,
  );
  assert.equal(
    realtimeScopeCanSubscribe(workspaceChannel, conversationScope),
    false,
  );
  assert.equal(
    realtimeScopeCanSubscribe(
      "conversation:workspace_1:507f1f77bcf86cd799439012",
      conversationScope,
    ),
    false,
  );
});

test("the existing channel matcher stays exact for both scope kinds", () => {
  assert.equal(
    realtimeChannelMatchesScope(workspaceChannel, workspaceScope),
    true,
  );
  assert.equal(
    realtimeChannelMatchesScope(conversationChannel, workspaceScope),
    false,
  );
  assert.equal(
    realtimeChannelMatchesScope(conversationChannel, conversationScope),
    true,
  );
  assert.equal(
    realtimeChannelMatchesScope(workspaceChannel, conversationScope),
    false,
  );
});

test("client-contract telemetry uses only bounded passive labels", () => {
  assert.equal(classifyRealtimeClientContract("dashboard-v1"), "dashboard-v1");
  assert.equal(classifyRealtimeClientContract("requests-v1"), "requests-v1");
  assert.equal(classifyRealtimeClientContract(undefined), "legacy-missing");
  assert.equal(classifyRealtimeClientContract("future-v2"), "legacy-missing");
  assert.equal(classifyRealtimeClientContract({ raw: true }), "legacy-missing");
});

test("refresh planning uses the same thirty-second lead for five minutes and one hour", () => {
  const nowMs = Date.parse("2030-01-01T00:00:00.000Z");
  assert.deepEqual(
    planRealtimeTokenRefresh("2030-01-01T00:05:00.000Z", nowMs),
    { kind: "scheduled", delayMs: 270_000 },
  );
  assert.deepEqual(
    planRealtimeTokenRefresh("2030-01-01T01:00:00.000Z", nowMs),
    { kind: "scheduled", delayMs: 3_570_000 },
  );
});

test("refresh planning distinguishes immediate expiry work from invalid input", () => {
  const nowMs = Date.parse("2030-01-01T00:04:30.000Z");
  for (const expiresAt of [
    "2030-01-01T00:05:00.000Z",
    "2030-01-01T00:04:45.000Z",
    "2030-01-01T00:04:30.000Z",
    "2030-01-01T00:04:00.000Z",
  ]) {
    assert.deepEqual(planRealtimeTokenRefresh(expiresAt, nowMs), {
      kind: "scheduled",
      delayMs: 0,
    });
  }

  for (const [expiresAt, suppliedNow] of [
    [undefined, nowMs],
    ["2030-01-01T00:05:00Z", nowMs],
    ["2030-02-30T00:05:00.000Z", nowMs],
    ["not-an-instant", nowMs],
    ["2030-01-01T00:05:00.000Z", Number.NaN],
    ["2030-01-01T00:05:00.000Z", Number.POSITIVE_INFINITY],
  ] as const) {
    assert.deepEqual(planRealtimeTokenRefresh(expiresAt, suppliedNow), {
      kind: "invalid",
    });
  }
});

test("candidate ACK deadlines stay bounded and leave shared pre-expiry headroom", () => {
  const nowMs = Date.parse("2030-01-01T00:00:00.000Z");
  assert.deepEqual(
    planRealtimeCandidateAckDeadline("2030-01-01T00:00:30.000Z", nowMs),
    { kind: "scheduled", delayMs: 10_000 },
  );
  assert.deepEqual(
    planRealtimeCandidateAckDeadline("2030-01-01T00:00:09.000Z", nowMs),
    { kind: "scheduled", delayMs: 4_000 },
  );
  assert.deepEqual(
    planRealtimeCandidateAckDeadline("2030-01-01T00:00:04.000Z", nowMs),
    { kind: "scheduled", delayMs: 0 },
  );
});

test("rotation retries use bounded jitter and never land on active expiry", () => {
  const nowMs = Date.parse("2030-01-01T00:00:00.000Z");
  assert.deepEqual(
    planRealtimeRotationRetry("2030-01-01T00:00:30.000Z", nowMs, 0),
    { kind: "scheduled", delayMs: 7_500 },
  );
  assert.deepEqual(
    planRealtimeRotationRetry("2030-01-01T00:00:30.000Z", nowMs, 1),
    { kind: "scheduled", delayMs: 15_000 },
  );
  assert.deepEqual(
    planRealtimeRotationRetry("2030-01-01T00:00:10.000Z", nowMs, 1),
    { kind: "scheduled", delayMs: 5_000 },
  );
  assert.deepEqual(
    planRealtimeRotationRetry("2030-01-01T00:00:05.000Z", nowMs, 0.5),
    { kind: "invalid" },
  );
  for (const jitterUnit of [-0.01, Number.NaN, 1.01]) {
    assert.deepEqual(
      planRealtimeRotationRetry("2030-01-01T00:00:30.000Z", nowMs, jitterUnit),
      { kind: "invalid" },
    );
  }
});
