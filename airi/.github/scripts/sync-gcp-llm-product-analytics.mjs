import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildPubSubServiceAgentEmail,
  grantIamBindings,
} from "./ensure-pubsub-resources.mjs";

export const BIGQUERY_DATASET = "icecore_llm_analytics";
export const BIGQUERY_TABLE = "llm_product_events";
export const PRODUCT_TOPIC = "icecore-llm-product-events";
export const PRODUCT_SUBSCRIPTION = "icecore-llm-product-events-bigquery";
export const DLQ_TOPIC = "icecore-llm-product-events-dead-letter";
export const DLQ_RETENTION_SUBSCRIPTION =
  "icecore-llm-product-events-dead-letter-retention";
export const COMPATIBILITY_VIEWS = [
  "llm_trace_events",
  "rag_turn_events",
  "llm_score_events",
  "eval_run_events",
];
export const LEGACY_TOPICS = [
  "icecore-llm-trace-events",
  "icecore-rag-turn-events",
  "icecore-llm-score-events",
  "icecore-eval-run-events",
  "icecore-llm-customer-feedback-events",
  "icecore-llm-human-evaluation-events",
];

const RETENTION_DURATION = "31d";
const RETENTION_DURATION_SECONDS = 31 * 24 * 60 * 60;
const MAX_DELIVERY_ATTEMPTS = 20;

export const RAW_TABLE_SCHEMA = [
  { name: "event_id", type: "STRING", mode: "REQUIRED" },
  { name: "event_kind", type: "STRING", mode: "REQUIRED" },
  { name: "event_ts", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "schema_version", type: "INTEGER", mode: "REQUIRED" },
  { name: "workspace_id", type: "STRING", mode: "REQUIRED" },
  { name: "conversation_id", type: "STRING", mode: "NULLABLE" },
  { name: "message_id", type: "STRING", mode: "NULLABLE" },
  { name: "trace_id", type: "STRING", mode: "NULLABLE" },
  { name: "source_service", type: "STRING", mode: "NULLABLE" },
  { name: "operation", type: "STRING", mode: "NULLABLE" },
  { name: "provider", type: "STRING", mode: "NULLABLE" },
  { name: "model", type: "STRING", mode: "NULLABLE" },
  { name: "status", type: "STRING", mode: "NULLABLE" },
  { name: "latency_ms", type: "INTEGER", mode: "NULLABLE" },
  { name: "prompt_tokens", type: "INTEGER", mode: "NULLABLE" },
  { name: "completion_tokens", type: "INTEGER", mode: "NULLABLE" },
  { name: "thinking_tokens", type: "INTEGER", mode: "NULLABLE" },
  { name: "cached_prompt_tokens", type: "INTEGER", mode: "NULLABLE" },
  { name: "total_tokens", type: "INTEGER", mode: "NULLABLE" },
  { name: "finish_reason", type: "STRING", mode: "NULLABLE" },
  { name: "input_hash", type: "STRING", mode: "NULLABLE" },
  { name: "output_hash", type: "STRING", mode: "NULLABLE" },
  { name: "estimated_cost_usd", type: "FLOAT", mode: "NULLABLE" },
  { name: "input_cost_usd", type: "FLOAT", mode: "NULLABLE" },
  { name: "output_cost_usd", type: "FLOAT", mode: "NULLABLE" },
  { name: "pricing_version", type: "STRING", mode: "NULLABLE" },
  { name: "billing_source", type: "STRING", mode: "NULLABLE" },
  { name: "company_id", type: "STRING", mode: "NULLABLE" },
  { name: "action_id", type: "STRING", mode: "NULLABLE" },
  { name: "customer_cost_usd", type: "FLOAT", mode: "NULLABLE" },
  { name: "answer_message_id", type: "STRING", mode: "NULLABLE" },
  { name: "channel", type: "STRING", mode: "NULLABLE" },
  { name: "result_type", type: "STRING", mode: "NULLABLE" },
  { name: "outcome", type: "STRING", mode: "NULLABLE" },
  { name: "product_mode", type: "STRING", mode: "NULLABLE" },
  { name: "pipeline_path", type: "STRING", mode: "NULLABLE" },
  { name: "retrieval_path", type: "STRING", mode: "NULLABLE" },
  { name: "duration_ms", type: "INTEGER", mode: "NULLABLE" },
  { name: "generation_model", type: "STRING", mode: "NULLABLE" },
  { name: "generation_latency_ms", type: "INTEGER", mode: "NULLABLE" },
  { name: "source_ids", type: "STRING", mode: "REPEATED" },
  { name: "citation_count", type: "INTEGER", mode: "NULLABLE" },
  { name: "retrieval_context_count", type: "INTEGER", mode: "NULLABLE" },
  { name: "asks_detected_count", type: "INTEGER", mode: "NULLABLE" },
  { name: "asks_answered_count", type: "INTEGER", mode: "NULLABLE" },
  { name: "missing_asks_count", type: "INTEGER", mode: "NULLABLE" },
  { name: "fallback_action", type: "STRING", mode: "NULLABLE" },
  { name: "fallback_reason", type: "STRING", mode: "NULLABLE" },
  { name: "score_name", type: "STRING", mode: "NULLABLE" },
  { name: "score_source", type: "STRING", mode: "NULLABLE" },
  { name: "data_type", type: "STRING", mode: "NULLABLE" },
  { name: "numeric_value", type: "FLOAT", mode: "NULLABLE" },
  { name: "boolean_value", type: "BOOLEAN", mode: "NULLABLE" },
  { name: "string_value", type: "STRING", mode: "NULLABLE" },
  { name: "eval_run_id", type: "STRING", mode: "NULLABLE" },
  { name: "evaluator_name", type: "STRING", mode: "NULLABLE" },
  { name: "sampled_count", type: "INTEGER", mode: "NULLABLE" },
  { name: "passed_count", type: "INTEGER", mode: "NULLABLE" },
  { name: "failed_count", type: "INTEGER", mode: "NULLABLE" },
];

const LEGACY_SCHEMAS = {
  llm_trace_events: [
    ["event_id", "STRING", "REQUIRED"],
    ["event_kind", "STRING", "REQUIRED"],
    ["event_ts", "TIMESTAMP", "REQUIRED"],
    ["schema_version", "INT64", "REQUIRED"],
    ["workspace_id", "STRING", "REQUIRED"],
    ["conversation_id", "STRING"],
    ["message_id", "STRING"],
    ["trace_id", "STRING"],
    ["source_service", "STRING"],
    ["metadata", "JSON"],
    ["operation", "STRING", "REQUIRED"],
    ["provider", "STRING", "REQUIRED"],
    ["model", "STRING", "REQUIRED"],
    ["status", "STRING", "REQUIRED"],
    ["latency_ms", "INT64"],
    ["prompt_tokens", "INT64"],
    ["completion_tokens", "INT64"],
    ["total_tokens", "INT64"],
    ["finish_reason", "STRING"],
    ["input_hash", "STRING"],
    ["output_hash", "STRING"],
    ["input_excerpt", "STRING"],
    ["output_excerpt", "STRING"],
    ["error_message", "STRING"],
    ["estimated_cost_usd", "FLOAT64"],
    ["input_cost_usd", "FLOAT64"],
    ["output_cost_usd", "FLOAT64"],
    ["pricing_version", "STRING"],
  ],
  rag_turn_events: [
    ["event_id", "STRING", "REQUIRED"],
    ["event_kind", "STRING", "REQUIRED"],
    ["event_ts", "TIMESTAMP", "REQUIRED"],
    ["schema_version", "INT64", "REQUIRED"],
    ["workspace_id", "STRING", "REQUIRED"],
    ["conversation_id", "STRING"],
    ["message_id", "STRING"],
    ["trace_id", "STRING"],
    ["source_service", "STRING"],
    ["metadata", "JSON"],
    ["answer_message_id", "STRING"],
    ["channel", "STRING"],
    ["result_type", "STRING"],
    ["outcome", "STRING"],
    ["product_mode", "STRING"],
    ["pipeline_path", "STRING"],
    ["retrieval_path", "STRING"],
    ["duration_ms", "INT64"],
    ["generation_model", "STRING"],
    ["generation_latency_ms", "INT64"],
    ["source_ids", "ARRAY<STRING>"],
    ["citation_count", "INT64"],
    ["retrieval_context_count", "INT64"],
    ["fallback_action", "STRING"],
    ["fallback_reason", "STRING"],
    ["input_hash", "STRING"],
    ["output_hash", "STRING"],
    ["input_excerpt", "STRING"],
    ["output_excerpt", "STRING"],
  ],
  llm_score_events: [
    ["event_id", "STRING", "REQUIRED"],
    ["event_kind", "STRING", "REQUIRED"],
    ["event_ts", "TIMESTAMP", "REQUIRED"],
    ["schema_version", "INT64", "REQUIRED"],
    ["workspace_id", "STRING", "REQUIRED"],
    ["conversation_id", "STRING"],
    ["message_id", "STRING"],
    ["trace_id", "STRING"],
    ["source_service", "STRING"],
    ["metadata", "JSON"],
    ["score_name", "STRING", "REQUIRED"],
    ["score_source", "STRING", "REQUIRED"],
    ["data_type", "STRING", "REQUIRED"],
    ["numeric_value", "FLOAT64"],
    ["boolean_value", "BOOL"],
    ["string_value", "STRING"],
    ["comment", "STRING"],
    ["reasoning_excerpt", "STRING"],
  ],
  eval_run_events: [
    ["event_id", "STRING", "REQUIRED"],
    ["event_kind", "STRING", "REQUIRED"],
    ["event_ts", "TIMESTAMP", "REQUIRED"],
    ["schema_version", "INT64", "REQUIRED"],
    ["workspace_id", "STRING", "REQUIRED"],
    ["conversation_id", "STRING"],
    ["message_id", "STRING"],
    ["trace_id", "STRING"],
    ["source_service", "STRING"],
    ["metadata", "JSON"],
    ["eval_run_id", "STRING", "REQUIRED"],
    ["evaluator_name", "STRING", "REQUIRED"],
    ["status", "STRING", "REQUIRED"],
    ["sampled_count", "INT64"],
    ["passed_count", "INT64"],
    ["failed_count", "INT64"],
    ["error_message", "STRING"],
  ],
};

const KNOWN_MISSING_LEGACY_COLUMNS = {
  llm_trace_events: new Set([
    "estimated_cost_usd",
    "input_cost_usd",
    "output_cost_usd",
    "pricing_version",
  ]),
};

function compact(value) {
  return String(value || "").trim();
}

function normalizePublisherServiceAccount(value) {
  const normalized = compact(value).replace(/^serviceAccount:/, "");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/.test(
      normalized,
    )
  ) {
    throw new Error(`Invalid publisher service account: ${normalized}`);
  }
  return normalized;
}

export function normalizeConfig(input) {
  const projectId = compact(input?.projectId);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error(`Invalid Google Cloud project id: ${projectId}`);
  }
  const publisherServiceAccounts = [
    ...new Set(
      (Array.isArray(input?.publisherServiceAccounts)
        ? input.publisherServiceAccounts
        : [input?.publisherServiceAccounts]
      )
        .map(compact)
        .filter(Boolean)
        .map(normalizePublisherServiceAccount),
    ),
  ];
  if (publisherServiceAccounts.length === 0) {
    throw new Error("At least one publisher service account is required.");
  }
  const location = compact(input?.location) || "US";
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,62}$/.test(location)) {
    throw new Error(`Invalid BigQuery location: ${location}`);
  }

  return {
    projectId,
    projectNumber: compact(input?.projectNumber) || null,
    location,
    dataset: BIGQUERY_DATASET,
    table: BIGQUERY_TABLE,
    topic: PRODUCT_TOPIC,
    subscription: PRODUCT_SUBSCRIPTION,
    dlqTopic: DLQ_TOPIC,
    dlqRetentionSubscription: DLQ_RETENTION_SUBSCRIPTION,
    publisherServiceAccounts,
  };
}

export function normalizeSyncPhase(value) {
  const phase = compact(value).toLowerCase();
  if (!phase) throw new Error("Missing required --phase");
  if (
    !["prepare", "validate", "finalize", "validate-finalized"].includes(phase)
  ) {
    throw new Error(
      "--phase must be prepare, validate, finalize, or validate-finalized",
    );
  }
  return phase;
}

export function buildLegacySubscriptionInventoryCommands(config) {
  return LEGACY_TOPICS.map((topic) => [
    "pubsub",
    "topics",
    "list-subscriptions",
    topic,
    `--project=${config.projectId}`,
    "--format=json",
  ]);
}

export function findLegacyTopicSubscriptions(config, subscriptions) {
  const expectedTopics = new Set(
    LEGACY_TOPICS.map(
      (topic) => `projects/${config.projectId}/topics/${topic}`,
    ),
  );
  return (Array.isArray(subscriptions) ? subscriptions : []).filter(
    (subscription) =>
      expectedTopics.has(compact(subscription?.topic)) &&
      Boolean(compact(subscription?.name)),
  );
}

function assertLegacyTopicsDetached(config, subscriptions) {
  const blockers = findLegacyTopicSubscriptions(config, subscriptions);
  if (blockers.length === 0) return;
  throw new Error(
    [
      "LLM product-ledger finalize is blocked because subscriptions remain attached to legacy topics:",
      ...blockers.map(
        ({ name, topic }) => `- ${compact(name)} -> ${compact(topic)}`,
      ),
      "Explicitly drain or detach these legacy subscriptions, verify the consolidated gateway publisher, then rerun --phase finalize. This script will not delete or drain subscriptions automatically.",
    ].join("\n"),
  );
}

export function executeSyncPhase(phaseValue, actions) {
  const phase = normalizeSyncPhase(phaseValue);
  if (phase === "prepare") {
    actions.prepare();
    return { phase };
  }

  actions.validatePrepared();
  if (phase === "validate") return { phase };
  if (phase === "validate-finalized") {
    actions.validateFinalized();
    return { phase };
  }
  const subscriptions = actions.listSubscriptions();
  assertLegacyTopicsDetached(
    actions.config || { projectId: "project-1" },
    subscriptions,
  );
  actions.finalize();
  actions.validateFinalized();
  return { phase };
}

function qualifiedDataset(config) {
  return `\`${config.projectId}.${config.dataset}\``;
}

function qualifiedTable(config, table = config.table) {
  return `\`${config.projectId}.${config.dataset}.${table}\``;
}

export function buildDatasetDdl(config) {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qualifiedDataset(config)}`,
    `OPTIONS(location = '${config.location}', description = 'Durable tenant-facing LLM product analytics ledger')`,
  ].join("\n");
}

function sqlType(field) {
  if (field.mode === "REPEATED") return `ARRAY<${field.type}>`;
  return (
    {
      INTEGER: "INT64",
      FLOAT: "FLOAT64",
      BOOLEAN: "BOOL",
    }[field.type] || field.type
  );
}

export function buildRawTableDdl(config) {
  const fields = RAW_TABLE_SCHEMA.map(
    (field) =>
      `  ${field.name} ${sqlType(field)}${field.mode === "REQUIRED" ? " NOT NULL" : ""}`,
  ).join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${qualifiedTable(config)} (
${fields}
)
PARTITION BY DATE(event_ts)
CLUSTER BY workspace_id, event_kind
OPTIONS(
  require_partition_filter = FALSE,
  description = 'Complete deduplicated-by-view LLM product facts'
)`;
}

export function buildDisablePartitionFilterDdl(
  config,
  tableName = config.table,
) {
  return `ALTER TABLE ${qualifiedTable(config, tableName)} SET OPTIONS(require_partition_filter = FALSE)`;
}

export function buildArchiveTableOptionsDdl(config, tableName) {
  return `ALTER TABLE ${qualifiedTable(config, tableName)} SET OPTIONS(require_partition_filter = FALSE, partition_expiration_days = NULL)`;
}

function normalizeBigQueryType(value) {
  return (
    {
      INT64: "INTEGER",
      FLOAT64: "FLOAT",
      BOOL: "BOOLEAN",
    }[compact(value).toUpperCase()] || compact(value).toUpperCase()
  );
}

function normalizeMode(value) {
  return compact(value).toUpperCase() || "NULLABLE";
}

export function validateDataset(config, actual) {
  const errors = [];
  if (actual?.datasetReference?.projectId !== config.projectId) {
    errors.push(`dataset project must be ${config.projectId}`);
  }
  if (actual?.datasetReference?.datasetId !== config.dataset) {
    errors.push(`dataset id must be ${config.dataset}`);
  }
  if (
    compact(actual?.location).toUpperCase() !== config.location.toUpperCase()
  ) {
    errors.push(`dataset location must be ${config.location}`);
  }
  if (actual?.type && actual.type !== "DEFAULT") {
    errors.push("dataset must be a standard BigQuery dataset");
  }
  return errors;
}

export function validateRawTable(config, actual) {
  const errors = [];
  if (actual?.tableReference?.projectId !== config.projectId) {
    errors.push(`table project must be ${config.projectId}`);
  }
  if (actual?.tableReference?.datasetId !== config.dataset) {
    errors.push(`table dataset must be ${config.dataset}`);
  }
  if (actual?.tableReference?.tableId !== config.table) {
    errors.push(`table id must be ${config.table}`);
  }
  if (actual?.type !== "TABLE") errors.push("raw ledger must be a TABLE");

  const fields = new Map(
    (actual?.schema?.fields || []).map((field) => [field.name, field]),
  );
  for (const expected of RAW_TABLE_SCHEMA) {
    const field = fields.get(expected.name);
    if (!field) {
      errors.push(`missing column ${expected.name}`);
      continue;
    }
    if (normalizeBigQueryType(field.type) !== expected.type) {
      errors.push(
        `${expected.name} type must be ${expected.type}, received ${field.type}`,
      );
    }
    if (normalizeMode(field.mode) !== expected.mode) {
      errors.push(
        `${expected.name} must be ${expected.mode}, received ${normalizeMode(field.mode)}`,
      );
    }
  }
  for (const field of fields.values()) {
    if (!RAW_TABLE_SCHEMA.some(({ name }) => name === field.name)) {
      errors.push(`unexpected raw-table column ${field.name}`);
    }
  }
  if (actual?.timePartitioning?.type !== "DAY") {
    errors.push("partition type must be DAY");
  }
  if (actual?.timePartitioning?.field !== "event_ts") {
    errors.push("partition field must be event_ts");
  }
  if (
    JSON.stringify(actual?.clustering?.fields || []) !==
    JSON.stringify(["workspace_id", "event_kind"])
  ) {
    errors.push("clustering fields must be workspace_id,event_kind");
  }
  if (
    readField(actual, "requirePartitionFilter", "require_partition_filter") ===
    true
  ) {
    errors.push(
      "require_partition_filter must be disabled for compatibility views",
    );
  }
  if (actual?.timePartitioning?.expirationMs) {
    errors.push("raw product-ledger partitions must not expire");
  }
  return errors;
}

export function buildPubSubResourceCommands(config) {
  const projectFlag = `--project=${config.projectId}`;
  return {
    topic: {
      describe: ["pubsub", "topics", "describe", config.topic, projectFlag],
      create: [
        "pubsub",
        "topics",
        "create",
        config.topic,
        projectFlag,
        `--message-retention-duration=${RETENTION_DURATION}`,
      ],
    },
    dlqTopic: {
      describe: ["pubsub", "topics", "describe", config.dlqTopic, projectFlag],
      create: [
        "pubsub",
        "topics",
        "create",
        config.dlqTopic,
        projectFlag,
        `--message-retention-duration=${RETENTION_DURATION}`,
      ],
    },
    dlqRetentionSubscription: {
      describe: [
        "pubsub",
        "subscriptions",
        "describe",
        config.dlqRetentionSubscription,
        projectFlag,
      ],
      create: [
        "pubsub",
        "subscriptions",
        "create",
        config.dlqRetentionSubscription,
        projectFlag,
        `--topic=${config.dlqTopic}`,
        `--message-retention-duration=${RETENTION_DURATION}`,
        "--expiration-period=never",
      ],
    },
    subscription: {
      describe: [
        "pubsub",
        "subscriptions",
        "describe",
        config.subscription,
        projectFlag,
      ],
      create: [
        "pubsub",
        "subscriptions",
        "create",
        config.subscription,
        projectFlag,
        `--topic=${config.topic}`,
        `--bigquery-table=${config.projectId}:${config.dataset}.${config.table}`,
        "--use-table-schema",
        "--no-write-metadata",
        "--no-drop-unknown-fields",
        `--message-retention-duration=${RETENTION_DURATION}`,
        "--expiration-period=never",
        `--dead-letter-topic=${config.dlqTopic}`,
        `--max-delivery-attempts=${MAX_DELIVERY_ATTEMPTS}`,
      ],
    },
  };
}

function readField(value, camelName, snakeName) {
  if (value?.[camelName] !== undefined) return value[camelName];
  return value?.[snakeName];
}

function durationSeconds(value) {
  const stringValue = compact(value);
  const secondsMatch = stringValue.match(/^(\d+(?:\.\d+)?)s$/);
  if (secondsMatch) return Number(secondsMatch[1]);
  const durationMatch = stringValue.match(/^([\d.]+)([smhd])$/i);
  if (!durationMatch) return NaN;
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[
    durationMatch[2].toLowerCase()
  ];
  return Number(durationMatch[1]) * multiplier;
}

function isPersistentExpirationPolicy(value) {
  if (value === undefined || value === null) return true;
  return !compact(readField(value, "ttl", "ttl"));
}

function canonicalBigQueryTable(value) {
  const stringValue = compact(value);
  const apiMatch = stringValue.match(
    /^projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/,
  );
  if (apiMatch) return `${apiMatch[1]}:${apiMatch[2]}.${apiMatch[3]}`;
  return stringValue;
}

export function validatePubSubTopology(config, actual) {
  const expectedTopic = `projects/${config.projectId}/topics/${config.topic}`;
  const expectedDlqTopic = `projects/${config.projectId}/topics/${config.dlqTopic}`;
  const expectedSubscription = `projects/${config.projectId}/subscriptions/${config.subscription}`;
  const expectedDlqSubscription = `projects/${config.projectId}/subscriptions/${config.dlqRetentionSubscription}`;
  const expectedTable = `${config.projectId}:${config.dataset}.${config.table}`;
  const bigqueryConfig = readField(
    actual?.subscription,
    "bigqueryConfig",
    "bigquery_config",
  );
  const deadLetterPolicy = readField(
    actual?.subscription,
    "deadLetterPolicy",
    "dead_letter_policy",
  );
  const errors = [];

  if (actual?.topic?.name !== expectedTopic) {
    errors.push(`main topic must be ${expectedTopic}`);
  }
  if (
    durationSeconds(
      readField(
        actual?.topic,
        "messageRetentionDuration",
        "message_retention_duration",
      ),
    ) !== RETENTION_DURATION_SECONDS
  ) {
    errors.push(`main topic retention must be ${RETENTION_DURATION}`);
  }
  if (actual?.dlqTopic?.name !== expectedDlqTopic) {
    errors.push(`dead-letter topic must be ${expectedDlqTopic}`);
  }
  if (
    durationSeconds(
      readField(
        actual?.dlqTopic,
        "messageRetentionDuration",
        "message_retention_duration",
      ),
    ) !== RETENTION_DURATION_SECONDS
  ) {
    errors.push(`dead-letter topic retention must be ${RETENTION_DURATION}`);
  }
  if (actual?.subscription?.name !== expectedSubscription) {
    errors.push(`BigQuery subscription must be ${expectedSubscription}`);
  }
  if (actual?.subscription?.topic !== expectedTopic) {
    errors.push(`BigQuery subscription topic must be ${expectedTopic}`);
  }
  if (canonicalBigQueryTable(bigqueryConfig?.table) !== expectedTable) {
    errors.push(`BigQuery subscription table must be ${expectedTable}`);
  }
  if (
    readField(bigqueryConfig, "useTableSchema", "use_table_schema") !== true
  ) {
    errors.push("BigQuery subscription must use the BigQuery table schema");
  }
  if (readField(bigqueryConfig, "writeMetadata", "write_metadata") === true) {
    errors.push("BigQuery subscription must not write Pub/Sub metadata");
  }
  if (
    readField(bigqueryConfig, "dropUnknownFields", "drop_unknown_fields") ===
    true
  ) {
    errors.push("BigQuery subscription must reject unknown fields");
  }
  if (
    durationSeconds(
      readField(
        actual?.subscription,
        "messageRetentionDuration",
        "message_retention_duration",
      ),
    ) !== RETENTION_DURATION_SECONDS
  ) {
    errors.push(
      `BigQuery subscription retention must be ${RETENTION_DURATION}`,
    );
  }
  if (!isPersistentExpirationPolicy(actual?.subscription?.expirationPolicy)) {
    errors.push("BigQuery subscription must never expire");
  }
  if (
    readField(deadLetterPolicy, "deadLetterTopic", "dead_letter_topic") !==
    expectedDlqTopic
  ) {
    errors.push(`BigQuery subscription DLQ must be ${expectedDlqTopic}`);
  }
  if (
    Number(
      readField(
        deadLetterPolicy,
        "maxDeliveryAttempts",
        "max_delivery_attempts",
      ),
    ) !== MAX_DELIVERY_ATTEMPTS
  ) {
    errors.push(
      `BigQuery subscription max delivery attempts must be ${MAX_DELIVERY_ATTEMPTS}`,
    );
  }
  if (actual?.dlqRetentionSubscription?.name !== expectedDlqSubscription) {
    errors.push(
      `DLQ retention subscription must be ${expectedDlqSubscription}`,
    );
  }
  if (actual?.dlqRetentionSubscription?.topic !== expectedDlqTopic) {
    errors.push(`DLQ retention subscription topic must be ${expectedDlqTopic}`);
  }
  if (
    durationSeconds(
      readField(
        actual?.dlqRetentionSubscription,
        "messageRetentionDuration",
        "message_retention_duration",
      ),
    ) !== RETENTION_DURATION_SECONDS
  ) {
    errors.push(
      `DLQ retention subscription must retain for ${RETENTION_DURATION}`,
    );
  }
  if (
    !isPersistentExpirationPolicy(
      actual?.dlqRetentionSubscription?.expirationPolicy,
    )
  ) {
    errors.push("DLQ retention subscription must never expire");
  }

  return errors;
}

export function buildBigQueryTableIamCommand(config, projectNumber) {
  const serviceAgent = buildPubSubServiceAgentEmail(projectNumber);
  return [
    `--project_id=${config.projectId}`,
    "add-iam-policy-binding",
    `--member=serviceAccount:${serviceAgent}`,
    "--role=roles/bigquery.dataEditor",
    `${config.projectId}:${config.dataset}.${config.table}`,
  ];
}

export function buildPubSubIamCommands(config, projectNumber) {
  const member = `serviceAccount:${buildPubSubServiceAgentEmail(projectNumber)}`;
  return [
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      config.dlqTopic,
      `--project=${config.projectId}`,
      `--member=${member}`,
      "--role=roles/pubsub.publisher",
    ],
    [
      "pubsub",
      "subscriptions",
      "add-iam-policy-binding",
      config.subscription,
      `--project=${config.projectId}`,
      `--member=${member}`,
      "--role=roles/pubsub.subscriber",
    ],
    ...config.publisherServiceAccounts.map((serviceAccount) => [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      config.topic,
      `--project=${config.projectId}`,
      `--member=serviceAccount:${serviceAccount}`,
      "--role=roles/pubsub.publisher",
    ]),
  ];
}

export function buildLegacyTableMigrationDdls(config, viewName) {
  if (!COMPATIBILITY_VIEWS.includes(viewName)) {
    throw new Error(`Unsupported compatibility view: ${viewName}`);
  }
  return [
    `ALTER TABLE ${qualifiedTable(config, viewName)} RENAME TO ${viewName}_legacy`,
  ];
}

export function buildLegacyTableNormalizationDdls(config, viewName, actual) {
  const expectedSchema = LEGACY_SCHEMAS[viewName];
  if (!expectedSchema) {
    throw new Error(`Unsupported compatibility view: ${viewName}`);
  }
  const knownMissing = KNOWN_MISSING_LEGACY_COLUMNS[viewName] || new Set();
  const actualNames = new Set(
    (actual?.schema?.fields || []).map((field) => field.name),
  );
  return expectedSchema
    .filter(([name]) => knownMissing.has(name) && !actualNames.has(name))
    .map(
      ([name, type]) =>
        `ALTER TABLE ${qualifiedTable(config, viewName)} ADD COLUMN IF NOT EXISTS ${name} ${type}`,
    );
}

export function buildEmptyLegacyTableDdl(config, viewName) {
  const schema = LEGACY_SCHEMAS[viewName];
  if (!schema) throw new Error(`Unsupported compatibility view: ${viewName}`);
  const fields = schema
    .map(
      ([name, type, mode]) =>
        `  ${name} ${type}${mode === "REQUIRED" ? " NOT NULL" : ""}`,
    )
    .join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${qualifiedTable(config, `${viewName}_legacy`)} (
${fields}
)
PARTITION BY DATE(event_ts)
CLUSTER BY workspace_id
OPTIONS(description = 'Immutable compatibility archive for the consolidated LLM product ledger')`;
}

export function validateLegacyTableSchema(viewName, actual, options = {}) {
  const expectedSchema = LEGACY_SCHEMAS[viewName];
  if (!expectedSchema) {
    throw new Error(`Unsupported compatibility view: ${viewName}`);
  }
  const actualFields = new Map(
    (actual?.schema?.fields || []).map((field) => [field.name, field]),
  );
  const knownMissing = KNOWN_MISSING_LEGACY_COLUMNS[viewName] || new Set();
  const errors = [];
  const historicalFloatDurations = new Set([
    "latency_ms",
    "duration_ms",
    "generation_latency_ms",
  ]);
  for (const [name, type, mode] of expectedSchema) {
    const field = actualFields.get(name);
    if (!field) {
      if (options.allowKnownMissingColumns && knownMissing.has(name)) continue;
      errors.push(`missing legacy column ${name}`);
      continue;
    }
    const expectedType = normalizeBigQueryType(
      type === "ARRAY<STRING>" ? "STRING" : type,
    );
    const actualType = normalizeBigQueryType(field.type);
    const allowedTypes = historicalFloatDurations.has(name)
      ? new Set([expectedType, "FLOAT"])
      : new Set([expectedType]);
    if (!allowedTypes.has(actualType)) {
      errors.push(
        `${name} type must be ${[...allowedTypes].join(" or ")}, received ${field.type}`,
      );
    }
    const expectedMode = type === "ARRAY<STRING>" ? "REPEATED" : mode;
    if (normalizeMode(field.mode) !== normalizeMode(expectedMode)) {
      errors.push(
        `${name} must be ${normalizeMode(expectedMode)}, received ${normalizeMode(field.mode)}`,
      );
    }
  }
  const expectedNames = new Set(expectedSchema.map(([name]) => name));
  for (const field of actualFields.values()) {
    if (!expectedNames.has(field.name)) {
      errors.push(`unexpected legacy column ${field.name}`);
    }
  }
  return errors;
}

export function validateArchiveTableOptions(actual) {
  const errors = [];
  if (
    readField(actual, "requirePartitionFilter", "require_partition_filter") ===
    true
  ) {
    errors.push("require_partition_filter must be disabled");
  }
  if (actual?.timePartitioning?.type !== "DAY") {
    errors.push("archive partition type must be DAY");
  }
  if (actual?.timePartitioning?.field !== "event_ts") {
    errors.push("archive partition field must be event_ts");
  }
  if (actual?.timePartitioning?.expirationMs != null) {
    errors.push("partition_expiration_days must be cleared");
  }
  return errors;
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function deduplicatingViewDdl(config, viewName, branches, ctes = "") {
  const union = branches.join("\nUNION ALL\n");
  const rankedCte = `${ctes ? `${ctes.trim()},\n` : "WITH "}ranked_events`;
  return `CREATE OR REPLACE VIEW ${qualifiedTable(config, viewName)} AS
${rankedCte} AS (
  SELECT
    unioned_events.*,
    ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY source_priority ASC, event_ts DESC) AS duplicate_rank
  FROM (
${indent(union, 4)}
  ) AS unioned_events
)
SELECT * EXCEPT(source_priority, duplicate_rank)
FROM ranked_events
WHERE duplicate_rank = 1`;
}

function legacyBranch(config, viewName, columns) {
  const stableColumns = columns.map((column) =>
    ["thinking_tokens", "cached_prompt_tokens"].includes(column)
      ? `CAST(NULL AS INT64) AS ${column}`
      : ["latency_ms", "duration_ms", "generation_latency_ms"].includes(column)
        ? `SAFE_CAST(${column} AS INT64) AS ${column}`
        : column,
  );
  return `SELECT
${indent(stableColumns.join(",\n"), 2)},
  1 AS source_priority
FROM ${qualifiedTable(config, `${viewName}_legacy`)}`;
}

function rawBranch(config, eventKind, columns) {
  return `SELECT
${indent(columns.join(",\n"), 2)},
  0 AS source_priority
FROM ${qualifiedTable(config)}
WHERE event_kind = '${eventKind}'`;
}

const TRACE_COLUMNS = [
  "event_id",
  "event_kind",
  "event_ts",
  "schema_version",
  "workspace_id",
  "conversation_id",
  "message_id",
  "trace_id",
  "source_service",
  "metadata",
  "operation",
  "provider",
  "model",
  "status",
  "latency_ms",
  "prompt_tokens",
  "completion_tokens",
  "thinking_tokens",
  "cached_prompt_tokens",
  "total_tokens",
  "finish_reason",
  "input_hash",
  "output_hash",
  "input_excerpt",
  "output_excerpt",
  "error_message",
  "estimated_cost_usd",
  "input_cost_usd",
  "output_cost_usd",
  "pricing_version",
];

const TRACE_RAW_COLUMNS = TRACE_COLUMNS.map((column) => {
  if (column === "metadata")
    return "TO_JSON(STRUCT(billing_source, company_id, action_id, customer_cost_usd)) AS metadata";
  if (["input_excerpt", "output_excerpt", "error_message"].includes(column)) {
    return `CAST(NULL AS STRING) AS ${column}`;
  }
  return column;
});

const RAG_LEGACY_COLUMNS = [
  "event_id",
  "event_kind",
  "event_ts",
  "schema_version",
  "workspace_id",
  "conversation_id",
  "message_id",
  "trace_id",
  "source_service",
  "metadata",
  "answer_message_id",
  "channel",
  "result_type",
  "outcome",
  "product_mode",
  "pipeline_path",
  "retrieval_path",
  "duration_ms",
  "generation_model",
  "generation_latency_ms",
  "source_ids",
  "citation_count",
  "retrieval_context_count",
  "CAST(NULL AS INT64) AS asks_detected_count",
  "CAST(NULL AS INT64) AS asks_answered_count",
  "CAST(NULL AS INT64) AS missing_asks_count",
  "fallback_action",
  "fallback_reason",
  "input_hash",
  "output_hash",
  "input_excerpt",
  "output_excerpt",
];

const RAG_RAW_COLUMNS = RAG_LEGACY_COLUMNS.map((column) => {
  if (column === "metadata") return "CAST(NULL AS JSON) AS metadata";
  if (["input_excerpt", "output_excerpt"].includes(column)) {
    return `CAST(NULL AS STRING) AS ${column}`;
  }
  return column
    .replace(
      "CAST(NULL AS INT64) AS asks_detected_count",
      "asks_detected_count",
    )
    .replace(
      "CAST(NULL AS INT64) AS asks_answered_count",
      "asks_answered_count",
    )
    .replace("CAST(NULL AS INT64) AS missing_asks_count", "missing_asks_count");
});

const SCORE_COLUMNS = [
  "event_id",
  "event_kind",
  "event_ts",
  "schema_version",
  "workspace_id",
  "conversation_id",
  "message_id",
  "trace_id",
  "source_service",
  "metadata",
  "score_name",
  "score_source",
  "data_type",
  "numeric_value",
  "boolean_value",
  "string_value",
  "comment",
  "reasoning_excerpt",
];

const SCORE_RAW_COLUMNS = SCORE_COLUMNS.map((column) => {
  if (column === "metadata") return "CAST(NULL AS JSON) AS metadata";
  if (["comment", "reasoning_excerpt"].includes(column)) {
    return `CAST(NULL AS STRING) AS ${column}`;
  }
  return column;
});

const EVAL_COLUMNS = [
  "event_id",
  "event_kind",
  "event_ts",
  "schema_version",
  "workspace_id",
  "conversation_id",
  "message_id",
  "trace_id",
  "source_service",
  "metadata",
  "eval_run_id",
  "evaluator_name",
  "status",
  "sampled_count",
  "passed_count",
  "failed_count",
  "error_message",
];

const EVAL_RAW_COLUMNS = EVAL_COLUMNS.map((column) => {
  if (column === "metadata") return "CAST(NULL AS JSON) AS metadata";
  if (column === "error_message") {
    return "CAST(NULL AS STRING) AS error_message";
  }
  return column;
});

function buildScoreViewDdl(config) {
  const legacy = legacyBranch(config, "llm_score_events", SCORE_COLUMNS);
  const rawScores = `${rawBranch(config, "llm_score", SCORE_RAW_COLUMNS)}
  AND score_source IS NOT NULL
  AND score_source != 'system_eval'`;
  const derived = `SELECT
  LOWER(TO_HEX(SHA256(TO_JSON_STRING(['llm_score', event_id, score_name, data_type])))) AS event_id,
  'llm_score' AS event_kind,
  event_ts,
  schema_version,
  workspace_id,
  conversation_id,
  message_id,
  COALESCE(trace_id, event_id) AS trace_id,
  source_service,
  CAST(NULL AS JSON) AS metadata,
  score_name,
  'system_eval' AS score_source,
  data_type,
  numeric_value,
  boolean_value,
  CAST(NULL AS STRING) AS string_value,
  CAST(NULL AS STRING) AS comment,
  CAST(NULL AS STRING) AS reasoning_excerpt,
  0 AS source_priority
FROM derived_rag_scores`;
  const ctes = `WITH rag_score_inputs AS (
  SELECT
    *,
    COALESCE(NULLIF(ARRAY_LENGTH(source_ids), 0), retrieval_context_count, 0) AS context_count,
    (
      LOWER(COALESCE(result_type, '')) = 'fallback'
      OR LOWER(COALESCE(fallback_action, '')) LIKE '%fallback%'
      OR LOWER(COALESCE(fallback_action, '')) LIKE '%clarification%'
      OR LOWER(COALESCE(fallback_reason, '')) LIKE '%missing%'
      OR LOWER(COALESCE(fallback_reason, '')) LIKE '%gap%'
      OR LOWER(COALESCE(fallback_reason, '')) LIKE '%context%'
    ) AS fallback_like
  FROM ${qualifiedTable(config)}
  WHERE event_kind = 'rag_turn'
),
derived_rag_scores AS (
  SELECT
    rag_score_inputs.* EXCEPT(score_name, score_source, data_type, numeric_value, boolean_value, string_value),
    score.score_name,
    score.data_type,
    score.numeric_value,
    score.boolean_value
  FROM rag_score_inputs
  CROSS JOIN UNNEST([
    STRUCT(
      'rag_context_present' AS score_name,
      'boolean' AS data_type,
      CAST(NULL AS FLOAT64) AS numeric_value,
      context_count > 0 AS boolean_value
    ),
    STRUCT(
      'rag_answer_without_context',
      'boolean',
      CAST(NULL AS FLOAT64),
      output_hash IS NOT NULL AND context_count = 0 AND NOT fallback_like
    ),
    STRUCT(
      'rag_fallback_without_context',
      'boolean',
      CAST(NULL AS FLOAT64),
      fallback_like AND context_count = 0
    ),
    STRUCT(
      'citation_coverage',
      'numeric',
      IF(context_count > 0, LEAST(1.0, SAFE_DIVIDE(COALESCE(citation_count, 0), context_count)), NULL),
      CAST(NULL AS BOOL)
    ),
    STRUCT(
      'answer_completeness',
      'numeric',
      IF(asks_detected_count > 0, SAFE_DIVIDE(asks_answered_count, asks_detected_count), NULL),
      CAST(NULL AS BOOL)
    ),
    STRUCT(
      'latency_within_target',
      'boolean',
      CAST(NULL AS FLOAT64),
      IF(duration_ms IS NULL, NULL, duration_ms <= 10000)
    )
  ]) AS score
)`;
  return deduplicatingViewDdl(
    config,
    "llm_score_events",
    [legacy, rawScores, derived],
    ctes,
  );
}

export function buildCompatibilityViewDdls(config) {
  return {
    llm_trace_events: deduplicatingViewDdl(config, "llm_trace_events", [
      legacyBranch(config, "llm_trace_events", TRACE_COLUMNS),
      rawBranch(config, "llm_trace", TRACE_RAW_COLUMNS),
    ]),
    rag_turn_events: deduplicatingViewDdl(config, "rag_turn_events", [
      legacyBranch(config, "rag_turn_events", RAG_LEGACY_COLUMNS),
      rawBranch(config, "rag_turn", RAG_RAW_COLUMNS),
    ]),
    llm_score_events: buildScoreViewDdl(config),
    eval_run_events: deduplicatingViewDdl(config, "eval_run_events", [
      legacyBranch(config, "eval_run_events", EVAL_COLUMNS),
      rawBranch(config, "eval_run", EVAL_RAW_COLUMNS),
    ]),
  };
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    if (key in args) {
      args[key] = Array.isArray(args[key])
        ? [...args[key], next]
        : [args[key], next];
    } else {
      args[key] = next;
    }
    index += 1;
  }
  return args;
}

export function getArgValues(args, name) {
  const value = args[name];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => compact(item).split(","))
    .map(compact)
    .filter(Boolean);
}

function resolveGcloudInvocation(args) {
  if (process.platform !== "win32") return { command: "gcloud", args };
  const where = spawnSync("where.exe", ["gcloud.ps1"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  const launcher = compact(where.stdout).split(/\r?\n/).find(Boolean);
  if (!launcher) return { command: "gcloud", args };
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      ...args,
    ],
  };
}

function runGcloud(args, options = {}) {
  const invocation = resolveGcloudInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
}

function resolveBqInvocation(args) {
  if (process.platform !== "win32")
    return { command: "bq", args, env: process.env };
  const where = spawnSync("where.exe", ["bq.cmd"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  const launcher = compact(where.stdout).split(/\r?\n/).find(Boolean);
  if (!launcher) return { command: "bq", args, env: process.env };
  const env = {
    ...process.env,
    AIRI_BQ_LAUNCHER: launcher,
    AIRI_BQ_ARGS_JSON: JSON.stringify(args),
  };
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$launcher = $env:AIRI_BQ_LAUNCHER; $cliArgs = @((ConvertFrom-Json $env:AIRI_BQ_ARGS_JSON)); & $launcher @cliArgs",
    ],
    env,
  };
}

export function buildBqInvocationArgs(args) {
  // Avoid bq's unused Drive scope request, which can prefix JSON with a WIF warning.
  return ["--enable_gdrive=false", ...args];
}

function runBq(args, options = {}) {
  const invocation = resolveBqInvocation(buildBqInvocationArgs(args));
  return spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: invocation.env,
    input: options.input,
    stdio: options.capture
      ? [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      : "inherit",
    shell: false,
  });
}

export function buildCommandFailure(label, result) {
  const detail = compact(
    result?.stderr || result?.stdout || result?.error?.message,
  ).slice(0, 1000);
  return new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}

export function buildBigQueryDdlCommand(config, ddl) {
  return {
    args: [
      `--project_id=${config.projectId}`,
      "--format=none",
      "query",
      `--location=${config.location}`,
      "--use_legacy_sql=false",
      "--quiet",
    ],
    input: ddl,
  };
}

function runDdl(config, ddl, label = "BigQuery DDL") {
  const command = buildBigQueryDdlCommand(config, ddl);
  const result = runBq(command.args, { capture: true, input: command.input });
  if (result.status !== 0 || result.error) {
    throw buildCommandFailure(label, result);
  }
}

export function isMissingBigQueryDescribeResult(result) {
  return /not[ _-]?found/i.test(
    compact(`${result?.stdout || ""}\n${result?.stderr || ""}`),
  );
}

function readBqJson(config, identifier, options = {}) {
  const args = [
    `--project_id=${config.projectId}`,
    "show",
    "--format=prettyjson",
  ];
  if (options.dataset) args.push("--dataset");
  args.push(identifier);
  const result = runBq(args, { capture: true });
  if (result.status !== 0 || result.error) {
    if (options.allowMissing && isMissingBigQueryDescribeResult(result)) {
      return null;
    }
    throw buildCommandFailure(`BigQuery describe ${identifier}`, result);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `BigQuery describe ${identifier} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertNoErrors(label, errors) {
  if (errors.length > 0) {
    throw new Error(`${label} validation failed:\n- ${errors.join("\n- ")}`);
  }
}

export function isMissingGcloudDescribeResult(result) {
  const detail = compact(
    `${result?.stdout || ""}\n${result?.stderr || ""}\n${result?.error?.message || ""}`,
  );
  return /\bNOT_FOUND\b|\b(?:status|code)(?: code)?[:= ]+404\b/i.test(detail);
}

export function ensureGcloudResource(resource, options = {}) {
  const run = options.run || runGcloud;
  const current = run(resource.describe, { capture: true });
  if (current.status === 0 && !current.error) return "existing";
  if (!isMissingGcloudDescribeResult(current)) {
    throw buildCommandFailure(
      `Google Cloud resource describe (${resource.describe.join(" ")})`,
      current,
    );
  }

  const created = run(resource.create, { capture: true });
  if (created.status !== 0 || created.error) {
    throw buildCommandFailure(
      `Google Cloud resource create (${resource.create.join(" ")})`,
      created,
    );
  }
  return "created";
}

function readPubSubResource(resource) {
  const result = runGcloud([...resource.describe, "--format=json"], {
    capture: true,
  });
  if (result.status !== 0 || result.error) {
    throw buildCommandFailure(
      `Pub/Sub describe (${resource.describe.join(" ")})`,
      result,
    );
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `Pub/Sub describe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveProjectNumber(projectId) {
  const result = runGcloud(
    ["projects", "describe", projectId, "--format=value(projectNumber)"],
    { capture: true },
  );
  if (result.status !== 0 || result.error || !compact(result.stdout)) {
    throw buildCommandFailure(
      `Resolve project number for ${projectId}`,
      result,
    );
  }
  return compact(result.stdout);
}

function readBigQueryTableIamPolicy(config) {
  const result = runBq(
    [
      `--project_id=${config.projectId}`,
      "get-iam-policy",
      "--table",
      `${config.projectId}:${config.dataset}.${config.table}`,
    ],
    { capture: true },
  );
  if (result.status !== 0 || result.error) {
    throw buildCommandFailure("Read BigQuery table IAM policy", result);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `BigQuery table IAM policy returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function grantBigQueryTableIam(config, command) {
  const member = command.find((item) => item.startsWith("--member="))?.slice(9);
  const role = command.find((item) => item.startsWith("--role="))?.slice(7);
  const policy = readBigQueryTableIamPolicy(config);
  const exists = policy?.bindings?.some(
    (binding) =>
      binding.role === role &&
      !binding.condition &&
      Array.isArray(binding.members) &&
      binding.members.includes(member),
  );
  if (exists) return;
  const result = runBq(command, { capture: true });
  if (result.status !== 0 || result.error) {
    throw buildCommandFailure(
      "Grant Pub/Sub service agent BigQuery table writer IAM",
      result,
    );
  }
}

export function validateCompatibilityView(config, viewName, actual) {
  const errors = [];
  if (actual?.type !== "VIEW") {
    errors.push(`canonical compatibility object must be a VIEW`);
    return errors;
  }
  const query = compact(actual?.view?.query);
  if (viewName === "llm_trace_events") {
    for (const column of ["thinking_tokens", "cached_prompt_tokens"]) {
      if (!query.includes(column))
        errors.push(`view query must expose ${column}`);
    }
  }
  for (const tableName of [config.table, `${viewName}_legacy`]) {
    if (!query.includes(`${config.projectId}.${config.dataset}.${tableName}`)) {
      errors.push(`view query must reference ${tableName}`);
    }
  }
  if (
    !/ROW_NUMBER\s*\(\s*\)\s*OVER\s*\(\s*PARTITION\s+BY\s+event_id\s+ORDER\s+BY\s+source_priority\s+ASC/i.test(
      query,
    )
  ) {
    errors.push("view query must deduplicate by event_id with source priority");
  }
  const expectedEventKind = {
    llm_trace_events: "llm_trace",
    rag_turn_events: "rag_turn",
    llm_score_events: "llm_score",
    eval_run_events: "eval_run",
  }[viewName];
  if (!query.includes(`event_kind = '${expectedEventKind}'`)) {
    errors.push(`view query must select ${expectedEventKind} product facts`);
  }
  if (actual?.view?.useLegacySql === true) {
    errors.push("compatibility view must use standard SQL");
  }
  return errors;
}

export function reconcileCompatibilityView(
  config,
  viewName,
  ddl,
  operations = {},
) {
  const read =
    operations.read ||
    ((identifier, options) => readBqJson(config, identifier, options));
  const executeDdl =
    operations.executeDdl || ((statement) => runDdl(config, statement));
  const currentIdentifier = `${config.projectId}:${config.dataset}.${viewName}`;
  const archiveIdentifier = `${currentIdentifier}_legacy`;
  let current = read(currentIdentifier, { allowMissing: true });
  let archive = read(archiveIdentifier, { allowMissing: true });

  if (current && current.type === "TABLE") {
    if (archive) {
      throw new Error(
        `Cannot archive ${viewName}: both the legacy base table and ${viewName}_legacy already exist. Resolve the conflict without deleting data.`,
      );
    }
    assertNoErrors(
      `${viewName} canonical legacy table schema`,
      validateLegacyTableSchema(viewName, current, {
        allowKnownMissingColumns: true,
      }),
    );
    for (const normalizationDdl of buildLegacyTableNormalizationDdls(
      config,
      viewName,
      current,
    )) {
      executeDdl(normalizationDdl);
    }
    current = read(currentIdentifier);
    assertNoErrors(
      `${viewName} normalized canonical legacy table schema`,
      validateLegacyTableSchema(viewName, current),
    );
    for (const migrationDdl of buildLegacyTableMigrationDdls(
      config,
      viewName,
    )) {
      executeDdl(migrationDdl);
    }
    current = null;
    archive = read(archiveIdentifier);
  }
  if (current && current.type !== "VIEW") {
    throw new Error(
      `${viewName} must be a TABLE eligible for one-time archival or a VIEW; received ${current.type || "unknown"}.`,
    );
  }
  if (!archive) {
    executeDdl(buildEmptyLegacyTableDdl(config, viewName));
    archive = read(archiveIdentifier);
  }
  if (archive.type !== "TABLE") {
    throw new Error(`${viewName}_legacy must remain a TABLE.`);
  }
  assertNoErrors(
    `${viewName}_legacy archive schema`,
    validateLegacyTableSchema(viewName, archive),
  );
  executeDdl(buildArchiveTableOptionsDdl(config, `${viewName}_legacy`));
  archive = read(archiveIdentifier);
  if (archive?.type !== "TABLE") {
    throw new Error(`${viewName}_legacy must remain a TABLE.`);
  }
  assertNoErrors(
    `${viewName}_legacy archive schema after option reconciliation`,
    validateLegacyTableSchema(viewName, archive),
  );
  assertNoErrors(
    `${viewName}_legacy archive options`,
    validateArchiveTableOptions(archive),
  );

  executeDdl(ddl);
  const verified = read(currentIdentifier);
  assertNoErrors(
    `${viewName} compatibility view`,
    validateCompatibilityView(config, viewName, verified),
  );
}

export function validateFinalizedCompatibilityViews(config, operations = {}) {
  const read =
    operations.read ||
    ((identifier, options) => readBqJson(config, identifier, options));
  for (const viewName of COMPATIBILITY_VIEWS) {
    const currentIdentifier = `${config.projectId}:${config.dataset}.${viewName}`;
    const archiveIdentifier = `${currentIdentifier}_legacy`;
    assertNoErrors(
      `${viewName} compatibility view`,
      validateCompatibilityView(config, viewName, read(currentIdentifier)),
    );
    const archive = read(archiveIdentifier);
    if (archive?.type !== "TABLE") {
      throw new Error(`${viewName}_legacy must remain a TABLE.`);
    }
    assertNoErrors(
      `${viewName}_legacy archive schema`,
      validateLegacyTableSchema(viewName, archive),
    );
    assertNoErrors(
      `${viewName}_legacy archive options`,
      validateArchiveTableOptions(archive),
    );
  }
}

function validatePreparedInfrastructure(config) {
  const resources = buildPubSubResourceCommands(config);
  assertNoErrors(
    "BigQuery dataset",
    validateDataset(
      config,
      readBqJson(config, `${config.projectId}:${config.dataset}`, {
        dataset: true,
      }),
    ),
  );
  assertNoErrors(
    "BigQuery raw table",
    validateRawTable(
      config,
      readBqJson(
        config,
        `${config.projectId}:${config.dataset}.${config.table}`,
      ),
    ),
  );
  assertNoErrors(
    "Pub/Sub product-ledger topology",
    validatePubSubTopology(config, {
      topic: readPubSubResource(resources.topic),
      dlqTopic: readPubSubResource(resources.dlqTopic),
      dlqRetentionSubscription: readPubSubResource(
        resources.dlqRetentionSubscription,
      ),
      subscription: readPubSubResource(resources.subscription),
    }),
  );
}

export function buildPrepareBigQueryDdlSteps(config) {
  return [
    { label: "BigQuery dataset DDL", ddl: buildDatasetDdl(config) },
    { label: "BigQuery raw table DDL", ddl: buildRawTableDdl(config) },
    {
      label: "BigQuery thinking token column DDL",
      ddl: `ALTER TABLE ${qualifiedTable(config)} ADD COLUMN IF NOT EXISTS thinking_tokens INT64`,
    },
    {
      label: "BigQuery cached prompt token column DDL",
      ddl: `ALTER TABLE ${qualifiedTable(config)} ADD COLUMN IF NOT EXISTS cached_prompt_tokens INT64`,
    },
    ...[
      ["billing_source", "STRING"],
      ["company_id", "STRING"],
      ["action_id", "STRING"],
      ["customer_cost_usd", "FLOAT64"],
    ].map(([name, type]) => ({
      label: `BigQuery ${name} column DDL`,
      ddl: `ALTER TABLE ${qualifiedTable(config)} ADD COLUMN IF NOT EXISTS ${name} ${type}`,
    })),
    {
      label: "BigQuery partition option DDL",
      ddl: buildDisablePartitionFilterDdl(config),
    },
  ];
}

export function prepareBigQuerySchema(config, operations = {}) {
  const read =
    operations.read ||
    ((identifier, options) => readBqJson(config, identifier, options));
  const executeDdl =
    operations.executeDdl || ((ddl, label) => runDdl(config, ddl, label));
  const dataset = read(`${config.projectId}:${config.dataset}`, {
    dataset: true,
    allowMissing: true,
  });
  if (dataset)
    assertNoErrors(
      "Existing BigQuery dataset",
      validateDataset(config, dataset),
    );
  else if (operations.existingOnly)
    throw new Error("Schema preparation requires an existing dataset");
  const table = read(`${config.projectId}:${config.dataset}.${config.table}`, {
    allowMissing: true,
  });
  if (table) {
    const reference = table.tableReference;
    if (
      table.type !== "TABLE" ||
      reference?.projectId !== config.projectId ||
      reference?.datasetId !== config.dataset ||
      reference?.tableId !== config.table
    ) {
      throw new Error(
        "Existing BigQuery raw table identity or type does not match",
      );
    }
    if (
      table.location &&
      table.location.toUpperCase() !== config.location.toUpperCase()
    ) {
      throw new Error("Existing BigQuery raw table location does not match");
    }
  } else if (operations.existingOnly)
    throw new Error("Schema preparation requires an existing raw table");
  const [datasetStep, tableStep, ...additiveSteps] =
    buildPrepareBigQueryDdlSteps(config);
  if (!dataset) executeDdl(datasetStep.ddl, datasetStep.label);
  if (!table) executeDdl(tableStep.ddl, tableStep.label);
  for (const { label, ddl } of additiveSteps) executeDdl(ddl, label);
}

function prepareInfrastructure(config, options = {}) {
  prepareBigQuerySchema(config, {
    existingOnly: options.existingInfrastructureOnly === true,
  });
  if (options.existingInfrastructureOnly === true) {
    validatePreparedInfrastructure(config);
    return;
  }
  const projectNumber =
    config.projectNumber || resolveProjectNumber(config.projectId);
  grantBigQueryTableIam(
    config,
    buildBigQueryTableIamCommand(config, projectNumber),
  );

  const resources = buildPubSubResourceCommands(config);
  for (const resource of [
    resources.topic,
    resources.dlqTopic,
    resources.dlqRetentionSubscription,
    resources.subscription,
  ]) {
    ensureGcloudResource(resource);
  }
  grantLlmProductAnalyticsIamBindings(
    buildPubSubIamCommands(config, projectNumber),
  );
  validatePreparedInfrastructure(config);
}

export function buildLlmProductAnalyticsIamFailureMessage(
  failedCommand,
  commands,
) {
  return [
    `Failed to grant LLM product analytics Pub/Sub IAM binding: ${failedCommand.join(" ")}`,
    "Run the required IAM commands with an identity that can update Pub/Sub policies:",
    ...commands.map((command) => `gcloud ${command.join(" ")}`),
  ].join("\n");
}

export function grantLlmProductAnalyticsIamBindings(commands, options = {}) {
  const grantBindings = options.grantBindings || grantIamBindings;
  return grantBindings(commands, {
    label: "LLM product analytics",
    failureMessage: buildLlmProductAnalyticsIamFailureMessage,
  });
}

function listProjectSubscriptions(config) {
  const subscriptions = [];
  for (const command of buildLegacySubscriptionInventoryCommands(config)) {
    const topic = command[3];
    const result = runGcloud(command, { capture: true });
    if (result.status !== 0 || result.error) {
      if (/not[ -]?found/i.test(compact(result.stderr))) continue;
      throw buildCommandFailure(
        `Inventory Pub/Sub subscriptions for ${topic}`,
        result,
      );
    }
    let entries;
    try {
      entries = JSON.parse(result.stdout || "[]");
    } catch (error) {
      throw new Error(
        `Pub/Sub subscription inventory for ${topic} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      const name = compact(typeof entry === "string" ? entry : entry?.name);
      if (!name) continue;
      subscriptions.push({
        name,
        topic: `projects/${config.projectId}/topics/${topic}`,
      });
    }
  }
  return subscriptions;
}

export function finalizeCompatibilityViews(config, operations = {}) {
  const viewDdls = buildCompatibilityViewDdls(config);
  const read =
    operations.read ||
    ((identifier, options) => readBqJson(config, identifier, options));
  const executeDdl =
    operations.executeDdl || ((statement) => runDdl(config, statement));
  for (const viewName of COMPATIBILITY_VIEWS) {
    const currentIdentifier = `${config.projectId}:${config.dataset}.${viewName}`;
    const archiveIdentifier = `${currentIdentifier}_legacy`;
    const current = read(currentIdentifier, { allowMissing: true });
    const archive = read(archiveIdentifier, { allowMissing: true });
    if (current?.type === "TABLE" && archive) {
      throw new Error(
        `Cannot archive ${viewName}: both the legacy base table and ${viewName}_legacy already exist. Resolve the conflict without deleting data.`,
      );
    }
    if (current?.type === "TABLE") {
      assertNoErrors(
        `${viewName} canonical legacy table schema`,
        validateLegacyTableSchema(viewName, current, {
          allowKnownMissingColumns: true,
        }),
      );
    } else if (current && current.type !== "VIEW") {
      throw new Error(
        `${viewName} must be a TABLE eligible for one-time archival or a VIEW; received ${current.type || "unknown"}.`,
      );
    }
    if (archive) {
      if (archive.type !== "TABLE") {
        throw new Error(`${viewName}_legacy must remain a TABLE.`);
      }
      assertNoErrors(
        `${viewName}_legacy archive schema`,
        validateLegacyTableSchema(viewName, archive),
      );
    }
  }
  for (const viewName of COMPATIBILITY_VIEWS) {
    reconcileCompatibilityView(config, viewName, viewDdls[viewName], {
      read,
      executeDdl,
    });
  }
}

export function syncGcpLlmProductAnalytics(input) {
  const config = normalizeConfig(input);
  const { phase } = executeSyncPhase(input?.phase, {
    config,
    prepare: () => prepareInfrastructure(config, input),
    validatePrepared: () => validatePreparedInfrastructure(config),
    validateFinalized: () => validateFinalizedCompatibilityViews(config),
    listSubscriptions: () => listProjectSubscriptions(config),
    finalize: () => finalizeCompatibilityViews(config),
  });

  return {
    phase,
    projectId: config.projectId,
    dataset: config.dataset,
    table: config.table,
    topic: config.topic,
    subscription: config.subscription,
    compatibilityViews: [...COMPATIBILITY_VIEWS],
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = syncGcpLlmProductAnalytics({
    phase: args.phase,
    projectId: args.project,
    publisherServiceAccounts: getArgValues(args, "publisher-service-account"),
    location: process.env.GCP_LLM_ANALYTICS_LOCATION,
  });
  console.info(
    JSON.stringify({
      event: "gcp.llm_product_analytics.sync",
      outcome: "success",
      ...result,
    }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "gcp.llm_product_analytics.sync",
        outcome: "error",
        error: {
          type: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    process.exit(1);
  }
}
