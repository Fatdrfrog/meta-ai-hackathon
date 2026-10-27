import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomerFeedbackEvent,
  buildHumanEvaluationEvent,
  buildLlmTraceEvent,
  buildLlmAnalyticsProductEvents,
  buildPubSubPublishPayloadForLlmProductAnalytics,
  buildRagTurnEventFromWideEvent,
  validateLlmAnalyticsEventBatch,
  type EvalRunEvent,
  type LlmAnalyticsEvent,
  type LlmAnalyticsPubSubMessage,
  type LlmScoreEvent,
} from "./llm-analytics.js";

type ProductPublishPayload = {
  topic: string;
  messages: LlmAnalyticsPubSubMessage[];
};

test("customer-key usage is retained without charging platform cost analytics", () => {
  const trace = buildLlmTraceEvent({
    eventTs: "2026-10-02T00:00:00.000Z",
    workspaceId: "workspace-1",
    operation: "reply",
    provider: "google",
    model: "gemini-3.5-flash",
    status: "ok",
    billingSource: "customer",
    companyId: "company-1",
    actionId: "reply:1",
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  });
  assert.equal(trace.estimated_cost_usd, 0);
  assert.equal(trace.metadata?.billing_source, "customer");
  assert.ok(
    Math.abs(Number(trace.metadata?.customer_cost_usd) - 0.0024) < 1e-10,
  );
  assert.equal(trace.metadata?.company_id, "company-1");
  const product = buildProductPayload([trace]);
  assert.ok(product);
  const stored = JSON.parse(
    Buffer.from(product.messages[0].data, "base64").toString(),
  );
  assert.equal(stored.billing_source, "customer");
  assert.equal(stored.company_id, "company-1");
  assert.equal(stored.action_id, "reply:1");
  assert.ok(Math.abs(stored.customer_cost_usd - 0.0024) < 1e-10);
});

test("keeps billable thinking/cache usage in product facts", () => {
  const trace = buildLlmTraceEvent({
    eventTs: "2026-10-02T00:00:00.000Z",
    workspaceId: "workspace-1",
    operation: "airi.reply.generate",
    provider: "vertex",
    model: "gemini-3.5-flash",
    status: "error",
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      thinking_tokens: 200,
      cached_prompt_tokens: 800,
      total_tokens: 1300,
    },
  });
  assert.equal(trace.completion_tokens, 100);
  assert.equal(trace.thinking_tokens, 200);
  assert.equal(trace.cached_prompt_tokens, 800);
  assert.ok(Math.abs((trace.estimated_cost_usd ?? 0) - 0.00312) < 1e-10);
  assert.doesNotThrow(() =>
    validateLlmAnalyticsEventBatch({ events: [trace] }),
  );
  const product = buildProductPayload([trace]);
  assert.ok(product);
  const productRow = JSON.parse(
    Buffer.from(product.messages[0].data, "base64").toString(),
  );
  assert.equal(productRow.thinking_tokens, 200);
  assert.equal(productRow.cached_prompt_tokens, 800);
  assert.equal(productRow.completion_tokens, 100);
  assert.throws(
    () =>
      validateLlmAnalyticsEventBatch({
        events: [{ ...trace, thinking_tokens: -1 }],
      }),
    /thinking_tokens is invalid/,
  );
});

function buildProductPayload(
  events: LlmAnalyticsEvent[],
  topic?: string,
): ProductPublishPayload | null {
  return buildPubSubPublishPayloadForLlmProductAnalytics(events, topic);
}

function withoutFields(
  value: object,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !fields.includes(key)),
  );
}

function scoreEvent(
  eventId: string,
  scoreSource: LlmScoreEvent["score_source"],
  fields: Partial<LlmScoreEvent> = {},
): LlmScoreEvent {
  return {
    event_id: eventId,
    event_kind: "llm_score",
    event_ts: "2026-08-13T12:00:02.000Z",
    schema_version: 2,
    workspace_id: "workspace-1",
    conversation_id: "conversation-1",
    score_name: "answer_quality",
    score_source: scoreSource,
    data_type: "numeric",
    numeric_value: 0.9,
    ...fields,
  };
}

test("prices Claude cache writes in the stored cost without a new event column", () => {
  const trace = buildLlmTraceEvent({
    eventTs: "2026-10-07T00:00:00.000Z",
    workspaceId: "workspace-1",
    operation: "airi.reply.generate",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    status: "ok",
    usage: {
      prompt_tokens: 3_300,
      completion_tokens: 200,
      cache_write_prompt_tokens: 3_000,
      total_tokens: 3_500,
    },
  });
  // 300 * $2 + 3000 * $2.50 (1.25x write) + 200 * $10, per million tokens.
  assert.ok(Math.abs((trace.estimated_cost_usd ?? 0) - 0.0101) < 1e-10);
  assert.equal(
    (trace as Record<string, unknown>).cache_write_prompt_tokens,
    undefined,
  );
  assert.doesNotThrow(() =>
    validateLlmAnalyticsEventBatch({ events: [trace] }),
  );
});

test("builds one product stream payload with eligible events in original order", () => {
  const trace = buildLlmTraceEvent({
    eventTs: "2026-08-13T12:00:00.000Z",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    operation: "airi.reply.generate",
    provider: "vertex",
    model: "gemini-3.5-flash",
    status: "ok",
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
    inputText: "Where is my order?",
    outputText: "Your order is in transit.",
  });
  const ragTurn = buildRagTurnEventFromWideEvent({
    eventTs: "2026-08-13T12:00:01.000Z",
    inputText: "Where is my order?",
    outputText: "Your order is in transit.",
    wideEvent: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      resultType: "ai_reply",
      outcome: "ok",
      sourceIds: ["source-1"],
      coverage: {
        asksDetected: ["order status", "delivery date"],
        asksAnswered: ["order status"],
        missingAsks: ["delivery date"],
      },
    },
  });
  const systemScore = scoreEvent("score-system", "system_eval");
  const judgeScore = scoreEvent("score-judge", "llm_judge");
  const humanScore = scoreEvent("score-human", "human_review");
  const customerScore = scoreEvent("score-customer", "customer_feedback");
  const feedback = buildCustomerFeedbackEvent({
    eventTs: "2026-08-13T12:00:03.000Z",
    workspaceId: "workspace-1",
    channel: "web",
    feedbackStage: "helpfulness",
    feedbackValue: "helpful",
    helpful: true,
  });
  const evaluation: EvalRunEvent = {
    event_id: "eval-1",
    event_kind: "eval_run",
    event_ts: "2026-08-13T12:00:04.000Z",
    schema_version: 2,
    workspace_id: "workspace-1",
    eval_run_id: "run-1",
    evaluator_name: "answer-quality",
    status: "completed",
  };
  const humanEvaluation = buildHumanEvaluationEvent({
    eventTs: "2026-08-13T12:00:05.000Z",
    workspaceId: "workspace-1",
    evaluationStatus: "reviewed",
    datasetDecision: "candidate",
  });

  const payload = buildProductPayload([
    systemScore,
    trace,
    feedback,
    judgeScore,
    ragTurn,
    humanScore,
    humanEvaluation,
    customerScore,
    evaluation,
  ]);

  assert.ok(payload);
  assert.equal(payload.topic, "icecore-llm-product-events");
  assert.deepEqual(
    payload.messages.map((message) => message.attributes.event_id),
    [
      trace.event_id,
      judgeScore.event_id,
      ragTurn.event_id,
      humanScore.event_id,
      customerScore.event_id,
      evaluation.event_id,
    ],
  );
  assert.deepEqual(
    payload.messages.map((message) =>
      JSON.parse(Buffer.from(message.data, "base64").toString("utf8")),
    ),
    [
      withoutFields(trace, [
        "metadata",
        "input_excerpt",
        "output_excerpt",
        "error_message",
      ]),
      withoutFields(judgeScore, ["metadata", "comment", "reasoning_excerpt"]),
      withoutFields(ragTurn, ["metadata", "input_excerpt", "output_excerpt"]),
      withoutFields(humanScore, ["metadata", "comment", "reasoning_excerpt"]),
      withoutFields(customerScore, [
        "metadata",
        "comment",
        "reasoning_excerpt",
      ]),
      withoutFields(evaluation, ["metadata", "error_message"]),
    ],
  );
  assert.deepEqual(payload.messages[0]?.attributes, {
    event_id: trace.event_id,
    event_kind: "llm_trace",
    workspace_id: "workspace-1",
    schema_version: "2",
  });
});

test("returns no product stream payload when every event is excluded", () => {
  const systemScore = scoreEvent("score-system", "system_eval");
  const feedback = buildCustomerFeedbackEvent({
    eventTs: "2026-08-13T12:00:03.000Z",
    workspaceId: "workspace-1",
    channel: "web",
    feedbackStage: "helpfulness",
    feedbackValue: "helpful",
    helpful: true,
  });
  const humanEvaluation = buildHumanEvaluationEvent({
    eventTs: "2026-08-13T12:00:05.000Z",
    workspaceId: "workspace-1",
    evaluationStatus: "reviewed",
    datasetDecision: "candidate",
  });

  assert.equal(buildProductPayload([]), null);
  assert.equal(
    buildProductPayload(
      [systemScore, feedback, humanEvaluation],
      "custom-topic",
    ),
    null,
  );
});

test("rejects malformed product facts before they can reach Pub/Sub", () => {
  const common = {
    event_id: "event-1",
    event_ts: "2026-08-13T12:00:00.000Z",
    schema_version: 2,
    workspace_id: "workspace-1",
  };

  for (const [event, message] of [
    [
      {
        ...common,
        event_kind: "llm_trace",
        operation: "chat",
        provider: "vertex",
        model: "gemini",
        status: "bogus",
      },
      "llm_trace status is invalid",
    ],
    [
      {
        ...common,
        event_kind: "llm_score",
        score_name: "quality",
        score_source: "bogus",
        data_type: "numeric",
      },
      "llm_score source is invalid",
    ],
    [
      {
        ...common,
        event_kind: "eval_run",
        eval_run_id: "run-1",
        evaluator_name: "judge",
        status: "bogus",
      },
      "eval_run status is invalid",
    ],
    [
      {
        ...common,
        event_kind: "rag_turn",
        event_ts: "not-a-date",
        source_ids: [],
      },
      "event_ts is invalid",
    ],
    [
      { ...common, event_kind: "rag_turn", schema_version: 0, source_ids: [] },
      "schema_version is invalid",
    ],
    [
      { ...common, event_kind: "rag_turn", source_ids: ["source-1", 7] },
      "rag_turn source_ids is invalid",
    ],
    [
      {
        ...common,
        event_kind: "llm_trace",
        operation: "chat",
        provider: "vertex",
        model: "gemini",
        status: "ok",
        total_tokens: "18",
      },
      "llm_trace total_tokens is invalid",
    ],
    [
      {
        ...common,
        event_kind: "llm_score",
        score_name: "quality",
        score_source: "llm_judge",
        data_type: "numeric",
        numeric_value: "0.9",
      },
      "llm_score numeric_value is invalid",
    ],
    [
      {
        ...common,
        event_kind: "llm_score",
        score_name: "quality",
        score_source: "llm_judge",
        data_type: "numeric",
        numeric_value: 0.9,
        boolean_value: { unsafe: true },
      },
      "llm_score boolean_value is invalid",
    ],
    [
      {
        ...common,
        event_kind: "eval_run",
        eval_run_id: "run-1",
        evaluator_name: "judge",
        status: "completed",
        sampled_count: -1,
      },
      "eval_run sampled_count is invalid",
    ],
    [
      {
        ...common,
        event_kind: "customer_feedback",
        channel: "sms",
        feedback_stage: "helpfulness",
        feedback_value: "helpful",
      },
      "customer_feedback channel is invalid",
    ],
    [
      {
        ...common,
        event_kind: "customer_feedback",
        channel: "web",
        feedback_stage: "survey",
        feedback_value: "helpful",
      },
      "customer_feedback feedback_stage is invalid",
    ],
    [
      {
        ...common,
        event_kind: "customer_feedback",
        channel: "web",
        feedback_stage: "helpfulness",
        feedback_value: " ",
      },
      "customer_feedback feedback_value is required",
    ],
    [
      {
        ...common,
        event_kind: "customer_feedback",
        channel: "web",
        feedback_stage: "reason",
        feedback_value: "incorrect",
        helpful: "false",
      },
      "customer_feedback helpful is invalid",
    ],
    [
      {
        ...common,
        event_kind: "customer_feedback",
        channel: "web",
        feedback_stage: "reason",
        feedback_value: "incorrect",
        reason_code: "made_up",
      },
      "customer_feedback reason_code is invalid",
    ],
    [
      {
        ...common,
        event_kind: "human_evaluation",
        evaluation_status: "complete",
        dataset_decision: "candidate",
      },
      "human_evaluation evaluation_status is invalid",
    ],
    [
      {
        ...common,
        event_kind: "human_evaluation",
        evaluation_status: "reviewed",
        dataset_decision: "publish",
      },
      "human_evaluation dataset_decision is invalid",
    ],
    [
      {
        ...common,
        event_kind: "human_evaluation",
        evaluation_status: "reviewed",
        dataset_decision: "candidate",
        dataset_split: "production",
      },
      "human_evaluation dataset_split is invalid",
    ],
    [
      {
        ...common,
        event_kind: "human_evaluation",
        evaluation_status: "reviewed",
        dataset_decision: "candidate",
        overall_score: "0.9",
      },
      "human_evaluation overall_score is invalid",
    ],
    [
      {
        ...common,
        event_kind: "human_evaluation",
        evaluation_status: "reviewed",
        dataset_decision: "candidate",
        expected_source_ids: ["source-1", 7],
      },
      "human_evaluation expected_source_ids is invalid",
    ],
    [
      { ...common, event_id: 123, event_kind: "rag_turn", source_ids: [] },
      "event_id is required",
    ],
  ] as const) {
    assert.throws(
      () => validateLlmAnalyticsEventBatch({ events: [event] }),
      new RegExp(message),
    );
  }
});

test("removes content and free-form metadata from durable product facts", () => {
  const trace = buildLlmTraceEvent({
    eventTs: "2026-08-13T12:00:00.000Z",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    operation: "airi.reply.generate",
    provider: "vertex",
    model: "gemini-3.5-flash",
    status: "error",
    inputText: "private customer prompt",
    outputText: "private generated answer",
    errorMessage: "provider error containing private customer text",
    metadata: { arbitrary_private_value: "must not leave the application" },
  });
  const ragTurn = buildRagTurnEventFromWideEvent({
    eventTs: "2026-08-13T12:00:01.000Z",
    inputText: "private retrieval question",
    outputText: "private retrieval answer",
    metadata: { arbitrary_private_value: "must not reach the warehouse" },
    wideEvent: {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      resultType: "ai_reply",
      outcome: "ok",
      sourceIds: ["source-1"],
      coverage: {
        asksDetected: ["order status", "delivery date"],
        asksAnswered: ["order status"],
        missingAsks: ["delivery date"],
      },
    },
  });

  const payload = buildProductPayload([trace, ragTurn]);
  assert.ok(payload);
  const serialized = payload.messages
    .map((message) => Buffer.from(message.data, "base64").toString("utf8"))
    .join("\n");

  for (const privateValue of [
    "private customer prompt",
    "private generated answer",
    "private customer text",
    "private retrieval question",
    "private retrieval answer",
    "arbitrary_private_value",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue));
  }
  const decoded = payload.messages.map((message) =>
    JSON.parse(Buffer.from(message.data, "base64").toString("utf8")),
  );
  for (const event of decoded) {
    assert.ok(!("metadata" in event));
    assert.ok(!("input_excerpt" in event));
    assert.ok(!("output_excerpt" in event));
  }
  assert.equal(decoded[0].event_kind, "llm_trace");
  assert.equal(decoded[0].total_tokens, trace.total_tokens);
  assert.equal(decoded[1].event_kind, "rag_turn");
  assert.deepEqual(decoded[1].source_ids, ["source-1"]);
  assert.equal(decoded[1].asks_detected_count, 2);
  assert.equal(decoded[1].asks_answered_count, 1);
  assert.equal(decoded[1].missing_asks_count, 1);

  const forgedTrace = {
    ...trace,
    forged_private_value: "must not reach BigQuery",
  } as LlmAnalyticsEvent;
  const privateTextScore = scoreEvent("score-private-text", "llm_judge", {
    data_type: "text",
    string_value: "private reviewer explanation",
  });
  const forgedPayload = buildProductPayload([forgedTrace, privateTextScore]);
  assert.ok(forgedPayload);
  const forgedSerialized = forgedPayload.messages
    .map((message) => Buffer.from(message.data, "base64").toString("utf8"))
    .join("\n");
  assert.doesNotMatch(
    forgedSerialized,
    /forged_private_value|must not reach BigQuery|private reviewer explanation/,
  );

  const durableEvents = buildLlmAnalyticsProductEvents([
    forgedTrace,
    privateTextScore,
  ]);
  assert.equal(durableEvents.length, 2);
  assert.doesNotMatch(
    JSON.stringify(durableEvents),
    /forged_private_value|must not reach BigQuery|private reviewer explanation/,
  );
});
