import assert from "node:assert/strict";
import test from "node:test";

import {
  BIGQUERY_DATASET,
  BIGQUERY_TABLE,
  COMPATIBILITY_VIEWS,
  DLQ_RETENTION_SUBSCRIPTION,
  DLQ_TOPIC,
  LEGACY_TOPICS,
  PRODUCT_SUBSCRIPTION,
  PRODUCT_TOPIC,
  RAW_TABLE_SCHEMA,
  buildArchiveTableOptionsDdl,
  buildBqInvocationArgs,
  buildBigQueryTableIamCommand,
  buildCommandFailure,
  buildBigQueryDdlCommand,
  buildCompatibilityViewDdls,
  buildDatasetDdl,
  buildDisablePartitionFilterDdl,
  buildEmptyLegacyTableDdl,
  buildLegacyTableMigrationDdls,
  buildLegacyTableNormalizationDdls,
  buildLegacySubscriptionInventoryCommands,
  buildPubSubIamCommands,
  buildPubSubResourceCommands,
  buildRawTableDdl,
  buildPrepareBigQueryDdlSteps,
  ensureGcloudResource,
  executeSyncPhase,
  finalizeCompatibilityViews,
  findLegacyTopicSubscriptions,
  getArgValues,
  grantLlmProductAnalyticsIamBindings,
  normalizeConfig,
  normalizeSyncPhase,
  isMissingGcloudDescribeResult,
  parseArgs,
  prepareBigQuerySchema,
  reconcileCompatibilityView,
  validateArchiveTableOptions,
  validateDataset,
  validateFinalizedCompatibilityViews,
  validateLegacyTableSchema,
  validatePubSubTopology,
  validateRawTable,
  isMissingBigQueryDescribeResult,
} from "./sync-gcp-llm-product-analytics.mjs";

const CONFIG = normalizeConfig({
  projectId: "project-1",
  publisherServiceAccounts: [
    "gateway@project-1.iam.gserviceaccount.com",
    "serviceAccount:web@project-1.iam.gserviceaccount.com",
  ],
});

test("keeps an explicitly empty repeated publisher account out of CLI values", () => {
  const args = parseArgs([
    "node",
    "sync-gcp-llm-product-analytics.mjs",
    "--publisher-service-account",
    "gateway@project-1.iam.gserviceaccount.com",
    "--publisher-service-account",
    "",
  ]);

  assert.deepEqual(getArgValues(args, "publisher-service-account"), [
    "gateway@project-1.iam.gserviceaccount.com",
  ]);
});

test("reports the failed Pub/Sub IAM command instead of throwing a callback TypeError", () => {
  const commands = [
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      "icecore-llm-product-events",
      "--project=project-1",
      "--member=serviceAccount:gateway@project-1.iam.gserviceaccount.com",
      "--role=roles/pubsub.publisher",
    ],
  ];

  assert.throws(
    () =>
      grantLlmProductAnalyticsIamBindings(commands, {
        grantBindings: (actualCommands, options) => {
          throw new Error(
            options.failureMessage(actualCommands[0], actualCommands),
          );
        },
      }),
    /Failed to grant LLM product analytics Pub\/Sub IAM binding: pubsub topics add-iam-policy-binding icecore-llm-product-events/,
  );
});

const HISTORICAL_TRACE_FIELDS = [
  { name: "event_id", type: "STRING", mode: "REQUIRED" },
  { name: "event_kind", type: "STRING", mode: "REQUIRED" },
  { name: "event_ts", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "schema_version", type: "INTEGER", mode: "REQUIRED" },
  { name: "workspace_id", type: "STRING", mode: "REQUIRED" },
  { name: "conversation_id", type: "STRING" },
  { name: "message_id", type: "STRING" },
  { name: "trace_id", type: "STRING" },
  { name: "source_service", type: "STRING" },
  { name: "metadata", type: "JSON" },
  { name: "operation", type: "STRING", mode: "REQUIRED" },
  { name: "provider", type: "STRING", mode: "REQUIRED" },
  { name: "model", type: "STRING", mode: "REQUIRED" },
  { name: "status", type: "STRING", mode: "REQUIRED" },
  { name: "latency_ms", type: "FLOAT64" },
  { name: "prompt_tokens", type: "INTEGER" },
  { name: "completion_tokens", type: "INTEGER" },
  { name: "total_tokens", type: "INTEGER" },
  { name: "finish_reason", type: "STRING" },
  { name: "input_hash", type: "STRING" },
  { name: "output_hash", type: "STRING" },
  { name: "input_excerpt", type: "STRING" },
  { name: "output_excerpt", type: "STRING" },
  { name: "error_message", type: "STRING" },
  { name: "estimated_cost_usd", type: "FLOAT64" },
  { name: "input_cost_usd", type: "FLOAT64" },
  { name: "output_cost_usd", type: "FLOAT64" },
  { name: "pricing_version", type: "STRING" },
];

const HISTORICAL_RAG_FIELDS = [
  { name: "event_id", type: "STRING", mode: "REQUIRED" },
  { name: "event_kind", type: "STRING", mode: "REQUIRED" },
  { name: "event_ts", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "schema_version", type: "INTEGER", mode: "REQUIRED" },
  { name: "workspace_id", type: "STRING", mode: "REQUIRED" },
  { name: "conversation_id", type: "STRING" },
  { name: "message_id", type: "STRING" },
  { name: "trace_id", type: "STRING" },
  { name: "source_service", type: "STRING" },
  { name: "metadata", type: "JSON" },
  { name: "answer_message_id", type: "STRING" },
  { name: "channel", type: "STRING" },
  { name: "result_type", type: "STRING" },
  { name: "outcome", type: "STRING" },
  { name: "product_mode", type: "STRING" },
  { name: "pipeline_path", type: "STRING" },
  { name: "retrieval_path", type: "STRING" },
  { name: "duration_ms", type: "FLOAT64" },
  { name: "generation_model", type: "STRING" },
  { name: "generation_latency_ms", type: "FLOAT64" },
  { name: "source_ids", type: "STRING", mode: "REPEATED" },
  { name: "citation_count", type: "INTEGER" },
  { name: "retrieval_context_count", type: "INTEGER" },
  { name: "fallback_action", type: "STRING" },
  { name: "fallback_reason", type: "STRING" },
  { name: "input_hash", type: "STRING" },
  { name: "output_hash", type: "STRING" },
  { name: "input_excerpt", type: "STRING" },
  { name: "output_excerpt", type: "STRING" },
];

const EARLIEST_TRACE_FIELDS = HISTORICAL_TRACE_FIELDS.filter(
  ({ name }) =>
    ![
      "estimated_cost_usd",
      "input_cost_usd",
      "output_cost_usd",
      "pricing_version",
    ].includes(name),
);

const HISTORICAL_SCORE_FIELDS = [
  { name: "event_id", type: "STRING", mode: "REQUIRED" },
  { name: "event_kind", type: "STRING", mode: "REQUIRED" },
  { name: "event_ts", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "schema_version", type: "INTEGER", mode: "REQUIRED" },
  { name: "workspace_id", type: "STRING", mode: "REQUIRED" },
  { name: "conversation_id", type: "STRING" },
  { name: "message_id", type: "STRING" },
  { name: "trace_id", type: "STRING" },
  { name: "source_service", type: "STRING" },
  { name: "metadata", type: "JSON" },
  { name: "score_name", type: "STRING", mode: "REQUIRED" },
  { name: "score_source", type: "STRING", mode: "REQUIRED" },
  { name: "data_type", type: "STRING", mode: "REQUIRED" },
  { name: "numeric_value", type: "FLOAT64" },
  { name: "boolean_value", type: "BOOLEAN" },
  { name: "string_value", type: "STRING" },
  { name: "comment", type: "STRING" },
  { name: "reasoning_excerpt", type: "STRING" },
];

const HISTORICAL_EVAL_FIELDS = [
  { name: "event_id", type: "STRING", mode: "REQUIRED" },
  { name: "event_kind", type: "STRING", mode: "REQUIRED" },
  { name: "event_ts", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "schema_version", type: "INTEGER", mode: "REQUIRED" },
  { name: "workspace_id", type: "STRING", mode: "REQUIRED" },
  { name: "conversation_id", type: "STRING" },
  { name: "message_id", type: "STRING" },
  { name: "trace_id", type: "STRING" },
  { name: "source_service", type: "STRING" },
  { name: "metadata", type: "JSON" },
  { name: "eval_run_id", type: "STRING", mode: "REQUIRED" },
  { name: "evaluator_name", type: "STRING", mode: "REQUIRED" },
  { name: "status", type: "STRING", mode: "REQUIRED" },
  { name: "sampled_count", type: "INTEGER" },
  { name: "passed_count", type: "INTEGER" },
  { name: "failed_count", type: "INTEGER" },
  { name: "error_message", type: "STRING" },
];

function legacyTable(fields, overrides = {}) {
  return {
    type: "TABLE",
    schema: { fields },
    requirePartitionFilter: false,
    timePartitioning: { type: "DAY", field: "event_ts" },
    ...overrides,
  };
}

test("normalizes the deployment contract onto stable product-ledger resource names", () => {
  assert.deepEqual(CONFIG, {
    projectId: "project-1",
    projectNumber: null,
    location: "US",
    dataset: BIGQUERY_DATASET,
    table: BIGQUERY_TABLE,
    topic: PRODUCT_TOPIC,
    subscription: PRODUCT_SUBSCRIPTION,
    dlqTopic: DLQ_TOPIC,
    dlqRetentionSubscription: DLQ_RETENTION_SUBSCRIPTION,
    publisherServiceAccounts: [
      "gateway@project-1.iam.gserviceaccount.com",
      "web@project-1.iam.gserviceaccount.com",
    ],
  });

  assert.throws(
    () => normalizeConfig({ projectId: "project with spaces" }),
    /Invalid Google Cloud project id/,
  );
  assert.throws(
    () => normalizeConfig({ projectId: "project-1" }),
    /At least one publisher service account is required/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        projectId: "project-1",
        location: "US'); DROP SCHEMA x; --",
        publisherServiceAccounts: ["gateway@project-1.iam.gserviceaccount.com"],
      }),
    /Invalid BigQuery location/,
  );
});

test("supports the four explicit lifecycle phases and removes preflight", () => {
  assert.equal(normalizeSyncPhase("prepare"), "prepare");
  assert.equal(normalizeSyncPhase(" validate "), "validate");
  assert.equal(normalizeSyncPhase(" FINALIZE "), "finalize");
  assert.equal(
    normalizeSyncPhase(" validate-finalized "),
    "validate-finalized",
  );
  assert.throws(() => normalizeSyncPhase("preflight"), /--phase must be/);
  assert.throws(() => normalizeSyncPhase(""), /Missing required --phase/);
});

test("validate proves prepared state without inventory or mutation", () => {
  const calls = [];
  const result = executeSyncPhase("validate", {
    prepare: () => calls.push("prepare"),
    validatePrepared: () => calls.push("validatePrepared"),
    validateFinalized: () => calls.push("validateFinalized"),
    listSubscriptions: () => calls.push("listSubscriptions"),
    finalize: () => calls.push("finalize"),
  });

  assert.deepEqual(calls, ["validatePrepared"]);
  assert.deepEqual(result, { phase: "validate" });
});

test("validate-finalized is read-only and proves both prepared and finalized state", () => {
  const calls = [];
  const result = executeSyncPhase("validate-finalized", {
    validatePrepared: () => calls.push("validatePrepared"),
    validateFinalized: () => calls.push("validateFinalized"),
    listSubscriptions: () => calls.push("listSubscriptions"),
    finalize: () => calls.push("finalize"),
  });

  assert.deepEqual(calls, ["validatePrepared", "validateFinalized"]);
  assert.deepEqual(result, { phase: "validate-finalized" });
});

test("validate-finalized requires every canonical view and immutable archive without mutating them", () => {
  const legacyFields = {
    llm_trace_events: HISTORICAL_TRACE_FIELDS,
    rag_turn_events: HISTORICAL_RAG_FIELDS,
    llm_score_events: HISTORICAL_SCORE_FIELDS,
    eval_run_events: HISTORICAL_EVAL_FIELDS,
  };
  const compatibilityDdls = buildCompatibilityViewDdls(CONFIG);
  const objects = new Map();
  for (const viewName of COMPATIBILITY_VIEWS) {
    const current = `project-1:${BIGQUERY_DATASET}.${viewName}`;
    objects.set(current, {
      type: "VIEW",
      view: {
        useLegacySql: false,
        query: compatibilityDdls[viewName],
      },
    });
    objects.set(`${current}_legacy`, legacyTable(legacyFields[viewName]));
  }
  const reads = [];

  validateFinalizedCompatibilityViews(CONFIG, {
    read: (identifier) => {
      reads.push(identifier);
      return objects.get(identifier);
    },
  });

  assert.deepEqual(
    reads,
    COMPATIBILITY_VIEWS.flatMap((viewName) => [
      `project-1:${BIGQUERY_DATASET}.${viewName}`,
      `project-1:${BIGQUERY_DATASET}.${viewName}_legacy`,
    ]),
  );

  objects.set(`project-1:${BIGQUERY_DATASET}.llm_trace_events`, {
    type: "VIEW",
    view: {
      useLegacySql: false,
      query: `SELECT * FROM \`project-1.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\` UNION ALL SELECT * FROM \`project-1.${BIGQUERY_DATASET}.llm_trace_events_legacy\``,
    },
  });
  assert.throws(
    () =>
      validateFinalizedCompatibilityViews(CONFIG, {
        read: (identifier) => objects.get(identifier),
      }),
    /llm_trace_events compatibility view validation failed:[\s\S]*deduplicate by event_id/,
  );
  objects.set(`project-1:${BIGQUERY_DATASET}.llm_trace_events`, {
    type: "VIEW",
    view: { useLegacySql: false, query: compatibilityDdls.llm_trace_events },
  });

  objects.set(`project-1:${BIGQUERY_DATASET}.eval_run_events`, {
    type: "TABLE",
  });
  assert.throws(
    () =>
      validateFinalizedCompatibilityViews(CONFIG, {
        read: (identifier) => objects.get(identifier),
      }),
    /eval_run_events compatibility view validation failed:[\s\S]*must be a VIEW/,
  );
});

test("finalize validates before and after compatibility mutation", () => {
  const calls = [];
  const result = executeSyncPhase("finalize", {
    config: CONFIG,
    validatePrepared: () => calls.push("validatePrepared"),
    validateFinalized: () => calls.push("validateFinalized"),
    listSubscriptions: () => {
      calls.push("listSubscriptions");
      return [];
    },
    finalize: () => calls.push("finalize"),
  });
  assert.deepEqual(calls, [
    "validatePrepared",
    "listSubscriptions",
    "finalize",
    "validateFinalized",
  ]);
  assert.deepEqual(result, { phase: "finalize" });
});

test("prepare phase never invokes legacy cutover checks or mutations", () => {
  const calls = [];
  const result = executeSyncPhase("prepare", {
    prepare: () => calls.push("prepare"),
    validatePrepared: () => calls.push("validatePrepared"),
    listSubscriptions: () => {
      calls.push("listSubscriptions");
      return [];
    },
    finalize: () => calls.push("finalize"),
  });

  assert.deepEqual(calls, ["prepare"]);
  assert.deepEqual(result, { phase: "prepare" });
});

test("finalize fails closed on any legacy-topic subscription before compatibility mutation", () => {
  const calls = [];
  assert.throws(
    () =>
      executeSyncPhase("finalize", {
        prepare: () => calls.push("prepare"),
        validatePrepared: () => calls.push("validatePrepared"),
        listSubscriptions: () => {
          calls.push("listSubscriptions");
          return [
            {
              name: "projects/project-1/subscriptions/old-trace-sink",
              topic: "projects/project-1/topics/icecore-llm-trace-events",
            },
          ];
        },
        finalize: () => calls.push("finalize"),
      }),
    /old-trace-sink[\s\S]*icecore-llm-trace-events[\s\S]*drain or detach/,
  );
  assert.deepEqual(calls, ["validatePrepared", "listSubscriptions"]);
});

test("creates a Pub/Sub resource only after an explicit not-found describe", () => {
  const commands = [];
  const run = (args) => {
    commands.push(args);
    if (commands.length === 1) {
      return {
        status: 1,
        stderr: "ERROR: (gcloud.pubsub.topics.describe) NOT_FOUND",
      };
    }
    return { status: 0, stdout: "" };
  };

  assert.equal(
    ensureGcloudResource(
      {
        describe: ["pubsub", "topics", "describe", "topic-1"],
        create: ["pubsub", "topics", "create", "topic-1"],
      },
      { run },
    ),
    "created",
  );
  assert.equal(commands.length, 2);
});

test("classifies only explicit GCP not-found responses as creatable", () => {
  assert.equal(
    isMissingGcloudDescribeResult({
      status: 1,
      stderr: "ERROR: (gcloud.pubsub.topics.describe) NOT_FOUND",
    }),
    true,
  );
  assert.equal(
    isMissingGcloudDescribeResult({
      status: 1,
      stderr: "PERMISSION_DENIED: pubsub.topics.get",
    }),
    false,
  );
});

test("does not create after an authorization or transport describe failure", () => {
  const commands = [];
  assert.throws(
    () =>
      ensureGcloudResource(
        {
          describe: ["pubsub", "topics", "describe", "topic-1"],
          create: ["pubsub", "topics", "create", "topic-1"],
        },
        {
          run: (args) => {
            commands.push(args);
            return {
              status: 1,
              stderr: "PERMISSION_DENIED: pubsub.topics.get",
            };
          },
        },
      ),
    /Google Cloud resource describe.*PERMISSION_DENIED/,
  );
  assert.equal(commands.length, 1);
});

test("inventories all six legacy topics and returns only attached blockers", () => {
  assert.deepEqual(LEGACY_TOPICS, [
    "icecore-llm-trace-events",
    "icecore-rag-turn-events",
    "icecore-llm-score-events",
    "icecore-eval-run-events",
    "icecore-llm-customer-feedback-events",
    "icecore-llm-human-evaluation-events",
  ]);
  assert.deepEqual(
    buildLegacySubscriptionInventoryCommands(CONFIG),
    LEGACY_TOPICS.map((topic) => [
      "pubsub",
      "topics",
      "list-subscriptions",
      topic,
      "--project=project-1",
      "--format=json",
    ]),
  );
  assert.deepEqual(
    findLegacyTopicSubscriptions(CONFIG, [
      {
        name: "projects/project-1/subscriptions/trace-sub",
        topic: "projects/project-1/topics/icecore-llm-trace-events",
      },
      {
        name: "projects/project-1/subscriptions/new-ledger",
        topic: `projects/project-1/topics/${PRODUCT_TOPIC}`,
      },
      {
        name: "projects/another/subscriptions/not-our-project",
        topic: "projects/another/topics/icecore-llm-score-events",
      },
      {
        name: "projects/another/subscriptions/cross-project-trace-sink",
        topic: "projects/project-1/topics/icecore-llm-trace-events",
      },
    ]),
    [
      {
        name: "projects/project-1/subscriptions/trace-sub",
        topic: "projects/project-1/topics/icecore-llm-trace-events",
      },
      {
        name: "projects/another/subscriptions/cross-project-trace-sink",
        topic: "projects/project-1/topics/icecore-llm-trace-events",
      },
    ],
  );
});

test("builds an idempotent dataset and sparse raw-table contract", () => {
  assert.equal(
    buildDatasetDdl(CONFIG),
    [
      "CREATE SCHEMA IF NOT EXISTS `project-1.icecore_llm_analytics`",
      "OPTIONS(location = 'US', description = 'Durable tenant-facing LLM product analytics ledger')",
    ].join("\n"),
  );

  const ddl = buildRawTableDdl(CONFIG);
  for (const column of [
    "event_id STRING NOT NULL",
    "event_kind STRING NOT NULL",
    "event_ts TIMESTAMP NOT NULL",
    "schema_version INT64 NOT NULL",
    "workspace_id STRING NOT NULL",
    "source_ids ARRAY<STRING>",
    "asks_detected_count INT64",
    "asks_answered_count INT64",
    "missing_asks_count INT64",
    "estimated_cost_usd FLOAT64",
    "score_source STRING",
    "eval_run_id STRING",
  ]) {
    assert.match(ddl, new RegExp(column.replace(/[<>]/g, "\\$&")));
  }
  assert.match(
    ddl,
    /CREATE TABLE IF NOT EXISTS `project-1\.icecore_llm_analytics\.llm_product_events`/,
  );
  assert.match(ddl, /PARTITION BY DATE\(event_ts\)/);
  assert.match(ddl, /CLUSTER BY workspace_id, event_kind/);
  assert.match(ddl, /require_partition_filter = FALSE/);
  assert.doesNotMatch(ddl, /partition_expiration_days/);
  assert.doesNotMatch(
    ddl,
    /metadata|input_excerpt|output_excerpt|error_message|comment|reasoning_excerpt|feedback_value|evaluation_status/,
  );
  assert.equal(
    buildDisablePartitionFilterDdl(CONFIG),
    "ALTER TABLE `project-1.icecore_llm_analytics.llm_product_events` SET OPTIONS(require_partition_filter = FALSE)",
  );
  assert.equal(
    buildDisablePartitionFilterDdl(CONFIG, "llm_trace_events_legacy"),
    "ALTER TABLE `project-1.icecore_llm_analytics.llm_trace_events_legacy` SET OPTIONS(require_partition_filter = FALSE)",
  );
});

test("streams multiline BigQuery DDL over stdin instead of a shell-sensitive argument", () => {
  const ddl = "CREATE TABLE x (\n  event_id STRING\n)";
  assert.deepEqual(buildBigQueryDdlCommand(CONFIG, ddl), {
    args: [
      "--project_id=project-1",
      "--format=none",
      "query",
      "--location=US",
      "--use_legacy_sql=false",
      "--quiet",
    ],
    input: ddl,
  });
});

test("disables the unused Google Drive scope for every BigQuery command", () => {
  const args = [
    "--project_id=project-1",
    "show",
    "--format=prettyjson",
    "project-1:icecore_llm_analytics",
  ];

  assert.deepEqual(buildBqInvocationArgs(args), [
    "--enable_gdrive=false",
    ...args,
  ]);
});

test("preserves stdout-only BigQuery diagnostics in bounded command failures", () => {
  const error = buildCommandFailure("BigQuery dataset DDL", {
    status: 1,
    stdout:
      "BigQuery error in query operation: Access Denied: missing bigquery.jobs.create",
    stderr: "",
  });

  assert.equal(
    error.message,
    "BigQuery dataset DDL failed: BigQuery error in query operation: Access Denied: missing bigquery.jobs.create",
  );
});

test("labels every prepare DDL so deployment failures identify the exact stage", () => {
  assert.deepEqual(
    buildPrepareBigQueryDdlSteps(CONFIG).map(({ label }) => label),
    [
      "BigQuery dataset DDL",
      "BigQuery raw table DDL",
      "BigQuery thinking token column DDL",
      "BigQuery cached prompt token column DDL",
      "BigQuery billing_source column DDL",
      "BigQuery company_id column DDL",
      "BigQuery action_id column DDL",
      "BigQuery customer_cost_usd column DDL",
      "BigQuery partition option DDL",
    ],
  );
});

test("existing BigQuery schema preparation verifies ownership and location without CREATE or IAM", () => {
  const statements = [];
  const dataset = {
    datasetReference: {
      projectId: CONFIG.projectId,
      datasetId: CONFIG.dataset,
    },
    location: "US",
    type: "DEFAULT",
  };
  const table = {
    tableReference: {
      projectId: CONFIG.projectId,
      datasetId: CONFIG.dataset,
      tableId: CONFIG.table,
    },
    type: "TABLE",
    location: "US",
  };
  const read = (_identifier, options) => (options.dataset ? dataset : table);
  prepareBigQuerySchema(CONFIG, {
    read,
    existingOnly: true,
    executeDdl: (sql) => statements.push(sql),
  });
  assert.equal(statements.length, 7);
  assert.ok(statements.every((sql) => sql.startsWith("ALTER TABLE")));
  assert.ok(
    statements.some((sql) =>
      sql.includes("ADD COLUMN IF NOT EXISTS billing_source STRING"),
    ),
  );
  for (const drift of ["location", "type", "identity"]) {
    statements.length = 0;
    const changed = {
      ...table,
      ...(drift === "location"
        ? { location: "EU" }
        : drift === "type"
          ? { type: "VIEW" }
          : {
              tableReference: {
                ...table.tableReference,
                projectId: "another-project",
              },
            }),
    };
    assert.throws(() =>
      prepareBigQuerySchema(CONFIG, {
        existingOnly: true,
        read: (_id, options) => (options.dataset ? dataset : changed),
        executeDdl: (sql) => statements.push(sql),
      }),
    );
    assert.deepEqual(statements, []);
  }
});

test("schema preparation creates only positively missing base objects outside existing-only mode", () => {
  const statements = [];
  const options = {
    read: () => null,
    executeDdl: (sql) => statements.push(sql),
  };
  assert.throws(
    () => prepareBigQuerySchema(CONFIG, { ...options, existingOnly: true }),
    /existing/,
  );
  assert.deepEqual(statements, []);
  prepareBigQuerySchema(CONFIG, options);
  assert.match(statements[0], /^CREATE SCHEMA IF NOT EXISTS/);
  assert.match(statements[1], /^CREATE TABLE IF NOT EXISTS/);
  statements.length = 0;
  assert.throws(
    () =>
      prepareBigQuerySchema(CONFIG, {
        ...options,
        read: () => {
          throw new Error("access denied");
        },
      }),
    /access denied/,
  );
  assert.deepEqual(statements, []);
});

test("prepares optional usage columns idempotently and preserves immutable legacy schemas", () => {
  const viewDdl = buildCompatibilityViewDdls(CONFIG).llm_trace_events;
  const branches = viewDdl.split(/\bUNION ALL\b/);
  const rawBranch = branches.find((branch) =>
    branch.includes(`FROM \`project-1.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\``),
  );
  const archiveBranch = branches.find((branch) =>
    branch.includes(
      `FROM \`project-1.${BIGQUERY_DATASET}.llm_trace_events_legacy\``,
    ),
  );
  assert.ok(
    rawBranch,
    "trace compatibility view must select raw product facts",
  );
  assert.ok(archiveBranch, "trace compatibility view must retain legacy facts");
  for (const name of ["thinking_tokens", "cached_prompt_tokens"]) {
    assert.deepEqual(
      RAW_TABLE_SCHEMA.find((field) => field.name === name),
      {
        name,
        type: "INTEGER",
        mode: "NULLABLE",
      },
    );
    const statements = buildPrepareBigQueryDdlSteps(CONFIG)
      .map((step) => step.ddl)
      .join("\n");
    assert.match(
      statements,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${name} INT64`),
    );
    assert.match(rawBranch, new RegExp(`^\\s+${name},?\\s*$`, "m"));
    assert.doesNotMatch(
      rawBranch,
      new RegExp(`CAST\\(NULL AS INT64\\) AS ${name}`),
    );
    assert.match(
      archiveBranch,
      new RegExp(`CAST\\(NULL AS INT64\\) AS ${name}`),
    );
  }
});

test("recognizes BigQuery missing-resource errors whether bq writes stdout or stderr", () => {
  assert.equal(
    isMissingBigQueryDescribeResult({
      stdout:
        "BigQuery error in show operation: Not found: Table project-1:dataset.table",
      stderr: "",
    }),
    true,
  );
  assert.equal(
    isMissingBigQueryDescribeResult({
      stdout: "",
      stderr: "NOT_FOUND: dataset.table",
    }),
    true,
  );
  assert.equal(
    isMissingBigQueryDescribeResult({
      stdout: "",
      stderr: "Access Denied: missing bigquery.tables.get",
    }),
    false,
  );
});

test("validates dataset and raw-table drift before wiring delivery", () => {
  assert.deepEqual(
    validateDataset(CONFIG, {
      datasetReference: {
        projectId: "project-1",
        datasetId: BIGQUERY_DATASET,
      },
      location: "US",
      type: "DEFAULT",
    }),
    [],
  );
  assert.match(
    validateDataset(CONFIG, {
      datasetReference: {
        projectId: "project-1",
        datasetId: BIGQUERY_DATASET,
      },
      location: "EU",
    }).join("\n"),
    /dataset location must be US/,
  );

  const validTable = {
    tableReference: {
      projectId: "project-1",
      datasetId: BIGQUERY_DATASET,
      tableId: BIGQUERY_TABLE,
    },
    type: "TABLE",
    schema: {
      fields: RAW_TABLE_SCHEMA,
    },
    timePartitioning: { type: "DAY", field: "event_ts" },
    clustering: { fields: ["workspace_id", "event_kind"] },
    requirePartitionFilter: false,
    require_partition_filter: false,
  };
  assert.deepEqual(validateRawTable(CONFIG, validTable), []);

  assert.match(
    validateRawTable(CONFIG, {
      ...validTable,
      timePartitioning: { type: "DAY", field: "created_at" },
      clustering: { fields: ["event_kind", "workspace_id"] },
      requirePartitionFilter: true,
      require_partition_filter: true,
      schema: {
        fields: RAW_TABLE_SCHEMA.filter(
          ({ name }) => name !== "pricing_version",
        ).map((field) =>
          field.name === "event_id" ? { ...field, mode: "NULLABLE" } : field,
        ),
      },
    }).join("\n"),
    /event_id must be REQUIRED[\s\S]*missing column pricing_version[\s\S]*partition field must be event_ts[\s\S]*clustering fields must be workspace_id,event_kind[\s\S]*require_partition_filter must be disabled for compatibility views/,
  );
});

test("builds retained BigQuery delivery and dead-letter resources", () => {
  const commands = buildPubSubResourceCommands(CONFIG);

  assert.deepEqual(commands.topic.create, [
    "pubsub",
    "topics",
    "create",
    PRODUCT_TOPIC,
    "--project=project-1",
    "--message-retention-duration=31d",
  ]);
  assert.deepEqual(commands.dlqTopic.create, [
    "pubsub",
    "topics",
    "create",
    DLQ_TOPIC,
    "--project=project-1",
    "--message-retention-duration=31d",
  ]);
  assert.deepEqual(commands.dlqRetentionSubscription.create, [
    "pubsub",
    "subscriptions",
    "create",
    DLQ_RETENTION_SUBSCRIPTION,
    "--project=project-1",
    `--topic=${DLQ_TOPIC}`,
    "--message-retention-duration=31d",
    "--expiration-period=never",
  ]);
  assert.deepEqual(commands.subscription.create, [
    "pubsub",
    "subscriptions",
    "create",
    PRODUCT_SUBSCRIPTION,
    "--project=project-1",
    `--topic=${PRODUCT_TOPIC}`,
    `--bigquery-table=project-1:${BIGQUERY_DATASET}.${BIGQUERY_TABLE}`,
    "--use-table-schema",
    "--no-write-metadata",
    "--no-drop-unknown-fields",
    "--message-retention-duration=31d",
    "--expiration-period=never",
    `--dead-letter-topic=${DLQ_TOPIC}`,
    "--max-delivery-attempts=20",
  ]);
});

test("validates the retained direct-BigQuery topology without assuming exactly-once delivery", () => {
  const expectedTopic = `projects/project-1/topics/${PRODUCT_TOPIC}`;
  const expectedDlqTopic = `projects/project-1/topics/${DLQ_TOPIC}`;
  const expectedSubscription = `projects/project-1/subscriptions/${PRODUCT_SUBSCRIPTION}`;
  const expectedDlqSubscription = `projects/project-1/subscriptions/${DLQ_RETENTION_SUBSCRIPTION}`;
  const actual = {
    topic: { name: expectedTopic, messageRetentionDuration: "2678400s" },
    dlqTopic: {
      name: expectedDlqTopic,
      messageRetentionDuration: "2678400s",
    },
    subscription: {
      name: expectedSubscription,
      topic: expectedTopic,
      messageRetentionDuration: "2678400s",
      expirationPolicy: {},
      bigqueryConfig: {
        table: `projects/project-1/datasets/${BIGQUERY_DATASET}/tables/${BIGQUERY_TABLE}`,
        useTableSchema: true,
        writeMetadata: false,
        dropUnknownFields: false,
      },
      deadLetterPolicy: {
        deadLetterTopic: expectedDlqTopic,
        maxDeliveryAttempts: 20,
      },
    },
    dlqRetentionSubscription: {
      name: expectedDlqSubscription,
      topic: expectedDlqTopic,
      messageRetentionDuration: "2678400s",
      expirationPolicy: {},
    },
  };

  assert.deepEqual(validatePubSubTopology(CONFIG, actual), []);
  const errors = validatePubSubTopology(CONFIG, {
    ...actual,
    subscription: {
      ...actual.subscription,
      bigqueryConfig: {
        ...actual.subscription.bigqueryConfig,
        useTableSchema: false,
        writeMetadata: true,
        dropUnknownFields: true,
      },
      expirationPolicy: { ttl: "2678400s" },
    },
  });
  assert.match(
    errors.join("\n"),
    /must use the BigQuery table schema[\s\S]*must not write Pub\/Sub metadata[\s\S]*must reject unknown fields[\s\S]*must never expire/,
  );
});

test("grants only table-scoped BigQuery write and required Pub/Sub bindings", () => {
  const serviceAgent =
    "service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com";
  assert.deepEqual(buildBigQueryTableIamCommand(CONFIG, "123456789"), [
    `--project_id=project-1`,
    "add-iam-policy-binding",
    `--member=serviceAccount:${serviceAgent}`,
    "--role=roles/bigquery.dataEditor",
    `project-1:${BIGQUERY_DATASET}.${BIGQUERY_TABLE}`,
  ]);

  assert.deepEqual(buildPubSubIamCommands(CONFIG, "123456789"), [
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      DLQ_TOPIC,
      "--project=project-1",
      `--member=serviceAccount:${serviceAgent}`,
      "--role=roles/pubsub.publisher",
    ],
    [
      "pubsub",
      "subscriptions",
      "add-iam-policy-binding",
      PRODUCT_SUBSCRIPTION,
      "--project=project-1",
      `--member=serviceAccount:${serviceAgent}`,
      "--role=roles/pubsub.subscriber",
    ],
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      PRODUCT_TOPIC,
      "--project=project-1",
      "--member=serviceAccount:gateway@project-1.iam.gserviceaccount.com",
      "--role=roles/pubsub.publisher",
    ],
    [
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      PRODUCT_TOPIC,
      "--project=project-1",
      "--member=serviceAccount:web@project-1.iam.gserviceaccount.com",
      "--role=roles/pubsub.publisher",
    ],
  ]);
});

test("builds rename-only legacy-table migrations before compatibility views", () => {
  for (const viewName of COMPATIBILITY_VIEWS) {
    const statements = buildLegacyTableMigrationDdls(CONFIG, viewName);
    assert.equal(statements.length, 1);
    assert.equal(
      statements[0],
      `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.${viewName}\` RENAME TO ${viewName}_legacy`,
    );
    assert.doesNotMatch(statements.join("\n"), /\bDROP\b/i);
  }
});

test("normalizes the known earliest trace schema before rename", () => {
  assert.deepEqual(
    validateLegacyTableSchema(
      "llm_trace_events",
      legacyTable(EARLIEST_TRACE_FIELDS),
      { allowKnownMissingColumns: true },
    ),
    [],
  );
  assert.deepEqual(
    buildLegacyTableNormalizationDdls(
      CONFIG,
      "llm_trace_events",
      legacyTable(EARLIEST_TRACE_FIELDS),
    ),
    [
      `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.llm_trace_events\` ADD COLUMN IF NOT EXISTS estimated_cost_usd FLOAT64`,
      `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.llm_trace_events\` ADD COLUMN IF NOT EXISTS input_cost_usd FLOAT64`,
      `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.llm_trace_events\` ADD COLUMN IF NOT EXISTS output_cost_usd FLOAT64`,
      `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.llm_trace_events\` ADD COLUMN IF NOT EXISTS pricing_version STRING`,
    ],
  );
  assert.match(
    validateLegacyTableSchema(
      "llm_trace_events",
      legacyTable(EARLIEST_TRACE_FIELDS),
    ).join("\n"),
    /missing legacy column estimated_cost_usd/,
  );
});

test("accepts only the known historical FLOAT64 duration variants", () => {
  assert.deepEqual(
    validateLegacyTableSchema(
      "llm_trace_events",
      legacyTable(HISTORICAL_TRACE_FIELDS),
    ),
    [],
  );
  assert.deepEqual(
    validateLegacyTableSchema(
      "rag_turn_events",
      legacyTable(HISTORICAL_RAG_FIELDS),
    ),
    [],
  );

  const unexpectedType = HISTORICAL_RAG_FIELDS.map((field) =>
    field.name === "citation_count" ? { ...field, type: "FLOAT64" } : field,
  );
  const unexpectedColumn = [
    ...HISTORICAL_TRACE_FIELDS,
    { name: "unreviewed_payload", type: "JSON" },
  ];
  assert.match(
    validateLegacyTableSchema(
      "rag_turn_events",
      legacyTable(unexpectedType),
    ).join("\n"),
    /citation_count type must be INTEGER, received FLOAT64/,
  );
  assert.match(
    validateLegacyTableSchema(
      "llm_trace_events",
      legacyTable(unexpectedColumn),
    ).join("\n"),
    /unexpected legacy column unreviewed_payload/,
  );
});

test("pre-validates and normalizes a historical canonical table before renaming", () => {
  const earliest = legacyTable(EARLIEST_TRACE_FIELDS, {
    requirePartitionFilter: true,
    timePartitioning: {
      type: "DAY",
      field: "event_ts",
      expirationMs: "31536000000",
    },
  });
  const normalizedCanonical = legacyTable(HISTORICAL_TRACE_FIELDS, {
    requirePartitionFilter: true,
    timePartitioning: {
      type: "DAY",
      field: "event_ts",
      expirationMs: "31536000000",
    },
  });
  const normalizedArchive = legacyTable(HISTORICAL_TRACE_FIELDS);
  const viewDdl = buildCompatibilityViewDdls(CONFIG).llm_trace_events;
  const reads = [
    earliest,
    null,
    normalizedCanonical,
    normalizedCanonical,
    normalizedArchive,
    { type: "VIEW", view: { query: viewDdl, useLegacySql: false } },
  ];
  const ddls = [];

  reconcileCompatibilityView(CONFIG, "llm_trace_events", viewDdl, {
    read: () => reads.shift(),
    executeDdl: (ddl) => ddls.push(ddl),
  });

  assert.deepEqual(ddls, [
    ...buildLegacyTableNormalizationDdls(CONFIG, "llm_trace_events", earliest),
    `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.llm_trace_events\` RENAME TO llm_trace_events_legacy`,
    `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.llm_trace_events_legacy\` SET OPTIONS(require_partition_filter = FALSE, partition_expiration_days = NULL)`,
    viewDdl,
  ]);
  assert.equal(reads.length, 0);
});

test("does not rename a canonical table with unexpected schema drift", () => {
  const invalid = legacyTable(
    HISTORICAL_TRACE_FIELDS.map((field) =>
      field.name === "latency_ms" ? { ...field, type: "NUMERIC" } : field,
    ),
  );
  const reads = [invalid, null];
  const ddls = [];

  assert.throws(
    () =>
      reconcileCompatibilityView(
        CONFIG,
        "llm_trace_events",
        buildCompatibilityViewDdls(CONFIG).llm_trace_events,
        {
          read: () => reads.shift(),
          executeDdl: (ddl) => ddls.push(ddl),
        },
      ),
    /canonical legacy table schema validation failed:[\s\S]*latency_ms type must be INTEGER or FLOAT, received NUMERIC/,
  );
  assert.deepEqual(ddls, []);
});

test("pre-validates all canonical tables before renaming any of them", () => {
  const legacyFields = {
    llm_trace_events: HISTORICAL_TRACE_FIELDS,
    rag_turn_events: HISTORICAL_RAG_FIELDS,
    llm_score_events: HISTORICAL_SCORE_FIELDS,
    eval_run_events: HISTORICAL_EVAL_FIELDS.map((field) =>
      field.name === "event_id" ? { ...field, type: "INTEGER" } : field,
    ),
  };
  const objects = new Map();
  for (const viewName of COMPATIBILITY_VIEWS) {
    objects.set(
      `project-1:${BIGQUERY_DATASET}.${viewName}`,
      legacyTable(legacyFields[viewName]),
    );
    objects.set(`project-1:${BIGQUERY_DATASET}.${viewName}_legacy`, null);
  }
  const ddls = [];

  assert.throws(
    () =>
      finalizeCompatibilityViews(CONFIG, {
        read: (identifier) => objects.get(identifier),
        executeDdl: (ddl) => ddls.push(ddl),
      }),
    /eval_run_events canonical legacy table schema validation failed:[\s\S]*event_id type must be STRING, received INTEGER/,
  );
  assert.deepEqual(ddls, []);
});

test("resumes a partial finalize from its preexisting archive", () => {
  const expiringArchive = legacyTable(HISTORICAL_RAG_FIELDS, {
    requirePartitionFilter: true,
    timePartitioning: {
      type: "DAY",
      field: "event_ts",
      expirationMs: "604800000",
    },
  });
  const normalizedArchive = legacyTable(HISTORICAL_RAG_FIELDS);
  const viewDdl = buildCompatibilityViewDdls(CONFIG).rag_turn_events;
  const reads = [
    null,
    expiringArchive,
    normalizedArchive,
    { type: "VIEW", view: { query: viewDdl, useLegacySql: false } },
  ];
  const ddls = [];

  reconcileCompatibilityView(CONFIG, "rag_turn_events", viewDdl, {
    read: () => reads.shift(),
    executeDdl: (ddl) => ddls.push(ddl),
  });

  assert.deepEqual(ddls, [
    `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.rag_turn_events_legacy\` SET OPTIONS(require_partition_filter = FALSE, partition_expiration_days = NULL)`,
    viewDdl,
  ]);
  assert.equal(reads.length, 0);
});

test("clears and revalidates archive partition expiration before replacing the canonical name", () => {
  const expiringArchive = legacyTable(HISTORICAL_RAG_FIELDS, {
    requirePartitionFilter: true,
    timePartitioning: {
      type: "DAY",
      field: "event_ts",
      expirationMs: "604800000",
    },
  });
  const reads = [null, expiringArchive, expiringArchive];
  const ddls = [];

  assert.equal(
    buildArchiveTableOptionsDdl(CONFIG, "rag_turn_events_legacy"),
    `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.rag_turn_events_legacy\` SET OPTIONS(require_partition_filter = FALSE, partition_expiration_days = NULL)`,
  );
  assert.match(
    validateArchiveTableOptions(expiringArchive).join("\n"),
    /require_partition_filter must be disabled[\s\S]*partition_expiration_days must be cleared/,
  );
  assert.deepEqual(
    validateArchiveTableOptions(
      legacyTable(HISTORICAL_RAG_FIELDS, {
        timePartitioning: {
          type: "DAY",
          field: "event_ts",
          expirationMs: null,
        },
      }),
    ),
    [],
  );
  assert.throws(
    () =>
      reconcileCompatibilityView(
        CONFIG,
        "rag_turn_events",
        buildCompatibilityViewDdls(CONFIG).rag_turn_events,
        {
          read: () => reads.shift(),
          executeDdl: (ddl) => ddls.push(ddl),
        },
      ),
    /archive options validation failed:[\s\S]*partition_expiration_days must be cleared/,
  );
  assert.deepEqual(ddls, [
    `ALTER TABLE \`project-1.${BIGQUERY_DATASET}.rag_turn_events_legacy\` SET OPTIONS(require_partition_filter = FALSE, partition_expiration_days = NULL)`,
  ]);
});

test("creates empty typed archives on fresh projects and rejects incompatible archives", () => {
  const ddl = buildEmptyLegacyTableDdl(CONFIG, "llm_score_events");
  assert.match(
    ddl,
    /CREATE TABLE IF NOT EXISTS `project-1\.icecore_llm_analytics\.llm_score_events_legacy`/,
  );
  assert.match(ddl, /event_id STRING NOT NULL/);
  assert.match(ddl, /numeric_value FLOAT64/);
  assert.match(ddl, /boolean_value BOOL/);
  assert.match(ddl, /PARTITION BY DATE\(event_ts\)/);

  assert.deepEqual(
    validateLegacyTableSchema("llm_score_events", {
      schema: {
        fields: [
          { name: "event_id", type: "STRING", mode: "REQUIRED" },
          { name: "event_kind", type: "STRING", mode: "REQUIRED" },
          { name: "event_ts", type: "TIMESTAMP", mode: "REQUIRED" },
          { name: "schema_version", type: "INTEGER", mode: "REQUIRED" },
          { name: "workspace_id", type: "STRING", mode: "REQUIRED" },
          { name: "conversation_id", type: "STRING" },
          { name: "message_id", type: "STRING" },
          { name: "trace_id", type: "STRING" },
          { name: "source_service", type: "STRING" },
          { name: "metadata", type: "JSON" },
          { name: "score_name", type: "STRING", mode: "REQUIRED" },
          { name: "score_source", type: "STRING", mode: "REQUIRED" },
          { name: "data_type", type: "STRING", mode: "REQUIRED" },
          { name: "numeric_value", type: "FLOAT" },
          { name: "boolean_value", type: "BOOLEAN" },
          { name: "string_value", type: "STRING" },
          { name: "comment", type: "STRING" },
          { name: "reasoning_excerpt", type: "STRING" },
        ],
      },
    }),
    [],
  );
  assert.match(
    validateLegacyTableSchema("llm_score_events", {
      schema: {
        fields: [
          { name: "event_id", type: "INTEGER" },
          { name: "event_kind", type: "STRING" },
        ],
      },
    }).join("\n"),
    /event_id type must be STRING[\s\S]*missing legacy column event_ts/,
  );
});

test("builds deduplicating compatibility views with deterministic RAG-derived scores", () => {
  const ddls = buildCompatibilityViewDdls(CONFIG);
  assert.deepEqual(Object.keys(ddls), COMPATIBILITY_VIEWS);

  for (const [name, ddl] of Object.entries(ddls)) {
    assert.ok(
      ddl.includes(
        `CREATE OR REPLACE VIEW \`project-1.${BIGQUERY_DATASET}.${name}\``,
      ),
    );
    assert.match(
      ddl,
      /ROW_NUMBER\(\) OVER \(PARTITION BY event_id ORDER BY source_priority ASC, event_ts DESC\)/,
    );
    assert.ok(
      ddl.includes(`FROM \`project-1.${BIGQUERY_DATASET}.${name}_legacy\``),
    );
    assert.match(ddl, /UNION ALL/);
    assert.match(ddl, /source_priority ASC/);
    assert.doesNotMatch(ddl, /WITH,/);
  }

  const scores = ddls.llm_score_events;
  assert.match(
    ddls.llm_trace_events,
    /SAFE_CAST\(latency_ms AS INT64\) AS latency_ms/,
  );
  assert.match(
    ddls.rag_turn_events,
    /SAFE_CAST\(duration_ms AS INT64\) AS duration_ms/,
  );
  assert.match(
    ddls.rag_turn_events,
    /SAFE_CAST\(generation_latency_ms AS INT64\) AS generation_latency_ms/,
  );
  assert.match(scores, /event_kind = 'llm_score'/);
  assert.match(scores, /score_source != 'system_eval'/);
  assert.match(scores, /event_kind = 'rag_turn'/);
  assert.match(
    scores,
    /rag_score_inputs\.\* EXCEPT\(score_name, score_source, data_type, numeric_value, boolean_value, string_value\)/,
  );
  assert.match(
    scores,
    /SAFE_DIVIDE\(asks_answered_count, asks_detected_count\)/,
  );
  assert.match(scores, /output_hash IS NOT NULL/);
  assert.doesNotMatch(
    scores,
    /input_excerpt|output_excerpt|JSON_VALUE\(metadata/,
  );
  for (const scoreName of [
    "rag_context_present",
    "rag_answer_without_context",
    "rag_fallback_without_context",
    "citation_coverage",
    "answer_completeness",
    "latency_within_target",
  ]) {
    assert.match(scores, new RegExp(`'${scoreName}'`));
  }
  assert.match(
    scores,
    /LOWER\(TO_HEX\(SHA256\(TO_JSON_STRING\(\['llm_score', event_id, score_name, data_type\]\)\)\)\)/,
  );
  assert.match(scores, /UNION ALL/);
});
