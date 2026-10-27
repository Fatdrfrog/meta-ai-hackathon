import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AIRI_CONVERSATION_WORKFLOW,
  AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW,
  BULK_CAMPAIGN_DISPATCH_WORKFLOW,
  CAMPAIGN_EXECUTION_WORKFLOW,
  CAMPAIGN_NODE_RUN_WORKFLOW,
  CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW,
  HAPPYHORSE_VIDEO_WORKFLOW,
  HIGGSFIELD_ASSET_GENERATION_WORKFLOW,
  VIDEO_GENERATION_WORKFLOW,
  VIDEO_GENERATION_RECONCILE_WORKFLOW,
} from "@icecore/temporal";
import {
  Client,
  Connection,
  type WorkflowExecutionInfo,
} from "@temporalio/client";

import { getTemporalWorkerConfig } from "./config.js";
import { loadTemporalWorkerEnv } from "./load-env.js";

type ExecutionSelector = {
  runId?: string;
  workflowId: string;
};

type ExportArgs = {
  dryRun: boolean;
  failureExportLimit: number;
  failureScanLimit: number;
  fromGcloud: boolean;
  gcloudProject?: string;
  gcloudRegion: string;
  includeWorkflowTaskFailures: boolean;
  limit: number;
  outDir: string;
  pageSize: number;
  queries: string[];
  workerPool: string;
  workflowTypes: string[];
  executions: ExecutionSelector[];
};

type ExportTarget = {
  historyLength?: number;
  query?: string;
  runId?: string;
  status?: string;
  workflowId: string;
  workflowType?: string;
};

const DEFAULT_WORKFLOW_TYPES = [
  AIRI_CONVERSATION_WORKFLOW,
  AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW,
  BULK_CAMPAIGN_DISPATCH_WORKFLOW,
  CAMPAIGN_NODE_RUN_WORKFLOW,
  CAMPAIGN_EXECUTION_WORKFLOW,
  CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW,
  VIDEO_GENERATION_WORKFLOW,
  VIDEO_GENERATION_RECONCILE_WORKFLOW,
  HAPPYHORSE_VIDEO_WORKFLOW,
  HIGGSFIELD_ASSET_GENERATION_WORKFLOW,
];

const TEMPORAL_CLOUD_RUN_ENV_NAMES = new Set([
  "TEMPORAL_ADDRESS",
  "TEMPORAL_CLOUD_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_CLOUD_NAMESPACE",
  "TEMPORAL_TASK_QUEUE",
  "TEMPORAL_API_KEY",
  "TEMPORAL_CLOUD_API_KEY",
]);

const TEMPORAL_SECRET_ENV_NAMES = new Set([
  "TEMPORAL_API_KEY",
  "TEMPORAL_CLOUD_API_KEY",
]);

function defaultOutDir(): string {
  return fileURLToPath(
    new URL("../replay-histories/exported", import.meta.url),
  );
}

function printUsage(): void {
  console.log(`Export Temporal workflow histories for replay.

Usage:
  pnpm --filter @icecore/temporal-worker export:replay-histories -- [options]

Options:
  --from-gcloud                  Read Temporal connection settings from the Cloud Run worker pool.
  --gcloud-project <project>     GCP project for --from-gcloud. Defaults to env or gcloud config.
  --gcloud-region <region>       Cloud Run region. Default: europe-west1.
  --worker-pool <name>           Cloud Run worker pool. Default: airi-temporal-worker-prod.
  --out <dir>                    Output directory. Default: apps/temporal-worker/replay-histories/exported.
  --workflow-type <name>         Workflow type to export. Repeatable.
  --query <visibility-query>     Temporal visibility query to export. Repeatable.
  --execution <workflowId[,runId]> Export one execution exactly. Repeatable.
  --limit <n>                    Max histories per query. Default: 5.
  --page-size <n>                Temporal visibility page size. Default: min(limit, 100).
  --include-workflow-task-failures Export live Airi histories whose latest workflow task is failed.
  --failure-scan-limit <n>       Max Airi executions to scan for latest workflow task failures. Default: 100.
  --failure-export-limit <n>     Max failed workflow task histories to add. Default: 10.
  --dry-run                      List matching histories without writing files.
`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNext(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function addCsvValues(target: string[], rawValue: string): void {
  for (const value of rawValue.split(",")) {
    const normalized = value.trim();
    if (normalized) target.push(normalized);
  }
}

function parseExecutionSelector(rawValue: string): ExecutionSelector {
  const commaIndex = rawValue.indexOf(",");
  if (commaIndex === -1) {
    return { workflowId: rawValue.trim() };
  }

  const workflowId = rawValue.slice(0, commaIndex).trim();
  const runId = rawValue.slice(commaIndex + 1).trim();
  if (!workflowId) {
    throw new Error(`Invalid --execution value: ${rawValue}`);
  }

  return {
    workflowId,
    runId: runId || undefined,
  };
}

function parseArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = {
    dryRun: false,
    executions: [],
    failureExportLimit: parsePositiveInt(
      process.env.TEMPORAL_REPLAY_FAILURE_EXPORT_LIMIT,
      10,
    ),
    failureScanLimit: parsePositiveInt(
      process.env.TEMPORAL_REPLAY_FAILURE_SCAN_LIMIT,
      100,
    ),
    fromGcloud: false,
    gcloudRegion: process.env.GCP_REGION || "europe-west1",
    includeWorkflowTaskFailures: false,
    limit: parsePositiveInt(process.env.TEMPORAL_REPLAY_EXPORT_LIMIT, 5),
    outDir: process.env.TEMPORAL_REPLAY_EXPORT_DIR || defaultOutDir(),
    pageSize: 0,
    queries: [],
    workerPool: process.env.GCP_WORKER_POOL_NAME || "airi-temporal-worker-prod",
    workflowTypes: [],
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--include-workflow-task-failures") {
      args.includeWorkflowTaskFailures = true;
      continue;
    }

    if (arg === "--from-gcloud") {
      args.fromGcloud = true;
      continue;
    }

    if (arg === "--gcloud-project") {
      args.gcloudProject = readNext(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--gcloud-region") {
      args.gcloudRegion = readNext(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--worker-pool") {
      args.workerPool = readNext(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--out") {
      args.outDir = path.resolve(process.cwd(), readNext(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--workflow-type") {
      addCsvValues(args.workflowTypes, readNext(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--query") {
      args.queries.push(readNext(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--execution") {
      args.executions.push(parseExecutionSelector(readNext(argv, index, arg)));
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      args.limit = parsePositiveInt(readNext(argv, index, arg), args.limit);
      index += 1;
      continue;
    }

    if (arg === "--page-size") {
      args.pageSize = parsePositiveInt(
        readNext(argv, index, arg),
        args.pageSize,
      );
      index += 1;
      continue;
    }

    if (arg === "--failure-scan-limit") {
      args.failureScanLimit = parsePositiveInt(
        readNext(argv, index, arg),
        args.failureScanLimit,
      );
      index += 1;
      continue;
    }

    if (arg === "--failure-export-limit") {
      args.failureExportLimit = parsePositiveInt(
        readNext(argv, index, arg),
        args.failureExportLimit,
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown export argument: ${arg}`);
  }

  args.outDir = path.resolve(process.cwd(), args.outDir);
  args.pageSize = args.pageSize || Math.min(args.limit, 100);

  return args;
}

function quoteWindowsCommandArg(value: string): string {
  if (/^[a-z0-9_./:=@+-]+$/i.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function runGcloud(args: string[], input?: string): string {
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec || "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            ["gcloud", ...args].map(quoteWindowsCommandArg).join(" "),
          ],
          {
            encoding: "utf8",
            input,
          },
        )
      : spawnSync("gcloud", args, {
          encoding: "utf8",
          input,
        });

  if (result.status !== 0) {
    if (result.error) {
      throw result.error;
    }

    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      `gcloud ${args.join(" ")} failed` +
        (stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""),
    );
  }

  return result.stdout.trim();
}

function resolveGcloudProject(explicitProject?: string): string {
  const project =
    explicitProject ||
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    runGcloud(["config", "get-value", "project", "--quiet"]);

  if (!project) {
    throw new Error(
      "Unable to resolve GCP project. Pass --gcloud-project or set GCP_PROJECT_ID.",
    );
  }

  return project;
}

function readWorkerPoolEnvEntries(params: {
  project: string;
  region: string;
  workerPool: string;
}): Array<{
  name?: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { key?: string; name?: string } };
}> {
  const rawJson = runGcloud([
    "beta",
    "run",
    "worker-pools",
    "describe",
    params.workerPool,
    `--project=${params.project}`,
    `--region=${params.region}`,
    "--format=json",
  ]);
  const parsed = JSON.parse(rawJson) as {
    spec?: {
      template?: {
        spec?: {
          containers?: Array<{
            env?: Array<{
              name?: string;
              value?: string;
              valueFrom?: { secretKeyRef?: { key?: string; name?: string } };
            }>;
          }>;
        };
      };
    };
  };

  const containers = parsed.spec?.template?.spec?.containers || [];
  return containers.flatMap((container) => container.env || []);
}

function accessSecretVersion(params: {
  project: string;
  secret: string;
  version: string;
}): string {
  return runGcloud([
    "secrets",
    "versions",
    "access",
    params.version,
    `--secret=${params.secret}`,
    `--project=${params.project}`,
  ]);
}

function loadTemporalEnvFromGcloud(args: ExportArgs): void {
  const project = resolveGcloudProject(args.gcloudProject);
  const envEntries = readWorkerPoolEnvEntries({
    project,
    region: args.gcloudRegion,
    workerPool: args.workerPool,
  });

  let loaded = 0;
  for (const entry of envEntries) {
    if (!entry.name || !TEMPORAL_CLOUD_RUN_ENV_NAMES.has(entry.name)) {
      continue;
    }

    if (entry.value !== undefined) {
      process.env[entry.name] = entry.value;
      loaded += 1;
      continue;
    }

    const secretRef = entry.valueFrom?.secretKeyRef;
    if (secretRef?.name && TEMPORAL_SECRET_ENV_NAMES.has(entry.name)) {
      process.env[entry.name] = accessSecretVersion({
        project,
        secret: secretRef.name,
        version: secretRef.key || "latest",
      });
      loaded += 1;
    }
  }

  console.log(
    `Loaded ${loaded} Temporal setting(s) from Cloud Run worker pool ` +
      `${args.workerPool} in ${project}/${args.gcloudRegion}.`,
  );
}

function escapeVisibilityValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildQueries(args: ExportArgs): string[] {
  if (args.queries.length > 0) {
    return args.queries;
  }

  if (args.workflowTypes.length === 0 && args.executions.length > 0) {
    return [];
  }

  const workflowTypes =
    args.workflowTypes.length > 0 ? args.workflowTypes : DEFAULT_WORKFLOW_TYPES;

  return workflowTypes.map(
    (workflowType) => `WorkflowType="${escapeVisibilityValue(workflowType)}"`,
  );
}

function normalizeBytesForJson(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString("base64");
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeBytesForJson(item));
  }

  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (nestedValue !== undefined) {
        normalized[key] = normalizeBytesForJson(nestedValue);
      }
    }
    return normalized;
  }

  return value;
}

function safeFilePart(value: string): string {
  const normalized = value
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length <= 80) {
    return normalized || "unknown";
  }

  const digest = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `${normalized.slice(0, 70)}-${digest}`;
}

function targetKey(target: ExportTarget): string {
  return `${target.workflowId}\u0000${target.runId || ""}`;
}

function historyEvents(history: unknown): Array<Record<string, unknown>> {
  const events = (history as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(events)) {
    return [];
  }

  return events.filter(
    (event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object",
  );
}

function eventTypeName(event: Record<string, unknown>): string {
  return String(event.eventType || "").toLowerCase();
}

function hasEventAttributes(
  event: Record<string, unknown>,
  key: string,
): boolean {
  return Boolean(event[key] && typeof event[key] === "object");
}

function hasLatestWorkflowTaskFailure(history: unknown): boolean {
  let latestWorkflowTaskFailed = false;

  for (const event of historyEvents(history)) {
    const type = eventTypeName(event);
    if (
      hasEventAttributes(event, "workflowTaskFailedEventAttributes") ||
      type.includes("workflow_task_failed")
    ) {
      latestWorkflowTaskFailed = true;
      continue;
    }

    if (
      hasEventAttributes(event, "workflowTaskCompletedEventAttributes") ||
      hasEventAttributes(event, "workflowExecutionCompletedEventAttributes") ||
      hasEventAttributes(event, "workflowExecutionFailedEventAttributes") ||
      hasEventAttributes(event, "workflowExecutionTimedOutEventAttributes") ||
      hasEventAttributes(
        event,
        "workflowExecutionContinuedAsNewEventAttributes",
      ) ||
      hasEventAttributes(event, "workflowExecutionCanceledEventAttributes") ||
      hasEventAttributes(event, "workflowExecutionTerminatedEventAttributes") ||
      type.includes("workflow_task_completed") ||
      type.includes("workflow_execution_completed") ||
      type.includes("workflow_execution_failed") ||
      type.includes("workflow_execution_timed_out") ||
      type.includes("workflow_execution_continued_as_new") ||
      type.includes("workflow_execution_canceled") ||
      type.includes("workflow_execution_terminated")
    ) {
      latestWorkflowTaskFailed = false;
    }
  }

  return latestWorkflowTaskFailed;
}

function toTarget(info: WorkflowExecutionInfo, query?: string): ExportTarget {
  return {
    historyLength: info.historyLength,
    query,
    runId: info.runId,
    status: info.status.name,
    workflowId: info.workflowId,
    workflowType: info.type,
  };
}

async function describeExecution(
  client: Client,
  execution: ExecutionSelector,
): Promise<ExportTarget> {
  const handle = client.workflow.getHandle(
    execution.workflowId,
    execution.runId,
  );
  const description = await handle.describe();

  return {
    historyLength: description.historyLength,
    runId: description.runId || execution.runId,
    status: description.status.name,
    workflowId: description.workflowId || execution.workflowId,
    workflowType: description.type,
  };
}

async function collectTargets(
  client: Client,
  args: ExportArgs,
): Promise<ExportTarget[]> {
  const targets: ExportTarget[] = [];
  const seen = new Set<string>();

  for (const execution of args.executions) {
    const target = await describeExecution(client, execution);
    const key = targetKey(target);
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  }

  for (const query of buildQueries(args)) {
    let matched = 0;
    for await (const info of client.workflow.list({
      pageSize: args.pageSize,
      query,
    })) {
      const target = toTarget(info, query);
      const key = targetKey(target);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }

      matched += 1;
      if (matched >= args.limit) {
        break;
      }
    }
  }

  return targets;
}

async function appendWorkflowTaskFailureTargets(params: {
  args: ExportArgs;
  client: Client;
  targets: ExportTarget[];
}): Promise<void> {
  if (!params.args.includeWorkflowTaskFailures) {
    return;
  }

  const seen = new Set(params.targets.map(targetKey));
  const query = `WorkflowType="${escapeVisibilityValue(
    AIRI_CONVERSATION_WORKFLOW,
  )}"`;
  let scanned = 0;
  let appended = 0;

  for await (const info of params.client.workflow.list({
    pageSize: Math.min(params.args.failureScanLimit, 100),
    query,
  })) {
    if (scanned >= params.args.failureScanLimit) {
      break;
    }
    scanned += 1;

    const target = toTarget(info, "workflow_task_failure_scan");
    const key = targetKey(target);
    if (seen.has(key)) {
      continue;
    }

    const handle = params.client.workflow.getHandle(
      target.workflowId,
      target.runId,
    );
    const history = await handle.fetchHistory();
    if (!hasLatestWorkflowTaskFailure(history)) {
      continue;
    }

    seen.add(key);
    params.targets.push(target);
    appended += 1;

    if (appended >= params.args.failureExportLimit) {
      break;
    }
  }

  console.log(
    `Scanned ${scanned} Airi conversation workflow(s) for latest workflow task failures; added ${appended}.`,
  );
}

async function writeFixture(params: {
  address: string;
  history: unknown;
  namespace: string;
  outDir: string;
  target: ExportTarget;
}): Promise<string> {
  await mkdir(params.outDir, { recursive: true });

  const workflowType = params.target.workflowType || "workflow";
  const runId = params.target.runId || "latest";
  const fileName = [
    safeFilePart(workflowType),
    safeFilePart(params.target.workflowId),
    safeFilePart(runId),
  ].join("__");
  const filePath = path.join(params.outDir, `${fileName}.json`);
  const payload = {
    exportedAt: new Date().toISOString(),
    history: normalizeBytesForJson(params.history),
    historyLength: params.target.historyLength,
    runId: params.target.runId,
    source: {
      address: params.address,
      namespace: params.namespace,
      query: params.target.query,
    },
    status: params.target.status,
    workflowId: params.target.workflowId,
    workflowType: params.target.workflowType,
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  loadTemporalWorkerEnv();

  if (args.fromGcloud) {
    loadTemporalEnvFromGcloud(args);
  }

  const config = getTemporalWorkerConfig();
  const connection = await Connection.connect({
    address: config.address,
    apiKey: config.apiKey || undefined,
    tls: config.tls ? {} : null,
  });

  try {
    const client = new Client({
      connection,
      namespace: config.namespace,
    });
    const targets = await collectTargets(client, args);
    await appendWorkflowTaskFailureTargets({ args, client, targets });

    if (targets.length === 0) {
      console.log("No workflow histories matched the export criteria.");
      return;
    }

    for (const target of targets) {
      const label = `${target.workflowType || "workflow"} ${target.workflowId}${
        target.runId ? `/${target.runId}` : ""
      }`;

      if (args.dryRun) {
        console.log(
          `MATCH ${label} status=${target.status || "unknown"} historyLength=${
            target.historyLength ?? "unknown"
          }`,
        );
        continue;
      }

      const handle = client.workflow.getHandle(target.workflowId, target.runId);
      const history = await handle.fetchHistory();
      const filePath = await writeFixture({
        address: config.address,
        history,
        namespace: config.namespace,
        outDir: args.outDir,
        target,
      });
      console.log(`WROTE ${path.relative(process.cwd(), filePath)} (${label})`);
    }
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error("Replay history export failed.");
  console.error(error);
  process.exit(1);
});
