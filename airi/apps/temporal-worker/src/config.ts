import { randomUUID } from "node:crypto";

import {
  AIRI_CONVERSATION_TASK_QUEUE,
  CREATIVE_ASSET_EDIT_TASK_QUEUE,
  buildAiriConversationTaskQueue,
  resolveAiriConversationRouting,
  type AiriConversationQueueClass,
} from "@icecore/temporal";
import { readEnvFlag as parseBooleanEnv } from "@icecore/shared/lib/env";
import {
  assertTemporalTlsApiKey,
  resolveTemporalConnectionEnv,
} from "@icecore/shared/lib/temporal-connection-env";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

const TEMPORAL_WORKER_PROCESS_INSTANCE_ID = randomUUID();

export type TemporalWorkerConfig = {
  address: string;
  namespace: string;
  apiKey: string | null;
  taskQueue: string;
  activityQueueClass: AiriConversationQueueClass;
  tls: boolean;
  target: "local" | "cloud";
  deploymentName: string;
  buildId: string;
  versioningBehavior: "PINNED" | "AUTO_UPGRADE";
  identity: string;
  workflowBundlePath: string | null;
  reuseV8Context: boolean;
  maxConcurrentWorkflowTaskExecutions: number;
  maxConcurrentWorkflowTaskPolls: number;
  maxConcurrentActivityTaskExecutions: number;
  maxConcurrentActivityTaskPolls: number;
  maxCachedWorkflows: number;
  shutdownGraceTime: string;
  shutdownForceTime: string;
  requestsProjectionWriterEnabled: boolean;
  requestsProjectionRealtimeEnabled: boolean;
};

export function resolveTemporalMediaTaskQueue(): string {
  return (
    normalizeOptionalString(process.env.AIRI_MEDIA_TASK_QUEUE) ||
    normalizeOptionalString(process.env.TEMPORAL_MEDIA_TASK_QUEUE) ||
    CREATIVE_ASSET_EDIT_TASK_QUEUE
  );
}

function parseIntegerEnv(
  key: string,
  fallback: number,
  limits?: { min?: number; max?: number },
): number {
  const rawValue = normalizeOptionalString(process.env[key]);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (limits?.min !== undefined && parsed < limits.min) {
    return limits.min;
  }

  if (limits?.max !== undefined && parsed > limits.max) {
    return limits.max;
  }

  return parsed;
}

function durationEnvOrDefault(key: string, fallback: string): string {
  return normalizeOptionalString(process.env[key]) || fallback;
}

function resolveWorkerBuildId(): string {
  return (
    normalizeOptionalString(process.env.TEMPORAL_WORKER_BUILD_ID) ||
    normalizeOptionalString(process.env.K_REVISION) ||
    normalizeOptionalString(process.env.IMAGE_DIGEST) ||
    normalizeOptionalString(process.env.GIT_SHA) ||
    "dev-build"
  );
}

function resolveWorkerIdentity(params: {
  deploymentName: string;
  buildId: string;
}): string {
  const explicit = normalizeOptionalString(
    process.env.TEMPORAL_WORKER_IDENTITY,
  );
  if (explicit) {
    return explicit;
  }

  const revision =
    normalizeOptionalString(process.env.K_REVISION) || params.buildId;

  return `${params.deploymentName}:${revision}:${TEMPORAL_WORKER_PROCESS_INSTANCE_ID}`;
}

function parseStrictInfrastructureBoolean(key: string): boolean {
  const rawValue = process.env[key];
  if (rawValue === undefined) return false;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${key} must be exactly true or false`);
}

function resolveRequestsProjectionInfrastructure() {
  const writerEnabled = parseStrictInfrastructureBoolean(
    "REQUESTS_PROJECTION_WRITER_ENABLED",
  );
  const realtimeEnabled = parseStrictInfrastructureBoolean(
    "REQUESTS_PROJECTION_REALTIME_ENABLED",
  );
  if (realtimeEnabled && !writerEnabled) {
    throw new Error(
      "REQUESTS_PROJECTION_REALTIME_ENABLED requires REQUESTS_PROJECTION_WRITER_ENABLED=true",
    );
  }
  if (!writerEnabled) {
    return { writerEnabled, realtimeEnabled };
  }

  const rawPoolSize = process.env.MONGODB_MAX_POOL_SIZE;
  if (!rawPoolSize || !/^\d+$/.test(rawPoolSize)) {
    throw new Error(
      "MONGODB_MAX_POOL_SIZE must be an explicit integer of at least 12 for the requests projection writer",
    );
  }
  const mongoMaxPoolSize = Number(rawPoolSize);
  if (!Number.isSafeInteger(mongoMaxPoolSize) || mongoMaxPoolSize < 12) {
    throw new Error(
      "MONGODB_MAX_POOL_SIZE must be an explicit integer of at least 12 for the requests projection writer",
    );
  }
  const mongoAppName = normalizeOptionalString(process.env.MONGODB_APP_NAME);
  if (
    !mongoAppName ||
    mongoAppName === "icecore-web" ||
    !mongoAppName.toLowerCase().includes("worker")
  ) {
    throw new Error(
      "MONGODB_APP_NAME must be an explicit worker-specific non-default name for the requests projection writer",
    );
  }
  return { writerEnabled, realtimeEnabled };
}

export function getTemporalWorkerConfig(): TemporalWorkerConfig {
  const connection = resolveTemporalConnectionEnv();
  const routing = resolveAiriConversationRouting();
  const taskQueue =
    normalizeOptionalString(process.env.TEMPORAL_TASK_QUEUE) ||
    buildAiriConversationTaskQueue() ||
    routing.taskQueue ||
    AIRI_CONVERSATION_TASK_QUEUE;
  const deploymentName =
    normalizeOptionalString(process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME) ||
    "airi-temporal-worker";
  const buildId = resolveWorkerBuildId();
  const rawVersioningBehavior =
    normalizeOptionalString(process.env.TEMPORAL_WORKER_VERSIONING_BEHAVIOR) ||
    "AUTO_UPGRADE";
  const versioningBehavior =
    rawVersioningBehavior === "PINNED" ? "PINNED" : "AUTO_UPGRADE";
  const requestsProjection = resolveRequestsProjectionInfrastructure();

  assertTemporalTlsApiKey(
    connection,
    "TEMPORAL_API_KEY or TEMPORAL_CLOUD_API_KEY is required when using Temporal Cloud or any TLS Temporal endpoint",
  );

  return {
    address: connection.address,
    namespace: connection.namespace,
    apiKey: connection.apiKey,
    taskQueue,
    activityQueueClass: routing.activityQueueClass,
    tls: connection.tls,
    target: connection.tls ? "cloud" : "local",
    deploymentName,
    buildId,
    versioningBehavior,
    identity: resolveWorkerIdentity({ deploymentName, buildId }),
    workflowBundlePath: normalizeOptionalString(
      process.env.TEMPORAL_WORKER_WORKFLOW_BUNDLE_PATH,
    ),
    reuseV8Context: parseBooleanEnv("TEMPORAL_WORKER_REUSE_V8_CONTEXT", true),
    maxConcurrentWorkflowTaskExecutions: parseIntegerEnv(
      "TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS",
      32,
      { min: 2, max: 512 },
    ),
    maxConcurrentWorkflowTaskPolls: parseIntegerEnv(
      "TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_POLLS",
      8,
      { min: 1, max: 128 },
    ),
    maxConcurrentActivityTaskExecutions: parseIntegerEnv(
      "TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS",
      8,
      { min: 1, max: 256 },
    ),
    maxConcurrentActivityTaskPolls: parseIntegerEnv(
      "TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_POLLS",
      4,
      { min: 1, max: 128 },
    ),
    maxCachedWorkflows: parseIntegerEnv(
      "TEMPORAL_WORKER_MAX_CACHED_WORKFLOWS",
      128,
      { min: 0, max: 10000 },
    ),
    shutdownGraceTime: durationEnvOrDefault(
      "TEMPORAL_WORKER_SHUTDOWN_GRACE_TIME",
      "30s",
    ),
    shutdownForceTime: durationEnvOrDefault(
      "TEMPORAL_WORKER_SHUTDOWN_FORCE_TIME",
      "120s",
    ),
    requestsProjectionWriterEnabled: requestsProjection.writerEnabled,
    requestsProjectionRealtimeEnabled: requestsProjection.realtimeEnabled,
  };
}
