import assert from "node:assert/strict";
import test from "node:test";
import type {
  AiriConversationOutboundDeliveryRequest,
  AiriConversationOutboundDeliveryResult,
  AiriConversationPostDeliveryEffect,
} from "@icecore/temporal";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

import {
  executeGenerativeAIDeferredDelivery,
  type GenerativeAIDeferredDeliveryDependencies,
} from "./workflows/airi-conversation-generative-ai";

const command = {
  version: 1 as const,
  kind: "start_generative_ai_scenario" as const,
  workflowId: "scenario-generation:execution-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  executionId: "execution-1",
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "a".repeat(64),
  actionNodeId: "generate-1",
};

const strictDelivery: AiriConversationOutboundDeliveryRequest = {
  deliveryKey: "ack-1",
  reservedMessageId: "reserved-1",
  context: { content: "Creating your video." },
  dispatchPolicy: "at_most_once",
};

const effect: AiriConversationPostDeliveryEffect = {
  kind: "clear_suppressed_state",
  conversationId: "conversation-1",
};

function harness(params: {
  deliveries?: AiriConversationOutboundDeliveryResult[];
  startDetachedWorkflow?: GenerativeAIDeferredDeliveryDependencies["startDetachedWorkflow"];
}) {
  const requests: AiriConversationOutboundDeliveryRequest[] = [];
  const finalizations: unknown[] = [];
  const starts: unknown[] = [];
  const terminals: unknown[] = [];
  const deliveries = [...(params.deliveries || [])];
  const dependencies: GenerativeAIDeferredDeliveryDependencies = {
    deliver: async (request) => {
      requests.push(request);
      const delivery = deliveries.shift();
      assert.ok(delivery, "a delivery result is configured");
      return delivery;
    },
    finalizeEffects: async (input) => {
      finalizations.push(input);
    },
    startDetachedWorkflow:
      params.startDetachedWorkflow ||
      (async (input) => {
        starts.push(input);
      }),
    terminalizeAcceptedExecution: async (input) => {
      terminals.push(input);
    },
  };
  return { dependencies, requests, finalizations, starts, terminals };
}

test("sent acknowledgment finalizes effects once and starts the detached workflow", async () => {
  const delivery = {
    deliveryKey: "ack-1",
    outboundMessageId: "outbound-1",
    outboundDate: "2026-07-30T10:00:01.000Z",
    classification: "sent" as const,
  };
  const { dependencies, requests, finalizations, starts, terminals } = harness({
    deliveries: [delivery],
  });

  await executeGenerativeAIDeferredDelivery({
    command,
    pendingDelivery: {
      ...strictDelivery,
      postDeliveryEffects: [effect],
    },
    postDeliveryEffects: [effect],
    dependencies,
  });

  assert.deepEqual(requests, [strictDelivery]);
  assert.deepEqual(finalizations, [
    {
      delivery,
      effects: [effect],
    },
  ]);
  assert.deepEqual(starts, [
    {
      workflowId: command.workflowId,
      parentClosePolicy: "ABANDON",
      input: command,
    },
  ]);
  assert.deepEqual(terminals, []);
});

test("a silent start launches the detached workflow without any delivery", async () => {
  for (const pendingDelivery of [null, undefined]) {
    const { dependencies, requests, finalizations, starts, terminals } =
      harness({});

    await executeGenerativeAIDeferredDelivery({
      command,
      pendingDelivery,
      dependencies,
    });

    assert.deepEqual(requests, []);
    assert.deepEqual(finalizations, []);
    assert.deepEqual(starts, [
      {
        workflowId: command.workflowId,
        parentClosePolicy: "ABANDON",
        input: command,
      },
    ]);
    assert.deepEqual(terminals, []);
  }
});

test("manual handoff exact-clears without effects or a paid workflow", async () => {
  const { dependencies, finalizations, starts, terminals } = harness({
    deliveries: [
      {
        deliveryKey: "ack-1",
        outboundMessageId: "outbound-1",
        outboundDate: null,
        classification: "skipped",
        skipped: true,
        skipReason: "manual_handoff_active",
      },
    ],
  });

  await executeGenerativeAIDeferredDelivery({
    command,
    pendingDelivery: strictDelivery,
    postDeliveryEffects: [effect],
    dependencies,
  });

  assert.deepEqual(finalizations, []);
  assert.deepEqual(starts, []);
  assert.deepEqual(terminals, [{ command, outcome: "manual_handoff" }]);
});

test("explicit unsent classifications apply Failure without finalizing effects", async () => {
  for (const classification of ["not_attempted", "outcome_unknown"] as const) {
    const { dependencies, finalizations, starts, terminals } = harness({
      deliveries: [
        {
          deliveryKey: "ack-1",
          outboundMessageId: "outbound-1",
          outboundDate: null,
          classification,
        },
      ],
    });

    await executeGenerativeAIDeferredDelivery({
      command,
      pendingDelivery: strictDelivery,
      postDeliveryEffects: [effect],
      dependencies,
    });

    assert.deepEqual(finalizations, []);
    assert.deepEqual(starts, []);
    assert.deepEqual(terminals, [{ command, outcome: "failure" }]);
  }
});

test("unclassified retries reuse one effect-free strict request then finalize once", async () => {
  const sentDelivery = {
    deliveryKey: "ack-1",
    outboundMessageId: "outbound-1",
    outboundDate: "2026-07-30T10:00:01.000Z",
    classification: "sent" as const,
  };
  const { dependencies, requests, finalizations, starts, terminals } = harness({
    deliveries: [
      {
        deliveryKey: "ack-1",
        outboundMessageId: "outbound-1",
        outboundDate: null,
      },
      {
        deliveryKey: "ack-1",
        outboundMessageId: "outbound-1",
        outboundDate: null,
      },
      sentDelivery,
    ],
  });

  await executeGenerativeAIDeferredDelivery({
    command,
    pendingDelivery: {
      ...strictDelivery,
      postDeliveryEffects: [effect],
    },
    postDeliveryEffects: [effect],
    dependencies,
  });

  assert.equal(requests.length, 3);
  assert.deepEqual(requests, [strictDelivery, strictDelivery, strictDelivery]);
  assert.deepEqual(finalizations, [
    {
      delivery: sentDelivery,
      effects: [effect],
    },
  ]);
  assert.equal(starts.length, 1);
  assert.deepEqual(terminals, []);
});

test("exhausted unclassified retries preserve the accepted owner", async () => {
  const { dependencies, requests, finalizations, starts, terminals } = harness({
    deliveries: Array.from({ length: 3 }, () => ({
      deliveryKey: "ack-1",
      outboundMessageId: "outbound-1",
      outboundDate: null,
    })),
  });

  await assert.rejects(
    executeGenerativeAIDeferredDelivery({
      command,
      pendingDelivery: strictDelivery,
      postDeliveryEffects: [effect],
      dependencies,
    }),
    /unclassified/,
  );

  assert.equal(requests.length, 3);
  assert.deepEqual(finalizations, []);
  assert.deepEqual(starts, []);
  assert.deepEqual(terminals, []);
});

test("a non-strict legacy acknowledgment delivery fails before callbacks", async () => {
  for (const pendingDelivery of [
    { ...strictDelivery, dispatchPolicy: "default" as const },
    { ...strictDelivery, dispatchPolicy: undefined },
  ]) {
    const { dependencies, requests, finalizations, starts, terminals } =
      harness({
        deliveries: [],
      });

    await assert.rejects(
      executeGenerativeAIDeferredDelivery({
        command,
        pendingDelivery,
        postDeliveryEffects: [effect],
        dependencies,
      }),
      /at_most_once/,
    );

    assert.deepEqual(requests, []);
    assert.deepEqual(finalizations, []);
    assert.deepEqual(starts, []);
    assert.deepEqual(terminals, []);
  }
});

test("an exact duplicate child start is idempotent while unrelated errors retry", async () => {
  const sentDelivery = {
    deliveryKey: "ack-1",
    outboundMessageId: "outbound-1",
    outboundDate: "2026-07-30T10:00:01.000Z",
    classification: "sent" as const,
  };
  const duplicateHarness = harness({
    deliveries: [sentDelivery],
    startDetachedWorkflow: async () => {
      throw new WorkflowExecutionAlreadyStartedError(
        "already started",
        command.workflowId,
        "airiScenarioGenerativeAIWorkflow",
      );
    },
  });
  await executeGenerativeAIDeferredDelivery({
    command,
    pendingDelivery: strictDelivery,
    postDeliveryEffects: [],
    dependencies: duplicateHarness.dependencies,
  });
  assert.deepEqual(duplicateHarness.terminals, []);

  for (const error of [
    new WorkflowExecutionAlreadyStartedError(
      "different child exists",
      "scenario-generation:different-execution",
      "airiScenarioGenerativeAIWorkflow",
    ),
    new Error("Temporal unavailable"),
  ]) {
    const retryHarness = harness({
      deliveries: [sentDelivery],
      startDetachedWorkflow: async () => {
        throw error;
      },
    });
    await assert.rejects(
      executeGenerativeAIDeferredDelivery({
        command,
        pendingDelivery: strictDelivery,
        postDeliveryEffects: [],
        dependencies: retryHarness.dependencies,
      }),
      error,
    );
  }
});
