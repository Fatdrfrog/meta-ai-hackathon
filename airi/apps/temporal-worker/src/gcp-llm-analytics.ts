import {
  LLM_ANALYTICS_QUERY_NAMES,
  type LlmAnalyticsGatewayEventResponse,
  type LlmAnalyticsQueryGatewayRequest,
  type LlmAnalyticsQueryGatewayResponse,
  type LlmAnalyticsQueryName,
} from "@icecore/airi-runtime/ai-gateway";
import {
  buildBigQueryCostExpression,
  buildBigQueryInputCostExpression,
  buildBigQueryOutputCostExpression,
} from "@icecore/airi-runtime/llm-pricing";
import {
  buildPubSubPublishPayloadForLlmProductAnalytics,
  LLM_ANALYTICS_PRODUCT_EVENTS_TOPIC,
  type LlmAnalyticsEvent,
  type LlmAnalyticsProductPubSubPublishPayload,
} from "@icecore/airi-runtime/llm-analytics";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { firstEnv, readEnv, readEnvFlag } from "@icecore/shared/lib/env";

type FetchLike = typeof fetch;

type GoogleAccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

type BigQueryField = {
  name: string;
  type?: string;
  mode?: string;
  fields?: BigQueryField[];
};

type BigQueryRow = {
  f?: Array<{ v?: unknown }>;
};

type BigQueryQueryResponse = {
  schema?: {
    fields?: BigQueryField[];
  };
  rows?: BigQueryRow[];
  totalRows?: string;
  pageToken?: string;
  jobComplete?: boolean;
  jobReference?: {
    projectId?: string;
    jobId?: string;
    location?: string;
  };
};

const DEFAULT_DATASET = "icecore_llm_analytics";
const DEFAULT_MAXIMUM_BYTES_BILLED = 1_073_741_824;
const BIGQUERY_QUERY_DEADLINE_MS = 20_000;
const BIGQUERY_REQUEST_TIMEOUT_MS = 5_000;
const BIGQUERY_MAX_RESULT_REQUESTS = 20;
const BIGQUERY_MAX_PAGE_TOKEN_LENGTH = 8_192;

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let pendingAccessTokenFetch: Promise<string> | null = null;

export function resetGcpLlmAnalyticsAccessTokenForTests(): void {
  cachedAccessToken = null;
  pendingAccessTokenFetch = null;
}

function getGcpProjectId(): string | null {
  return firstEnv("GOOGLE_CLOUD_PROJECT", "GCP_PROJECT_ID");
}

function getDatasetId(): string {
  return DEFAULT_DATASET;
}

function getMaximumBytesBilled(): string {
  const configured = readEnv("GCP_LLM_ANALYTICS_MAX_BYTES_BILLED");
  if (!configured) return String(DEFAULT_MAXIMUM_BYTES_BILLED);
  const bytes = Number(configured);
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(
      "GCP_LLM_ANALYTICS_MAX_BYTES_BILLED must be a positive safe integer",
    );
  }
  return String(bytes);
}

function getLlmAnalyticsProductEventsTopic(): string {
  return LLM_ANALYTICS_PRODUCT_EVENTS_TOPIC;
}

function isGcpLlmAnalyticsEnabled(): boolean {
  return readEnvFlag("GCP_LLM_ANALYTICS_ENABLED");
}

function buildPublishPayloads(
  events: LlmAnalyticsEvent[],
): LlmAnalyticsProductPubSubPublishPayload[] {
  const productPayload = buildPubSubPublishPayloadForLlmProductAnalytics(
    events,
    getLlmAnalyticsProductEventsTopic(),
  );
  return productPayload ? [productPayload] : [];
}

async function fetchGoogleAccessToken(
  fetchFn: FetchLike = fetch,
  timeoutMs = 2_000,
): Promise<string> {
  const staticToken = firstEnv(
    "GCP_LLM_ANALYTICS_ACCESS_TOKEN",
    "GOOGLE_OAUTH_ACCESS_TOKEN",
  );
  if (staticToken) return staticToken;

  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt - now > 60_000) {
    return cachedAccessToken.token;
  }

  if (pendingAccessTokenFetch) {
    return pendingAccessTokenFetch;
  }

  const tokenFetch = (async () => {
    const response = await fetchFn(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: {
          "Metadata-Flavor": "Google",
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!response.ok) {
      throw new Error(`metadata token request failed: HTTP ${response.status}`);
    }

    const tokenResponse = (await response.json()) as GoogleAccessTokenResponse;
    const token = tokenResponse.access_token?.trim();
    if (!token) {
      throw new Error("metadata token response did not include access_token");
    }

    cachedAccessToken = {
      token,
      expiresAt:
        Date.now() + Math.max(60, tokenResponse.expires_in || 300) * 1000,
    };
    return token;
  })();

  pendingAccessTokenFetch = tokenFetch;
  try {
    return await tokenFetch;
  } finally {
    if (pendingAccessTokenFetch === tokenFetch) {
      pendingAccessTokenFetch = null;
    }
  }
}

export async function publishLlmAnalyticsEventsToPubSub(
  events: LlmAnalyticsEvent[],
  options?: { fetchFn?: FetchLike; accessTokenTimeoutMs?: number },
): Promise<LlmAnalyticsGatewayEventResponse> {
  if (events.length === 0) {
    return { accepted: 0, published: 0, skipped: false, topics: [] };
  }

  const projectId = getGcpProjectId();
  if (!isGcpLlmAnalyticsEnabled() || !projectId) {
    airiWorkerLogger.info("llm.analytics.pubsub", {
      note: "skipped",
      accepted: events.length,
      enabled: isGcpLlmAnalyticsEnabled(),
      hasProjectId: Boolean(projectId),
    });
    return { accepted: events.length, published: 0, skipped: true, topics: [] };
  }

  const publishPayloads = buildPublishPayloads(events);
  if (publishPayloads.length === 0) {
    airiWorkerLogger.info("llm.analytics.pubsub", {
      note: "no_product_facts",
      accepted: events.length,
      published: 0,
      topics: [],
    });
    return {
      accepted: events.length,
      published: 0,
      skipped: false,
      topics: [],
    };
  }

  const fetchFn = options?.fetchFn || fetch;
  const token = await fetchGoogleAccessToken(
    fetchFn,
    options?.accessTokenTimeoutMs,
  );
  let published = 0;
  const topics: string[] = [];
  for (const [payloadIndex, publishPayload] of publishPayloads.entries()) {
    const topic = publishPayload.topic;
    const response = await fetchFn(
      `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(
        projectId,
      )}/topics/${encodeURIComponent(topic)}:publish`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ messages: publishPayload.messages }),
      },
    );

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Pub/Sub publish failed for ${topic}: HTTP ${response.status} ${responseText.slice(
          0,
          500,
        )}`,
      );
    }
    if (payloadIndex === 0) {
      published = publishPayload.messages.length;
    }
    topics.push(topic);
  }

  airiWorkerLogger.info("llm.analytics.pubsub", {
    note: "published",
    accepted: events.length,
    published,
    topics,
  });

  return { accepted: events.length, published, skipped: false, topics };
}

function clampDays(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return 30;
  return Math.min(Math.max(Math.trunc(value), 1), 365);
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return 100;
  return Math.min(Math.max(Math.trunc(value), 1), 500);
}

function isQueryName(value: unknown): value is LlmAnalyticsQueryName {
  return (
    typeof value === "string" &&
    LLM_ANALYTICS_QUERY_NAMES.includes(value as LlmAnalyticsQueryName)
  );
}

function sanitizeBigQueryIdentifierPart(value: string): string {
  return value.replace(/`/g, "");
}

function tableName(
  projectId: string,
  datasetId: string,
  table: string,
): string {
  return `\`${[projectId, datasetId, table]
    .map(sanitizeBigQueryIdentifierPart)
    .join(".")}\``;
}

function queryUsesLimit(queryName: LlmAnalyticsQueryName): boolean {
  return ![
    "quality_overview",
    "generation_quality",
    "system_performance",
    "operational_efficiency",
    "spend_overview",
    "airi_chat_overview",
    "airi_chat_quality_score",
  ].includes(queryName);
}

function buildWorkspaceScopeClause(useMultiWorkspace: boolean): string {
  return useMultiWorkspace
    ? "workspace_id IN UNNEST(@workspace_ids)"
    : "workspace_id = @workspace_id";
}

function buildTraceCostExpressions(): {
  totalCost: string;
  inputCost: string;
  outputCost: string;
} {
  return {
    totalCost: buildBigQueryCostExpression({
      modelColumn: "model",
      promptTokensColumn: "prompt_tokens",
      completionTokensColumn: "completion_tokens",
      thinkingTokensColumn: "thinking_tokens",
      cachedPromptTokensColumn: "cached_prompt_tokens",
      eventTsColumn: "event_ts",
      storedCostColumn: "estimated_cost_usd",
    }),
    inputCost: buildBigQueryInputCostExpression({
      modelColumn: "model",
      promptTokensColumn: "prompt_tokens",
      cachedPromptTokensColumn: "cached_prompt_tokens",
      eventTsColumn: "event_ts",
      storedCostColumn: "input_cost_usd",
    }),
    outputCost: buildBigQueryOutputCostExpression({
      modelColumn: "model",
      completionTokensColumn: "completion_tokens",
      thinkingTokensColumn: "thinking_tokens",
      eventTsColumn: "event_ts",
      storedCostColumn: "output_cost_usd",
    }),
  };
}

function buildAllowedQuery(params: {
  projectId: string;
  datasetId: string;
  queryName: LlmAnalyticsQueryName;
  useMultiWorkspace: boolean;
}): string {
  const traces = tableName(
    params.projectId,
    params.datasetId,
    "llm_trace_events",
  );
  const ragTurns = tableName(
    params.projectId,
    params.datasetId,
    "rag_turn_events",
  );
  const scores = tableName(
    params.projectId,
    params.datasetId,
    "llm_score_events",
  );
  const evalRuns = tableName(
    params.projectId,
    params.datasetId,
    "eval_run_events",
  );
  const workspaceScope = buildWorkspaceScopeClause(params.useMultiWorkspace);
  const { totalCost, inputCost, outputCost } = buildTraceCostExpressions();

  if (params.queryName === "quality_overview") {
    return `
      SELECT
        (SELECT COUNT(*) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts) AS trace_count,
        (SELECT COUNTIF(status = 'error') FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts) AS error_count,
        (SELECT AVG(latency_ms) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts) AS avg_latency_ms,
        (SELECT APPROX_QUANTILES(latency_ms, 100)[OFFSET(50)] FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND latency_ms IS NOT NULL) AS p50_latency_ms,
        (SELECT APPROX_QUANTILES(latency_ms, 100)[OFFSET(95)] FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND latency_ms IS NOT NULL) AS p95_latency_ms,
        (SELECT SUM(total_tokens) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts) AS total_tokens,
        (SELECT SUM(${totalCost}) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts) AS total_cost_usd,
        (SELECT COUNT(*) FROM ${ragTurns}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts) AS rag_turn_count,
        (SELECT COUNTIF(
            result_type = 'fallback'
            OR fallback_action IS NOT NULL
            OR IFNULL(retrieval_context_count, 0) = 0
          ) FROM ${ragTurns}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts) AS rag_issue_count
    `;
  }

  if (params.queryName === "generation_quality") {
    return `
      WITH rag_stats AS (
        SELECT
          COUNT(*) AS rag_turn_count,
          COUNTIF(
            COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) > 0
          ) AS grounded_turn_count,
          COUNTIF(
            outcome != 'ok'
            OR result_type = 'fallback'
            OR fallback_action IS NOT NULL
            OR COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) = 0
          ) AS rag_issue_count,
          SAFE_DIVIDE(
            COUNTIF(
              COALESCE(
                NULLIF(ARRAY_LENGTH(source_ids), 0),
                NULLIF(retrieval_context_count, 0),
                0
              ) > 0
            ),
            COUNT(*)
          ) AS groundedness_rate,
          AVG(IF(
            asks_detected_count > 0,
            SAFE_DIVIDE(asks_answered_count, asks_detected_count),
            NULL
          )) AS answer_completeness,
          AVG(IF(
            COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) > 0,
            LEAST(
              1.0,
              SAFE_DIVIDE(
                IFNULL(citation_count, 0),
                COALESCE(
                  NULLIF(ARRAY_LENGTH(source_ids), 0),
                  NULLIF(retrieval_context_count, 0),
                  0
                )
              )
            ),
            NULL
          )) AS citation_coverage,
          COUNTIF(
            output_hash IS NOT NULL
            AND COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) = 0
            AND NOT (
              LOWER(IFNULL(result_type, '')) = 'fallback'
              OR STRPOS(LOWER(IFNULL(fallback_action, '')), 'fallback') > 0
              OR STRPOS(LOWER(IFNULL(fallback_action, '')), 'clarification') > 0
              OR STRPOS(LOWER(IFNULL(fallback_reason, '')), 'missing') > 0
              OR STRPOS(LOWER(IFNULL(fallback_reason, '')), 'gap') > 0
              OR STRPOS(LOWER(IFNULL(fallback_reason, '')), 'context') > 0
            )
          ) AS answer_without_context_count,
          COUNTIF(
            COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) = 0
            AND (
              LOWER(IFNULL(result_type, '')) = 'fallback'
              OR STRPOS(LOWER(IFNULL(fallback_action, '')), 'fallback') > 0
              OR STRPOS(LOWER(IFNULL(fallback_action, '')), 'clarification') > 0
              OR STRPOS(LOWER(IFNULL(fallback_reason, '')), 'missing') > 0
              OR STRPOS(LOWER(IFNULL(fallback_reason, '')), 'gap') > 0
              OR STRPOS(LOWER(IFNULL(fallback_reason, '')), 'context') > 0
            )
          ) AS fallback_without_context_count
        FROM ${ragTurns}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
      ),
      score_stats AS (
        SELECT
          AVG(IF(score_name IN ('answer_relevance', 'response_relevance', 'semantic_relevance'), numeric_value, NULL)) AS answer_relevance,
          AVG(IF(score_name IN ('toxicity', 'toxicity_score'), numeric_value, NULL)) AS toxicity_score,
          SAFE_DIVIDE(
            COUNTIF(score_name IN ('guardrail_pass', 'safety_guardrail_pass') AND boolean_value = TRUE),
            COUNTIF(score_name IN ('guardrail_pass', 'safety_guardrail_pass') AND boolean_value IS NOT NULL)
          ) AS guardrail_pass_rate,
          COUNTIF(score_name IN ('toxicity_detected', 'toxic_output') AND boolean_value = TRUE) AS toxicity_violation_count
        FROM ${scores}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
      ),
      eval_stats AS (
        SELECT
          COUNT(*) AS eval_run_count,
          SUM(IFNULL(sampled_count, 0)) AS eval_sampled_count,
          SUM(IFNULL(passed_count, 0)) AS eval_passed_count,
          SUM(IFNULL(failed_count, 0)) AS eval_failed_count,
          SAFE_DIVIDE(SUM(IFNULL(passed_count, 0)), SUM(IFNULL(sampled_count, 0))) AS eval_pass_rate
        FROM ${evalRuns}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
      )
      SELECT
        rag_turn_count,
        grounded_turn_count,
        rag_issue_count,
        ROUND(COALESCE(groundedness_rate, SAFE_DIVIDE(grounded_turn_count, rag_turn_count)) * 100, 1) AS groundedness_pct,
        ROUND(answer_relevance * 100, 1) AS answer_relevance_pct,
        ROUND(answer_completeness * 100, 1) AS answer_completeness_pct,
        ROUND(citation_coverage * 100, 1) AS citation_coverage_pct,
        ROUND(guardrail_pass_rate * 100, 1) AS guardrail_pass_pct,
        ROUND(toxicity_score * 100, 1) AS toxicity_score_pct,
        toxicity_violation_count,
        answer_without_context_count,
        fallback_without_context_count,
        eval_run_count,
        eval_sampled_count,
        eval_passed_count,
        eval_failed_count,
        ROUND(eval_pass_rate * 100, 1) AS eval_pass_pct,
        ROUND(
          SAFE_DIVIDE(
            IFNULL(COALESCE(groundedness_rate, SAFE_DIVIDE(grounded_turn_count, rag_turn_count)) * 0.35, 0)
              + IFNULL(answer_relevance * 0.25, 0)
              + IFNULL(answer_completeness * 0.20, 0)
              + IFNULL(guardrail_pass_rate * 0.20, 0),
            IF(COALESCE(groundedness_rate, SAFE_DIVIDE(grounded_turn_count, rag_turn_count)) IS NULL, 0, 0.35)
              + IF(answer_relevance IS NULL, 0, 0.25)
              + IF(answer_completeness IS NULL, 0, 0.20)
              + IF(guardrail_pass_rate IS NULL, 0, 0.20)
          ) * 100,
          1
        ) AS generation_quality_score
      FROM rag_stats
      CROSS JOIN score_stats
      CROSS JOIN eval_stats
    `;
  }

  if (params.queryName === "system_performance") {
    return `
      WITH trace_stats AS (
        SELECT
          COUNT(*) AS trace_count,
          AVG(latency_ms) AS avg_latency_ms,
          APPROX_QUANTILES(latency_ms, 100)[OFFSET(50)] AS p50_latency_ms,
          APPROX_QUANTILES(latency_ms, 100)[OFFSET(95)] AS p95_latency_ms,
          APPROX_QUANTILES(latency_ms, 100)[OFFSET(99)] AS p99_latency_ms,
          SUM(IFNULL(total_tokens, 0)) AS total_tokens,
          SAFE_DIVIDE(SUM(IFNULL(total_tokens, 0)), SUM(latency_ms) / 1000) AS tokens_per_second,
          SAFE_DIVIDE(SUM(IFNULL(completion_tokens, 0)), SUM(latency_ms) / 1000) AS output_tokens_per_second
        FROM ${traces}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
      ),
      rag_stats AS (
        SELECT
          COUNT(*) AS rag_turn_count,
          AVG(duration_ms) AS avg_rag_duration_ms,
          APPROX_QUANTILES(duration_ms, 100)[OFFSET(95)] AS p95_rag_duration_ms,
          APPROX_QUANTILES(duration_ms, 100)[OFFSET(99)] AS p99_rag_duration_ms
        FROM ${ragTurns}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
          AND duration_ms IS NOT NULL
      )
      SELECT
        trace_count,
        avg_latency_ms,
        p50_latency_ms,
        p95_latency_ms,
        p99_latency_ms,
        total_tokens,
        tokens_per_second,
        output_tokens_per_second,
        CAST(NULL AS FLOAT64) AS avg_time_to_first_token_ms,
        CAST(NULL AS FLOAT64) AS p95_time_to_first_token_ms,
        'unavailable: llm_trace_events does not currently emit time_to_first_token_ms' AS time_to_first_token_note,
        rag_turn_count,
        avg_rag_duration_ms,
        p95_rag_duration_ms,
        p99_rag_duration_ms
      FROM trace_stats
      CROSS JOIN rag_stats
    `;
  }

  if (params.queryName === "operational_efficiency") {
    return `
      WITH trace_stats AS (
      SELECT
        COUNT(*) AS trace_count,
        COUNTIF(status = 'error') AS error_count,
        ROUND(SAFE_DIVIDE(COUNTIF(status = 'error'), COUNT(*)) * 100, 1) AS error_rate_pct,
        SUM(IFNULL(prompt_tokens, 0)) AS prompt_tokens,
        SUM(IFNULL(completion_tokens, 0)) AS completion_tokens,
        SUM(IFNULL(thinking_tokens, 0)) AS thinking_tokens,
        SUM(IFNULL(cached_prompt_tokens, 0)) AS cached_prompt_tokens,
        ROUND(SAFE_DIVIDE(SUM(IFNULL(cached_prompt_tokens, 0)), SUM(IFNULL(prompt_tokens, 0))) * 100, 1) AS cached_prompt_token_share_pct,
        SUM(IFNULL(total_tokens, 0)) AS total_tokens,
        ROUND(SAFE_DIVIDE(SUM(IFNULL(prompt_tokens, 0)), SUM(IFNULL(total_tokens, 0))) * 100, 1) AS prompt_token_share_pct,
        ROUND(SAFE_DIVIDE(SUM(IFNULL(completion_tokens, 0)), SUM(IFNULL(total_tokens, 0))) * 100, 1) AS completion_token_share_pct,
        SUM(${totalCost}) AS total_cost_usd,
        SAFE_DIVIDE(SUM(${totalCost}), COUNT(*)) AS avg_cost_per_call,
        SAFE_DIVIDE(SUM(${totalCost}), SUM(IFNULL(total_tokens, 0)) / 1000) AS cost_per_1k_tokens_usd
      FROM ${traces}
      WHERE ${workspaceScope}
        AND event_ts BETWEEN @start_ts AND @end_ts
      ),
      cache_stats AS (
        SELECT
          COUNTIF(pipeline_path = 'semantic_cache_hit') AS semantic_cache_hit_count,
          COUNTIF(pipeline_path IS NOT NULL) AS semantic_cache_observed_count
        FROM ${ragTurns}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
      )
      SELECT
        trace_stats.*,
        semantic_cache_hit_count,
        semantic_cache_observed_count,
        ROUND(
          SAFE_DIVIDE(
            semantic_cache_hit_count,
            semantic_cache_observed_count
          ) * 100,
          1
        ) AS semantic_cache_hit_rate_pct
      FROM trace_stats
      CROSS JOIN cache_stats
    `;
  }

  if (params.queryName === "spend_overview") {
    return `
      SELECT
        SUM(${totalCost}) AS total_cost_usd,
        SUM(${inputCost}) AS input_cost_usd,
        SUM(${outputCost}) AS output_cost_usd,
        COUNT(*) AS trace_count,
        SAFE_DIVIDE(SUM(${totalCost}), COUNT(*)) AS avg_cost_per_call,
        SUM(IFNULL(total_tokens, 0)) AS total_tokens
      FROM ${traces}
      WHERE ${workspaceScope}
        AND event_ts BETWEEN @start_ts AND @end_ts
    `;
  }

  if (params.queryName === "spend_daily") {
    return `
      SELECT
        DATE(event_ts) AS date,
        SUM(${totalCost}) AS total_cost_usd,
        COUNT(*) AS trace_count
      FROM ${traces}
      WHERE ${workspaceScope}
        AND event_ts BETWEEN @start_ts AND @end_ts
      GROUP BY date
      ORDER BY date ASC
      LIMIT @limit
    `;
  }

  if (params.queryName === "spend_by_operation") {
    return `
      SELECT
        operation,
        COUNT(*) AS calls,
        SUM(${totalCost}) AS total_cost_usd,
        SUM(IFNULL(total_tokens, 0)) AS total_tokens
      FROM ${traces}
      WHERE ${workspaceScope}
        AND event_ts BETWEEN @start_ts AND @end_ts
      GROUP BY operation
      ORDER BY total_cost_usd DESC
      LIMIT @limit
    `;
  }

  if (params.queryName === "model_breakdown") {
    return `
      SELECT
        provider,
        model,
        operation,
        COUNT(*) AS calls,
        COUNTIF(status = 'error') AS errors,
        AVG(latency_ms) AS avg_latency_ms,
        SUM(total_tokens) AS total_tokens,
        SUM(${totalCost}) AS total_cost_usd
      FROM ${traces}
      WHERE ${workspaceScope}
        AND event_ts BETWEEN @start_ts AND @end_ts
      GROUP BY provider, model, operation
      ORDER BY total_cost_usd DESC
      LIMIT @limit
    `;
  }

  if (params.queryName === "rag_failures") {
    return `
      SELECT
        result_type,
        fallback_action,
        fallback_reason,
        retrieval_path,
        COUNT(*) AS turns,
        AVG(duration_ms) AS avg_duration_ms
      FROM ${ragTurns}
      WHERE ${workspaceScope}
        AND event_ts BETWEEN @start_ts AND @end_ts
        AND (
          outcome != 'ok'
          OR result_type = 'fallback'
          OR fallback_action IS NOT NULL
          OR IFNULL(retrieval_context_count, 0) = 0
        )
      GROUP BY result_type, fallback_action, fallback_reason, retrieval_path
      ORDER BY turns DESC
      LIMIT @limit
    `;
  }

  if (params.queryName === "airi_chat_overview") {
    return `
      SELECT
        (SELECT COUNT(*) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND operation = 'airi_chat.reply') AS trace_count,
        (SELECT COUNTIF(status = 'error') FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND operation = 'airi_chat.reply') AS error_count,
        (SELECT AVG(latency_ms) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND operation = 'airi_chat.reply') AS avg_latency_ms,
        (SELECT APPROX_QUANTILES(latency_ms, 100)[OFFSET(95)] FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND operation = 'airi_chat.reply'
            AND latency_ms IS NOT NULL) AS p95_latency_ms,
        (SELECT SUM(total_tokens) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND operation = 'airi_chat.reply') AS total_tokens,
        (SELECT SUM(${totalCost}) FROM ${traces}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND operation = 'airi_chat.reply') AS total_cost_usd,
        (SELECT COUNT(*) FROM ${ragTurns}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND source_service = 'web.airi_chat') AS rag_turn_count,
        (SELECT COUNTIF(IFNULL(retrieval_context_count, 0) > 0) FROM ${ragTurns}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND source_service = 'web.airi_chat') AS grounded_turn_count,
        (SELECT COUNTIF(IFNULL(retrieval_context_count, 0) = 0) FROM ${ragTurns}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND source_service = 'web.airi_chat') AS no_context_turn_count,
        (SELECT AVG(retrieval_context_count) FROM ${ragTurns}
          WHERE ${workspaceScope}
            AND event_ts BETWEEN @start_ts AND @end_ts
            AND source_service = 'web.airi_chat') AS avg_context_count
    `;
  }

  if (params.queryName === "airi_chat_daily") {
    return `
      WITH trace_daily AS (
        SELECT
          DATE(event_ts) AS date,
          COUNT(*) AS trace_count,
          COUNTIF(status = 'error') AS error_count,
          AVG(latency_ms) AS avg_latency_ms,
          SUM(${totalCost}) AS total_cost_usd
        FROM ${traces}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
          AND operation = 'airi_chat.reply'
        GROUP BY date
      ),
      rag_daily AS (
        SELECT
          DATE(event_ts) AS date,
          COUNT(*) AS rag_turn_count,
          COUNTIF(IFNULL(retrieval_context_count, 0) > 0) AS grounded_turn_count,
          COUNTIF(IFNULL(retrieval_context_count, 0) = 0) AS no_context_turn_count
        FROM ${ragTurns}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
          AND source_service = 'web.airi_chat'
        GROUP BY date
      )
      SELECT
        COALESCE(trace_daily.date, rag_daily.date) AS date,
        IFNULL(trace_daily.trace_count, 0) AS trace_count,
        IFNULL(trace_daily.error_count, 0) AS error_count,
        trace_daily.avg_latency_ms AS avg_latency_ms,
        IFNULL(trace_daily.total_cost_usd, 0) AS total_cost_usd,
        IFNULL(rag_daily.rag_turn_count, 0) AS rag_turn_count,
        IFNULL(rag_daily.grounded_turn_count, 0) AS grounded_turn_count,
        IFNULL(rag_daily.no_context_turn_count, 0) AS no_context_turn_count
      FROM trace_daily
      FULL OUTER JOIN rag_daily USING (date)
      ORDER BY date ASC
      LIMIT @limit
    `;
  }

  if (params.queryName === "airi_chat_issues") {
    return `
      SELECT
        result_type,
        fallback_action,
        fallback_reason,
        retrieval_path,
        COUNT(*) AS turns,
        AVG(duration_ms) AS avg_duration_ms
      FROM ${ragTurns}
      WHERE ${workspaceScope}
        AND event_ts BETWEEN @start_ts AND @end_ts
        AND source_service = 'web.airi_chat'
        AND (
          outcome != 'ok'
          OR result_type = 'fallback'
          OR fallback_action IS NOT NULL
          OR IFNULL(retrieval_context_count, 0) = 0
        )
      GROUP BY result_type, fallback_action, fallback_reason, retrieval_path
      ORDER BY turns DESC
      LIMIT @limit
    `;
  }

  if (params.queryName === "airi_chat_quality_score") {
    return `
      WITH trace_summary AS (
        SELECT
          COUNT(*) AS trace_count,
          COUNTIF(status = 'error') AS error_count,
          SUM(${totalCost}) AS total_cost_usd
        FROM ${traces}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
          AND operation = 'airi_chat.reply'
      ),
      rag_summary AS (
        SELECT
          COUNT(*) AS answer_count,
          COUNTIF(
            COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) > 0
          ) AS grounded_count,
          COUNTIF(
            COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) = 0
          ) AS no_context_count,
          SAFE_DIVIDE(
            COUNTIF(duration_ms <= 10000),
            COUNTIF(duration_ms IS NOT NULL)
          ) AS latency_target_pass_rate,
          AVG(IF(
            COALESCE(
              NULLIF(ARRAY_LENGTH(source_ids), 0),
              NULLIF(retrieval_context_count, 0),
              0
            ) > 0,
            LEAST(
              1.0,
              SAFE_DIVIDE(
                IFNULL(citation_count, 0),
                COALESCE(
                  NULLIF(ARRAY_LENGTH(source_ids), 0),
                  NULLIF(retrieval_context_count, 0),
                  0
                )
              )
            ),
            NULL
          )) AS citation_coverage
        FROM ${ragTurns}
        WHERE ${workspaceScope}
          AND event_ts BETWEEN @start_ts AND @end_ts
          AND source_service = 'web.airi_chat'
      )
      SELECT
        rag_summary.answer_count,
        SAFE_DIVIDE(rag_summary.grounded_count, rag_summary.answer_count) AS grounded_rate,
        SAFE_DIVIDE(rag_summary.no_context_count, rag_summary.answer_count) AS no_context_rate,
        rag_summary.latency_target_pass_rate,
        SAFE_DIVIDE(trace_summary.error_count, trace_summary.trace_count) AS error_rate,
        rag_summary.citation_coverage,
        SAFE_DIVIDE(trace_summary.total_cost_usd, rag_summary.answer_count) AS cost_per_answer,
        rag_summary.answer_count < 50 AS sample_size_warning
      FROM rag_summary
      CROSS JOIN trace_summary
    `;
  }

  return `
    SELECT
      DATE(event_ts) AS date,
      score_name,
      COUNT(*) AS score_count,
      AVG(numeric_value) AS avg_numeric_value,
      COUNTIF(boolean_value = TRUE) AS true_count,
      COUNTIF(boolean_value = FALSE) AS false_count
    FROM ${scores}
    WHERE ${workspaceScope}
      AND event_ts BETWEEN @start_ts AND @end_ts
    GROUP BY date, score_name
    ORDER BY date ASC, score_name ASC
    LIMIT @limit
  `;
}

function parseBigQueryValue(field: BigQueryField, rawValue: unknown): unknown {
  if (rawValue === null || rawValue === undefined) return null;
  if (field.mode === "REPEATED" && Array.isArray(rawValue)) {
    const elementField = { ...field, mode: undefined };
    return rawValue.map((item) => {
      const elementValue =
        item && typeof item === "object" && "v" in item
          ? (item as { v?: unknown }).v
          : item;
      return parseBigQueryValue(elementField, elementValue);
    });
  }
  if (field.type === "INTEGER" || field.type === "INT64") {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : null;
  }
  if (
    field.type === "FLOAT" ||
    field.type === "FLOAT64" ||
    field.type === "NUMERIC" ||
    field.type === "BIGNUMERIC"
  ) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : null;
  }
  if (field.type === "BOOLEAN" || field.type === "BOOL") {
    return rawValue === true || rawValue === "true";
  }
  return rawValue;
}

function parseBigQueryRows(
  response: BigQueryQueryResponse,
): Array<Record<string, unknown>> {
  const fields = response.schema?.fields || [];
  return (response.rows || []).map((row) => {
    const values = row.f || [];
    const record: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      record[field.name] = parseBigQueryValue(field, values[index]?.v);
    });
    return record;
  });
}

function boundedBigQueryQueryDeadlineMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return BIGQUERY_QUERY_DEADLINE_MS;
  return Math.max(1, Math.min(BIGQUERY_QUERY_DEADLINE_MS, Math.floor(value!)));
}

function getRemainingBigQueryQueryMs(
  deadlineAt: number,
  now: () => number,
): number {
  const remaining = Math.floor(deadlineAt - now());
  if (remaining <= 0) {
    throw new Error(
      "BigQuery query did not complete within the bounded deadline",
    );
  }
  return remaining;
}

function normalizeBigQueryPageToken(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("BigQuery query response included an invalid page token");
  }
  const token = value.trim();
  if (!token || token.length > BIGQUERY_MAX_PAGE_TOKEN_LENGTH) {
    throw new Error("BigQuery query response included an invalid page token");
  }
  return token;
}

function normalizeBigQueryJobReference(
  value: BigQueryQueryResponse["jobReference"],
  expectedProjectId: string,
): { jobId: string; location: string | null } | null {
  if (!value) return null;
  if (
    value.projectId !== undefined &&
    String(value.projectId).trim() !== expectedProjectId
  ) {
    throw new Error("BigQuery query response referenced an unexpected project");
  }
  const jobId = String(value.jobId || "").trim();
  const location = String(value.location || "").trim();
  if (!jobId || jobId.length > 1_024 || location.length > 128) {
    throw new Error(
      "BigQuery query response did not include a usable job reference",
    );
  }
  return { jobId, location: location || null };
}

function bigQueryTotalRowsExceedsLimit(
  totalRows: string | undefined,
  limit: number,
): boolean {
  if (!totalRows || !/^\d{1,30}$/.test(totalRows)) return false;
  return BigInt(totalRows) > BigInt(limit);
}

async function fetchBigQueryQueryResponse(input: {
  fetchFn: FetchLike;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<BigQueryQueryResponse> {
  const response = await input.fetchFn(input.url, {
    ...input.init,
    redirect: "error",
    signal: AbortSignal.timeout(
      Math.max(1, Math.min(BIGQUERY_REQUEST_TIMEOUT_MS, input.timeoutMs)),
    ),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `BigQuery query failed: HTTP ${response.status} ${bodyText.slice(0, 500)}`,
    );
  }
  try {
    const body = JSON.parse(bodyText) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body as BigQueryQueryResponse;
  } catch {
    throw new Error("BigQuery query returned an invalid JSON response");
  }
}

export async function queryLlmAnalyticsFromBigQuery(
  request: LlmAnalyticsQueryGatewayRequest,
  options?: {
    fetchFn?: FetchLike;
    now?: () => number;
    queryDeadlineMs?: number;
  },
): Promise<LlmAnalyticsQueryGatewayResponse> {
  const workspaceId = String(request.workspaceId || "").trim();
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!isQueryName(request.query)) {
    throw new Error("query is not allowlisted");
  }

  const projectId = getGcpProjectId();
  if (!isGcpLlmAnalyticsEnabled() || !projectId) {
    return {
      query: request.query,
      workspaceId,
      rows: [],
      limited: false,
      source: "disabled",
      generatedAt: new Date().toISOString(),
    };
  }

  const maximumBytesBilled = getMaximumBytesBilled();
  const fetchFn = options?.fetchFn || fetch;
  const token = await fetchGoogleAccessToken(fetchFn);
  const now = options?.now || Date.now;
  const queryDeadlineMs = boundedBigQueryQueryDeadlineMs(
    options?.queryDeadlineMs,
  );
  const deadlineAt = now() + queryDeadlineMs;
  const days = clampDays(request.days);
  const limit = clampLimit(request.limit);
  const queryLimit = limit + 1;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const requestedWorkspaceIds = Array.isArray(request.workspaceIds)
    ? request.workspaceIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const useMultiWorkspace = requestedWorkspaceIds.length > 1;
  const workspaceIds = useMultiWorkspace
    ? requestedWorkspaceIds
    : [workspaceId];

  const query = buildAllowedQuery({
    projectId,
    datasetId: getDatasetId(),
    queryName: request.query,
    useMultiWorkspace,
  });
  const queryParameters: Array<{
    name: string;
    parameterType: { type: string; arrayType?: { type: string } };
    parameterValue: { value?: string; arrayValues?: Array<{ value: string }> };
  }> = [
    {
      name: "start_ts",
      parameterType: { type: "TIMESTAMP" },
      parameterValue: { value: start.toISOString() },
    },
    {
      name: "end_ts",
      parameterType: { type: "TIMESTAMP" },
      parameterValue: { value: end.toISOString() },
    },
  ];
  if (useMultiWorkspace) {
    queryParameters.unshift({
      name: "workspace_ids",
      parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
      parameterValue: {
        arrayValues: workspaceIds.map((id) => ({ value: id })),
      },
    });
  } else {
    queryParameters.unshift({
      name: "workspace_id",
      parameterType: { type: "STRING" },
      parameterValue: { value: workspaceIds[0] || workspaceId },
    });
  }
  if (queryUsesLimit(request.query)) {
    queryParameters.push({
      name: "limit",
      parameterType: { type: "INT64" },
      parameterValue: { value: String(queryLimit) },
    });
  }

  let body = await fetchBigQueryQueryResponse({
    fetchFn,
    url: `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(
      projectId,
    )}/queries`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        query,
        useLegacySql: false,
        maximumBytesBilled,
        parameterMode: "NAMED",
        queryParameters,
        maxResults: queryLimit,
        timeoutMs: Math.min(BIGQUERY_REQUEST_TIMEOUT_MS, queryDeadlineMs),
        jobTimeoutMs: String(queryDeadlineMs),
      }),
    },
    timeoutMs: getRemainingBigQueryQueryMs(deadlineAt, now),
  });

  let jobReference = normalizeBigQueryJobReference(
    body.jobReference,
    projectId,
  );
  let schema = body.schema;
  const rawRows: BigQueryRow[] =
    body.jobComplete === false ? [] : body.rows || [];
  let totalRows = body.totalRows;
  let pageToken =
    body.jobComplete === false
      ? null
      : normalizeBigQueryPageToken(body.pageToken);
  const seenPageTokens = new Set<string>();
  let resultRequests = 0;

  while (
    body.jobComplete === false ||
    (pageToken !== null && rawRows.length < queryLimit)
  ) {
    if (!jobReference) {
      throw new Error(
        "BigQuery query response did not include a usable job reference",
      );
    }
    resultRequests += 1;
    if (resultRequests > BIGQUERY_MAX_RESULT_REQUESTS) {
      throw new Error(
        "BigQuery query exceeded the bounded result request limit",
      );
    }
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error("BigQuery query returned a repeated page token");
      }
      seenPageTokens.add(pageToken);
    }

    const remainingMs = getRemainingBigQueryQueryMs(deadlineAt, now);
    const queryResultUrl = new URL(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(
        projectId,
      )}/queries/${encodeURIComponent(jobReference.jobId)}`,
    );
    if (jobReference.location) {
      queryResultUrl.searchParams.set("location", jobReference.location);
    }
    queryResultUrl.searchParams.set(
      "maxResults",
      String(Math.max(1, queryLimit - rawRows.length)),
    );
    queryResultUrl.searchParams.set(
      "timeoutMs",
      String(Math.min(BIGQUERY_REQUEST_TIMEOUT_MS, remainingMs)),
    );
    if (pageToken) queryResultUrl.searchParams.set("pageToken", pageToken);

    body = await fetchBigQueryQueryResponse({
      fetchFn,
      url: queryResultUrl.toString(),
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      timeoutMs: remainingMs,
    });
    const nextJobReference = normalizeBigQueryJobReference(
      body.jobReference,
      projectId,
    );
    if (nextJobReference) jobReference = nextJobReference;
    if (body.jobComplete === false) {
      pageToken = null;
      continue;
    }
    if (body.schema) schema = body.schema;
    const remainingRows = Math.max(0, queryLimit - rawRows.length);
    rawRows.push(...(body.rows || []).slice(0, remainingRows));
    if (body.totalRows !== undefined) totalRows = body.totalRows;
    pageToken = normalizeBigQueryPageToken(body.pageToken);
  }

  const rows = parseBigQueryRows({ schema, rows: rawRows });
  const limited =
    rows.length > limit ||
    pageToken !== null ||
    bigQueryTotalRowsExceedsLimit(totalRows, limit);
  return {
    query: request.query,
    workspaceId,
    rows: limited ? rows.slice(0, limit) : rows,
    limited,
    source: "bigquery",
    generatedAt: new Date().toISOString(),
  };
}
