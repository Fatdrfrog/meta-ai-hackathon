import { traceableChain } from "@icecore/airi-runtime/tracing";
import {
  AIRI_COACH_ACTIVITY,
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY,
  KNOWLEDGE_CANONICAL_SYNC_ACTIVITY,
} from "@icecore/temporal";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

const OBSERVED_ACTIVITY_TYPES = new Set([
  AIRI_COACH_ACTIVITY,
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY,
  KNOWLEDGE_CANONICAL_SYNC_ACTIVITY,
]);

const CORRELATION_CONTAINERS = [
  "input",
  "params",
  "payload",
  "request",
  "turn",
] as const;

type UnknownRecord = Record<string, unknown>;

function findStringField(
  values: readonly unknown[],
  candidateKeys: readonly string[],
  depth = 0,
): string | undefined {
  for (const value of values) {
    const record = asNullableRecord(value);
    if (!record) continue;
    for (const key of candidateKeys) {
      const candidate = record[key];
      if (
        typeof candidate === "string" &&
        candidate.length <= 512 &&
        candidate.trim()
      ) {
        return candidate.trim();
      }
    }
    if (depth >= 1) continue;
    const nested = CORRELATION_CONTAINERS.map((key) => record[key]).filter(
      (value) => value !== undefined,
    );
    const candidate = findStringField(nested, candidateKeys, depth + 1);
    if (candidate) return candidate;
  }
  return undefined;
}

export function readSessionIdentity(args: readonly unknown[]) {
  const workspaceId = findStringField(args, ["workspaceId", "workspace_id"]);
  const conversationId = findStringField(args, [
    "conversationId",
    "conversation_id",
  ]);

  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

export function shouldTraceLlmActivity(activityType: string): boolean {
  return OBSERVED_ACTIVITY_TYPES.has(activityType);
}

export const createLlmObservabilityActivityInterceptors: ActivityInterceptorsFactory =
  (context) => ({
    inbound: {
      execute(input, next) {
        const { info } = context;
        if (!shouldTraceLlmActivity(info.activityType)) {
          return next(input);
        }

        const executeActivity = traceableChain(() => next(input), {
          name: `airi.temporal.activity.${info.activityType}`,
          tags: ["airi", "temporal", "activity"],
          getMetadata: () => ({
            activity_type: info.activityType,
            attempt: info.attempt,
            is_local: info.isLocal,
            operation: info.activityType,
            source_service: "temporal-worker",
            task_queue: info.taskQueue,
            workflow_type: info.workflowType,
          }),
          getSessionIdentity: () => readSessionIdentity(input.args),
        });

        return executeActivity();
      },
    },
  });
