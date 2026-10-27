import "server-only";

import {
  buildLlmTraceEvent,
  buildRagTurnEventFromWideEvent,
  type BuildLlmTraceEventParams,
  type BuildRagTurnEventParams,
  type LlmAnalyticsEvent,
} from "@icecore/airi-runtime/llm-analytics";
import {
  drainPendingAfterResponseWork,
  runAfterResponse,
} from "@/lib/after-response-work";
import { trackInAiriChatRunTaskScope } from "@/lib/airi-chats/after-response";
import { airiReplyLogger } from "@/lib/airi/reply/runtime/reply-logging";
import {
  buildReviewItemDraftsForRagTurn,
  persistReviewItemDrafts,
} from "@/lib/llm-analytics/review-items";

function isLlmAnalyticsEmitEnabled(): boolean {
  const raw = String(process.env.LLM_ANALYTICS_EVENTS_ENABLED || "").trim();
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  return true;
}

async function persistLlmAnalyticsEvents(
  events: LlmAnalyticsEvent[],
  context?: {
    workspaceId?: string | null;
    conversationId?: string | null;
    note?: string | null;
  }
): Promise<boolean> {
  try {
    const { persistLlmAnalyticsEventsWithOutbox } = await import(
      "@/lib/cross-store-outbox"
    );
    const result = await persistLlmAnalyticsEventsWithOutbox(events);
    if (result.applied || result.queuedToOutbox) {
      return true;
    }
    airiReplyLogger.warn("llm.analytics.ingest_failed", {
      workspaceId: context?.workspaceId || events[0]?.workspace_id || null,
      conversationId:
        context?.conversationId || events[0]?.conversation_id || null,
      note: context?.note || "publish_failed",
      eventCount: events.length,
      errorMessage: result.errorMessage || "analytics persistence failed",
    });
    return false;
  } catch (error) {
    airiReplyLogger.warn("llm.analytics.ingest_failed", {
      workspaceId: context?.workspaceId || events[0]?.workspace_id || null,
      conversationId:
        context?.conversationId || events[0]?.conversation_id || null,
      note: context?.note || "publish_failed",
      eventCount: events.length,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function emitLlmAnalyticsEvents(
  events: LlmAnalyticsEvent[],
  context?: {
    workspaceId?: string | null;
    conversationId?: string | null;
    note?: string | null;
  }
): Promise<boolean> {
  if (events.length === 0 || !isLlmAnalyticsEmitEnabled()) {
    return true;
  }

  // Never holds the AI call that produced the events; see runAfterResponse
  // for where the write runs in a durable run, a request or the worker.
  runAfterResponse("llm_analytics", () =>
    persistLlmAnalyticsEvents(events, context)
  );
  return true;
}

/**
 * Waits until the after-response work started outside a request (analytics
 * writes, AI spend settles) settles, or `timeoutMs` passes. Resolves true
 * when nothing is left pending. The Temporal worker calls this on shutdown.
 */
export function drainPendingLlmAnalyticsEvents(
  timeoutMs: number
): Promise<boolean> {
  return drainPendingAfterResponseWork(timeoutMs);
}

export async function recordLlmTraceAnalyticsEvent(
  params: BuildLlmTraceEventParams
): Promise<boolean> {
  try {
    const event = buildLlmTraceEvent(params);
    return await emitLlmAnalyticsEvents([event], {
      workspaceId: event.workspace_id,
      conversationId: event.conversation_id,
      note: "llm_trace",
    });
  } catch (error) {
    airiReplyLogger.warn("llm.analytics.build_failed", {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId || null,
      note: "llm_trace",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function recordRagTurnAnalyticsEvents(
  params: BuildRagTurnEventParams,
  options?: { persistReviewItems?: boolean }
): Promise<boolean> {
  try {
    const ragTurn = buildRagTurnEventFromWideEvent(params);
    const reviewDrafts = buildReviewItemDraftsForRagTurn(ragTurn);
    const persisted = await emitLlmAnalyticsEvents([ragTurn], {
      workspaceId: ragTurn.workspace_id,
      conversationId: ragTurn.conversation_id,
      note: "rag_turn",
    });

    if (options?.persistReviewItems !== false && reviewDrafts.length > 0) {
      const persistReviewItems = () =>
        persistReviewItemDrafts(reviewDrafts).catch(error => {
          airiReplyLogger.warn("llm.analytics.review_item_failed", {
            workspaceId: ragTurn.workspace_id,
            conversationId: ragTurn.conversation_id,
            traceId: ragTurn.trace_id || ragTurn.event_id,
            draftCount: reviewDrafts.length,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        });
      // Kept alive by a durable Airi chat run when there is one.
      if (!trackInAiriChatRunTaskScope(persistReviewItems)) {
        void persistReviewItems();
      }
    }
    return persisted;
  } catch (error) {
    const workspaceId =
      typeof params.wideEvent.workspaceId === "string"
        ? params.wideEvent.workspaceId
        : null;
    const conversationId =
      typeof params.wideEvent.conversationId === "string"
        ? params.wideEvent.conversationId
        : null;

    airiReplyLogger.warn("llm.analytics.build_failed", {
      workspaceId,
      conversationId,
      note: "rag_turn",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
