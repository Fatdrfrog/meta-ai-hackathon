import { createHash } from "node:crypto";
import {
  coerceCompactString as compactString,
  asNullableRecord,
} from "@icecore/shared/lib/value-utils";
import { estimateLlmCostUsd } from "./llm-pricing";

export const LLM_ANALYTICS_SCHEMA_VERSION = 2;
export const LLM_ANALYTICS_DEFAULT_BATCH_LIMIT = 100;
export const LLM_ANALYTICS_DEFAULT_EXCERPT_LIMIT = 240;
export const LLM_ANALYTICS_PRODUCT_EVENTS_TOPIC = "icecore-llm-product-events";

export const LLM_ANALYTICS_EVENT_KINDS = [
  "llm_trace",
  "rag_turn",
  "llm_score",
  "eval_run",
  "customer_feedback",
  "human_evaluation",
] as const;

export const LLM_ANALYTICS_WAREHOUSE_EVENT_KINDS = [
  "llm_trace",
  "rag_turn",
  "llm_score",
  "eval_run",
] as const;

const CUSTOMER_FEEDBACK_CHANNELS = [
  "whatsapp",
  "web",
  "telegram",
  "instagram",
  "email",
  "other",
] as const;
const CUSTOMER_FEEDBACK_STAGES = ["helpfulness", "reason"] as const;
const CUSTOMER_FEEDBACK_REASON_CODES = [
  "incorrect",
  "not_enough_detail",
  "did_not_answer",
  "unsafe_or_inappropriate",
  "other",
] as const;
const HUMAN_EVALUATION_STATUSES = [
  "queued",
  "reviewed",
  "accepted_for_golden",
  "rejected",
  "needs_followup",
] as const;
const HUMAN_EVALUATION_DATASET_DECISIONS = [
  "candidate",
  "add_to_golden",
  "do_not_add",
  "needs_more_context",
] as const;
const HUMAN_EVALUATION_DATASET_SPLITS = [
  "train",
  "validation",
  "test",
] as const;

export type LlmAnalyticsEventKind = (typeof LLM_ANALYTICS_EVENT_KINDS)[number];
export type LlmAnalyticsWarehouseEventKind =
  (typeof LLM_ANALYTICS_WAREHOUSE_EVENT_KINDS)[number];

export type LlmAnalyticsScoreDataType =
  | "numeric"
  | "boolean"
  | "categorical"
  | "text";

export type LlmAnalyticsScoreSource =
  | "system_eval"
  | "llm_judge"
  | "human_review"
  | "customer_feedback";

export type LlmAnalyticsStatus = "ok" | "error" | "cancelled";

/** Visible output and billable thinking are separate provider counters. */
export type LlmTokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  thinking_tokens?: number;
  cached_prompt_tokens?: number;
  /** Prompt tokens written to the prompt cache; priced, not persisted. */
  cache_write_prompt_tokens?: number;
};

export function normalizeLlmTokenUsage(
  usage: LlmTokenUsage | null | undefined,
): LlmTokenUsage | undefined {
  if (!usage) return undefined;
  const normalized: LlmTokenUsage = {};
  for (const key of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "thinking_tokens",
    "cached_prompt_tokens",
    "cache_write_prompt_tokens",
  ] as const) {
    const value = usage[key];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      normalized[key] = value;
    }
  }
  if (
    normalized.cached_prompt_tokens !== undefined &&
    normalized.prompt_tokens !== undefined
  ) {
    normalized.cached_prompt_tokens = Math.min(
      normalized.cached_prompt_tokens,
      normalized.prompt_tokens,
    );
  }
  if (
    normalized.cache_write_prompt_tokens !== undefined &&
    normalized.prompt_tokens !== undefined
  ) {
    normalized.cache_write_prompt_tokens = Math.min(
      normalized.cache_write_prompt_tokens,
      normalized.prompt_tokens - (normalized.cached_prompt_tokens ?? 0),
    );
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export type LlmAnalyticsCommonEvent = {
  event_id: string;
  event_kind: LlmAnalyticsEventKind;
  event_ts: string;
  schema_version: number;
  workspace_id: string;
  conversation_id?: string | null;
  message_id?: string | null;
  trace_id?: string | null;
  source_service?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type LlmTraceEvent = LlmAnalyticsCommonEvent & {
  event_kind: "llm_trace";
  operation: string;
  provider: string;
  model: string;
  status: LlmAnalyticsStatus;
  latency_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  thinking_tokens?: number | null;
  cached_prompt_tokens?: number | null;
  total_tokens?: number | null;
  finish_reason?: string | null;
  input_hash?: string | null;
  output_hash?: string | null;
  input_excerpt?: string | null;
  output_excerpt?: string | null;
  error_message?: string | null;
  estimated_cost_usd?: number | null;
  input_cost_usd?: number | null;
  output_cost_usd?: number | null;
  pricing_version?: string | null;
  billing_source?: "platform" | "customer";
  company_id?: string | null;
  action_id?: string | null;
  customer_cost_usd?: number | null;
};

export type RagTurnEvent = LlmAnalyticsCommonEvent & {
  event_kind: "rag_turn";
  answer_message_id?: string | null;
  channel?: string | null;
  result_type?: string | null;
  outcome?: string | null;
  product_mode?: string | null;
  pipeline_path?: string | null;
  retrieval_path?: string | null;
  duration_ms?: number | null;
  generation_model?: string | null;
  generation_latency_ms?: number | null;
  source_ids: string[];
  citation_count?: number | null;
  retrieval_context_count?: number | null;
  asks_detected_count?: number | null;
  asks_answered_count?: number | null;
  missing_asks_count?: number | null;
  fallback_action?: string | null;
  fallback_reason?: string | null;
  input_hash?: string | null;
  output_hash?: string | null;
  input_excerpt?: string | null;
  output_excerpt?: string | null;
};

export type LlmScoreEvent = LlmAnalyticsCommonEvent & {
  event_kind: "llm_score";
  score_name: string;
  score_source: LlmAnalyticsScoreSource;
  data_type: LlmAnalyticsScoreDataType;
  numeric_value?: number | null;
  boolean_value?: boolean | null;
  string_value?: string | null;
  comment?: string | null;
  reasoning_excerpt?: string | null;
};

export type EvalRunEvent = LlmAnalyticsCommonEvent & {
  event_kind: "eval_run";
  eval_run_id: string;
  evaluator_name: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  sampled_count?: number | null;
  passed_count?: number | null;
  failed_count?: number | null;
  error_message?: string | null;
};

export type CustomerFeedbackEvent = LlmAnalyticsCommonEvent & {
  event_kind: "customer_feedback";
  channel: (typeof CUSTOMER_FEEDBACK_CHANNELS)[number];
  feedback_stage: (typeof CUSTOMER_FEEDBACK_STAGES)[number];
  feedback_value: string;
  helpful?: boolean | null;
  reason_code?: (typeof CUSTOMER_FEEDBACK_REASON_CODES)[number] | null;
  source_message_id?: string | null;
  feedback_prompt_message_id?: string | null;
  customer_message_id?: string | null;
  input_hash?: string | null;
  output_hash?: string | null;
  input_excerpt?: string | null;
  output_excerpt?: string | null;
  customer_comment_excerpt?: string | null;
};

export type HumanEvaluationEvent = LlmAnalyticsCommonEvent & {
  event_kind: "human_evaluation";
  evaluator_user_id?: string | null;
  evaluation_status: (typeof HUMAN_EVALUATION_STATUSES)[number];
  dataset_decision: (typeof HUMAN_EVALUATION_DATASET_DECISIONS)[number];
  dataset_split?: (typeof HUMAN_EVALUATION_DATASET_SPLITS)[number] | null;
  relevance_score?: number | null;
  trustworthiness_score?: number | null;
  conciseness_score?: number | null;
  completeness_score?: number | null;
  safety_score?: number | null;
  overall_score?: number | null;
  judge_explanation?: string | null;
  expected_behavior?: string | null;
  expected_source_ids?: string[];
  linked_feedback_event_id?: string | null;
  linked_rag_turn_event_id?: string | null;
};

export type LlmAnalyticsEvent =
  | LlmTraceEvent
  | RagTurnEvent
  | LlmScoreEvent
  | EvalRunEvent
  | CustomerFeedbackEvent
  | HumanEvaluationEvent;

export type LlmAnalyticsWarehouseScoreEvent = LlmScoreEvent & {
  score_source: Exclude<LlmAnalyticsScoreSource, "system_eval">;
};

export type LlmAnalyticsWarehouseEvent =
  | LlmTraceEvent
  | RagTurnEvent
  | LlmAnalyticsWarehouseScoreEvent
  | EvalRunEvent;

export type LlmAnalyticsEventBatch = {
  events: LlmAnalyticsEvent[];
};

export type LlmAnalyticsPubSubMessage = {
  data: string;
  attributes: {
    event_id: string;
    event_kind: LlmAnalyticsEventKind;
    workspace_id: string;
    schema_version: string;
  };
};

export type LlmAnalyticsProductPubSubPublishPayload = {
  topic: string;
  messages: LlmAnalyticsPubSubMessage[];
};

export type BuildLlmTraceEventParams = {
  eventTs?: string | Date;
  workspaceId: string;
  companyId?: string | null;
  actionId?: string | null;
  billingSource?: "platform" | "customer";
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  operation: string;
  provider: string;
  model: string;
  status: LlmAnalyticsStatus;
  latencyMs?: number | null;
  usage?: LlmTokenUsage | null;
  finishReason?: string | null;
  inputText?: string | null;
  outputText?: string | null;
  errorMessage?: string | null;
  sourceService?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type BuildRagTurnEventParams = {
  eventTs?: string | Date;
  answerMessageId?: string | null;
  inputText?: string | null;
  outputText?: string | null;
  sourceService?: string | null;
  metadata?: Record<string, unknown> | null;
  wideEvent: Record<string, unknown>;
};

export type BuildCustomerFeedbackEventParams = {
  eventTs?: string | Date;
  workspaceId: string;
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  sourceService?: string | null;
  metadata?: Record<string, unknown> | null;
  channel: CustomerFeedbackEvent["channel"];
  feedbackStage: CustomerFeedbackEvent["feedback_stage"];
  feedbackValue: string;
  helpful?: boolean | null;
  reasonCode?: CustomerFeedbackEvent["reason_code"];
  sourceMessageId?: string | null;
  feedbackPromptMessageId?: string | null;
  customerMessageId?: string | null;
  inputText?: string | null;
  outputText?: string | null;
  customerComment?: string | null;
};

export type BuildHumanEvaluationEventParams = {
  eventTs?: string | Date;
  workspaceId: string;
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  sourceService?: string | null;
  metadata?: Record<string, unknown> | null;
  evaluatorUserId?: string | null;
  evaluationStatus: HumanEvaluationEvent["evaluation_status"];
  datasetDecision: HumanEvaluationEvent["dataset_decision"];
  datasetSplit?: HumanEvaluationEvent["dataset_split"];
  relevanceScore?: number | null;
  trustworthinessScore?: number | null;
  concisenessScore?: number | null;
  completenessScore?: number | null;
  safetyScore?: number | null;
  overallScore?: number | null;
  judgeExplanation?: string | null;
  expectedBehavior?: string | null;
  expectedSourceIds?: string[];
  linkedFeedbackEventId?: string | null;
  linkedRagTurnEventId?: string | null;
};

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (value && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function stableEventId(parts: unknown[]): string {
  return stableHash(stableJson(parts));
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => compactString(item))
        .filter((item): item is string => Boolean(item)),
    ),
  );
}

function jsonRecord(value: Record<string, unknown> | null | undefined) {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function buildInputHash(text?: string | null): string | null {
  const normalized = compactString(text);
  return normalized ? stableHash(normalized) : null;
}

function buildOutputHash(text?: string | null): string | null {
  const normalized = compactString(text);
  return normalized ? stableHash(normalized) : null;
}

export function redactAndExcerptText(
  text: string | null | undefined,
  limit: number = LLM_ANALYTICS_DEFAULT_EXCERPT_LIMIT,
): string | null {
  const normalized = compactString(text);
  if (!normalized) return null;

  const redacted = normalized
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]");

  return redacted.slice(0, Math.max(0, limit));
}

export function buildLlmTraceEvent(
  params: BuildLlmTraceEventParams,
): LlmTraceEvent {
  const eventTs = isoTimestamp(params.eventTs);
  const workspaceId = compactString(params.workspaceId);
  if (!workspaceId) {
    throw new Error("workspaceId is required for LLM trace events");
  }

  const eventId = stableEventId([
    "llm_trace",
    workspaceId,
    params.conversationId || null,
    params.messageId || null,
    params.traceId || null,
    params.operation,
    params.provider,
    params.model,
    eventTs,
  ]);

  const usage = normalizeLlmTokenUsage(params.usage);
  const promptTokens = toNullableNumber(usage?.prompt_tokens);
  const completionTokens = toNullableNumber(usage?.completion_tokens);
  const costEstimate =
    promptTokens !== null ||
    completionTokens !== null ||
    usage?.thinking_tokens !== undefined
      ? estimateLlmCostUsd({
          model: compactString(params.model) || "unknown",
          promptTokens,
          completionTokens,
          thinkingTokens: usage?.thinking_tokens,
          cachedPromptTokens: usage?.cached_prompt_tokens,
          cacheWritePromptTokens: usage?.cache_write_prompt_tokens,
          eventTs,
        })
      : null;

  return {
    event_id: eventId,
    event_kind: "llm_trace",
    event_ts: eventTs,
    schema_version: LLM_ANALYTICS_SCHEMA_VERSION,
    workspace_id: workspaceId,
    conversation_id: compactString(params.conversationId),
    message_id: compactString(params.messageId),
    trace_id: compactString(params.traceId),
    source_service: compactString(params.sourceService),
    metadata: jsonRecord({
      ...params.metadata,
      billing_source: params.billingSource ?? "unknown",
      company_id: params.companyId ?? null,
      action_id: params.actionId ?? null,
      customer_cost_usd:
        params.billingSource === "customer"
          ? (costEstimate?.totalCostUsd ?? null)
          : null,
    }),
    operation: compactString(params.operation) || "unknown",
    provider: compactString(params.provider) || "unknown",
    model: compactString(params.model) || "unknown",
    status: params.status,
    latency_ms: toNullableNumber(params.latencyMs),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    ...(usage?.thinking_tokens !== undefined
      ? { thinking_tokens: usage.thinking_tokens }
      : {}),
    ...(usage?.cached_prompt_tokens !== undefined
      ? { cached_prompt_tokens: usage.cached_prompt_tokens }
      : {}),
    total_tokens: toNullableNumber(usage?.total_tokens),
    finish_reason: compactString(params.finishReason),
    input_hash: buildInputHash(params.inputText),
    output_hash: buildOutputHash(params.outputText),
    input_excerpt: redactAndExcerptText(params.inputText),
    output_excerpt: redactAndExcerptText(params.outputText),
    error_message: redactAndExcerptText(params.errorMessage),
    estimated_cost_usd:
      params.billingSource === "customer"
        ? 0
        : (costEstimate?.totalCostUsd ?? null),
    input_cost_usd:
      params.billingSource === "customer"
        ? 0
        : (costEstimate?.inputCostUsd ?? null),
    output_cost_usd:
      params.billingSource === "customer"
        ? 0
        : (costEstimate?.outputCostUsd ?? null),
    pricing_version: costEstimate?.pricingVersion ?? null,
    ...(params.billingSource
      ? {
          billing_source: params.billingSource,
          company_id: compactString(params.companyId),
          action_id: compactString(params.actionId),
          customer_cost_usd:
            params.billingSource === "customer"
              ? (costEstimate?.totalCostUsd ?? null)
              : 0,
        }
      : {}),
  };
}

function collectRagSourceIds(
  wideEvent: Record<string, unknown>,
  retrieval: Record<string, unknown> | null,
): string[] {
  const candidates = [
    retrieval?.selectedSourceIds,
    retrieval?.chosenSourceIds,
    retrieval?.sourceIds,
    retrieval?.matchedSourceIds,
    asNullableRecord(retrieval?.activeSelection)?.sourceIds,
    wideEvent.selectedSourceIds,
    wideEvent.chosenSourceIds,
    wideEvent.sourceIds,
  ];

  for (const candidate of candidates) {
    const ids = asStringArray(candidate);
    if (ids.length > 0) return ids;
  }

  return [];
}

function readCoverage(
  wideEvent: Record<string, unknown>,
  retrieval: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return (
    asNullableRecord(retrieval?.coverage) ||
    asNullableRecord(wideEvent.coverage)
  );
}

function countCitations(
  wideEvent: Record<string, unknown>,
  retrieval: Record<string, unknown> | null,
): number | null {
  const explicit = toNullableNumber(wideEvent.citationCount);
  if (explicit !== null) return explicit;

  const attached = asStringArray(wideEvent.attachedArticleLinks);
  if (attached.length > 0) return attached.length;

  const citations = asStringArray(retrieval?.citations);
  return citations.length > 0 ? citations.length : null;
}

export function buildRagTurnEventFromWideEvent(
  params: BuildRagTurnEventParams,
): RagTurnEvent {
  const eventTs = isoTimestamp(params.eventTs);
  const wideEvent = params.wideEvent;
  const retrieval = asNullableRecord(wideEvent.retrieval);
  const workspaceId = compactString(wideEvent.workspaceId);
  if (!workspaceId) {
    throw new Error("workspaceId is required for RAG turn events");
  }

  const conversationId = compactString(wideEvent.conversationId);
  const sourceIds = collectRagSourceIds(wideEvent, retrieval);
  const coverage = readCoverage(wideEvent, retrieval);
  const missingAsks = asStringArray(coverage?.missingAsks);
  const asksDetected = asStringArray(coverage?.asksDetected);
  const asksAnswered = asStringArray(coverage?.asksAnswered);
  const metadata = {
    ...(params.metadata || {}),
    coverage:
      coverage &&
      (asksDetected.length || asksAnswered.length || missingAsks.length)
        ? {
            asksDetected,
            asksAnswered,
            missingAsks,
          }
        : undefined,
  };

  const resultType = compactString(wideEvent.resultType);
  const eventId = stableEventId([
    "rag_turn",
    workspaceId,
    conversationId,
    params.answerMessageId || null,
    resultType,
    eventTs,
  ]);

  return {
    event_id: eventId,
    event_kind: "rag_turn",
    event_ts: eventTs,
    schema_version: LLM_ANALYTICS_SCHEMA_VERSION,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    message_id: compactString(params.answerMessageId),
    trace_id: compactString(wideEvent.traceId),
    source_service: compactString(params.sourceService),
    metadata: jsonRecord(metadata),
    answer_message_id: compactString(params.answerMessageId),
    channel: compactString(wideEvent.channel),
    result_type: resultType,
    outcome: compactString(wideEvent.outcome),
    product_mode: compactString(wideEvent.productMode),
    pipeline_path: compactString(wideEvent.pipelinePath),
    retrieval_path: compactString(wideEvent.retrievalPath),
    duration_ms: toNullableNumber(wideEvent.durationMs),
    generation_model: compactString(wideEvent.generationModel),
    generation_latency_ms: toNullableNumber(wideEvent.generationInferenceMs),
    source_ids: sourceIds,
    citation_count: countCitations(wideEvent, retrieval),
    retrieval_context_count: sourceIds.length,
    asks_detected_count: coverage ? asksDetected.length : null,
    asks_answered_count: coverage ? asksAnswered.length : null,
    missing_asks_count: coverage ? missingAsks.length : null,
    fallback_action: compactString(wideEvent.fallbackAction),
    fallback_reason: compactString(wideEvent.fallbackReason),
    input_hash: buildInputHash(params.inputText),
    output_hash: buildOutputHash(params.outputText),
    input_excerpt: redactAndExcerptText(params.inputText),
    output_excerpt: redactAndExcerptText(params.outputText),
  };
}

function buildScoreEvent(params: {
  ragTurn: RagTurnEvent;
  scoreName: string;
  dataType: LlmAnalyticsScoreDataType;
  numericValue?: number | null;
  booleanValue?: boolean | null;
  stringValue?: string | null;
  comment?: string | null;
}): LlmScoreEvent {
  return {
    event_id: stableEventId([
      "llm_score",
      params.ragTurn.event_id,
      params.scoreName,
      params.dataType,
    ]),
    event_kind: "llm_score",
    event_ts: params.ragTurn.event_ts,
    schema_version: LLM_ANALYTICS_SCHEMA_VERSION,
    workspace_id: params.ragTurn.workspace_id,
    conversation_id: params.ragTurn.conversation_id,
    message_id: params.ragTurn.message_id,
    trace_id: params.ragTurn.trace_id || params.ragTurn.event_id,
    source_service: params.ragTurn.source_service,
    metadata: {
      rag_turn_event_id: params.ragTurn.event_id,
    },
    score_name: params.scoreName,
    score_source: "system_eval",
    data_type: params.dataType,
    numeric_value: params.numericValue ?? null,
    boolean_value: params.booleanValue ?? null,
    string_value: params.stringValue ?? null,
    comment: params.comment ?? null,
    reasoning_excerpt: null,
  };
}

function isFallbackLikeRagTurn(ragTurn: RagTurnEvent): boolean {
  const resultType = compactString(ragTurn.result_type)?.toLowerCase();
  const fallbackAction = compactString(ragTurn.fallback_action)?.toLowerCase();
  const fallbackReason = compactString(ragTurn.fallback_reason)?.toLowerCase();

  return Boolean(
    resultType === "fallback" ||
      fallbackAction?.includes("fallback") ||
      fallbackAction?.includes("clarification") ||
      fallbackReason?.includes("missing") ||
      fallbackReason?.includes("gap") ||
      fallbackReason?.includes("context"),
  );
}

function hasRagContext(ragTurn: RagTurnEvent): boolean {
  return (
    ragTurn.source_ids.length > 0 ||
    Boolean(
      ragTurn.retrieval_context_count && ragTurn.retrieval_context_count > 0,
    )
  );
}

function citationCoverageForRagTurn(ragTurn: RagTurnEvent): number | null {
  if (!hasRagContext(ragTurn)) return null;
  const contextCount =
    ragTurn.source_ids.length ||
    (typeof ragTurn.retrieval_context_count === "number"
      ? ragTurn.retrieval_context_count
      : 0);
  if (contextCount <= 0) return null;
  const citationCount =
    typeof ragTurn.citation_count === "number" && ragTurn.citation_count > 0
      ? ragTurn.citation_count
      : 0;
  return Number(Math.min(1, citationCount / contextCount).toFixed(4));
}

export function buildDeterministicScoreEventsForRagTurn(
  ragTurn: RagTurnEvent,
): LlmScoreEvent[] {
  const coverage = asNullableRecord(ragTurn.metadata?.coverage);
  const missingAsks = asStringArray(coverage?.missingAsks);
  const asksDetected = asStringArray(coverage?.asksDetected);
  const asksAnswered = asStringArray(coverage?.asksAnswered);
  const answerCompleteness =
    (ragTurn.asks_detected_count ?? asksDetected.length) === 0
      ? null
      : Number(
          (
            (ragTurn.asks_answered_count ?? asksAnswered.length) /
            (ragTurn.asks_detected_count ?? asksDetected.length)
          ).toFixed(4),
        );
  const hasContext = hasRagContext(ragTurn);
  const fallbackLike = isFallbackLikeRagTurn(ragTurn);
  const hasGeneratedOutput = Boolean(compactString(ragTurn.output_excerpt));
  const answerWithoutContext =
    hasGeneratedOutput && !hasContext && !fallbackLike;
  const fallbackWithoutContext = fallbackLike && !hasContext;
  const citationCoverage = citationCoverageForRagTurn(ragTurn);

  return [
    buildScoreEvent({
      ragTurn,
      scoreName: "rag_context_present",
      dataType: "boolean",
      booleanValue: hasContext,
      comment: hasContext
        ? null
        : "No retrieved context source ids were attached to this turn.",
    }),
    buildScoreEvent({
      ragTurn,
      scoreName: "rag_answer_without_context",
      dataType: "boolean",
      booleanValue: answerWithoutContext,
      comment: answerWithoutContext
        ? "A generated answer was emitted without retrieved source context or fallback markers."
        : null,
    }),
    buildScoreEvent({
      ragTurn,
      scoreName: "rag_fallback_without_context",
      dataType: "boolean",
      booleanValue: fallbackWithoutContext,
      comment: fallbackWithoutContext
        ? "Fallback path emitted without retrieved source context; likely knowledge gap."
        : null,
    }),
    buildScoreEvent({
      ragTurn,
      scoreName: "citation_coverage",
      dataType: "numeric",
      numericValue: citationCoverage,
      comment:
        hasContext && citationCoverage === 0
          ? "Retrieved context was attached, but no citations were recorded."
          : null,
    }),
    buildScoreEvent({
      ragTurn,
      scoreName: "answer_completeness",
      dataType: "numeric",
      numericValue: answerCompleteness,
      comment:
        missingAsks.length > 0
          ? `Missing asks: ${missingAsks.slice(0, 5).join(", ")}`
          : null,
    }),
    buildScoreEvent({
      ragTurn,
      scoreName: "latency_within_target",
      dataType: "boolean",
      booleanValue:
        typeof ragTurn.duration_ms === "number"
          ? ragTurn.duration_ms <= 10_000
          : null,
      comment:
        typeof ragTurn.duration_ms === "number" && ragTurn.duration_ms > 10_000
          ? "RAG turn exceeded the default 10s customer-facing latency target."
          : null,
    }),
  ];
}

function clampScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

export function buildCustomerFeedbackEvent(
  params: BuildCustomerFeedbackEventParams,
): CustomerFeedbackEvent {
  const eventTs = isoTimestamp(params.eventTs);
  const workspaceId = compactString(params.workspaceId);
  if (!workspaceId) {
    throw new Error("workspaceId is required for customer feedback events");
  }

  const feedbackValue = compactString(params.feedbackValue);
  if (!feedbackValue) {
    throw new Error("feedbackValue is required for customer feedback events");
  }

  const eventId = stableEventId([
    "customer_feedback",
    workspaceId,
    params.conversationId || null,
    params.messageId || null,
    params.sourceMessageId || null,
    params.feedbackPromptMessageId || null,
    params.customerMessageId || null,
    params.feedbackStage,
    feedbackValue,
    eventTs,
  ]);

  return {
    event_id: eventId,
    event_kind: "customer_feedback",
    event_ts: eventTs,
    schema_version: LLM_ANALYTICS_SCHEMA_VERSION,
    workspace_id: workspaceId,
    conversation_id: compactString(params.conversationId),
    message_id: compactString(params.messageId),
    trace_id: compactString(params.traceId),
    source_service: compactString(params.sourceService),
    metadata: jsonRecord(params.metadata),
    channel: params.channel,
    feedback_stage: params.feedbackStage,
    feedback_value: feedbackValue,
    helpful: typeof params.helpful === "boolean" ? params.helpful : null,
    reason_code: params.reasonCode ?? null,
    source_message_id: compactString(params.sourceMessageId),
    feedback_prompt_message_id: compactString(params.feedbackPromptMessageId),
    customer_message_id: compactString(params.customerMessageId),
    input_hash: buildInputHash(params.inputText),
    output_hash: buildOutputHash(params.outputText),
    input_excerpt: redactAndExcerptText(params.inputText),
    output_excerpt: redactAndExcerptText(params.outputText),
    customer_comment_excerpt: redactAndExcerptText(params.customerComment),
  };
}

export function buildHumanEvaluationEvent(
  params: BuildHumanEvaluationEventParams,
): HumanEvaluationEvent {
  const eventTs = isoTimestamp(params.eventTs);
  const workspaceId = compactString(params.workspaceId);
  if (!workspaceId) {
    throw new Error("workspaceId is required for human evaluation events");
  }

  const eventId = stableEventId([
    "human_evaluation",
    workspaceId,
    params.conversationId || null,
    params.messageId || null,
    params.traceId || null,
    params.evaluatorUserId || null,
    params.linkedFeedbackEventId || null,
    params.linkedRagTurnEventId || null,
    params.evaluationStatus,
    params.datasetDecision,
    eventTs,
  ]);

  return {
    event_id: eventId,
    event_kind: "human_evaluation",
    event_ts: eventTs,
    schema_version: LLM_ANALYTICS_SCHEMA_VERSION,
    workspace_id: workspaceId,
    conversation_id: compactString(params.conversationId),
    message_id: compactString(params.messageId),
    trace_id: compactString(params.traceId),
    source_service: compactString(params.sourceService),
    metadata: jsonRecord(params.metadata),
    evaluator_user_id: compactString(params.evaluatorUserId),
    evaluation_status: params.evaluationStatus,
    dataset_decision: params.datasetDecision,
    dataset_split: params.datasetSplit ?? null,
    relevance_score: clampScore(params.relevanceScore),
    trustworthiness_score: clampScore(params.trustworthinessScore),
    conciseness_score: clampScore(params.concisenessScore),
    completeness_score: clampScore(params.completenessScore),
    safety_score: clampScore(params.safetyScore),
    overall_score: clampScore(params.overallScore),
    judge_explanation: redactAndExcerptText(params.judgeExplanation, 1000),
    expected_behavior: redactAndExcerptText(params.expectedBehavior, 1000),
    expected_source_ids: asStringArray(params.expectedSourceIds),
    linked_feedback_event_id: compactString(params.linkedFeedbackEventId),
    linked_rag_turn_event_id: compactString(params.linkedRagTurnEventId),
  };
}

function isEventKind(value: unknown): value is LlmAnalyticsEventKind {
  return (
    typeof value === "string" &&
    LLM_ANALYTICS_EVENT_KINDS.includes(value as LlmAnalyticsEventKind)
  );
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function requireStringField(
  event: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (typeof event[field] !== "string" || !compactString(event[field])) {
    throw new Error(`${label} ${field} is required`);
  }
}

function validateOptionalStringFields(
  event: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    const value = event[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`${label} ${field} is invalid`);
    }
  }
}

function validateOptionalNumberFields(
  event: Record<string, unknown>,
  fields: readonly string[],
  label: string,
  options?: { integer?: boolean; nonNegative?: boolean },
): void {
  for (const field of fields) {
    const value = event[field];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (options?.integer && !Number.isSafeInteger(value)) ||
      (options?.nonNegative && value < 0)
    ) {
      throw new Error(`${label} ${field} is invalid`);
    }
  }
}

function validateLlmAnalyticsEventShape(event: Record<string, unknown>): void {
  const timestamp = event.event_ts;
  if (
    typeof timestamp !== "string" ||
    !timestamp.trim() ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error("event_ts is invalid");
  }
  if (
    !Number.isSafeInteger(event.schema_version) ||
    event.schema_version !== LLM_ANALYTICS_SCHEMA_VERSION
  ) {
    throw new Error("schema_version is invalid");
  }
  validateOptionalStringFields(
    event,
    ["conversation_id", "message_id", "trace_id", "source_service"],
    "event",
  );
  if (
    event.metadata !== undefined &&
    event.metadata !== null &&
    !asNullableRecord(event.metadata)
  ) {
    throw new Error("event metadata is invalid");
  }

  if (event.event_kind === "llm_trace") {
    for (const field of ["operation", "provider", "model"] as const) {
      requireStringField(event, field, "llm_trace");
    }
    if (!isOneOf(event.status, ["ok", "error", "cancelled"])) {
      throw new Error("llm_trace status is invalid");
    }
    validateOptionalStringFields(
      event,
      [
        "finish_reason",
        "input_hash",
        "output_hash",
        "input_excerpt",
        "output_excerpt",
        "error_message",
        "pricing_version",
      ],
      "llm_trace",
    );
    validateOptionalNumberFields(
      event,
      [
        "latency_ms",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "thinking_tokens",
        "cached_prompt_tokens",
      ],
      "llm_trace",
      { integer: true, nonNegative: true },
    );
    if (
      typeof event.cached_prompt_tokens === "number" &&
      typeof event.prompt_tokens === "number" &&
      event.cached_prompt_tokens > event.prompt_tokens
    ) {
      throw new Error("llm_trace cached_prompt_tokens exceeds prompt_tokens");
    }
    validateOptionalNumberFields(
      event,
      ["estimated_cost_usd", "input_cost_usd", "output_cost_usd"],
      "llm_trace",
      { nonNegative: true },
    );
  } else if (event.event_kind === "rag_turn") {
    if (
      !Array.isArray(event.source_ids) ||
      !event.source_ids.every(
        (sourceId) => typeof sourceId === "string" && Boolean(sourceId.trim()),
      )
    ) {
      throw new Error("rag_turn source_ids is invalid");
    }
    validateOptionalStringFields(
      event,
      [
        "answer_message_id",
        "channel",
        "result_type",
        "outcome",
        "product_mode",
        "pipeline_path",
        "retrieval_path",
        "generation_model",
        "fallback_action",
        "fallback_reason",
        "input_hash",
        "output_hash",
        "input_excerpt",
        "output_excerpt",
      ],
      "rag_turn",
    );
    validateOptionalNumberFields(
      event,
      [
        "duration_ms",
        "generation_latency_ms",
        "citation_count",
        "retrieval_context_count",
        "asks_detected_count",
        "asks_answered_count",
        "missing_asks_count",
      ],
      "rag_turn",
      { integer: true, nonNegative: true },
    );
  } else if (event.event_kind === "llm_score") {
    requireStringField(event, "score_name", "llm_score");
    if (
      !isOneOf(event.score_source, [
        "system_eval",
        "llm_judge",
        "human_review",
        "customer_feedback",
      ])
    ) {
      throw new Error("llm_score source is invalid");
    }
    if (
      !isOneOf(event.data_type, ["numeric", "boolean", "categorical", "text"])
    ) {
      throw new Error("llm_score data_type is invalid");
    }
    const scoreValueField =
      event.data_type === "numeric"
        ? "numeric_value"
        : event.data_type === "boolean"
          ? "boolean_value"
          : "string_value";
    const scoreValue = event[scoreValueField];
    const validScoreValue =
      event.data_type === "numeric"
        ? typeof scoreValue === "number" && Number.isFinite(scoreValue)
        : event.data_type === "boolean"
          ? typeof scoreValue === "boolean"
          : typeof scoreValue === "string" && Boolean(scoreValue.trim());
    if (!validScoreValue) {
      throw new Error(`llm_score ${scoreValueField} is invalid`);
    }
    const numericValue = event.numeric_value;
    if (
      numericValue !== undefined &&
      numericValue !== null &&
      (typeof numericValue !== "number" || !Number.isFinite(numericValue))
    ) {
      throw new Error("llm_score numeric_value is invalid");
    }
    const booleanValue = event.boolean_value;
    if (
      booleanValue !== undefined &&
      booleanValue !== null &&
      typeof booleanValue !== "boolean"
    ) {
      throw new Error("llm_score boolean_value is invalid");
    }
    validateOptionalStringFields(
      event,
      ["string_value", "comment", "reasoning_excerpt"],
      "llm_score",
    );
  } else if (event.event_kind === "eval_run") {
    requireStringField(event, "eval_run_id", "eval_run");
    requireStringField(event, "evaluator_name", "eval_run");
    if (
      !isOneOf(event.status, [
        "queued",
        "running",
        "completed",
        "failed",
        "cancelled",
      ])
    ) {
      throw new Error("eval_run status is invalid");
    }
    validateOptionalNumberFields(
      event,
      ["sampled_count", "passed_count", "failed_count"],
      "eval_run",
      { integer: true, nonNegative: true },
    );
    validateOptionalStringFields(event, ["error_message"], "eval_run");
  } else if (event.event_kind === "customer_feedback") {
    if (!isOneOf(event.channel, CUSTOMER_FEEDBACK_CHANNELS)) {
      throw new Error("customer_feedback channel is invalid");
    }
    if (!isOneOf(event.feedback_stage, CUSTOMER_FEEDBACK_STAGES)) {
      throw new Error("customer_feedback feedback_stage is invalid");
    }
    requireStringField(event, "feedback_value", "customer_feedback");
    if (
      event.helpful !== undefined &&
      event.helpful !== null &&
      typeof event.helpful !== "boolean"
    ) {
      throw new Error("customer_feedback helpful is invalid");
    }
    if (
      event.reason_code !== undefined &&
      event.reason_code !== null &&
      !isOneOf(event.reason_code, CUSTOMER_FEEDBACK_REASON_CODES)
    ) {
      throw new Error("customer_feedback reason_code is invalid");
    }
    validateOptionalStringFields(
      event,
      [
        "source_message_id",
        "feedback_prompt_message_id",
        "customer_message_id",
        "input_hash",
        "output_hash",
        "input_excerpt",
        "output_excerpt",
        "customer_comment_excerpt",
      ],
      "customer_feedback",
    );
  } else if (event.event_kind === "human_evaluation") {
    if (!isOneOf(event.evaluation_status, HUMAN_EVALUATION_STATUSES)) {
      throw new Error("human_evaluation evaluation_status is invalid");
    }
    if (!isOneOf(event.dataset_decision, HUMAN_EVALUATION_DATASET_DECISIONS)) {
      throw new Error("human_evaluation dataset_decision is invalid");
    }
    if (
      event.dataset_split !== undefined &&
      event.dataset_split !== null &&
      !isOneOf(event.dataset_split, HUMAN_EVALUATION_DATASET_SPLITS)
    ) {
      throw new Error("human_evaluation dataset_split is invalid");
    }
    validateOptionalStringFields(
      event,
      [
        "evaluator_user_id",
        "judge_explanation",
        "expected_behavior",
        "linked_feedback_event_id",
        "linked_rag_turn_event_id",
      ],
      "human_evaluation",
    );
    validateOptionalNumberFields(
      event,
      [
        "relevance_score",
        "trustworthiness_score",
        "conciseness_score",
        "completeness_score",
        "safety_score",
        "overall_score",
      ],
      "human_evaluation",
    );
    if (
      event.expected_source_ids !== undefined &&
      (!Array.isArray(event.expected_source_ids) ||
        !event.expected_source_ids.every(
          (sourceId) =>
            typeof sourceId === "string" && Boolean(sourceId.trim()),
        ))
    ) {
      throw new Error("human_evaluation expected_source_ids is invalid");
    }
  }
}

export function validateLlmAnalyticsEventBatch(
  input: unknown,
  options?: { maxEvents?: number },
): LlmAnalyticsEventBatch {
  const maxEvents = options?.maxEvents ?? LLM_ANALYTICS_DEFAULT_BATCH_LIMIT;
  const record = asNullableRecord(input);
  const events = Array.isArray(record?.events) ? record.events : null;
  if (!events) {
    throw new Error("events must be an array");
  }
  if (events.length > maxEvents) {
    throw new Error(`events batch exceeds the limit of ${maxEvents}`);
  }

  for (const event of events) {
    const eventRecord = asNullableRecord(event);
    if (!eventRecord) throw new Error("event must be an object");
    if (
      typeof eventRecord.event_id !== "string" ||
      !compactString(eventRecord.event_id)
    ) {
      throw new Error("event_id is required");
    }
    if (!isEventKind(eventRecord.event_kind)) {
      throw new Error("event_kind is invalid");
    }
    if (
      typeof eventRecord.workspace_id !== "string" ||
      !compactString(eventRecord.workspace_id)
    ) {
      throw new Error("workspace_id is required");
    }
    if (!compactString(eventRecord.event_ts)) {
      throw new Error("event_ts is required");
    }
    validateLlmAnalyticsEventShape(eventRecord);
  }

  return { events: events as LlmAnalyticsEvent[] };
}

function encodePubSubData(event: LlmAnalyticsEvent): string {
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64");
}

function buildLlmAnalyticsPubSubMessage(
  event: LlmAnalyticsEvent,
): LlmAnalyticsPubSubMessage {
  return {
    data: encodePubSubData(event),
    attributes: {
      event_id: event.event_id,
      event_kind: event.event_kind,
      workspace_id: event.workspace_id,
      schema_version: String(event.schema_version),
    },
  };
}

function toLlmAnalyticsProductFact(
  event: LlmAnalyticsWarehouseEvent,
): LlmAnalyticsWarehouseEvent {
  const common = {
    event_id: event.event_id,
    event_ts: event.event_ts,
    schema_version: event.schema_version,
    workspace_id: event.workspace_id,
    conversation_id: event.conversation_id,
    message_id: event.message_id,
    trace_id: event.trace_id,
    source_service: event.source_service,
  };

  if (event.event_kind === "llm_trace") {
    return {
      ...common,
      event_kind: "llm_trace",
      operation: event.operation,
      provider: event.provider,
      model: event.model,
      status: event.status,
      latency_ms: event.latency_ms,
      prompt_tokens: event.prompt_tokens,
      completion_tokens: event.completion_tokens,
      thinking_tokens: event.thinking_tokens,
      cached_prompt_tokens: event.cached_prompt_tokens,
      total_tokens: event.total_tokens,
      finish_reason: event.finish_reason,
      input_hash: event.input_hash,
      output_hash: event.output_hash,
      estimated_cost_usd: event.estimated_cost_usd,
      input_cost_usd: event.input_cost_usd,
      output_cost_usd: event.output_cost_usd,
      pricing_version: event.pricing_version,
      ...(event.billing_source
        ? {
            billing_source: event.billing_source,
            company_id: event.company_id,
            action_id: event.action_id,
            customer_cost_usd: event.customer_cost_usd,
          }
        : {}),
    };
  }

  if (event.event_kind === "rag_turn") {
    return {
      ...common,
      event_kind: "rag_turn",
      answer_message_id: event.answer_message_id,
      channel: event.channel,
      result_type: event.result_type,
      outcome: event.outcome,
      product_mode: event.product_mode,
      pipeline_path: event.pipeline_path,
      retrieval_path: event.retrieval_path,
      duration_ms: event.duration_ms,
      generation_model: event.generation_model,
      generation_latency_ms: event.generation_latency_ms,
      source_ids: event.source_ids,
      citation_count: event.citation_count,
      retrieval_context_count: event.retrieval_context_count,
      asks_detected_count: event.asks_detected_count,
      asks_answered_count: event.asks_answered_count,
      missing_asks_count: event.missing_asks_count,
      fallback_action: event.fallback_action,
      fallback_reason: event.fallback_reason,
      input_hash: event.input_hash,
      output_hash: event.output_hash,
    };
  }

  if (event.event_kind === "llm_score") {
    const fact: LlmAnalyticsWarehouseScoreEvent = {
      ...common,
      event_kind: "llm_score",
      score_name: event.score_name,
      score_source: event.score_source,
      data_type: event.data_type,
      numeric_value: event.numeric_value,
      boolean_value: event.boolean_value,
    };
    if (event.data_type === "categorical") {
      fact.string_value =
        compactString(event.string_value)?.slice(0, 100) || null;
    }
    return fact;
  }

  return {
    ...common,
    event_kind: "eval_run",
    eval_run_id: event.eval_run_id,
    evaluator_name: event.evaluator_name,
    status: event.status,
    sampled_count: event.sampled_count,
    passed_count: event.passed_count,
    failed_count: event.failed_count,
  };
}

export function buildLlmAnalyticsProductEvents(
  events: LlmAnalyticsEvent[],
): LlmAnalyticsWarehouseEvent[] {
  return events
    .filter(isLlmAnalyticsWarehouseEvent)
    .map(toLlmAnalyticsProductFact);
}

export function isLlmAnalyticsWarehouseEvent(
  event: LlmAnalyticsEvent,
): event is LlmAnalyticsWarehouseEvent {
  if (
    !LLM_ANALYTICS_WAREHOUSE_EVENT_KINDS.includes(
      event.event_kind as LlmAnalyticsWarehouseEventKind,
    )
  ) {
    return false;
  }

  return (
    event.event_kind !== "llm_score" || event.score_source !== "system_eval"
  );
}

export function buildPubSubPublishPayloadForLlmProductAnalytics(
  events: LlmAnalyticsEvent[],
  topic: string = LLM_ANALYTICS_PRODUCT_EVENTS_TOPIC,
): LlmAnalyticsProductPubSubPublishPayload | null {
  const messages = buildLlmAnalyticsProductEvents(events).map(
    buildLlmAnalyticsPubSubMessage,
  );
  return messages.length > 0 ? { topic, messages } : null;
}
