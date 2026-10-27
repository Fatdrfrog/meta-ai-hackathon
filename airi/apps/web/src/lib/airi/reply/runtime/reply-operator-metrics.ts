import { getPostHogClient } from "@/lib/posthog/server";
import type {
  ReplyFallbackAction,
  ReplyFallbackReason,
} from "@/lib/airi/reply/generation/reply-fallback-policy";
import type {
  TurnUnderstandingConfidence,
  TurnUnderstandingKind,
} from "@/lib/airi/reply/turn/understand-customer-turn";
import { airiReplyLogger } from "@/lib/airi/reply/runtime/reply-logging";

const LOG_EVERY_EVENTS = 25;
const LOG_FORCE_INTERVAL_MS = 5 * 60 * 1000;

export type ReplyOperatorCounterName =
  | "safe_conversational_replies"
  | "rag_turns"
  | "grounded_recovery_usage"
  | "generic_clarification_usage"
  | "low_confidence_understanding_results";

type WorkspaceReplyOperatorCounters = {
  safeConversationalReplies: number;
  ragTurns: number;
  groundedRecoveryUsage: number;
  genericClarificationUsage: number;
  lowConfidenceUnderstandingResults: number;
  totalEvents: number;
  lastLogAt: number;
};

type MetricProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

const replyOperatorCounters = new Map<string, WorkspaceReplyOperatorCounters>();

function createCounters(): WorkspaceReplyOperatorCounters {
  return {
    safeConversationalReplies: 0,
    ragTurns: 0,
    groundedRecoveryUsage: 0,
    genericClarificationUsage: 0,
    lowConfidenceUnderstandingResults: 0,
    totalEvents: 0,
    lastLogAt: 0,
  };
}

function getCounters(workspaceId: string): WorkspaceReplyOperatorCounters {
  const existing = replyOperatorCounters.get(workspaceId);
  if (existing) return existing;

  const created = createCounters();
  replyOperatorCounters.set(workspaceId, created);
  return created;
}

function incrementCounter(
  counters: WorkspaceReplyOperatorCounters,
  counterName: ReplyOperatorCounterName
): void {
  if (counterName === "safe_conversational_replies") {
    counters.safeConversationalReplies += 1;
  } else if (counterName === "rag_turns") {
    counters.ragTurns += 1;
  } else if (counterName === "grounded_recovery_usage") {
    counters.groundedRecoveryUsage += 1;
  } else if (counterName === "generic_clarification_usage") {
    counters.genericClarificationUsage += 1;
  } else if (counterName === "low_confidence_understanding_results") {
    counters.lowConfidenceUnderstandingResults += 1;
  }

  counters.totalEvents += 1;
}

function trackPostHogCounter(params: {
  workspaceId: string;
  conversationId: string;
  counterName: ReplyOperatorCounterName;
  properties?: MetricProperties;
}): void {
  try {
    const posthog = getPostHogClient();
    if (!posthog) return;

    posthog.capture({
      distinctId: `airi:workspace:${params.workspaceId}`,
      event: "airi_reply_operator_counter",
      properties: {
        // A workspace is not a person; keep it out of person profiles.
        $process_person_profile: false,
        workspace_id: params.workspaceId,
        conversation_id: params.conversationId,
        counter_name: params.counterName,
        ...params.properties,
      },
    });
  } catch (error) {
    airiReplyLogger.warn("airi.reply.metrics", {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      counterName: params.counterName,
      note: "posthog_capture_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function maybeLog(
  workspaceId: string,
  counters: WorkspaceReplyOperatorCounters
): void {
  const now = Date.now();
  const shouldLogByCount =
    counters.totalEvents > 0 && counters.totalEvents % LOG_EVERY_EVENTS === 0;
  const shouldLogByTime = now - counters.lastLogAt > LOG_FORCE_INTERVAL_MS;

  if (!shouldLogByCount && !shouldLogByTime) return;

  counters.lastLogAt = now;
  airiReplyLogger.info("airi.reply.metrics", {
    workspaceId,
    note: "operator_confidence_counters",
    totalEvents: counters.totalEvents,
    safeConversationalReplies: counters.safeConversationalReplies,
    ragTurns: counters.ragTurns,
    groundedRecoveryUsage: counters.groundedRecoveryUsage,
    genericClarificationUsage: counters.genericClarificationUsage,
    lowConfidenceUnderstandingResults:
      counters.lowConfidenceUnderstandingResults,
  });
}

function recordCounter(params: {
  workspaceId: string;
  conversationId: string;
  counterName: ReplyOperatorCounterName;
  properties?: MetricProperties;
}): void {
  const counters = getCounters(params.workspaceId);
  incrementCounter(counters, params.counterName);
  trackPostHogCounter(params);
  maybeLog(params.workspaceId, counters);
}

export function trackTurnUnderstandingMetrics(params: {
  workspaceId: string;
  conversationId: string;
  channel?: string | null;
  turnKind: TurnUnderstandingKind;
  confidence: TurnUnderstandingConfidence;
  proceedWithRag: boolean;
  hasConversationWindow: boolean;
  safeReplySent: boolean;
}): void {
  const sharedProperties = {
    channel: params.channel || null,
    turn_kind: params.turnKind,
    confidence: params.confidence,
    proceed_with_rag: params.proceedWithRag,
    has_conversation_window: params.hasConversationWindow,
  };

  if (params.safeReplySent) {
    recordCounter({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      counterName: "safe_conversational_replies",
      properties: sharedProperties,
    });
  }

  if (params.confidence === "low") {
    recordCounter({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      counterName: "low_confidence_understanding_results",
      properties: sharedProperties,
    });
  }
}

export function trackRagOutcomeMetrics(params: {
  workspaceId: string;
  conversationId: string;
  channel?: string | null;
  resultType: string;
  fallbackAction?: ReplyFallbackAction;
  fallbackReason?: ReplyFallbackReason;
}): void {
  const sharedProperties = {
    channel: params.channel || null,
    result_type: params.resultType,
    fallback_action: params.fallbackAction || null,
    fallback_reason: params.fallbackReason || null,
  };

  recordCounter({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    counterName: "rag_turns",
    properties: sharedProperties,
  });

  if (params.fallbackAction === "grounded_recovery") {
    recordCounter({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      counterName: "grounded_recovery_usage",
      properties: sharedProperties,
    });
  }

  if (params.fallbackAction === "generic_clarification") {
    recordCounter({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      counterName: "generic_clarification_usage",
      properties: sharedProperties,
    });
  }
}

export function getReplyOperatorMetricsSnapshotForTest(workspaceId: string): {
  safeConversationalReplies: number;
  ragTurns: number;
  groundedRecoveryUsage: number;
  genericClarificationUsage: number;
  lowConfidenceUnderstandingResults: number;
  totalEvents: number;
} {
  const counters = replyOperatorCounters.get(workspaceId) || createCounters();
  return {
    safeConversationalReplies: counters.safeConversationalReplies,
    ragTurns: counters.ragTurns,
    groundedRecoveryUsage: counters.groundedRecoveryUsage,
    genericClarificationUsage: counters.genericClarificationUsage,
    lowConfidenceUnderstandingResults:
      counters.lowConfidenceUnderstandingResults,
    totalEvents: counters.totalEvents,
  };
}

export function resetReplyOperatorMetricsForTest(): void {
  replyOperatorCounters.clear();
}
