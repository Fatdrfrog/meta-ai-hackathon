import assert from "node:assert/strict";
import test from "node:test";
import type { LlmAnalyticsEvent } from "@icecore/airi-runtime/llm-analytics";
import {
  publishLlmAnalyticsEventsToPubSub,
  queryLlmAnalyticsFromBigQuery,
  resetGcpLlmAnalyticsAccessTokenForTests,
} from "./gcp-llm-analytics";

const ENV_KEYS = [
  "GCP_LLM_ANALYTICS_ENABLED",
  "GCP_LLM_ANALYTICS_PROJECT_ID",
  "GCP_LLM_ANALYTICS_DATASET",
  "GCP_LLM_ANALYTICS_MAX_BYTES_BILLED",
  "GCP_LLM_ANALYTICS_ACCESS_TOKEN",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "GCP_PROJECT_ID",
  "GCP_LLM_ANALYTICS_TOPIC_PRODUCT_EVENTS",
  "GCP_LLM_ANALYTICS_TOPIC_TRACES",
  "GCP_LLM_ANALYTICS_TOPIC_RAG_TURNS",
  "GCP_LLM_ANALYTICS_TOPIC_SCORES",
  "GCP_LLM_ANALYTICS_TOPIC_EVAL_RUNS",
  "GCP_LLM_ANALYTICS_TOPIC_CUSTOMER_FEEDBACK",
  "GCP_LLM_ANALYTICS_TOPIC_HUMAN_EVALUATIONS",
] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
}

function restoreEnv(
  snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>,
) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function enableBigQuery(projectId = "project-1", _retiredDatasetId?: string) {
  process.env.GCP_LLM_ANALYTICS_ENABLED = "true";
  process.env.GCP_LLM_ANALYTICS_PROJECT_ID = "ignored-project";
  process.env.GCP_LLM_ANALYTICS_DATASET = "ignored_dataset";
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  delete process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN;
  delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  delete process.env.GCP_PROJECT_ID;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function analyticsEvent(
  eventKind: LlmAnalyticsEvent["event_kind"],
  eventId: string,
  fields: Record<string, unknown> = {},
): LlmAnalyticsEvent {
  return {
    event_id: eventId,
    event_kind: eventKind,
    event_ts: "2026-08-13T00:00:00.000Z",
    schema_version: 2,
    workspace_id: "workspace-1",
    ...fields,
  } as LlmAnalyticsEvent;
}

function decodePublishedEvent(message: { data: string }): LlmAnalyticsEvent {
  return JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
}

test("publishes a mixed analytics batch to one product topic call", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-product");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "static-token";
  process.env.GCP_LLM_ANALYTICS_TOPIC_TRACES = "legacy-traces";
  process.env.GCP_LLM_ANALYTICS_TOPIC_RAG_TURNS = "legacy-rag";
  const requests: Array<{
    url: string;
    body: { messages: Array<{ data: string }> };
    redirect: RequestRedirect | undefined;
  }> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        redirect: init?.redirect,
      });
      return response({ messageIds: ["message-1", "message-2"] });
    };

    const result = await publishLlmAnalyticsEventsToPubSub(
      [
        analyticsEvent("llm_trace", "trace-1", {
          operation: "chat",
          provider: "google",
          model: "gemini",
          status: "ok",
        }),
        analyticsEvent("rag_turn", "rag-1", { source_ids: [] }),
      ],
      { fetchFn },
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.redirect, "error");
    assert.match(
      requests[0]?.url || "",
      /topics\/icecore-llm-product-events:publish$/,
    );
    assert.deepEqual(
      requests[0]?.body.messages.map(
        (message) => decodePublishedEvent(message).event_kind,
      ),
      ["llm_trace", "rag_turn"],
    );
    assert.deepEqual(result, {
      accepted: 2,
      published: 2,
      skipped: false,
      topics: ["icecore-llm-product-events"],
    });
  } finally {
    restoreEnv(env);
  }
});

test("publishes only durable product facts from a mixed analytics batch", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-filtered");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "static-token";
  const requests: Array<{ body: { messages: Array<{ data: string }> } }> = [];

  try {
    const fetchFn: typeof fetch = async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return response({ messageIds: ["1", "2", "3"] });
    };

    const result = await publishLlmAnalyticsEventsToPubSub(
      [
        analyticsEvent("customer_feedback", "feedback-1"),
        analyticsEvent("human_evaluation", "human-evaluation-1"),
        analyticsEvent("llm_score", "system-score-1", {
          score_name: "citation_coverage",
          score_source: "system_eval",
          data_type: "numeric",
        }),
        analyticsEvent("llm_score", "judge-score-1", {
          score_name: "answer_relevance",
          score_source: "llm_judge",
          data_type: "numeric",
        }),
        analyticsEvent("llm_score", "human-score-1", {
          score_name: "answer_relevance",
          score_source: "human_review",
          data_type: "numeric",
        }),
        analyticsEvent("eval_run", "eval-1", {
          eval_run_id: "run-1",
          evaluator_name: "judge",
          status: "completed",
        }),
      ],
      { fetchFn },
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0]?.body.messages.map(
        (message) => decodePublishedEvent(message).event_id,
      ),
      ["judge-score-1", "human-score-1", "eval-1"],
    );
    assert.equal(result.accepted, 6);
    assert.equal(result.published, 3);
    assert.equal(result.skipped, false);
  } finally {
    restoreEnv(env);
  }
});

test("accepts a fully filtered analytics batch without calling Pub/Sub", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-no-product-facts");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "static-token";
  let requestCount = 0;

  try {
    const fetchFn: typeof fetch = async () => {
      requestCount += 1;
      return response({ messageIds: [] });
    };

    const result = await publishLlmAnalyticsEventsToPubSub(
      [
        analyticsEvent("customer_feedback", "feedback-2"),
        analyticsEvent("human_evaluation", "human-evaluation-2"),
        analyticsEvent("llm_score", "system-score-2", {
          score_name: "rag_context_present",
          score_source: "system_eval",
          data_type: "boolean",
        }),
      ],
      { fetchFn },
    );

    assert.equal(requestCount, 0);
    assert.deepEqual(result, {
      accepted: 3,
      published: 0,
      skipped: false,
      topics: [],
    });
  } finally {
    restoreEnv(env);
  }
});

test("ignores retired topology overrides and uses the stable product topic", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-override");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "static-token";
  process.env.GCP_LLM_ANALYTICS_TOPIC_PRODUCT_EVENTS = "custom-product-events";
  process.env.GCP_LLM_ANALYTICS_TOPIC_TRACES = "ignored-legacy-traces";
  let publishUrl = "";

  try {
    const fetchFn: typeof fetch = async (input) => {
      publishUrl = String(input);
      return response({ messageIds: ["1"] });
    };

    const result = await publishLlmAnalyticsEventsToPubSub(
      [
        analyticsEvent("llm_trace", "trace-override", {
          operation: "chat",
          provider: "google",
          model: "gemini",
          status: "ok",
        }),
      ],
      { fetchFn },
    );

    assert.match(publishUrl, /topics\/icecore-llm-product-events:publish$/);
    assert.deepEqual(result.topics, ["icecore-llm-product-events"]);
  } finally {
    restoreEnv(env);
  }
});

test("preserves disabled and missing-project publish behavior", async () => {
  const env = snapshotEnv();
  let requestCount = 0;
  const events = [
    analyticsEvent("llm_trace", "trace-skipped", {
      operation: "chat",
      provider: "google",
      model: "gemini",
      status: "ok",
    }),
  ];

  try {
    const fetchFn: typeof fetch = async () => {
      requestCount += 1;
      return response({});
    };

    process.env.GCP_LLM_ANALYTICS_ENABLED = "false";
    process.env.GOOGLE_CLOUD_PROJECT = "project-disabled";
    const disabledResult = await publishLlmAnalyticsEventsToPubSub(events, {
      fetchFn,
    });

    process.env.GCP_LLM_ANALYTICS_ENABLED = "true";
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCP_PROJECT_ID;
    const missingProjectResult = await publishLlmAnalyticsEventsToPubSub(
      events,
      { fetchFn },
    );

    assert.equal(requestCount, 0);
    assert.deepEqual(disabledResult, {
      accepted: 1,
      published: 0,
      skipped: true,
      topics: [],
    });
    assert.deepEqual(missingProjectResult, disabledResult);
  } finally {
    restoreEnv(env);
  }
});

test("deduplicates concurrent metadata token refreshes", async () => {
  const env = snapshotEnv();
  enableBigQuery();
  let metadataRequests = 0;

  try {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        metadataRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return response({ access_token: "metadata-token", expires_in: 300 });
      }
      return response({ schema: { fields: [] }, rows: [] });
    };

    await Promise.all([
      queryLlmAnalyticsFromBigQuery(
        { workspaceId: "workspace-1", query: "model_breakdown", days: 7 },
        { fetchFn },
      ),
      queryLlmAnalyticsFromBigQuery(
        { workspaceId: "workspace-1", query: "rag_failures", days: 7 },
        { fetchFn },
      ),
    ]);

    assert.equal(metadataRequests, 1);
  } finally {
    restoreEnv(env);
  }
});

test("bounds a stalled metadata token request before publishing", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-token-timeout");
  resetGcpLlmAnalyticsAccessTokenForTests();
  let publishRequests = 0;

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        assert.equal(init?.redirect, "error");
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason || new Error("aborted")),
            { once: true },
          );
        });
      }
      publishRequests += 1;
      return response({ messageIds: ["1"] });
    };

    await assert.rejects(
      publishLlmAnalyticsEventsToPubSub(
        [
          analyticsEvent("llm_trace", "trace-token-timeout", {
            operation: "chat",
            provider: "google",
            model: "gemini",
            status: "ok",
          }),
        ],
        { accessTokenTimeoutMs: 5, fetchFn },
      ),
      /timeout|abort/i,
    );
    assert.equal(publishRequests, 0);
  } finally {
    restoreEnv(env);
  }
});

test("omits the limit parameter for quality overview queries", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-2", "dataset_2");
  const queryBodies: Array<{ queryParameters?: Array<{ name?: string }> }> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "overview-token", expires_in: 300 });
      }
      queryBodies.push(JSON.parse(String(init?.body)));
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "quality_overview", limit: 1 },
      { fetchFn },
    );

    const queryBody = queryBodies[0];
    assert.ok(queryBody);
    assert.deepEqual(
      queryBody?.queryParameters?.map((param) => param.name),
      ["workspace_id", "start_ts", "end_ts"],
    );
  } finally {
    restoreEnv(env);
  }
});

test("bounds billed query bytes with a validated operator override", async () => {
  const env = snapshotEnv();
  resetGcpLlmAnalyticsAccessTokenForTests();
  enableBigQuery();
  delete process.env.GCP_LLM_ANALYTICS_MAX_BYTES_BILLED;
  const bodies: Array<{ maximumBytesBilled?: string; query?: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    if (String(input).includes("metadata.google.internal")) {
      return response({ access_token: "fixture-token", expires_in: 300 });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return response({ schema: { fields: [] }, rows: [] });
  };
  try {
    const request = {
      workspaceId: "workspace-1",
      query: "spend_overview" as const,
    };
    await queryLlmAnalyticsFromBigQuery(request, { fetchFn });
    assert.equal(bodies[0].maximumBytesBilled, "1073741824");
    assert.match(bodies[0].query ?? "", /thinking_tokens/);
    assert.match(bodies[0].query ?? "", /cached_prompt_tokens/);
    assert.match(bodies[0].query ?? "", /COALESCE\(input_cost_usd,/);
    assert.match(bodies[0].query ?? "", /COALESCE\(output_cost_usd,/);
    process.env.GCP_LLM_ANALYTICS_MAX_BYTES_BILLED = "20971520";
    await queryLlmAnalyticsFromBigQuery(request, { fetchFn });
    assert.equal(bodies[1].maximumBytesBilled, "20971520");
    for (const invalid of ["0", "-1", "2e9", "unlimited", "9007199254740992"]) {
      process.env.GCP_LLM_ANALYTICS_MAX_BYTES_BILLED = invalid;
      await assert.rejects(
        queryLlmAnalyticsFromBigQuery(request, { fetchFn }),
        /MAX_BYTES_BILLED/,
      );
    }
    assert.equal(bodies.length, 2);
  } finally {
    restoreEnv(env);
  }
});

test("strips backticks from BigQuery identifier parts", async () => {
  const env = snapshotEnv();
  enableBigQuery("project`2", "dataset`2");
  let sql = "";

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "identifier-token", expires_in: 300 });
      }
      sql = JSON.parse(String(init?.body)).query;
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "quality_overview" },
      { fetchFn },
    );

    assert.match(sql, /`project2\.icecore_llm_analytics\.llm_trace_events`/);
    assert.doesNotMatch(sql, /project`2|dataset`2/);
  } finally {
    restoreEnv(env);
  }
});

test("omits the limit parameter for spend overview queries", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-spend", "dataset_spend");
  const queryBodies: Array<{ queryParameters?: Array<{ name?: string }> }> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "spend-token", expires_in: 300 });
      }
      queryBodies.push(JSON.parse(String(init?.body)));
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "spend_overview", limit: 1 },
      { fetchFn },
    );

    const queryBody = queryBodies[0];
    assert.ok(queryBody);
    assert.deepEqual(
      queryBody?.queryParameters?.map((param) => param.name),
      ["workspace_id", "start_ts", "end_ts"],
    );
  } finally {
    restoreEnv(env);
  }
});

test("includes repriced cost fields in spend overview SQL", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-spend-sql", "dataset_spend_sql");
  let sql = "";

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "spend-sql-token", expires_in: 300 });
      }
      sql = JSON.parse(String(init?.body)).query;
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "spend_overview" },
      { fetchFn },
    );

    assert.match(sql, /total_cost_usd/);
    assert.match(sql, /estimated_cost_usd/);
    assert.match(sql, /gemini-3\.5-flash/);
  } finally {
    restoreEnv(env);
  }
});

test("orders model breakdown by repriced cost for spend reporting", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-model-spend", "dataset_model_spend");
  let sql = "";

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "model-spend-token", expires_in: 300 });
      }
      sql = JSON.parse(String(init?.body)).query;
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "model_breakdown" },
      { fetchFn },
    );

    assert.match(sql, /ORDER BY total_cost_usd DESC/);
    assert.doesNotMatch(sql, /ORDER BY calls DESC/);
  } finally {
    restoreEnv(env);
  }
});

test("uses workspace_ids for company rollup queries", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-company", "dataset_company");
  const queryBodies: Array<{ queryParameters?: Array<{ name?: string }> }> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "company-token", expires_in: 300 });
      }
      queryBodies.push(JSON.parse(String(init?.body)));
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      {
        workspaceId: "workspace-1",
        workspaceIds: ["workspace-1", "workspace-2"],
        query: "spend_overview",
      },
      { fetchFn },
    );

    const queryBody = queryBodies[0];
    assert.ok(queryBody);
    assert.deepEqual(
      queryBody?.queryParameters?.map((param) => param.name),
      ["workspace_ids", "start_ts", "end_ts"],
    );
  } finally {
    restoreEnv(env);
  }
});

test("builds allowlisted Airi chat overview SQL without a limit parameter", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-airi-chat", "dataset_airi_chat");
  const queryBodies: Array<{
    query?: string;
    queryParameters?: Array<{ name?: string }>;
  }> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "airi-chat-token", expires_in: 300 });
      }
      queryBodies.push(JSON.parse(String(init?.body)));
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "airi_chat_overview", limit: 1 },
      { fetchFn },
    );

    const queryBody = queryBodies[0];
    assert.ok(queryBody);
    assert.deepEqual(
      queryBody?.queryParameters?.map((param) => param.name),
      ["workspace_id", "start_ts", "end_ts"],
    );
    assert.match(queryBody.query || "", /operation = 'airi_chat\.reply'/);
    assert.match(queryBody.query || "", /source_service = 'web\.airi_chat'/);
  } finally {
    restoreEnv(env);
  }
});

test("builds allowlisted Airi chat daily SQL with joined trace and RAG rows", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-airi-daily", "dataset_airi_daily");
  let sql = "";
  let queryParameterNames: Array<string | undefined> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "airi-daily-token", expires_in: 300 });
      }
      const body = JSON.parse(String(init?.body));
      sql = body.query;
      queryParameterNames = body.queryParameters.map(
        (param: { name?: string }) => param.name,
      );
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "airi_chat_daily", limit: 14 },
      { fetchFn },
    );

    assert.deepEqual(queryParameterNames, [
      "workspace_id",
      "start_ts",
      "end_ts",
      "limit",
    ]);
    assert.match(sql, /WITH trace_daily AS/);
    assert.match(sql, /FULL OUTER JOIN rag_daily USING \(date\)/);
    assert.match(sql, /operation = 'airi_chat\.reply'/);
    assert.match(sql, /source_service = 'web\.airi_chat'/);
  } finally {
    restoreEnv(env);
  }
});

test("builds allowlisted Airi chat quality score SQL without a limit parameter", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-airi-quality", "dataset_airi_quality");
  let sql = "";
  let queryParameterNames: Array<string | undefined> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({
          access_token: "airi-quality-token",
          expires_in: 300,
        });
      }
      const body = JSON.parse(String(init?.body));
      sql = body.query;
      queryParameterNames = body.queryParameters.map(
        (param: { name?: string }) => param.name,
      );
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      {
        workspaceId: "workspace-1",
        query: "airi_chat_quality_score",
        limit: 1,
      },
      { fetchFn },
    );

    assert.deepEqual(queryParameterNames, [
      "workspace_id",
      "start_ts",
      "end_ts",
    ]);
    assert.match(sql, /WITH trace_summary AS/);
    assert.match(sql, /operation = 'airi_chat\.reply'/);
    assert.match(sql, /source_service = 'web\.airi_chat'/);
    assert.match(sql, /duration_ms <= 10000/);
    assert.match(sql, /ARRAY_LENGTH\(source_ids\)/);
    assert.doesNotMatch(sql, /score_name = 'latency_within_target'/);
    assert.match(sql, /sample_size_warning/);
  } finally {
    restoreEnv(env);
  }
});

test("builds generation quality SQL across RAG, score, and eval tables", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-quality", "dataset_quality");
  let sql = "";
  let queryParameterNames: Array<string | undefined> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "quality-token", expires_in: 300 });
      }
      const body = JSON.parse(String(init?.body));
      sql = body.query;
      queryParameterNames = body.queryParameters.map(
        (param: { name?: string }) => param.name,
      );
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "generation_quality", limit: 1 },
      { fetchFn },
    );

    assert.deepEqual(queryParameterNames, [
      "workspace_id",
      "start_ts",
      "end_ts",
    ]);
    assert.match(
      sql,
      /`project-quality\.icecore_llm_analytics\.rag_turn_events`/,
    );
    assert.match(
      sql,
      /`project-quality\.icecore_llm_analytics\.llm_score_events`/,
    );
    assert.match(
      sql,
      /`project-quality\.icecore_llm_analytics\.eval_run_events`/,
    );
    assert.match(sql, /groundedness_pct/);
    assert.match(
      sql,
      /SAFE_DIVIDE\(asks_answered_count, asks_detected_count\)/,
    );
    assert.match(sql, /LEAST\(\s*1\.0,/);
    assert.match(sql, /output_hash IS NOT NULL/);
    assert.doesNotMatch(sql, /score_name IN \('answer_completeness'\)/);
    assert.doesNotMatch(sql, /score_name = 'rag_context_present'/);
    assert.match(sql, /answer_relevance_pct/);
    assert.match(sql, /guardrail_pass_pct/);
    assert.match(sql, /toxicity_violation_count/);
    assert.match(sql, /generation_quality_score/);
  } finally {
    restoreEnv(env);
  }
});

test("builds system performance SQL with p99 latency and throughput metrics", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-perf", "dataset_perf");
  let sql = "";

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "perf-token", expires_in: 300 });
      }
      sql = JSON.parse(String(init?.body)).query;
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "system_performance", limit: 1 },
      { fetchFn },
    );

    assert.match(sql, /p99_latency_ms/);
    assert.match(sql, /tokens_per_second/);
    assert.match(sql, /output_tokens_per_second/);
    assert.match(sql, /avg_time_to_first_token_ms/);
    assert.match(sql, /time_to_first_token_note/);
    assert.match(sql, /p99_rag_duration_ms/);
  } finally {
    restoreEnv(env);
  }
});

test("builds operational efficiency SQL with error, token, cost, and cache metrics", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-efficiency", "dataset_efficiency");
  let sql = "";

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "efficiency-token", expires_in: 300 });
      }
      sql = JSON.parse(String(init?.body)).query;
      return response({ schema: { fields: [] }, rows: [] });
    };

    await queryLlmAnalyticsFromBigQuery(
      {
        workspaceId: "workspace-1",
        query: "operational_efficiency",
        limit: 1,
      },
      { fetchFn },
    );

    assert.match(sql, /error_rate_pct/);
    assert.match(sql, /prompt_token_share_pct/);
    assert.match(sql, /completion_token_share_pct/);
    assert.match(sql, /cost_per_1k_tokens_usd/);
    assert.match(sql, /semantic_cache_hit_count/);
    assert.match(sql, /semantic_cache_hit_rate_pct/);
    assert.match(sql, /pipeline_path = 'semantic_cache_hit'/);
    assert.match(
      sql,
      /FROM `project-efficiency\.icecore_llm_analytics\.rag_turn_events`/,
    );
    assert.doesNotMatch(sql, /JSON_VALUE\(metadata/);
  } finally {
    restoreEnv(env);
  }
});

test("unwraps repeated BigQuery field element values", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-3", "dataset_3");

  try {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return response({ access_token: "repeated-token", expires_in: 300 });
      }
      return response({
        schema: {
          fields: [
            { name: "source_ids", type: "STRING", mode: "REPEATED" },
            { name: "scores", type: "INTEGER", mode: "REPEATED" },
          ],
        },
        rows: [
          {
            f: [
              { v: [{ v: "source-1" }, { v: "source-2" }] },
              { v: [{ v: "5" }, { v: "8" }] },
            ],
          },
        ],
      });
    };

    const result = await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "rag_failures" },
      { fetchFn },
    );

    assert.deepEqual(result.rows, [
      { source_ids: ["source-1", "source-2"], scores: [5, 8] },
    ]);
  } finally {
    restoreEnv(env);
  }
});

test("polls an incomplete BigQuery job before returning rows", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-poll");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "poll-token";
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  try {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/queries")) {
        return response({
          jobComplete: false,
          jobReference: {
            projectId: "project-poll",
            jobId: "job-1",
            location: "europe-west1",
          },
        });
      }
      return response({
        jobComplete: true,
        schema: { fields: [{ name: "calls", type: "INTEGER" }] },
        rows: [{ f: [{ v: "12" }] }],
      });
    };

    const result = await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "quality_overview" },
      { fetchFn },
    );

    assert.deepEqual(result.rows, [{ calls: 12 }]);
    assert.equal(requests.length, 2);
    assert.match(
      requests[1]?.url || "",
      /\/projects\/project-poll\/queries\/job-1\?.*location=europe-west1/,
    );
    assert.match(requests[1]?.url || "", /maxResults=101/);
    assert.match(requests[1]?.url || "", /timeoutMs=/);
    assert.equal(requests[0]?.init?.redirect, "error");
    assert.equal(requests[1]?.init?.redirect, "error");
    assert.equal(
      (requests[1]?.init?.headers as Record<string, string>)?.Authorization,
      "Bearer poll-token",
    );
  } finally {
    restoreEnv(env);
  }
});

test("follows BigQuery result pages without returning partial data", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-pages");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "page-token-secret";
  const urls: string[] = [];

  try {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/queries")) {
        return response({
          jobComplete: true,
          jobReference: {
            projectId: "project-pages",
            jobId: "job-pages",
            location: "US",
          },
          schema: { fields: [{ name: "model", type: "STRING" }] },
          rows: [{ f: [{ v: "gemini-a" }] }],
          pageToken: "next/page+token",
        });
      }
      return response({
        jobComplete: true,
        rows: [{ f: [{ v: "gemini-b" }] }],
      });
    };

    const result = await queryLlmAnalyticsFromBigQuery(
      { workspaceId: "workspace-1", query: "model_breakdown", limit: 1 },
      { fetchFn },
    );

    assert.deepEqual(result.rows, [{ model: "gemini-a" }]);
    assert.equal(result.limited, true);
    assert.equal(urls.length, 2);
    assert.match(urls[1] || "", /pageToken=next%2Fpage%2Btoken/);
    assert.doesNotMatch(urls[1] || "", /page-token-secret/);
  } finally {
    restoreEnv(env);
  }
});

test("fails closed when a BigQuery job never completes within the deadline", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-timeout");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "timeout-token";
  let nowMs = 0;
  let requests = 0;

  try {
    const fetchFn: typeof fetch = async (_input, init) => {
      requests += 1;
      assert.ok(init?.signal);
      nowMs += 6;
      return response({
        jobComplete: false,
        jobReference: {
          projectId: "project-timeout",
          jobId: "job-timeout",
          location: "EU",
        },
      });
    };

    await assert.rejects(
      queryLlmAnalyticsFromBigQuery(
        { workspaceId: "workspace-1", query: "quality_overview" },
        { fetchFn, now: () => nowMs, queryDeadlineMs: 10 },
      ),
      /BigQuery query did not complete within the bounded deadline/,
    );
    assert.equal(requests, 2);
  } finally {
    restoreEnv(env);
  }
});

test("rejects an incomplete BigQuery response without a usable job reference", async () => {
  const env = snapshotEnv();
  enableBigQuery("project-missing-job");
  process.env.GCP_LLM_ANALYTICS_ACCESS_TOKEN = "missing-job-token";
  let requests = 0;

  try {
    const fetchFn: typeof fetch = async () => {
      requests += 1;
      return response({ jobComplete: false });
    };

    await assert.rejects(
      queryLlmAnalyticsFromBigQuery(
        { workspaceId: "workspace-1", query: "quality_overview" },
        { fetchFn },
      ),
      /BigQuery query response did not include a usable job reference/,
    );
    assert.equal(requests, 1);
  } finally {
    restoreEnv(env);
  }
});
