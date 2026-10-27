import assert from "node:assert/strict";
import test from "node:test";

import type { WhatsAppCallWebhookEvent } from "@icecore/shared/lib/whatsapp/webhook-call-events";

import {
  buildCallEvent,
  execResult,
} from "./testing/whatsapp-call-fixtures.js";
import {
  createWhatsAppCallSessionReducer,
  deriveWhatsAppCallSessionState,
} from "./whatsapp-call-session-reducer-core.js";

function createReducerHarness() {
  const calls: unknown[][] = [];
  let nextSession: Record<string, unknown> | null = {
    _id: "session-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    callId: "wacid.1",
    state: "incoming",
  };

  return {
    calls,
    setNextSession: (value: Record<string, unknown> | null) => {
      nextSession = value;
    },
    upsertWhatsAppCallSessionFromEvent: createWhatsAppCallSessionReducer({
      whatsAppCallSessionModel: {
        findOneAndUpdate: (...args) => {
          calls.push(args);
          return execResult(nextSession);
        },
      },
    }),
  };
}

test("creates one durable session per workspace, source, and call id", async () => {
  const { calls, upsertWhatsAppCallSessionFromEvent } = createReducerHarness();
  const event = buildCallEvent();
  const result = await upsertWhatsAppCallSessionFromEvent({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    event,
  });

  const eventAt = new Date(1770000000 * 1000);
  assert.deepEqual(result, {
    _id: "session-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    callId: "wacid.1",
    state: "incoming",
  });
  assert.deepEqual(calls[0], [
    {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callId: "wacid.1",
    },
    {
      $setOnInsert: {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        callId: "wacid.1",
        firstSeenAt: eventAt,
      },
      $set: {
        state: "incoming",
        latestEvent: "connect",
        latestStatus: null,
        direction: "USER_INITIATED",
        from: null,
        to: null,
        fromUserId: "US.1349.private",
        fromParentUserId: "US.parent.private",
        toUserId: "US.1349.business",
        toParentUserId: "US.parent.business",
        recipientId: null,
        recipientUserId: null,
        recipientParentUserId: null,
        contactUserId: "US.1349.private",
        contactParentUserId: "US.parent.private",
        contactWaId: null,
        contactName: "Private Customer",
        contactUsername: "private_customer",
        countryCode: "US",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        bizOpaqueCallbackData: "call:workspace-1:wacid.1",
        sessionSdpType: "offer",
        sessionSdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
        durationSeconds: null,
        errorCode: null,
        errorMessage: null,
        lastProviderUpdateAt: eventAt,
        latestRawEvent: event.rawEvent,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ]);
});

[
  ["incoming", buildCallEvent({ event: "connect", status: null })],
  ["incoming", buildCallEvent({ event: "request", status: null })],
  ["pre_accepted", buildCallEvent({ event: "pre_accept", status: null })],
  ["accepted", buildCallEvent({ event: "accept", status: null })],
  [
    "ringing",
    buildCallEvent({ kind: "status", event: null, status: "RINGING" }),
  ],
  [
    "active",
    buildCallEvent({ kind: "status", event: null, status: "IN_PROGRESS" }),
  ],
  ["terminated", buildCallEvent({ event: "terminate", status: null })],
  ["missed", buildCallEvent({ kind: "status", event: null, status: "MISSED" })],
  [
    "failed",
    buildCallEvent({
      kind: "status",
      event: null,
      status: "FAILED",
      errorCode: 138019,
    }),
  ],
].forEach(([expectedState, event]) => {
  test(`maps provider lifecycle events to ${expectedState}`, () => {
    assert.equal(
      deriveWhatsAppCallSessionState(event as WhatsAppCallWebhookEvent),
      expectedState,
    );
  });
});

test("sets answered and ended timestamps only for matching lifecycle states", async () => {
  const { calls, upsertWhatsAppCallSessionFromEvent } = createReducerHarness();
  const accepted = buildCallEvent({
    event: "accept",
    timestamp: "1770000100",
    sessionSdpType: "answer",
    sessionSdp: "v=0\r\no=- 456 789 IN IP4 127.0.0.1",
  });
  const terminated = buildCallEvent({
    event: "terminate",
    timestamp: "1770000300",
    sessionSdpType: null,
    sessionSdp: null,
    durationSeconds: 200,
  });

  await upsertWhatsAppCallSessionFromEvent({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    event: accepted,
  });
  await upsertWhatsAppCallSessionFromEvent({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    event: terminated,
  });

  const acceptedUpdate = calls[0]?.[1] as { $set?: Record<string, unknown> };
  const terminatedUpdate = calls[1]?.[1] as { $set?: Record<string, unknown> };

  assert.deepEqual(
    acceptedUpdate.$set?.answeredAt,
    new Date(1770000100 * 1000),
  );
  assert.equal(Object.hasOwn(acceptedUpdate.$set ?? {}, "endedAt"), false);
  assert.equal(terminatedUpdate.$set?.state, "terminated");
  assert.equal(terminatedUpdate.$set?.durationSeconds, 200);
  assert.deepEqual(terminatedUpdate.$set?.endedAt, new Date(1770000300 * 1000));
});

test("skips events that do not contain a provider call id", async () => {
  const { calls, upsertWhatsAppCallSessionFromEvent } = createReducerHarness();
  const result = await upsertWhatsAppCallSessionFromEvent({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    event: buildCallEvent({ callId: null }),
  });

  assert.equal(result, null);
  assert.equal(calls.length, 0);
});
