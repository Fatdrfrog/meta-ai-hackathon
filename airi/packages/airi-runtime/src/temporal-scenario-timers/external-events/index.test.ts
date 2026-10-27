import assert from "node:assert/strict";
import test from "node:test";
import type { AiriScenarioGenerativeAIResultEvent } from "@icecore/temporal";
import type { AiriScenarioTimerDependencies } from "../dependencies";
import { handleAiriConversationExternalEvent } from "./index";

const event: AiriScenarioGenerativeAIResultEvent = {
  kind: "generative_ai_result",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "execution-1",
  executionId: "execution-1",
  scenarioWorkflowId: "scenario-generation:execution-1",
  videoWorkflowId: null,
  assetId: null,
  terminal: {
    state: "failed",
    code: "generation_preparation_failed",
    attemptToken: null,
  },
};

function host(
  overrides: Partial<AiriScenarioTimerDependencies> = {},
): AiriScenarioTimerDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected host effect");
  };
  return {
    connectDB: async () => undefined,
    loadConversation: unexpected,
    resolveScenariosEnabled: unexpected,
    loadScenario: unexpected,
    findLatestMessageAfter: unexpected,
    findTextMessagesAfter: unexpected,
    findPendingOutbound: unexpected,
    completeLockedScenarioAndPersist: unexpected,
    buildTimerTurnSignal: unexpected,
    generativeAIResult: {
      readOwner: async () => ({ classification: "absent", execution: null }),
      loadAsset: unexpected,
      hydrateOriginalInbound: unexpected,
      captureOutbound: unexpected,
      claimDelivery: unexpected,
      nowIso: () => "2026-09-08T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("the external-event entry point uses the supplied generative result owner", async () => {
  const calls: unknown[] = [];
  const dependencies = host();
  dependencies.connectDB = async () => {
    calls.push("connect");
  };
  dependencies.generativeAIResult.readOwner = async (input) => {
    calls.push(input);
    return { classification: "absent", execution: null };
  };
  assert.deepEqual(
    await handleAiriConversationExternalEvent(event, dependencies),
    {
      handled: true,
      clearTimer: false,
      pendingDelivery: null,
      generativeResultDisposition: "suppressed_stale",
    },
  );
  assert.deepEqual(calls, [
    "connect",
    {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
    },
  ]);
});

test("external-event host failures propagate so the existing activity can retry", async () => {
  const dependencies = host();
  const failure = new Error("owner read unavailable");
  dependencies.generativeAIResult.readOwner = async () => {
    throw failure;
  };
  await assert.rejects(
    handleAiriConversationExternalEvent(event, dependencies),
    (error) => error === failure,
  );
});

test("payment events require and use the supplied authoritative host", async () => {
  const payment = {
    kind: "payment_confirmed" as const, workspaceId: "workspace-1", conversationId: "conversation-1",
    conversionId: "conversion-1", messageId: "confirmed-payment:conversion-1", sourceId: "source-1",
    channel: "whatsapp" as const, messageDate: "2026-09-11T00:00:00.000Z",
  };
  await assert.rejects(handleAiriConversationExternalEvent(payment, host()), /authoritative host/);
  const result = { handled: true, paymentDisposition: "ready" as const };
  assert.equal(await handleAiriConversationExternalEvent(payment, host({
    handleConfirmedPaymentEvent: async input => { assert.equal(input, payment); return result; },
  })), result);
});
