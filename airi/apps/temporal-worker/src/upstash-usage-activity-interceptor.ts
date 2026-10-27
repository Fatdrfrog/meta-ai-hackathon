import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY,
} from "@icecore/temporal";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { readSessionIdentity } from "./llm-observability-activity-interceptor.js";
import {
  createUpstashUsage,
  isUpstashUsageTrackingInstalled,
  runInUpstashUsageScope,
  upstashUsageLogFields,
} from "./upstash-usage.js";

/** Always logged, so an AI turn that made no Upstash calls is still visible. */
const TURN_ACTIVITY_TYPES = new Set<string>([
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY,
  AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY,
]);

function readMessageId(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    for (const value of [record.messageId, record.reservedMessageId]) {
      if (typeof value === "string" && value.trim() && value.length <= 512) {
        return value.trim();
      }
    }
  }
  return undefined;
}

/**
 * One `airi.worker.upstash_usage` line per activity that touched Upstash,
 * and always for the AI conversation turn activities.
 */
export function buildUpstashUsageActivityInterceptors(
  logger: Pick<typeof airiWorkerLogger, "info"> = airiWorkerLogger,
): ActivityInterceptorsFactory {
  return (context) => ({
    inbound: {
      async execute(input, next) {
        if (!isUpstashUsageTrackingInstalled()) return next(input);
        const { info } = context;
        const usage = createUpstashUsage();
        const startedAt = Date.now();
        try {
          return await runInUpstashUsageScope(usage, () => next(input));
        } finally {
          if (
            usage.requests > 0 ||
            TURN_ACTIVITY_TYPES.has(info.activityType)
          ) {
            const messageId = readMessageId(input.args);
            logger.info("airi.worker.upstash_usage", {
              activityType: info.activityType,
              workflowType: info.workflowType ?? null,
              attempt: info.attempt,
              ...readSessionIdentity(input.args),
              ...(messageId ? { messageId } : {}),
              durationMs: Date.now() - startedAt,
              ...upstashUsageLogFields(usage),
            });
          }
        }
      },
    },
  });
}

export const createUpstashUsageActivityInterceptors =
  buildUpstashUsageActivityInterceptors();
