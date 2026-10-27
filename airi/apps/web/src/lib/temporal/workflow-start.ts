import "server-only";

import { isWorkflowAlreadyStartedError } from "@icecore/shared/lib/temporal-errors";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

// Kept out of ./client so tests that jest.mock("./client") with a factory
// still mock the client these helpers use.
import { getTemporalClient, isTemporalConfigured } from "./client";
import type { TemporalWorkflowHandle } from "./sdk-types";

export type WorkflowStartResult = {
  workflowId: string;
  taskQueue: string;
  handle: TemporalWorkflowHandle;
  duplicate: boolean;
};

/** Throws `message` (the feature's exact text) when Temporal is not configured. */
export function requireTemporalConfigured(message: string): void {
  if (!isTemporalConfigured()) {
    throw new Error(message);
  }
}

/** AIRI_MEDIA_TASK_QUEUE, then TEMPORAL_MEDIA_TASK_QUEUE, then the contract queue. */
export function resolveTemporalMediaTaskQueue(
  contractTaskQueue: string
): string {
  return (
    normalizeOptionalString(process.env.AIRI_MEDIA_TASK_QUEUE) ||
    normalizeOptionalString(process.env.TEMPORAL_MEDIA_TASK_QUEUE) ||
    contractTaskQueue
  );
}

/**
 * Starts the workflow with REJECT_DUPLICATE; when that id is already running,
 * attaches to it instead and reports `duplicate: true`.
 */
export async function startOrAttachWorkflow(params: {
  workflowType: string;
  workflowId: string;
  taskQueue: string;
  args: unknown[];
  /** Pass "USE_EXISTING" only where the workflow already used it. */
  conflictPolicy?: "USE_EXISTING";
  onDuplicate?: (handle: TemporalWorkflowHandle) => Promise<void>;
}): Promise<WorkflowStartResult> {
  const { workflowId, taskQueue } = params;
  const client = getTemporalClient();

  try {
    const handle = await client.workflow.start(params.workflowType, {
      workflowId,
      taskQueue,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      ...(params.conflictPolicy
        ? { workflowIdConflictPolicy: params.conflictPolicy }
        : {}),
      args: params.args,
    });
    return { workflowId, taskQueue, handle, duplicate: false };
  } catch (error) {
    if (!isWorkflowAlreadyStartedError(error)) throw error;
    const handle = client.workflow.getHandle(workflowId);
    await params.onDuplicate?.(handle);
    return { workflowId, taskQueue, handle, duplicate: true };
  }
}
