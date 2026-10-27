import assert from "node:assert/strict";
import test from "node:test";
import {
  AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE,
  AIRI_TURN_PREPARATION_NOT_STARTED,
  AIRI_OUTBOUND_PREPARATION_FAILED,
  toAiriConversationTurnReference,
  type AiriConversationTurnRetryWork,
} from "@icecore/temporal";
import {
  classifyTurnFailure,
  createTurnRecovery,
  getPreparedTurnFailure,
  nextTurnRetryAt,
} from "./workflows/airi-conversation-turn-recovery.js";

const work: AiriConversationTurnRetryWork = {
  turn: {
    workspaceId: "ws",
    conversationId: "conversation",
    messageId: "message",
    turnContextId: "context",
  },
  stage: "prepare",
  attempt: 1,
  dueAtMs: 5000,
};

test("recovery revisions retain independent retries and deduplicate their own replay", () => {
  const recovery = createTurnRecovery();
  const revised = {
    ...work,
    turn: { ...work.turn, messageRecoveryRevision: "a".repeat(64) },
  };
  recovery.schedule(work);
  recovery.schedule(revised);
  recovery.schedule(revised);
  assert.equal(recovery.snapshot().retries.length, 2);
  assert.equal(
    recovery.takeReady(5000)?.turn.messageRecoveryRevision,
    undefined,
  );
  assert.equal(
    recovery.takeReady(5000)?.turn.messageRecoveryRevision,
    "a".repeat(64),
  );
});

test("only positively preflight preparation failures are retryable", () => {
  assert.equal(
    classifyTurnFailure("prepare", new Error("model failed")),
    "outcome_unknown",
  );
  assert.equal(
    classifyTurnFailure("prepare", {
      cause: { type: AIRI_TURN_PREPARATION_NOT_STARTED, nonRetryable: true },
    }),
    "retryable",
  );
  assert.equal(
    classifyTurnFailure("delivery", new Error("response lost")),
    "outcome_unknown",
  );
  assert.equal(
    classifyTurnFailure("timer_plan", new Error("Mongo unavailable")),
    "retryable",
  );
  assert.equal(
    classifyTurnFailure("timer_plan", { cause: { nonRetryable: true } }),
    "terminal",
  );
});

test("company capacity deferral is retried only on the patched preparation path", () => {
  const deferred = { cause: { type: "AIRI_COMPANY_CAPACITY_DEFERRED" } };
  assert.equal(classifyTurnFailure("prepare", deferred), "outcome_unknown");
  assert.equal(
    classifyTurnFailure("prepare", deferred, { retryCompanyCapacity: true }),
    "retryable",
  );
  assert.equal(
    classifyTurnFailure("delivery", deferred, { retryCompanyCapacity: true }),
    "outcome_unknown",
  );
});

test("retries an explicitly rejected retryable provider request only on the patched delivery path", () => {
  const rejected = {
    cause: { type: AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE },
  };
  assert.equal(classifyTurnFailure("delivery", rejected), "outcome_unknown");
  assert.equal(
    classifyTurnFailure("delivery", rejected, {
      retryKnownUnsentDelivery: true,
    }),
    "retryable",
  );
  assert.equal(
    classifyTurnFailure("prepare", rejected, {
      retryKnownUnsentDelivery: true,
    }),
    "outcome_unknown",
  );
});

test("failed returned responses cannot become successful turn completion", () => {
  const result = {
    messageId: "message",
    completedAt: "now",
    outcome: {
      responseStatus: 503,
      executionStatus: "response" as const,
      skippedConcurrent: false,
    },
  };
  assert.equal(getPreparedTurnFailure(result), "outcome_unknown");
  assert.equal(
    getPreparedTurnFailure({
      ...result,
      outcome: { ...result.outcome, responseStatus: 403 },
    }),
    "terminal",
  );
  assert.equal(
    getPreparedTurnFailure({
      ...result,
      outcome: { ...result.outcome, responseStatus: 200 },
    }),
    null,
  );
});

test("retries delivery only with explicit pre-provider proof on the patched path", () => {
  const preparationFailure = {
    cause: { type: AIRI_OUTBOUND_PREPARATION_FAILED, nonRetryable: false },
  };
  assert.equal(
    classifyTurnFailure("delivery", preparationFailure),
    "outcome_unknown",
  );
  assert.equal(
    classifyTurnFailure("delivery", preparationFailure, {
      retryKnownUnsentDelivery: true,
    }),
    "retryable",
  );
  assert.equal(
    classifyTurnFailure("delivery", new Error("provider response lost"), {
      retryKnownUnsentDelivery: true,
    }),
    "outcome_unknown",
  );
  assert.equal(
    classifyTurnFailure("prepare", preparationFailure, {
      retryKnownUnsentDelivery: true,
    }),
    "outcome_unknown",
  );
});

test("recovery retains completed stages across a continue-as-new snapshot", () => {
  const process = {
    messageId: "message",
    completedAt: "now",
    outcome: {
      responseStatus: 200,
      executionStatus: "response" as const,
      skippedConcurrent: false,
    },
    pendingDelivery: {
      deliveryKey: "stable",
      reservedMessageId: "outbound",
      context: { text: "private response" },
    },
  };
  const recovery = createTurnRecovery();
  recovery.schedule({ ...work, stage: "timer_plan", process });
  const restored = createTurnRecovery(
    JSON.parse(JSON.stringify(recovery.snapshot())),
  );
  assert.equal(restored.takeReady(4999), null);
  assert.deepEqual(restored.takeReady(5000), {
    ...work,
    stage: "timer_plan",
    process,
  });
  assert.equal(restored.nextDueAtMs(), null);
});

test("fresh inbound supersedes only unstarted preparation retries", () => {
  const recovery = createTurnRecovery();
  recovery.schedule(work);
  recovery.schedule({
    ...work,
    stage: "timer_plan",
    turn: { ...work.turn, messageId: "already-sent" },
  });
  assert.deepEqual(
    recovery.takeSupersedableRetries().map((item) => item.turn.messageId),
    ["message"],
  );
  assert.equal(recovery.snapshot().retries[0].turn.messageId, "already-sent");
});

test("fresh inbound supersedes only delivery retries carrying durable proof of no send", () => {
  const recovery = createTurnRecovery();
  const proven = {
    ...work,
    stage: "delivery" as const,
    deliveryNotAttempted: true as const,
  };
  const unknown = {
    ...work,
    stage: "delivery" as const,
    turn: { ...work.turn, messageId: "unknown-send" },
  };
  recovery.schedule(proven);
  recovery.schedule(unknown);
  const restored = createTurnRecovery(recovery.snapshot());
  assert.deepEqual(
    restored.takeSupersedableRetries().map((item) => item.turn.messageId),
    [work.turn.messageId],
  );
  assert.deepEqual(restored.snapshot().retries, [unknown]);
});

test("a fresh inbound leaves the unstarted retries it may not supersede", () => {
  const recovery = createTurnRecovery();
  const tap = {
    ...work,
    turn: {
      ...work.turn,
      messageId: "tap",
      triggerEventKind: "whatsapp_button_reply",
    },
  };
  recovery.schedule(work);
  recovery.schedule(tap);
  const isTap = (item: AiriConversationTurnRetryWork) =>
    item.turn.triggerEventKind === "whatsapp_button_reply";
  assert.equal(recovery.hasUnstartedRetry(isTap), true);
  assert.deepEqual(
    recovery
      .takeSupersedableRetries((item) => !isTap(item))
      .map((item) => item.turn.messageId),
    ["message"],
  );
  assert.deepEqual(
    recovery.snapshot().retries.map((item) => item.turn.messageId),
    ["tap"],
  );
  recovery.schedule({ ...tap, stage: "timer_plan" });
  assert.equal(recovery.hasUnstartedRetry(isTap), false);
});

test("takes the earliest matching unstarted retry before its backoff passes", () => {
  const recovery = createTurnRecovery();
  const tap = (messageId: string, dueAtMs: number) => ({
    ...work,
    dueAtMs,
    turn: {
      ...work.turn,
      messageId,
      triggerEventKind: "whatsapp_button_reply",
    },
  });
  const isTap = (item: AiriConversationTurnRetryWork) =>
    item.turn.triggerEventKind === "whatsapp_button_reply";
  recovery.schedule(work);
  recovery.schedule(tap("tap-0", Number.MAX_SAFE_INTEGER));
  recovery.schedule(tap("tap-1", Number.MAX_SAFE_INTEGER));
  recovery.schedule({ ...tap("tap-sent", 0), stage: "timer_plan" });

  assert.equal(recovery.takeUnstartedRetry(isTap)?.turn.messageId, "tap-0");
  assert.deepEqual(
    recovery.snapshot().retries.map((item) => item.turn.messageId),
    [work.turn.messageId, "tap-1", "tap-sent"],
  );
  assert.equal(recovery.takeUnstartedRetry(isTap)?.turn.messageId, "tap-1");
  // A tap whose preparation started is not taken.
  assert.equal(recovery.takeUnstartedRetry(isTap), null);
});

test("runtime references cannot reveal inline payloads or prepared output", () => {
  const reference = toAiriConversationTurnReference({
    ...work.turn,
    textPreview: "customer message",
    autoReplyPayload: { accessToken: "secret" },
  });
  assert.equal("textPreview" in reference, false);
  assert.equal("autoReplyPayload" in reference, false);
  assert.equal(reference.turnContextId, "context");
});

test("runtime references preserve immutable unavailable provenance only when present", () => {
  const unavailable = { ...work.turn, whatsappMessageContentUnavailable: true };
  assert.equal(
    (toAiriConversationTurnReference(unavailable) as typeof unavailable)
      .whatsappMessageContentUnavailable,
    true,
  );
  assert.equal(
    "whatsappMessageContentUnavailable" in
      toAiriConversationTurnReference(work.turn),
    false,
  );
});

test("retry delay is capped without changing the original turn", () => {
  assert.equal(nextTurnRetryAt(1000, 1), 6000);
  assert.equal(nextTurnRetryAt(1000, 1000000), 301000);
  assert.equal(work.turn.messageId, "message");
});
