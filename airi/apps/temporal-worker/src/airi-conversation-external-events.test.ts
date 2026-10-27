import assert from "node:assert/strict";
import test from "node:test";

import type {
  AiriConversationControlExternalEvent,
  AiriConversationExternalEventLifecycleSnapshot,
  AiriConversationPaymentConfirmedEvent,
  AiriConversationTurnRetryWork,
  AiriScenarioGenerativeAIResultEvent,
} from "@icecore/temporal";
import {
  AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT,
  AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT,
  createAiriConversationExternalEventLifecycle,
} from "./workflows/airi-conversation-external-events.js";

const NOW_MS = 1_000_000;

function paymentEvent(
  conversionId: string,
): AiriConversationPaymentConfirmedEvent {
  return {
    kind: "payment_confirmed",
    conversionId,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    sourceId: "source-1",
    channel: "whatsapp",
    messageId: `confirmed-payment:${conversionId}`,
    messageDate: "2026-09-11T00:00:00.000Z",
  };
}

test("payment retries retain prepared work and acknowledgement across continue-as-new", () => {
  const event = paymentEvent("sale-1");
  let lifecycle = createAiriConversationExternalEventLifecycle();
  lifecycle.enqueue(event, NOW_MS);
  lifecycle.takeReady(NOW_MS);
  const work: AiriConversationTurnRetryWork = {
    turn: { ...event },
    stage: "timer_plan",
    attempt: 0,
    dueAtMs: NOW_MS,
    process: {
      messageId: event.messageId,
      completedAt: event.messageDate,
      outcome: {
        executionStatus: "completed",
        responseStatus: null,
        skippedConcurrent: false,
      },
    },
  };
  lifecycle.checkpointPayment(event, work);
  assert.equal(
    lifecycle.failInFlight(NOW_MS)?.classification,
    "payment_requeued",
  );
  lifecycle = createAiriConversationExternalEventLifecycle(
    lifecycle.snapshot(),
  );
  assert.equal(
    lifecycle.enqueue({ ...event, messageId: "different-envelope" }, NOW_MS)
      .classification,
    "duplicate",
  );
  assert.deepEqual(lifecycle.takeReady(NOW_MS + 5_000)?.paymentTurnWork, work);
  const ack = {
    ...event,
    phase: "complete" as const,
    completionStatus: "processed" as const,
  };
  lifecycle.checkpointPayment(ack);
  lifecycle = createAiriConversationExternalEventLifecycle(
    lifecycle.snapshot(),
  );
  const resumed = lifecycle.takeReady(NOW_MS + 5_000);
  assert.deepEqual(resumed?.event, ack);
  assert.equal(resumed?.paymentTurnWork, undefined);
  assert.equal(
    lifecycle.completeInFlight()?.classification,
    "payment_processed",
  );
  assert.equal(lifecycle.enqueue(event, NOW_MS).classification, "duplicate");
});

test("accepted payments are retained above the generative capacity and survive restore", () => {
  let lifecycle = createAiriConversationExternalEventLifecycle();
  for (
    let i = 0;
    i < AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT + 20;
    i++
  ) {
    assert.equal(
      lifecycle.enqueue(paymentEvent(`sale-${i}`), NOW_MS).classification,
      "enqueued",
    );
  }
  lifecycle = createAiriConversationExternalEventLifecycle(
    lifecycle.snapshot(),
  );
  assert.equal(
    lifecycle.snapshot().queued.length,
    AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT + 20,
  );
  while (lifecycle.takeReady(NOW_MS)) lifecycle.completeInFlight();
  assert.equal(
    lifecycle.snapshot().processedPaymentKeys?.length,
    AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT,
  );
  // The SQL ledger remains authoritative after this bounded local history expires.
  assert.equal(
    lifecycle.enqueue(paymentEvent("sale-0"), NOW_MS).classification,
    "enqueued",
  );
  assert.equal(
    lifecycle.enqueue(paymentEvent("sale-275"), NOW_MS).classification,
    "duplicate",
  );
});

function controlEvent(
  messageId: string,
  kind: AiriConversationControlExternalEvent["kind"] = "human_outbound",
): AiriConversationControlExternalEvent {
  return {
    kind,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId,
    channel: "whatsapp",
    sourceId: "source-1",
    messageDate: "2026-07-30T00:00:00.000Z",
    enqueuedAt: "2026-07-30T00:00:01.000Z",
  };
}

function generativeEvent(
  executionId: string,
): AiriScenarioGenerativeAIResultEvent {
  return {
    kind: "generative_ai_result",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId: executionId,
    executionId,
    scenarioWorkflowId: `scenario-generation:${executionId}`,
    videoWorkflowId: `video-generation:asset-${executionId}`,
    assetId: `asset-${executionId}`,
    terminal: {
      state: "complete",
      code: "generation_complete",
      attemptToken: `attempt-${executionId}`,
    },
  };
}

test("control events retain enqueue-time dedupe after terminal activity failure", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  const event = controlEvent("message-1");

  assert.deepEqual(lifecycle.enqueue(event, NOW_MS), {
    classification: "enqueued",
    key: "human_outbound:message-1",
  });
  assert.deepEqual(lifecycle.enqueue(event, NOW_MS + 1), {
    classification: "duplicate",
    key: "human_outbound:message-1",
  });
  assert.deepEqual(lifecycle.takeReady(NOW_MS), {
    key: "human_outbound:message-1",
    event,
    attempt: 0,
  });
  assert.deepEqual(lifecycle.failInFlight(NOW_MS + 2, true), {
    classification: "control_dropped",
    key: "human_outbound:message-1",
  });
  assert.deepEqual(lifecycle.enqueue(event, NOW_MS + 3), {
    classification: "duplicate",
    key: "human_outbound:message-1",
  });
});

test("timer replans retain enqueue-time dedupe while retrying a terminal activity failure", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  const event = controlEvent("timer-replan-1", "timer_replan");

  assert.equal(lifecycle.enqueue(event, NOW_MS).classification, "enqueued");
  assert.equal(
    lifecycle.enqueue(event, NOW_MS + 1).classification,
    "duplicate",
  );
  assert.deepEqual(lifecycle.takeReady(NOW_MS), {
    key: "timer_replan:timer-replan-1",
    event,
    attempt: 0,
  });
  assert.deepEqual(lifecycle.failInFlight(NOW_MS + 2, true), {
    classification: "timer_replan_requeued",
    key: "timer_replan:timer-replan-1",
    attempt: 1,
    dueAtMs: NOW_MS + 5_002,
  });
  assert.equal(
    lifecycle.enqueue(event, NOW_MS + 3).classification,
    "duplicate",
  );
});

test("continue-as-new preserves one failed timer replan processing path", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  const event = controlEvent("timer-replan-2", "timer_replan");

  lifecycle.enqueue(event, NOW_MS);
  lifecycle.takeReady(NOW_MS);
  lifecycle.failInFlight(NOW_MS, true);

  const restored = createAiriConversationExternalEventLifecycle(
    lifecycle.snapshot(),
  );
  assert.equal(restored.takeReady(NOW_MS + 4_999), null);
  assert.deepEqual(restored.takeReady(NOW_MS + 5_000), {
    key: "timer_replan:timer-replan-2",
    event,
    attempt: 1,
  });
  assert.deepEqual(restored.completeInFlight(), {
    classification: "control_processed",
    key: "timer_replan:timer-replan-2",
  });
  assert.equal(restored.takeReady(NOW_MS + 5_000), null);
  assert.equal(
    restored.enqueue(event, NOW_MS + 5_001).classification,
    "duplicate",
  );
});

test("a durable run adopts one legacy-carried timer replan with its dedupe key", () => {
  const event = controlEvent("legacy-timer-replan", "timer_replan");
  const lifecycle = createAiriConversationExternalEventLifecycle({
    version: 1,
    queued: [{ event, attempt: 0, dueAtMs: 0 }],
    inFlight: null,
    controlSeenKeys: ["timer_replan:legacy-timer-replan"],
    processedGenerativeKeys: [],
  });

  assert.deepEqual(lifecycle.takeReady(0), {
    key: "timer_replan:legacy-timer-replan",
    event,
    attempt: 0,
  });
  assert.equal(lifecycle.enqueue(event, 1).classification, "duplicate");
  assert.deepEqual(lifecycle.completeInFlight(), {
    classification: "control_processed",
    key: "timer_replan:legacy-timer-replan",
  });
  assert.equal(lifecycle.takeReady(1), null);
});

test("control dedupe remains stable for the full workflow run", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  for (
    let index = 0;
    index < AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT + 10;
    index += 1
  ) {
    const event = controlEvent(`message-${index}`);
    lifecycle.enqueue(event, NOW_MS);
    lifecycle.takeReady(NOW_MS);
    lifecycle.completeInFlight();
  }

  assert.equal(
    lifecycle.enqueue(controlEvent("message-0"), NOW_MS).classification,
    "duplicate",
  );
  assert.equal(
    lifecycle.snapshot().controlSeenKeys.length,
    AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT,
  );
});

test("generative results dedupe while queued or in flight without becoming processed", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  const event = generativeEvent("execution-1");

  assert.equal(lifecycle.enqueue(event, NOW_MS).classification, "enqueued");
  assert.equal(
    lifecycle.enqueue(event, NOW_MS + 1).classification,
    "duplicate",
  );
  assert.deepEqual(lifecycle.snapshot().processedGenerativeKeys, []);

  assert.equal(
    lifecycle.takeReady(NOW_MS)?.key,
    "generative_ai_result:execution-1",
  );
  assert.equal(
    lifecycle.enqueue(event, NOW_MS + 2).classification,
    "duplicate",
  );
  assert.deepEqual(lifecycle.snapshot().processedGenerativeKeys, []);
});

test("generative activity failure requeues with deterministic bounded backoff", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  const event = generativeEvent("execution-2");

  lifecycle.enqueue(event, NOW_MS);
  lifecycle.takeReady(NOW_MS);
  assert.deepEqual(lifecycle.failInFlight(NOW_MS + 100), {
    classification: "generative_requeued",
    key: "generative_ai_result:execution-2",
    attempt: 1,
    dueAtMs: NOW_MS + 5_100,
  });
  assert.equal(lifecycle.hasReady(NOW_MS + 5_099), false);
  assert.equal(lifecycle.nextDueAtMs(), NOW_MS + 5_100);
  assert.equal(lifecycle.takeReady(NOW_MS + 5_099), null);
  assert.deepEqual(lifecycle.takeReady(NOW_MS + 5_100), {
    key: "generative_ai_result:execution-2",
    event,
    attempt: 1,
  });
  assert.deepEqual(lifecycle.failInFlight(NOW_MS + 5_100), {
    classification: "generative_requeued",
    key: "generative_ai_result:execution-2",
    attempt: 2,
    dueAtMs: NOW_MS + 20_100,
  });

  const saturated = createAiriConversationExternalEventLifecycle({
    version: 1,
    queued: [
      {
        event: generativeEvent("execution-saturated"),
        attempt: 1_000_000,
        dueAtMs: NOW_MS,
      },
    ],
    inFlight: null,
    controlSeenKeys: [],
    processedGenerativeKeys: [],
  });
  saturated.takeReady(NOW_MS);
  assert.deepEqual(saturated.failInFlight(NOW_MS), {
    classification: "generative_requeued",
    key: "generative_ai_result:execution-saturated",
    attempt: 1_000_000,
    dueAtMs: NOW_MS + 300_000,
  });
});

test("deferred generative retry does not block ready control work or ordinary turns", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  lifecycle.enqueue(generativeEvent("execution-3"), NOW_MS);
  lifecycle.takeReady(NOW_MS);
  lifecycle.failInFlight(NOW_MS);

  assert.equal(lifecycle.hasReady(NOW_MS + 1), false);
  assert.equal(lifecycle.takeReady(NOW_MS + 1), null);

  const control = controlEvent("message-2", "timer_replan");
  lifecycle.enqueue(control, NOW_MS + 1);
  assert.deepEqual(lifecycle.takeReady(NOW_MS + 1), {
    key: "timer_replan:message-2",
    event: control,
    attempt: 0,
  });
});

test("classified completion acknowledges a generative result only after processing", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  const event = generativeEvent("execution-4");

  lifecycle.enqueue(event, NOW_MS);
  lifecycle.takeReady(NOW_MS);
  assert.deepEqual(lifecycle.completeInFlight(), {
    classification: "generative_processed",
    key: "generative_ai_result:execution-4",
  });
  assert.deepEqual(lifecycle.snapshot().processedGenerativeKeys, [
    "generative_ai_result:execution-4",
  ]);
  assert.equal(
    lifecycle.enqueue(event, NOW_MS + 1).classification,
    "duplicate",
  );

  const control = controlEvent("message-3");
  lifecycle.enqueue(control, NOW_MS + 2);
  lifecycle.takeReady(NOW_MS + 2);
  assert.deepEqual(lifecycle.completeInFlight(), {
    classification: "control_processed",
    key: "human_outbound:message-3",
  });
});

test("continue-as-new snapshot restores queued and in-flight work without duplication", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  const inFlight = generativeEvent("execution-5");
  const queued = generativeEvent("execution-6");

  lifecycle.enqueue(inFlight, NOW_MS);
  lifecycle.takeReady(NOW_MS);
  lifecycle.enqueue(queued, NOW_MS + 1);

  const restored = createAiriConversationExternalEventLifecycle(
    lifecycle.snapshot(),
  );
  assert.deepEqual(restored.takeReady(NOW_MS + 1), {
    key: "generative_ai_result:execution-5",
    event: inFlight,
    attempt: 0,
  });
  restored.completeInFlight();
  assert.deepEqual(restored.takeReady(NOW_MS + 1), {
    key: "generative_ai_result:execution-6",
    event: queued,
    attempt: 0,
  });
});

test("snapshot state and accepted pending work remain bounded", () => {
  const oldControlKeys = Array.from(
    { length: AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT + 10 },
    (_, index) => `human_outbound:old-${index}`,
  );
  const oldProcessedKeys = Array.from(
    { length: AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT + 10 },
    (_, index) => `generative_ai_result:old-${index}`,
  );
  const restored = createAiriConversationExternalEventLifecycle({
    version: 1,
    queued: [],
    inFlight: null,
    controlSeenKeys: oldControlKeys,
    processedGenerativeKeys: oldProcessedKeys,
  });
  const boundedSnapshot = restored.snapshot();

  assert.equal(
    boundedSnapshot.controlSeenKeys.length,
    AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT,
  );
  assert.equal(
    boundedSnapshot.processedGenerativeKeys.length,
    AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT,
  );
  assert.equal(boundedSnapshot.controlSeenKeys[0], "human_outbound:old-10");
  assert.equal(
    boundedSnapshot.processedGenerativeKeys[0],
    "generative_ai_result:old-10",
  );

  const lifecycle = createAiriConversationExternalEventLifecycle();
  for (
    let index = 0;
    index < AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT;
    index += 1
  ) {
    assert.equal(
      lifecycle.enqueue(generativeEvent(`execution-${index}`), NOW_MS)
        .classification,
      "enqueued",
    );
  }
  assert.deepEqual(
    lifecycle.enqueue(generativeEvent("execution-over-capacity"), NOW_MS),
    {
      classification: "capacity_exceeded",
      key: "generative_ai_result:execution-over-capacity",
    },
  );
  assert.equal(
    lifecycle.snapshot().queued.length,
    AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT,
  );

  assert.equal(
    lifecycle.enqueue(controlEvent("control-after-saturation"), NOW_MS)
      .classification,
    "enqueued",
  );
});

test("snapshot round trip keeps only bounded event identity and retry metadata", () => {
  const lifecycle = createAiriConversationExternalEventLifecycle();
  lifecycle.enqueue(generativeEvent("execution-7"), NOW_MS);
  lifecycle.takeReady(NOW_MS);
  lifecycle.failInFlight(NOW_MS);

  const snapshot: AiriConversationExternalEventLifecycleSnapshot =
    lifecycle.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "controlSeenKeys",
    "inFlight",
    "processedGenerativeKeys",
    "queued",
    "version",
  ]);
  assert.deepEqual(Object.keys(snapshot.queued[0] ?? {}).sort(), [
    "attempt",
    "dueAtMs",
    "event",
  ]);
});
