import { buildAiriCoachWorkflowId } from "@icecore/temporal";

import {
  isTemporalConfigured,
  startAiriCoachWorkflow,
} from "@/lib/temporal/background-jobs";

export type AiriCoachJobPayload = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  agentId?: string;
};

export function buildAiriCoachDedupeKey(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}): string {
  return buildAiriCoachWorkflowId(params);
}

export type EnqueueAiriCoachJobResult = {
  queued: boolean;
  reason: "queued" | "not_configured" | "publish_failed";
  dedupeKey: string;
  workflowId?: string;
  duplicate?: boolean;
  errorMessage?: string;
};

export async function enqueueAiriCoachJob(
  payload: AiriCoachJobPayload
): Promise<EnqueueAiriCoachJobResult> {
  const dedupeKey = buildAiriCoachDedupeKey(payload);
  if (!isTemporalConfigured()) {
    return {
      queued: false,
      reason: "not_configured",
      dedupeKey,
      workflowId: dedupeKey,
    };
  }

  try {
    const start = await startAiriCoachWorkflow(payload);
    return {
      queued: true,
      reason: "queued",
      dedupeKey,
      workflowId: start.workflowId,
      duplicate: start.duplicate,
    };
  } catch (error) {
    return {
      queued: false,
      reason: "publish_failed",
      dedupeKey,
      workflowId: dedupeKey,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fire-and-forget coach enqueue for manager sends. enqueueAiriCoachJob
 * never throws, so only a result that was not queued is logged.
 */
export function enqueueAiriCoachJobBestEffort(
  payload: AiriCoachJobPayload,
  logTag: string
): void {
  void enqueueAiriCoachJob(payload).then(result => {
    if (result.queued) return;
    console.warn(`[${logTag}] Failed to enqueue Airi coach job`, {
      reason: result.reason,
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
    });
  });
}
