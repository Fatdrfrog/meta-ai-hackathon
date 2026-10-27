import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ApplicationFailure,
  defaultPayloadConverter,
  type WorkflowHandle,
} from "@temporalio/client";
import {
  AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY,
  AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
  AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY,
  AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
  AIRI_CONVERSATION_INGEST_TURN_SIGNAL,
  AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY,
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY,
  AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY,
  AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY,
  AIRI_CONVERSATION_WORKFLOW,
  AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION,
  AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW,
  AIRI_TURN_PREPARATION_NOT_STARTED,
  AIRI_OUTBOUND_PREPARATION_FAILED,
  AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE,
  type AiriConversationRuntimeState,
  type AiriConversationPaymentConfirmedEvent,
  type AiriConversationTimerDescriptor,
  type AiriConversationTurnDisposition,
  type AiriConversationTurnProcessResult,
  type AiriConversationTurnSignal,
  type AiriConversationWorkflowInput,
} from "@icecore/temporal";
import {
  createLocalTemporalWorkflowHarness,
  waitForWorkflowQuery,
} from "./testing/local-temporal.js";

const workflowsPath = fileURLToPath(
  new URL("./workflows/airi-conversation.ts", import.meta.url),
);
const turn: AiriConversationTurnSignal = {
  workspaceId: "workflow-test-workspace",
  conversationId: "workflow-test-conversation",
  sourceId: "workflow-test-source",
  channel: "web_widget",
  messageId: "inbound-1",
  textPreview: "Synthetic workflow regression",
};
const input: AiriConversationWorkflowInput = {
  contractVersion: AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION,
  workspaceId: turn.workspaceId,
  conversationId: turn.conversationId,
  sourceId: turn.sourceId,
  initialTurn: turn,
};
const timer: AiriConversationTimerDescriptor = {
  kind: "post_action_no_reply_timeout",
  workspaceId: turn.workspaceId,
  conversationId: turn.conversationId,
  channel: "web_widget",
  sourceId: turn.sourceId || null,
  scenarioId: "scenario-1",
  scenarioName: null,
  dueAt: new Date(0).toISOString(),
  triggerNodeId: "trigger-1",
  conditionNodeId: "condition-1",
  sourceActionNodeId: "action-1",
  linkedConditionId: "condition-1",
  waitStartedAt: new Date(0).toISOString(),
  pendingLastOutboundMessageId: "outbound-1",
  lastInboundMessageId: turn.messageId,
  lastInboundAt: null,
  lastInboundText: null,
};
const timerInput: AiriConversationWorkflowInput = {
  ...input,
  initialTurn: null,
  carryover: { state: { activeTimer: timer } },
};
const timerTurn: AiriConversationTurnSignal = {
  workspaceId: turn.workspaceId,
  conversationId: turn.conversationId,
  sourceId: turn.sourceId,
  channel: "web_widget",
  messageId: `scenario-timeout:${timer.kind}:${timer.scenarioId}:${timer.waitStartedAt}`,
  triggerEventKind: "no_human_reply_timeout",
  scenarioOverrideId: timer.scenarioId,
};
// What the reply runtime returns for a timer turn when the conversation's
// scenarios are off: the turn succeeds and the wait is left untouched.
const skippedTimerTurnOutcome = {
  executionStatus: "response" as const,
  responseStatus: 200,
  skippedConcurrent: false,
  responseBody: { status: "ok", skipped_proactive_no_scenario: true },
};
// Bounds a regressed re-fire loop: after three fires the wait reads as stale.
const MAX_TIMER_FIRES = 3;

/** A tap on a scenario button (stb/wsc/wbc payload), as the webhook signals it. */
function buttonTap(messageId: string): AiriConversationTurnSignal {
  return {
    ...turn,
    channel: "whatsapp",
    messageId,
    textPreview: `Synthetic card ${messageId}`,
    triggerEventKind: "whatsapp_button_reply",
  };
}

function prepared(
  request = turn,
  overrides: Partial<AiriConversationTurnProcessResult> = {},
): AiriConversationTurnProcessResult {
  return {
    messageId: request.messageId,
    completedAt: new Date().toISOString(),
    outcome: {
      executionStatus: "completed",
      responseStatus: null,
      skippedConcurrent: false,
    },
    ...overrides,
  };
}

function activities(overrides: object = {}) {
  return {
    [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
      request: AiriConversationTurnSignal,
    ) => prepared(request),
    [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => ({ timer: null }),
    [AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY]: async () => undefined,
    ...overrides,
  };
}

function queryUntil(
  handle: WorkflowHandle,
  predicate: (state: AiriConversationRuntimeState) => boolean,
  timeoutMs?: number,
) {
  return waitForWorkflowQuery(
    handle,
    AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
    predicate,
    timeoutMs,
  );
}

function assertBoundedRetry(nextAttemptAt: string, updatedAt: string) {
  const delayMs = Date.parse(nextAttemptAt) - Date.parse(updatedAt);
  assert.ok(delayMs > 0 && delayMs <= 300_000, `Unbounded retry: ${delayMs}ms`);
}

function paymentEvent(
  conversionId = "sale-1",
): AiriConversationPaymentConfirmedEvent {
  return {
    kind: "payment_confirmed",
    conversionId,
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    sourceId: turn.sourceId!,
    channel: "whatsapp",
    messageId: `confirmed-payment:${conversionId}`,
    messageDate: new Date().toISOString(),
  };
}

function paymentTurn(
  event: AiriConversationPaymentConfirmedEvent,
): AiriConversationTurnSignal {
  return {
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    sourceId: event.sourceId,
    channel: event.channel,
    messageId: event.messageId,
    messageDate: event.messageDate,
  };
}

describe(
  "real Temporal conversation failure recovery",
  {
    skip:
      process.env.TEMPORAL_WORKFLOW_TESTS !== "1"
        ? "Set TEMPORAL_WORKFLOW_TESTS=1 with Temporal CLI installed"
        : false,
    concurrency: false,
    timeout: 480_000,
  },
  () => {
    let harness: Awaited<ReturnType<typeof createLocalTemporalWorkflowHarness>>;
    before(async () => {
      harness = await createLocalTemporalWorkflowHarness(workflowsPath);
    });
    after(async () => {
      await harness?.close();
    });

    it("executes each payment directly without coalescing and retries only its acknowledgement", async () => {
      const first = paymentEvent();
      const second = paymentEvent("sale-2");
      const preparedIds: string[] = [];
      const acknowledgements: AiriConversationPaymentConfirmedEvent[] = [];
      let firstAckAttempts = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          carryover: { pendingExternalEvents: [first, second] },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            preparedIds.push(request.messageId);
            return prepared(request);
          },
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
            event: AiriConversationPaymentConfirmedEvent,
          ) => {
            if (event.phase === "complete") {
              if (
                event.conversionId === first.conversionId &&
                ++firstAckAttempts <= 3
              )
                throw new Error("temporary acknowledgement failure");
              acknowledgements.push(event);
              return { handled: true, paymentDisposition: "terminal" };
            }
            return {
              handled: true,
              paymentDisposition: "ready",
              paymentTurn: paymentTurn(event),
            };
          },
        }),
        assert: async (handle) => {
          await queryUntil(handle, () => acknowledgements.length === 2, 30_000);
          assert.deepEqual(
            [...preparedIds].sort(),
            [first.messageId, second.messageId, turn.messageId].sort(),
          );
          assert.equal(firstAckAttempts, 4);
          assert.ok(
            acknowledgements.every(
              (event) => event.completionStatus === "processed",
            ),
          );
          await handle.signal(
            AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
            first,
          );
          await delay(100);
          assert.equal(preparedIds.length, 3);
        },
      });
    });

    it("payment enqueue and terminal rejection preserve an unrelated active timer", async () => {
      const payment = paymentEvent();
      const futureTimer = {
        ...timer,
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      };
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let preparations = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...timerInput,
          carryover: { state: { activeTimer: futureTimer } },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            preparations++;
            return prepared();
          },
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async () => {
            entered = true;
            await gate;
            return { handled: true, paymentDisposition: "terminal" };
          },
        }),
        assert: async (handle) => {
          await queryUntil(handle, (state) => !!state.activeTimer);
          await handle.signal(
            AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
            payment,
          );
          const processing = await queryUntil(
            handle,
            (state) => entered && state.activeMessageId === payment.messageId,
          );
          assert.equal(processing.activeTimer?.dueAt, futureTimer.dueAt);
          release();
          const done = await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === payment.messageId,
          );
          assert.equal(done.activeTimer?.dueAt, futureTimer.dueAt);
          assert.equal(preparations, 0);
        },
      });
    });

    it("payment preparation ambiguity is acknowledged failed once and stale runtime output is skipped", async () => {
      const ambiguous = paymentEvent();
      const stale = paymentEvent("sale-stale");
      const unsuccessful = paymentEvent("sale-unsuccessful");
      const acknowledgements: AiriConversationPaymentConfirmedEvent[] = [];
      let preparations = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          initialTurn: null,
          carryover: {
            pendingExternalEvents: [ambiguous, stale, unsuccessful],
          },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            preparations++;
            if (request.messageId === ambiguous.messageId)
              throw new Error("lost preparation result");
            if (request.messageId === unsuccessful.messageId)
              return prepared(request, {
                outcome: {
                  executionStatus: "failed",
                  responseStatus: 500,
                  skippedConcurrent: true,
                  responseBody: { skipped_concurrent: true },
                },
              });
            return prepared(request, {
              outcome: {
                executionStatus: "response",
                responseStatus: 200,
                skippedConcurrent: false,
                responseBody: {
                  status: "ok",
                  skipped_confirmed_payment_scenario: true,
                },
              },
            });
          },
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
            event: AiriConversationPaymentConfirmedEvent,
          ) => {
            if (event.phase === "complete") {
              acknowledgements.push(event);
              return { handled: true, paymentDisposition: "terminal" };
            }
            return {
              handled: true,
              paymentDisposition: "ready",
              paymentTurn: paymentTurn(event),
            };
          },
        }),
        assert: async (handle) => {
          await queryUntil(handle, () => acknowledgements.length === 3);
          assert.deepEqual(
            acknowledgements.map((event) => event.completionStatus),
            ["failed", "skipped", "failed"],
          );
          await handle.signal(
            AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
            ambiguous,
          );
          await delay(100);
          assert.equal(preparations, 3);
        },
      });
    });

    it("payment retry retains its identity after preflight failure and ignores signal acknowledgement fields", async () => {
      const payment = paymentEvent();
      let preparations = 0;
      const acknowledgements: AiriConversationPaymentConfirmedEvent[] = [];
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: { ...input, initialTurn: null },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            if (++preparations === 1)
              throw ApplicationFailure.create({
                message: "Known preflight outage",
                type: AIRI_TURN_PREPARATION_NOT_STARTED,
              });
            return prepared(request);
          },
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
            event: AiriConversationPaymentConfirmedEvent,
          ) => {
            if (event.phase === "complete") {
              acknowledgements.push(event);
              return { handled: true, paymentDisposition: "terminal" };
            }
            return {
              handled: true,
              paymentDisposition: "ready",
              paymentTurn: paymentTurn(event),
            };
          },
        }),
        assert: async (handle) => {
          await handle.signal(AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL, {
            ...payment,
            phase: "complete",
            completionStatus: "processed",
          });
          const pending = await queryUntil(
            handle,
            (state) => state.lastExecutionStatus === "failed",
          );
          assert.equal(pending.lastProcessedMessageId, null);
          assert.equal(acknowledgements.length, 0);
          await handle.signal(
            AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
            payment,
          );
          await queryUntil(handle, () => acknowledgements.length === 1, 20_000);
          assert.equal(preparations, 2);
          assert.equal(acknowledgements[0]?.completionStatus, "processed");
        },
      });
    });

    it("payment delivery ambiguity is terminal and never delivered again", async () => {
      const payment = paymentEvent();
      let deliveries = 0;
      const acknowledgements: AiriConversationPaymentConfirmedEvent[] = [];
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          initialTurn: null,
          carryover: { pendingExternalEvents: [payment] },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) =>
            prepared(request, {
              pendingDelivery: {
                deliveryKey: payment.messageId,
                reservedMessageId: "payment-outbound",
                context: {},
              },
            }),
          [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async () => {
            deliveries++;
            return {
              deliveryKey: payment.messageId,
              outboundMessageId: "payment-outbound",
              outboundDate: payment.messageDate,
              classification: "outcome_unknown",
            };
          },
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
            event: AiriConversationPaymentConfirmedEvent,
          ) => {
            if (event.phase === "complete") {
              acknowledgements.push(event);
              return { handled: true, paymentDisposition: "terminal" };
            }
            return {
              handled: true,
              paymentDisposition: "ready",
              paymentTurn: paymentTurn(event),
            };
          },
        }),
        assert: async (handle) => {
          await queryUntil(handle, () => acknowledgements.length === 1);
          assert.equal(acknowledgements[0]?.completionStatus, "failed");
          assert.equal(
            acknowledgements[0]?.completionReason,
            "payment_delivery_outcome_unknown",
          );
          await handle.signal(
            AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
            payment,
          );
          await delay(100);
          assert.equal(deliveries, 1);
        },
      });
    });

    it("payment continue-as-new carries acknowledgement intent without repeating a delivered turn", async () => {
      const rotatingHarness = await createLocalTemporalWorkflowHarness(
        workflowsPath,
        { suggestContinueAsNewAfterEvents: 10 },
      );
      const payment = paymentEvent();
      let prepares = 0;
      let deliveries = 0;
      let acknowledgements = 0;
      try {
        await rotatingHarness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input: {
            ...input,
            initialTurn: null,
            carryover: { pendingExternalEvents: [payment] },
          },
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
              request: AiriConversationTurnSignal,
            ) => {
              prepares++;
              return prepared(request, {
                pendingDelivery: {
                  deliveryKey: payment.messageId,
                  reservedMessageId: "payment-outbound",
                  context: { text: "Private payment response" },
                },
              });
            },
            [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async () => {
              deliveries++;
              return {
                deliveryKey: payment.messageId,
                outboundMessageId: "payment-outbound",
                outboundDate: payment.messageDate,
                classification: "sent",
              };
            },
            [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
              event: AiriConversationPaymentConfirmedEvent,
            ) => {
              if (event.phase === "complete") {
                if (++acknowledgements <= 3)
                  throw new Error("Temporary acknowledgement outage");
                return { handled: true, paymentDisposition: "terminal" };
              }
              return {
                handled: true,
                paymentDisposition: "ready",
                paymentTurn: paymentTurn(event),
              };
            },
          }),
          assert: async (handle) => {
            await queryUntil(
              handle,
              (state) => state.lastExecutionStatus === "failed",
            );
            const original = handle.client.getHandle(
              handle.workflowId,
              handle.firstExecutionRunId,
            );
            let continued: AiriConversationWorkflowInput | undefined;
            const deadline = Date.now() + 10_000;
            while (!continued && Date.now() < deadline) {
              const history = await original.fetchHistory();
              const payload = history.events?.find(
                (event) => event.workflowExecutionContinuedAsNewEventAttributes,
              )?.workflowExecutionContinuedAsNewEventAttributes?.input
                ?.payloads?.[0];
              if (payload)
                continued =
                  defaultPayloadConverter.fromPayload<AiriConversationWorkflowInput>(
                    payload,
                  );
              else await delay(25);
            }
            const queued =
              continued?.carryover?.externalEventLifecycle?.queued[0];
            assert.ok(
              queued,
              "Expected payment checkpoint in real continue-as-new history",
            );
            assert.equal(queued.event.kind, "payment_confirmed");
            assert.equal(
              (queued.event as AiriConversationPaymentConfirmedEvent).phase,
              "complete",
            );
            assert.equal(queued.paymentTurnWork, undefined);
            const state = await queryUntil(
              handle,
              (state) => state.lastProcessedMessageId === payment.messageId,
              20_000,
            );
            assert.equal(prepares, 1);
            assert.equal(deliveries, 1);
            assert.equal(acknowledgements, 4);
            assert.equal(
              JSON.stringify(state).includes("Private payment response"),
              false,
            );
          },
        });
      } finally {
        await rotatingHarness.close();
      }
    });

    it("payment deferred delivery preserves generative terminalization and accurate payment outcomes", async () => {
      const events = ["outcome_unknown", "not_attempted", "skipped"].map(
        paymentEvent,
      );
      const acknowledgements: AiriConversationPaymentConfirmedEvent[] = [];
      let terminalizations = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          initialTurn: null,
          carryover: { pendingExternalEvents: events },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) =>
            prepared(request, {
              pendingDelivery: {
                deliveryKey: request.messageId,
                reservedMessageId: "payment-outbound",
                dispatchPolicy: "at_most_once",
                context: {},
              },
              deferredCommand: {
                version: 1,
                kind: "start_generative_ai_scenario",
                workflowId: `generation:${request.messageId}`,
                workspaceId: request.workspaceId,
                conversationId: request.conversationId,
                executionId: request.messageId,
                scenarioId: "scenario-1",
                scenarioRevisionFingerprint: "revision-1",
                actionNodeId: "action-1",
              },
            }),
          [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async (request: {
            deliveryKey: string;
          }) => ({
            deliveryKey: request.deliveryKey,
            outboundMessageId: "payment-outbound",
            outboundDate: events[0]!.messageDate,
            classification: request.deliveryKey.replace(
              "confirmed-payment:",
              "",
            ),
            skipReason: "manual_handoff_active",
          }),
          [AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY]: async () => {
            terminalizations++;
          },
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
            event: AiriConversationPaymentConfirmedEvent,
          ) => {
            if (event.phase === "complete") {
              acknowledgements.push(event);
              return { handled: true, paymentDisposition: "terminal" };
            }
            return {
              handled: true,
              paymentDisposition: "ready",
              paymentTurn: paymentTurn(event),
            };
          },
        }),
        assert: async (handle) => {
          await queryUntil(handle, () => acknowledgements.length === 3);
          assert.deepEqual(
            acknowledgements.map((event) => event.completionStatus),
            ["failed", "failed", "skipped"],
          );
          assert.equal(terminalizations, 3);
        },
      });
    });

    it("starts an accepted generation without delivering a customer message", async () => {
      const executionId = randomUUID();
      const command = {
        version: 1 as const,
        kind: "start_generative_ai_scenario" as const,
        workflowId: `scenario-generation:${executionId}`,
        workspaceId: turn.workspaceId,
        conversationId: turn.conversationId,
        executionId,
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "a".repeat(64),
        actionNodeId: "generate-1",
      };
      const deliveries: unknown[] = [];
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) =>
            prepared(request, {
              pendingDelivery: null,
              deferredCommand: command,
            }),
          [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async (
            request: unknown,
          ) => {
            deliveries.push(request);
            throw ApplicationFailure.nonRetryable(
              "A silent generation start delivers nothing",
            );
          },
        }),
        assert: async (handle) => {
          await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === turn.messageId,
            30_000,
          );
          const child = handle.client.getHandle(command.workflowId);
          try {
            const description = await child.describe();
            assert.equal(
              description.type,
              AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW,
            );
          } finally {
            await child
              .terminate("Local integration test completed")
              .catch(() => undefined);
          }
          assert.deepEqual(deliveries, []);
        },
      });
    });

    it("payment timer planning retry retains the delivered turn checkpoint", async () => {
      const payment = paymentEvent();
      let prepares = 0;
      let deliveries = 0;
      let plans = 0;
      let acknowledged = false;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          initialTurn: null,
          carryover: { pendingExternalEvents: [payment] },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            prepares++;
            return prepared(request, {
              pendingDelivery: {
                deliveryKey: payment.messageId,
                reservedMessageId: "payment-outbound",
                context: {},
              },
            });
          },
          [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async () => {
            deliveries++;
            return {
              deliveryKey: payment.messageId,
              outboundMessageId: "payment-outbound",
              outboundDate: payment.messageDate,
              classification: "sent",
            };
          },
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
            if (++plans <= 3) throw new Error("Temporary planning outage");
            return { timer: null };
          },
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
            event: AiriConversationPaymentConfirmedEvent,
          ) => {
            if (event.phase === "complete") {
              acknowledged = true;
              return { handled: true, paymentDisposition: "terminal" };
            }
            return {
              handled: true,
              paymentDisposition: "ready",
              paymentTurn: paymentTurn(event),
            };
          },
        }),
        assert: async (handle) => {
          const pending = await queryUntil(
            handle,
            (state) => state.lastExecutionStatus === "failed",
          );
          assert.equal(pending.lastProcessedMessageId, null);
          assert.equal(acknowledged, false);
          await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === payment.messageId,
            20_000,
          );
          assert.equal(prepares, 1);
          assert.equal(deliveries, 1);
          assert.equal(plans, 4);
          assert.equal(acknowledged, true);
        },
      });
    });

    it("payment bursts retain every accepted signal and rotate once before draining the backlog", async () => {
      const events = Array.from({ length: 276 }, (_, i) =>
        paymentEvent(`burst-${i}`),
      );
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handled = new Set<string>();
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: { ...input, initialTurn: null },
        activities: activities({
          [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: async (
            event: AiriConversationPaymentConfirmedEvent,
          ) => {
            if (!entered) {
              entered = true;
              await gate;
            }
            handled.add(event.conversionId);
            return { handled: true, paymentDisposition: "terminal" };
          },
        }),
        assert: async (handle) => {
          try {
            await handle.signal(
              AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
              events[0],
            );
            await queryUntil(handle, () => entered);
            await Promise.all(
              events
                .slice(1)
                .map((event) =>
                  handle.signal(
                    AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
                    event,
                  ),
                ),
            );
          } finally {
            release();
          }
          await queryUntil(
            handle,
            (state) =>
              handled.size === events.length && state.status === "idle",
            60_000,
          );
          const original = handle.client.getHandle(
            handle.workflowId,
            handle.firstExecutionRunId,
          );
          const originalHistory = await original.fetchHistory();
          const continued = originalHistory.events?.find(
            (event) => event.workflowExecutionContinuedAsNewEventAttributes,
          )?.workflowExecutionContinuedAsNewEventAttributes;
          assert.ok(
            continued?.newExecutionRunId,
            "A burst must rotate the workflow history",
          );
          const resumed = handle.client.getHandle(
            handle.workflowId,
            continued.newExecutionRunId,
          );
          const resumedHistory = await resumed.fetchHistory();
          assert.equal(
            resumedHistory.events?.some(
              (event) => !!event.workflowExecutionContinuedAsNewEventAttributes,
            ),
            false,
            "A restored backlog must drain without rotating once per payment",
          );
          assert.equal(handled.size, events.length);
        },
      });
    });

    it("replays captured histories from before durable turn recovery", async () => {
      for (const name of [
        "completed",
        "preparation-failed",
        "timer-build-failed",
      ]) {
        const fixture = JSON.parse(
          await readFile(
            new URL(
              `../replay-histories/synthetic-airi-${name}-before-turn-recovery.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ) as { workflowId: string; history: unknown };
        await harness.replay(fixture.history, fixture.workflowId);
      }
    });

    it("replays captured histories from before failed-turn re-planning and re-fire suppression", async () => {
      for (const name of [
        "failed-inbound-before-failed-turn-timer-replan",
        "timer-refire-before-refire-suppression",
        "timer-fire-continued-as-new-before-refire-suppression",
        // Re-fired on the pre-fix build, then AUTO_UPGRADEd to the fixed build.
        "timer-refire-upgraded-mid-flight",
      ]) {
        const fixture = JSON.parse(
          await readFile(
            new URL(
              `../replay-histories/synthetic-airi-${name}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ) as { workflowId: string; history: unknown };
        await harness.replay(fixture.history, fixture.workflowId);
      }
    });

    it("replays captured histories from before in-order button taps", async () => {
      // The old build folded the taps into the newest turn and superseded a
      // tap's preparation retry; replay must keep those histories' commands.
      for (const name of ["burst", "retry"]) {
        const fixture = JSON.parse(
          await readFile(
            new URL(
              `../replay-histories/synthetic-airi-button-tap-${name}-before-in-order-button-taps.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ) as { workflowId: string; history: unknown };
        await harness.replay(fixture.history, fixture.workflowId);
      }
    });

    it("executes and replays a completed synthetic turn", async () => {
      let prepareCalls = 0;
      const receipts: AiriConversationTurnDisposition[] = [];
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            prepareCalls++;
            return prepared();
          },
          [AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY]: async (
            receipt: AiriConversationTurnDisposition,
          ) => {
            receipts.push(receipt);
          },
        }),
        assert: async (handle) => {
          const state = await queryUntil(
            handle,
            (state) => state.lastExecutionStatus === "completed",
          );
          assert.equal(state.lastProcessedMessageId, turn.messageId);
          assert.equal(prepareCalls, 1);
          assert.equal(receipts[0]?.status, "completed");
        },
      });
    });

    it("processes one richer revision of an already seen message and ignores its retry", async () => {
      let prepareCalls = 0;
      const recovered = { ...turn, messageRecoveryRevision: "a".repeat(64) };
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            prepareCalls++;
            return prepared();
          },
        }),
        assert: async (handle) => {
          await queryUntil(
            handle,
            (state) => state.lastExecutionStatus === "completed",
          );
          assert.equal(prepareCalls, 1);
          await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, recovered);
          await queryUntil(handle, () => prepareCalls === 2);
          await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, recovered);
          await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, turn);
          await queryUntil(
            handle,
            (state) => state.lastExecutionStatus === "completed",
          );
          assert.equal(prepareCalls, 2);
        },
      });
    });

    it("keeps richer revisions and adjacent typed signals in order without coalescing either away", async () => {
      const recovered = { ...turn, messageRecoveryRevision: "a".repeat(64) };
      const secondRevision = {
        ...turn,
        messageRecoveryRevision: "b".repeat(64),
      };
      const burst = [
        { ...turn, messageId: "typed-before-recovery" },
        recovered,
        { ...turn, messageId: "typed-after-recovery" },
        secondRevision,
      ];
      const preparedKeys: string[] = [];
      const receipts: AiriConversationTurnDisposition[] = [];
      let releaseFirst!: () => void;
      const firstPrepare = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      try {
        await harness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input,
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
              request: AiriConversationTurnSignal,
            ) => {
              preparedKeys.push(
                request.messageRecoveryRevision || request.messageId,
              );
              if (preparedKeys.length === 1) await firstPrepare;
              return prepared(request);
            },
            [AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY]: async (
              receipt: AiriConversationTurnDisposition,
            ) => {
              receipts.push(receipt);
            },
          }),
          assert: async (handle) => {
            await queryUntil(handle, () => preparedKeys.length === 1);
            for (const signal of [...burst, recovered])
              await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, signal);
            await queryUntil(
              handle,
              (state) => state.pendingTurns === burst.length,
            );
            releaseFirst();
            await queryUntil(
              handle,
              (state) => state.status === "idle" && state.pendingTurns === 0,
              60_000,
            );
            assert.deepEqual(preparedKeys, [
              turn.messageId,
              "typed-before-recovery",
              "a".repeat(64),
              "typed-after-recovery",
              "b".repeat(64),
            ]);
            assert.deepEqual(
              receipts.filter((receipt) => receipt.status === "superseded"),
              [],
            );
          },
        });
      } finally {
        releaseFirst();
      }
    });

    it("does not clear an active follow-up timer when a richer revision is admitted", async () => {
      const activeTimer = {
        ...timer,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      let preparationStarted = false;
      let releasePreparation!: () => void;
      const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      try {
        await harness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input: {
            ...input,
            initialTurn: null,
            carryover: { state: { activeTimer } },
          },
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
              request: AiriConversationTurnSignal,
            ) => {
              preparationStarted = true;
              await preparation;
              return prepared(request);
            },
            [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => ({
              timer: activeTimer,
            }),
          }),
          assert: async (handle) => {
            await queryUntil(handle, (state) => Boolean(state.activeTimer));
            await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, {
              ...turn,
              messageRecoveryRevision: "a".repeat(64),
            });
            const during = await queryUntil(handle, () => preparationStarted);
            releasePreparation();
            assert.deepEqual(during.activeTimer, activeTimer);
            const after = await queryUntil(
              handle,
              (state) => state.lastExecutionStatus === "completed",
            );
            assert.deepEqual(after.activeTimer, activeTimer);
          },
        });
      } finally {
        releasePreparation();
      }
    });

    it("preserves an unavailable turn's timer and adjacent normal signals", async () => {
      const activeTimer = {
        ...timer,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      const unavailable = { ...turn, whatsappMessageContentUnavailable: true };
      const burst = [
        { ...turn, messageId: "typed-before-unavailable" },
        { ...unavailable, messageId: "unavailable-2" },
        { ...turn, messageId: "typed-after-unavailable" },
      ];
      const preparedTurns: AiriConversationTurnSignal[] = [];
      let releaseFirst!: () => void;
      const firstPrepare = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          initialTurn: null,
          carryover: { state: { activeTimer } },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            preparedTurns.push(request);
            if (preparedTurns.length === 1) await firstPrepare;
            return prepared(request);
          },
        }),
        assert: async (handle) => {
          let during: AiriConversationRuntimeState;
          try {
            await handle.signal(
              AIRI_CONVERSATION_INGEST_TURN_SIGNAL,
              unavailable,
            );
            during = await queryUntil(handle, () => preparedTurns.length === 1);
            for (const signal of burst)
              await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, signal);
            await queryUntil(
              handle,
              (state) => state.pendingTurns === burst.length,
            );
          } finally {
            releaseFirst();
          }
          const after = await queryUntil(
            handle,
            (state) => state.status === "idle" && state.pendingTurns === 0,
            60_000,
          );
          assert.deepEqual(
            preparedTurns.map((item) => item.messageId),
            [turn.messageId, ...burst.map((item) => item.messageId)],
          );
          assert.deepEqual(during.activeTimer, activeTimer);
          assert.equal(
            after.turnRecovery?.recentDispositions.some(
              (receipt) => receipt.status === "superseded",
            ),
            false,
          );
          assert.equal(
            (preparedTurns[0] as typeof unavailable)
              .whatsappMessageContentUnavailable,
            true,
          );
        },
      });
    });

    for (const [kind, protectedTurn] of [
      [
        "a richer revision",
        { ...turn, messageRecoveryRevision: "a".repeat(64) },
      ],
      [
        "an unavailable turn",
        { ...turn, whatsappMessageContentUnavailable: true },
      ],
    ] as const)
      it(`does not supersede an unrelated normal preparation retry with ${kind}`, async () => {
        const normalRetry = { ...turn, messageId: "typed-retry" };
        const preparedKeys: string[] = [];
        await harness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input: {
            ...input,
            initialTurn: protectedTurn,
            carryover: {
              turnLifecycle: {
                version: 1,
                recentDispositions: [],
                retries: [
                  {
                    turn: normalRetry,
                    stage: "prepare",
                    attempt: 1,
                    dueAtMs: 0,
                  },
                ],
              },
            },
          },
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
              request: AiriConversationTurnSignal,
            ) => {
              preparedKeys.push(
                request.messageRecoveryRevision || request.messageId,
              );
              return prepared(request);
            },
          }),
          assert: async (handle) => {
            const state = await queryUntil(
              handle,
              (state) =>
                state.status === "idle" &&
                state.lastExecutionStatus === "completed",
              60_000,
            );
            assert.deepEqual(
              [...preparedKeys].sort(),
              [
                "messageRecoveryRevision" in protectedTurn
                  ? protectedTurn.messageRecoveryRevision
                  : protectedTurn.messageId,
                "typed-retry",
              ].sort(),
            );
            assert.equal(
              state.turnRecovery?.recentDispositions.some(
                (receipt) => receipt.status === "superseded",
              ),
              false,
            );
          },
        });
      });

    it("retains unknown preparation without acknowledging or blindly retrying it", async () => {
      let prepareCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            prepareCalls++;
            throw new Error("Synthetic preparation outcome is unknown");
          },
        }),
        assert: async (handle) => {
          const state = await queryUntil(
            handle,
            (state) =>
              state.lastExecutionStatus === "failed" &&
              state.activeMessageId === null,
          );
          assert.equal(state.lastProcessedMessageId, null);
          assert.equal(
            state.turnRecovery?.recentDispositions[0]?.status,
            "outcome_unknown",
          );
          assert.deepEqual(state.turnRecovery?.pendingRetries, []);
          assert.equal(
            "textPreview" in state.turnRecovery!.recentDispositions[0].turn,
            false,
          );
          await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, turn);
          const duplicateState =
            await handle.query<AiriConversationRuntimeState>(
              AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
            );
          assert.equal(duplicateState.pendingTurns, 0);
          assert.equal(duplicateState.activeMessageId, null);
          assert.equal(prepareCalls, 1);
        },
      });
    });

    it("durably retries a typed preflight failure that never started preparation", async () => {
      let prepareCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            if (++prepareCalls === 1)
              throw ApplicationFailure.create({
                message: "Synthetic preflight storage outage",
                type: AIRI_TURN_PREPARATION_NOT_STARTED,
              });
            return prepared();
          },
        }),
        assert: async (handle) => {
          const failed = await queryUntil(
            handle,
            (state) => state.turnRecovery?.pendingRetries.length === 1,
          );
          assert.equal(failed.lastProcessedMessageId, null);
          const retry = failed.turnRecovery!.pendingRetries[0];
          assert.equal(retry.status, "retryable");
          assert.equal(retry.stage, "prepare");
          assertBoundedRetry(retry.nextAttemptAt!, retry.updatedAt);
          const recovered = await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === turn.messageId,
          );
          assert.equal(prepareCalls, 2);
          assert.deepEqual(recovered.turnRecovery?.pendingRetries, []);
          assert.equal(
            recovered.turnRecovery?.recentDispositions[0]?.status,
            "completed",
          );
        },
      });
    });

    it("treats a returned HTTP 503 failure as unknown instead of processed", async () => {
      let planCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () =>
            prepared(turn, {
              outcome: {
                executionStatus: "failed",
                responseStatus: 503,
                skippedConcurrent: false,
              },
            }),
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
            planCalls++;
            return { timer: null };
          },
        }),
        assert: async (handle) => {
          const state = await queryUntil(
            handle,
            (state) =>
              state.lastExecutionStatus === "failed" &&
              state.activeMessageId === null,
          );
          assert.equal(state.lastProcessedMessageId, null);
          assert.equal(
            state.turnRecovery?.recentDispositions[0]?.status,
            "outcome_unknown",
          );
          assert.deepEqual(state.turnRecovery?.pendingRetries, []);
          // Only the read-only timer recovery plans; the turn stays unprocessed.
          assert.equal(planCalls, 1);
        },
      });
    });

    it("retains and later retries the exact timer after activity retries exhaust", async () => {
      const builtTimers: AiriConversationTimerDescriptor[] = [];
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: timerInput,
        activities: activities({
          [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: async (
            candidate: AiriConversationTimerDescriptor,
          ) => {
            builtTimers.push(candidate);
            if (builtTimers.length <= 3)
              throw new Error("Synthetic timer storage outage");
            return {
              turn: null,
              timer: null,
              reason: "Timer eligibility rechecked",
            };
          },
        }),
        assert: async (handle) => {
          const failed = await queryUntil(handle, (state) =>
            Boolean(state.timerPreparationRetry),
          );
          assert.equal(builtTimers.length, 3);
          assert.deepEqual(failed.activeTimer, timer);
          assert.deepEqual(failed.timerPreparationRetry?.timer, timer);
          assert.equal(failed.lastProcessedMessageId, null);
          assertBoundedRetry(
            failed.timerPreparationRetry!.nextAttemptAt,
            failed.updatedAt,
          );
          const recovered = await queryUntil(
            handle,
            (state) => state.lastExecutionStatus === "completed",
          );
          assert.equal(builtTimers.length, 4);
          for (const candidate of builtTimers)
            assert.deepEqual(candidate, timer);
          assert.equal(recovered.activeTimer, null);
          assert.equal(recovered.timerPreparationRetry, null);
        },
      });
    });

    it("invalidates an old timer retry when a newer inbound arrives during backoff", async () => {
      let buildCalls = 0;
      const newerTurn = { ...turn, messageId: "inbound-2" };
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: timerInput,
        activities: activities({
          [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: async () => {
            buildCalls++;
            throw new Error("Synthetic timer storage outage");
          },
        }),
        assert: async (handle) => {
          const failed = await queryUntil(handle, (state) =>
            Boolean(state.timerPreparationRetry),
          );
          const oldRetryAt = Date.parse(
            failed.timerPreparationRetry!.nextAttemptAt,
          );
          await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, newerTurn);
          const state = await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === newerTurn.messageId,
          );
          assert.equal(state.activeTimer, null);
          assert.equal(state.timerPreparationRetry, null);
          await delay(Math.max(0, oldRetryAt - Date.now()) + 100);
          await handle.query(AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY);
          assert.equal(buildCalls, 3);
        },
      });
    });

    it("does not restore a stale timer when inbound arrives while its activity fails", async () => {
      let buildCalls = 0;
      let releaseBuild!: () => void;
      const firstBuild = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      const newerTurn = { ...turn, messageId: "inbound-during-build" };
      try {
        await harness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input: timerInput,
          activities: activities({
            [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: async () => {
              if (++buildCalls === 1) await firstBuild;
              throw new Error("Synthetic timer storage outage");
            },
          }),
          assert: async (handle) => {
            await queryUntil(handle, () => buildCalls === 1);
            await handle.signal(
              AIRI_CONVERSATION_INGEST_TURN_SIGNAL,
              newerTurn,
            );
            await queryUntil(handle, (state) => state.pendingTurns === 1);
            releaseBuild();
            const state = await queryUntil(
              handle,
              (state) => state.lastProcessedMessageId === newerTurn.messageId,
            );
            assert.equal(buildCalls, 3);
            assert.equal(state.activeTimer, null);
            assert.equal(state.timerPreparationRetry, null);
          },
        });
      } finally {
        releaseBuild();
      }
    });

    for (const failureType of [
      AIRI_OUTBOUND_PREPARATION_FAILED,
      AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE,
    ]) {
      it(`retries proven-unsent delivery from the same checkpoint before planning a follow-up (${failureType})`, async () => {
        let prepareCalls = 0;
        let deliveryCalls = 0;
        let acceptedSends = 0;
        let planCalls = 0;
        const request = {
          deliveryKey: "known-unsent-delivery",
          reservedMessageId: "same-outbound-owner",
          context: { content: "Prepared once" },
        };
        await harness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input,
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
              prepareCalls++;
              return prepared(turn, { pendingDelivery: request });
            },
            [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async (
              actual: typeof request,
            ) => {
              assert.equal(actual.deliveryKey, request.deliveryKey);
              assert.equal(actual.reservedMessageId, request.reservedMessageId);
              assert.deepEqual(actual.context, request.context);
              if (++deliveryCalls <= 3)
                throw ApplicationFailure.retryable(
                  "Header not available before provider submission",
                  failureType,
                );
              acceptedSends++;
              return {
                deliveryKey: request.deliveryKey,
                outboundMessageId: request.reservedMessageId,
                outboundDate: new Date().toISOString(),
                classification: "sent",
              };
            },
            [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
              planCalls++;
              assert.equal(acceptedSends, 1);
              return { timer: null };
            },
          }),
          assert: async (handle) => {
            const retrying = await queryUntil(
              handle,
              (state) =>
                state.turnRecovery?.pendingRetries.length === 1 ||
                state.turnRecovery?.recentDispositions.at(-1)?.status ===
                  "outcome_unknown",
            );
            assert.equal(
              retrying.turnRecovery?.pendingRetries[0]?.stage,
              "delivery",
            );
            assert.equal(retrying.activeTimer, null);
            assert.equal(planCalls, 0);
            await queryUntil(
              handle,
              (state) => state.lastProcessedMessageId === turn.messageId,
            );
            assert.equal(prepareCalls, 1);
            assert.equal(deliveryCalls, 4);
            assert.equal(acceptedSends, 1);
            assert.equal(planCalls, 1);
            await harness.replay(
              await handle.fetchHistory(),
              handle.workflowId,
            );
          },
        });
      });
    }

    it("preserves capacity-deferred preparation beyond ordinary failure limits with a durable timer", async () => {
      const capacityHarness = await createLocalTemporalWorkflowHarness(
        workflowsPath,
        { suggestContinueAsNewAfterEvents: 10 },
      );
      let prepareCalls = 0;
      try {
        await capacityHarness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input: {
            ...input,
            initialTurn: null,
            carryover: {
              turnLifecycle: {
                version: 1,
                retries: [
                  {
                    turn,
                    stage: "prepare",
                    attempt: 4,
                    dueAtMs: Date.now() - 1,
                  },
                ],
                recentDispositions: [],
              },
            },
          },
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
              prepareCalls++;
              if (prepareCalls > 1) return prepared();
              throw ApplicationFailure.nonRetryable(
                "Company processing capacity limited",
                "AIRI_COMPANY_CAPACITY_DEFERRED",
              );
            },
          }),
          assert: async (handle) => {
            const deferred = await queryUntil(
              handle,
              (state) =>
                state.activeMessageId === null &&
                Boolean(state.turnRecovery?.recentDispositions.length),
            );
            const disposition =
              deferred.turnRecovery!.recentDispositions.at(-1)!;
            assert.equal(disposition.status, "retryable");
            assert.equal(disposition.attempt, 4);
            assert.equal(deferred.turnRecovery!.pendingRetries.length, 1);
            assert.ok(
              new Date(disposition.nextAttemptAt!).getTime() -
                new Date(disposition.updatedAt).getTime() >=
                60_000,
            );
            const calls = prepareCalls;
            await delay(100);
            assert.equal(prepareCalls, calls);
            const original = handle.client.getHandle(
              handle.workflowId,
              handle.firstExecutionRunId,
            );
            let continued: AiriConversationWorkflowInput | undefined;
            const deadline = Date.now() + 10_000;
            while (!continued && Date.now() < deadline) {
              const history = await original.fetchHistory();
              const payload = history.events?.find(
                (event) => event.workflowExecutionContinuedAsNewEventAttributes,
              )?.workflowExecutionContinuedAsNewEventAttributes?.input
                ?.payloads?.[0];
              if (payload)
                continued =
                  defaultPayloadConverter.fromPayload<AiriConversationWorkflowInput>(
                    payload,
                  );
              else await delay(25);
            }
            assert.ok(
              continued,
              "Capacity retry must survive a real ContinueAsNew",
            );
            assert.equal(
              continued.carryover?.turnLifecycle?.retries[0]?.attempt,
              4,
            );
            assert.equal(
              continued.carryover?.turnLifecycle?.retries[0]?.turn.messageId,
              turn.messageId,
            );
            await capacityHarness.replay(
              await original.fetchHistory(),
              handle.workflowId,
            );
            await queryUntil(
              handle,
              (state) => state.lastProcessedMessageId === turn.messageId,
              75_000,
            );
            assert.equal(prepareCalls, 2);
            await capacityHarness.replay(
              await handle.fetchHistory(),
              handle.workflowId,
            );
          },
        });
      } finally {
        await capacityHarness.close();
      }
    });

    it("exhausts known-unsent delivery retries without pretending to send or prepare again", async () => {
      let prepareCalls = 0;
      let deliveryCalls = 0;
      const checkpoint = prepared(turn, {
        pendingDelivery: {
          deliveryKey: "exhausted-unsent",
          reservedMessageId: "reserved-owner",
          context: {},
        },
      });
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          initialTurn: null,
          carryover: {
            turnLifecycle: {
              version: 1,
              retries: [
                {
                  turn,
                  stage: "delivery",
                  attempt: 4,
                  dueAtMs: Date.now() - 1,
                  process: checkpoint,
                },
              ],
              recentDispositions: [],
            },
          },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            prepareCalls++;
            return prepared();
          },
          [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async () => {
            deliveryCalls++;
            throw ApplicationFailure.retryable(
              "Header unavailable before provider submission",
              AIRI_OUTBOUND_PREPARATION_FAILED,
            );
          },
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => ({
            timer: null,
          }),
        }),
        assert: async (handle) => {
          const finished = await queryUntil(
            handle,
            (state) =>
              state.activeMessageId === null &&
              Boolean(state.turnRecovery?.recentDispositions.length),
          );
          assert.equal(
            finished.turnRecovery?.recentDispositions.at(-1)?.status,
            "terminal",
          );
          assert.equal(
            finished.turnRecovery?.recentDispositions.at(-1)?.stage,
            "delivery",
          );
          assert.deepEqual(finished.turnRecovery?.pendingRetries, []);
          assert.equal(finished.activeTimer, null);
          assert.equal(prepareCalls, 0);
          assert.equal(deliveryCalls, 3);
          await harness.replay(await handle.fetchHistory(), handle.workflowId);
        },
      });
    });

    it("a new inbound supersedes a proven-unsent prepared follow-up without sending it", async () => {
      const newer = { ...turn, messageId: "newer-inbound" };
      let deliveryCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...input,
          initialTurn: newer,
          carryover: {
            turnLifecycle: {
              version: 1,
              retries: [
                {
                  turn,
                  stage: "delivery",
                  deliveryNotAttempted: true,
                  attempt: 1,
                  dueAtMs: Date.now() + 60_000,
                  process: prepared(turn, {
                    pendingDelivery: {
                      deliveryKey: "superseded-follow-up",
                      reservedMessageId: "unsent-owner",
                      context: {},
                    },
                  }),
                },
              ],
              recentDispositions: [],
            },
          },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () =>
            prepared(newer),
          [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async () => {
            deliveryCalls++;
            throw new Error("Stale follow-up must not send");
          },
        }),
        assert: async (handle) => {
          const state = await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === newer.messageId,
          );
          assert.deepEqual(state.turnRecovery?.pendingRetries, []);
          assert.equal(
            state.turnRecovery?.recentDispositions.find(
              (item) => item.turn.messageId === turn.messageId,
            )?.status,
            "superseded",
          );
          assert.equal(deliveryCalls, 0);
          await harness.replay(await handle.fetchHistory(), handle.workflowId);
        },
      });
    });

    it("retries timer planning without preparing or delivering the turn twice", async () => {
      let prepareCalls = 0;
      let deliveryCalls = 0;
      let planCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            prepareCalls++;
            return prepared(turn, {
              pendingDelivery: {
                deliveryKey: "synthetic-delivery",
                reservedMessageId: "outbound-1",
                context: {},
              },
            });
          },
          [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async () => {
            deliveryCalls++;
            return {
              deliveryKey: "synthetic-delivery",
              outboundMessageId: "outbound-1",
              outboundDate: new Date().toISOString(),
              classification: "sent",
            };
          },
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
            if (++planCalls <= 3)
              throw new Error("Synthetic planning storage outage");
            return { timer: null };
          },
        }),
        assert: async (handle) => {
          const failed = await queryUntil(
            handle,
            (state) => state.turnRecovery?.pendingRetries.length === 1,
          );
          assert.equal(
            failed.turnRecovery?.pendingRetries[0]?.stage,
            "timer_plan",
          );
          assert.equal(failed.lastProcessedMessageId, null);
          await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === turn.messageId,
          );
          assert.equal(prepareCalls, 1);
          assert.equal(deliveryCalls, 1);
          assert.equal(planCalls, 4);
        },
      });
    });

    it("continues as new with retry checkpoints, timer retry identity, and unresolved dispositions", async () => {
      const rotatingHarness = await createLocalTemporalWorkflowHarness(
        workflowsPath,
        { suggestContinueAsNewAfterEvents: 10 },
      );
      const future = new Date(Date.now() + 60_000).toISOString();
      const pendingTimer = { ...timer, dueAt: future };
      const checkpoint = prepared(turn, {
        pendingDelivery: {
          deliveryKey: "already-sent",
          reservedMessageId: "outbound-1",
          context: { text: "Private prepared response" },
        },
      });
      const unresolved: AiriConversationTurnDisposition = {
        turn: {
          workspaceId: turn.workspaceId,
          conversationId: turn.conversationId,
          messageId: "earlier-unknown",
        },
        stage: "prepare",
        status: "outcome_unknown",
        attempt: 1,
        updatedAt: new Date().toISOString(),
        error: "Earlier ambiguous failure",
        nextAttemptAt: null,
      };
      let prepareCalls = 0;
      let deliveryCalls = 0;
      let planCalls = 0;
      try {
        await rotatingHarness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input: {
            ...input,
            initialTurn: null,
            carryover: {
              state: {
                activeTimer: pendingTimer,
                timerPreparationRetry: {
                  timer: pendingTimer,
                  attempt: 2,
                  nextAttemptAt: future,
                  lastError: "Earlier timer storage outage",
                },
              },
              turnLifecycle: {
                version: 1,
                recentDispositions: [unresolved],
                retries: [
                  {
                    turn,
                    stage: "timer_plan",
                    attempt: 0,
                    dueAtMs: Date.now() - 1,
                    process: checkpoint,
                  },
                ],
              },
            },
          },
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
              prepareCalls++;
              return prepared();
            },
            [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: async () => {
              deliveryCalls++;
              throw new Error("Should already be sent");
            },
            [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
              if (++planCalls <= 3)
                throw new Error("Synthetic planning storage outage");
              return { timer: pendingTimer };
            },
          }),
          assert: async (handle) => {
            await queryUntil(
              handle,
              (state) => state.turnRecovery?.pendingRetries.length === 1,
            );
            const original = handle.client.getHandle(
              handle.workflowId,
              handle.firstExecutionRunId,
            );
            let continuedInput: AiriConversationWorkflowInput | undefined;
            const deadline = Date.now() + 10_000;
            while (!continuedInput && Date.now() < deadline) {
              const history = await original.fetchHistory();
              const payload = history.events?.find(
                (event) => event.workflowExecutionContinuedAsNewEventAttributes,
              )?.workflowExecutionContinuedAsNewEventAttributes?.input
                ?.payloads?.[0];
              if (payload)
                continuedInput =
                  defaultPayloadConverter.fromPayload<AiriConversationWorkflowInput>(
                    payload,
                  );
              else await delay(25);
            }
            assert.ok(
              continuedInput,
              "Expected a real WorkflowExecutionContinuedAsNew history event",
            );
            const carried = continuedInput.carryover!;
            assert.deepEqual(
              carried.turnLifecycle?.retries[0]?.process,
              checkpoint,
            );
            assert.equal(
              carried.turnLifecycle?.retries[0]?.stage,
              "timer_plan",
            );
            assert.ok(
              carried.turnLifecycle?.recentDispositions.some(
                (item) =>
                  item.turn.messageId === unresolved.turn.messageId &&
                  item.status === "outcome_unknown",
              ),
            );
            assert.deepEqual(
              carried.state?.timerPreparationRetry?.timer,
              pendingTimer,
            );
            const recovered = await queryUntil(
              handle,
              (state) => state.lastProcessedMessageId === turn.messageId,
            );
            assert.ok(
              recovered.turnRecovery?.recentDispositions.some(
                (item) =>
                  item.turn.messageId === unresolved.turn.messageId &&
                  item.status === "outcome_unknown",
              ),
            );
            assert.equal(prepareCalls, 0);
            assert.equal(deliveryCalls, 0);
            assert.equal(planCalls, 4);
            assert.equal(
              JSON.stringify(recovered).includes("Private prepared response"),
              false,
            );
          },
        });
      } finally {
        await rotatingHarness.close();
      }
    });

    it("re-plans the pending timer after inbound turns fail without a retry", async () => {
      const pendingTimer = {
        ...timer,
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const terminalTurn = { ...turn, messageId: "inbound-terminal" };
      let prepareCalls = 0;
      let planCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: {
          ...timerInput,
          carryover: { state: { activeTimer: pendingTimer } },
        },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            prepareCalls++;
            if (request.messageId === turn.messageId)
              throw new Error("Synthetic preparation outcome is unknown");
            return prepared(request, {
              outcome: {
                executionStatus: "failed",
                responseStatus: 422,
                skippedConcurrent: false,
              },
            });
          },
          // Neither failed turn consumed the wait, so storage still plans it.
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
            planCalls++;
            return {
              timer: pendingTimer,
              reason: "pending_post_action_condition",
            };
          },
        }),
        assert: async (handle) => {
          await queryUntil(handle, (state) => !!state.activeTimer);
          for (const [inbound, status] of [
            [turn, "outcome_unknown"],
            [terminalTurn, "terminal"],
          ] as const) {
            await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, inbound);
            const state = await queryUntil(
              handle,
              (state) =>
                state.turnRecovery?.recentDispositions.at(-1)?.turn
                  .messageId === inbound.messageId &&
                state.activeMessageId === null,
            );
            assert.equal(
              state.turnRecovery?.recentDispositions.at(-1)?.status,
              status,
            );
            assert.deepEqual(state.turnRecovery?.pendingRetries, []);
            assert.equal(state.lastProcessedMessageId, null);
            assert.deepEqual(state.activeTimer, pendingTimer);
            assert.match(
              state.lastExecutionError || "",
              /; timer recovered: pending_post_action_condition$/,
            );
          }
          assert.equal(prepareCalls, 2);
          assert.equal(planCalls, 2);
        },
      });
    });

    it("keeps the turn failure when re-planning its timer also fails", async () => {
      let planCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input,
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            throw new Error("Synthetic preparation outcome is unknown");
          },
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
            planCalls++;
            throw new Error("Synthetic planning storage outage");
          },
        }),
        assert: async (handle) => {
          const state = await queryUntil(
            handle,
            (state) =>
              state.lastExecutionStatus === "failed" &&
              state.activeMessageId === null,
            20_000,
          );
          assert.equal(planCalls, 3);
          assert.equal(state.activeTimer, null);
          assert.equal(state.lastProcessedMessageId, null);
          assert.equal(
            state.turnRecovery?.recentDispositions[0]?.status,
            "outcome_unknown",
          );
          assert.match(
            state.lastExecutionError || "",
            /^Activity task failed; timer recovery failed: /,
          );
        },
      });
    });

    it("does not re-fire a timer whose own turn left its wait unchanged", async () => {
      let buildCalls = 0;
      let prepareCalls = 0;
      let planCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: timerInput,
        activities: activities({
          [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: async () =>
            ++buildCalls > MAX_TIMER_FIRES
              ? { turn: null, reason: "stale_pending_condition_state" }
              : { turn: timerTurn, reason: "timer_turn_ready" },
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            prepareCalls++;
            return prepared(request, { outcome: skippedTimerTurnOutcome });
          },
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
            planCalls++;
            return { timer, reason: "pending_post_action_condition" };
          },
        }),
        assert: async (handle) => {
          await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === timerTurn.messageId,
          );
          await delay(1_000);
          const state = await handle.query<AiriConversationRuntimeState>(
            AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
          );
          assert.equal(buildCalls, 1);
          assert.equal(prepareCalls, 1);
          assert.equal(planCalls, 1);
          assert.equal(state.activeTimer, null);
          assert.deepEqual(state.lastFiredTimer, timer);
          assert.equal(state.status, "idle");
        },
      });
    });

    it("arms the next wait's timer after a timer turn advances the scenario", async () => {
      const waitStartedAt = new Date().toISOString();
      const nextTimer: AiriConversationTimerDescriptor = {
        ...timer,
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        conditionNodeId: "condition-2",
        sourceActionNodeId: "action-2",
        linkedConditionId: "condition-2",
        waitStartedAt,
        pendingLastOutboundMessageId: "outbound-2",
      };
      let buildCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: timerInput,
        activities: activities({
          [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: async () => {
            buildCalls++;
            return { turn: timerTurn, reason: "timer_turn_ready" };
          },
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => ({
            timer: nextTimer,
            reason: "pending_post_action_condition",
          }),
        }),
        assert: async (handle) => {
          const state = await queryUntil(
            handle,
            (state) => state.lastProcessedMessageId === timerTurn.messageId,
          );
          assert.deepEqual(state.activeTimer, nextTimer);
          assert.equal(
            state.activeTimerReason,
            "pending_post_action_condition",
          );
          assert.equal(buildCalls, 1);
        },
      });
    });

    it("does not blindly re-fire a timer whose own turn has an unknown outcome", async () => {
      let buildCalls = 0;
      let prepareCalls = 0;
      let planCalls = 0;
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: timerInput,
        activities: activities({
          [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: async () =>
            ++buildCalls > MAX_TIMER_FIRES
              ? { turn: null, reason: "stale_pending_condition_state" }
              : { turn: timerTurn, reason: "timer_turn_ready" },
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async () => {
            prepareCalls++;
            throw new Error("Synthetic timer turn outcome is unknown");
          },
          [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => {
            planCalls++;
            return { timer, reason: "pending_post_action_condition" };
          },
        }),
        assert: async (handle) => {
          await queryUntil(
            handle,
            (state) =>
              state.turnRecovery?.recentDispositions.at(-1)?.turn.messageId ===
                timerTurn.messageId && state.activeMessageId === null,
          );
          await delay(1_000);
          const state = await handle.query<AiriConversationRuntimeState>(
            AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
          );
          assert.equal(buildCalls, 1);
          assert.equal(prepareCalls, 1);
          assert.equal(planCalls, 1);
          assert.equal(state.activeTimer, null);
          assert.equal(
            state.turnRecovery?.recentDispositions.at(-1)?.status,
            "outcome_unknown",
          );
        },
      });
    });

    it("runs rapid button taps in order and coalesces only the typed turns between them", async () => {
      const burst = [
        buttonTap("tap-1"),
        buttonTap("tap-2"),
        { ...turn, messageId: "typed-2" },
        { ...turn, messageId: "typed-3" },
        buttonTap("tap-3"),
      ];
      const preparedIds: string[] = [];
      const receipts: AiriConversationTurnDisposition[] = [];
      let releaseFirst!: () => void;
      const firstPrepare = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      try {
        await harness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input,
          activities: activities({
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
              request: AiriConversationTurnSignal,
            ) => {
              preparedIds.push(request.messageId);
              if (request.messageId === turn.messageId) await firstPrepare;
              return prepared(request);
            },
            [AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY]: async (
              receipt: AiriConversationTurnDisposition,
            ) => {
              receipts.push(receipt);
            },
          }),
          assert: async (handle) => {
            await queryUntil(handle, () => preparedIds.length === 1);
            for (const item of burst)
              await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, item);
            await queryUntil(
              handle,
              (state) => state.pendingTurns === burst.length,
            );
            releaseFirst();
            await queryUntil(
              handle,
              (state) =>
                state.lastProcessedMessageId === "tap-3" &&
                state.status === "idle",
              60_000,
            );
            assert.deepEqual(preparedIds, [
              turn.messageId,
              "tap-1",
              "tap-2",
              "typed-3",
              "tap-3",
            ]);
            assert.deepEqual(
              receipts
                .filter((receipt) => receipt.status === "superseded")
                .map((receipt) => [
                  receipt.turn.messageId,
                  receipt.supersededByMessageId,
                ]),
              [["typed-2", "typed-3"]],
            );
          },
        });
      } finally {
        releaseFirst();
      }
    });

    it("runs a button tap's preparation retry before the turns that arrive during its backoff", async () => {
      const tap = buttonTap("tap-1");
      const typedTurn = { ...turn, messageId: "typed-during-backoff" };
      const laterTap = buttonTap("tap-2");
      const preparedIds: string[] = [];
      await harness.run({
        workflowType: AIRI_CONVERSATION_WORKFLOW,
        input: { ...input, initialTurn: tap },
        activities: activities({
          [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
            request: AiriConversationTurnSignal,
          ) => {
            preparedIds.push(request.messageId);
            if (preparedIds.length === 1)
              throw ApplicationFailure.create({
                message: "Synthetic preflight storage outage",
                type: AIRI_TURN_PREPARATION_NOT_STARTED,
              });
            return prepared(request);
          },
        }),
        assert: async (handle) => {
          await queryUntil(
            handle,
            (state) => state.turnRecovery?.pendingRetries.length === 1,
          );
          await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, typedTurn);
          await handle.signal(AIRI_CONVERSATION_INGEST_TURN_SIGNAL, laterTap);
          const state = await queryUntil(
            handle,
            (state) =>
              state.lastProcessedMessageId === laterTap.messageId &&
              state.activeMessageId === null,
            60_000,
          );
          // The tap answers its wait first; the typed turn and the later tap
          // follow in order, so one wait can't fire two routes.
          assert.deepEqual(preparedIds, [
            tap.messageId,
            tap.messageId,
            typedTurn.messageId,
            laterTap.messageId,
          ]);
          assert.deepEqual(state.turnRecovery?.pendingRetries, []);
          assert.deepEqual(
            state.turnRecovery?.recentDispositions.map((item) => [
              item.turn.messageId,
              item.status,
            ]),
            [
              [tap.messageId, "completed"],
              [typedTurn.messageId, "completed"],
              [laterTap.messageId, "completed"],
            ],
          );
        },
      });
    });

    it("carries the fired timer through continue-as-new so its turn cannot re-arm it", async () => {
      const rotatingHarness = await createLocalTemporalWorkflowHarness(
        workflowsPath,
        { suggestContinueAsNewAfterEvents: 10 },
      );
      let buildCalls = 0;
      let prepareCalls = 0;
      try {
        await rotatingHarness.run({
          workflowType: AIRI_CONVERSATION_WORKFLOW,
          input: timerInput,
          activities: activities({
            [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: async () =>
              ++buildCalls > MAX_TIMER_FIRES
                ? { turn: null, reason: "stale_pending_condition_state" }
                : { turn: timerTurn, reason: "timer_turn_ready" },
            [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: async (
              request: AiriConversationTurnSignal,
            ) => {
              prepareCalls++;
              return prepared(request, { outcome: skippedTimerTurnOutcome });
            },
            [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: async () => ({
              timer,
              reason: "pending_post_action_condition",
            }),
          }),
          assert: async (handle) => {
            await queryUntil(
              handle,
              (state) => state.lastProcessedMessageId === timerTurn.messageId,
            );
            await delay(1_000);
            const state = await handle.query<AiriConversationRuntimeState>(
              AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
            );
            // The fire and its turn ran in different runs of the workflow.
            const original = handle.client.getHandle(
              handle.workflowId,
              handle.firstExecutionRunId,
            );
            const payload = (await original.fetchHistory()).events?.find(
              (event) => event.workflowExecutionContinuedAsNewEventAttributes,
            )?.workflowExecutionContinuedAsNewEventAttributes?.input
              ?.payloads?.[0];
            assert.ok(payload, "The timer fire must end the first run");
            const carried =
              defaultPayloadConverter.fromPayload<AiriConversationWorkflowInput>(
                payload,
              ).carryover;
            assert.deepEqual(
              carried?.pendingTurns?.map((item) => item.messageId),
              [timerTurn.messageId],
            );
            assert.deepEqual(carried?.state?.lastFiredTimer, timer);
            assert.equal(buildCalls, 1);
            assert.equal(prepareCalls, 1);
            assert.equal(state.activeTimer, null);
          },
        });
      } finally {
        await rotatingHarness.close();
      }
    });
  },
);
