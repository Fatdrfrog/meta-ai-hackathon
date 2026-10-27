import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  configureTracingAdapter,
  type TraceRequest,
} from "@icecore/airi-runtime/tracing";
import type {
  ActivityExecuteInput,
  ActivityInterceptorsFactory,
} from "@temporalio/worker";

import {
  createLlmObservabilityActivityInterceptors,
  shouldTraceLlmActivity,
} from "./llm-observability-activity-interceptor.js";

afterEach(() => {
  configureTracingAdapter(null);
});

function createActivityContext(activityType: string) {
  return {
    info: {
      activityType,
      attempt: 2,
      isLocal: false,
      taskQueue: "airi-conversation",
      workflowType: "airiConversationWorkflow",
    },
  } as Parameters<ActivityInterceptorsFactory>[0];
}

test("only AI-bearing activity families receive LLM observability workflow spans", () => {
  assert.equal(shouldTraceLlmActivity("airi.prepareConversationTurn"), true);
  assert.equal(shouldTraceLlmActivity("airi.scenarioGenerativeAI.begin"), true);
  assert.equal(shouldTraceLlmActivity("airiCoachActivity"), true);
  assert.equal(shouldTraceLlmActivity("knowledgeCanonicalSyncActivity"), true);
  assert.equal(
    shouldTraceLlmActivity("conversation.mediaAnalysis.process"),
    true,
  );
  assert.equal(shouldTraceLlmActivity("airi.deliverOutbound"), false);
  assert.equal(
    shouldTraceLlmActivity("billingSubscriptionChargeActivity"),
    false,
  );
});

test("activity interceptor separates native session identity from safe operational metadata", async () => {
  const requests: TraceRequest[] = [];
  const resolvedMetadata: Array<Record<string, unknown>> = [];
  configureTracingAdapter({
    trace(request, execute) {
      requests.push(request);
      const metadata = request.getMetadata?.();
      assert.equal(metadata instanceof Promise, false);
      resolvedMetadata.push((metadata || {}) as Record<string, unknown>);
      return execute();
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const interceptors = createLlmObservabilityActivityInterceptors(
    createActivityContext("airi.prepareConversationTurn"),
  );
  const input = {
    args: [
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        text: "private customer message",
      },
    ],
    headers: {},
  } as ActivityExecuteInput;
  let executions = 0;

  const result = await interceptors.inbound?.execute?.(
    input,
    async (received) => {
      executions += 1;
      assert.equal(received, input);
      return "complete";
    },
  );

  assert.equal(result, "complete");
  assert.equal(executions, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.operation, "chain");
  assert.equal(
    requests[0]?.name,
    "airi.temporal.activity.airi.prepareConversationTurn",
  );
  assert.deepEqual(requests[0]?.sessionIdentity, {
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(resolvedMetadata, [
    {
      activity_type: "airi.prepareConversationTurn",
      attempt: 2,
      is_local: false,
      operation: "airi.prepareConversationTurn",
      source_service: "temporal-worker",
      task_queue: "airi-conversation",
      workflow_type: "airiConversationWorkflow",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(resolvedMetadata),
    /workspace-1|conversation-1|message-1|private customer message/,
  );
});

test("activity retries retain session identity and their own attempt metadata", async () => {
  const requests: TraceRequest[] = [];
  configureTracingAdapter({
    trace(request, execute) {
      requests.push(request);
      return execute();
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const input = {
    args: [
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
      },
    ],
    headers: {},
  } as ActivityExecuteInput;

  for (const attempt of [1, 2]) {
    const context = createActivityContext("airi.prepareConversationTurn");
    (context.info as { attempt: number }).attempt = attempt;
    const interceptors = createLlmObservabilityActivityInterceptors(context);
    assert.equal(
      await interceptors.inbound?.execute?.(input, async () => "complete"),
      "complete",
    );
  }

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.sessionIdentity, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    });
  }
  assert.deepEqual(
    await Promise.all(
      requests.map(async (request) => (await request.getMetadata?.())?.attempt),
    ),
    [1, 2],
  );
});

test("observed activities execute once when no tracing provider is configured", async () => {
  const interceptors = createLlmObservabilityActivityInterceptors(
    createActivityContext("airi.prepareConversationTurn"),
  );
  const input = { args: [], headers: {} } as ActivityExecuteInput;
  let executions = 0;

  const result = await interceptors.inbound?.execute?.(
    input,
    async (received) => {
      executions += 1;
      assert.equal(received, input);
      return "complete";
    },
  );

  assert.equal(result, "complete");
  assert.equal(executions, 1);
});

test("unobserved activities bypass the tracing adapter", async () => {
  let traces = 0;
  configureTracingAdapter({
    trace(_request, execute) {
      traces += 1;
      return execute();
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const interceptors = createLlmObservabilityActivityInterceptors(
    createActivityContext("billingSubscriptionChargeActivity"),
  );
  const input = { args: [], headers: {} } as ActivityExecuteInput;

  assert.equal(
    await interceptors.inbound?.execute?.(input, async () => "complete"),
    "complete",
  );
  assert.equal(traces, 0);
});
