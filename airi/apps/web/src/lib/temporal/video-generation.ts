import "server-only";

import {
  CREATIVE_ASSET_EDIT_TASK_QUEUE,
  VIDEO_GENERATION_STATUS_SIGNAL,
  VIDEO_GENERATION_WORKFLOW,
  VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
  buildVideoGenerationWorkflowId,
  normalizeVideoGenerationCompletionTarget,
  type VideoGenerationStatusSignal,
  type VideoGenerationWorkflowInput,
} from "@icecore/temporal";

import { getTemporalClient, getTemporalWebClientConfig } from "./client";
import { isTemporalSdkError } from "./sdk";
import type { TemporalWorkflowExecutionStatusName } from "./sdk-types";
import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  type WorkflowStartResult,
} from "./workflow-start";

export type VideoGenerationWorkflowStartResult = WorkflowStartResult;

export class VideoGenerationWorkflowStartAmbiguousError extends Error {
  constructor(readonly cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Video generation workflow start outcome is ambiguous: ${detail}`);
    this.name = "VideoGenerationWorkflowStartAmbiguousError";
  }
}

export class VideoGenerationWorkflowNotRunningError extends Error {
  constructor(readonly status: TemporalWorkflowExecutionStatusName) {
    super(`Existing video generation workflow is ${status}`);
    this.name = "VideoGenerationWorkflowNotRunningError";
  }
}

const NOT_CONFIGURED_MESSAGE =
  "Temporal is not configured for video generation";

export { isTemporalConfigured } from "./client";

export async function startVideoGenerationWorkflow(
  input: Omit<
    VideoGenerationWorkflowInput,
    "contractVersion" | "mediaTaskQueue"
  >
): Promise<VideoGenerationWorkflowStartResult> {
  requireTemporalConfigured(NOT_CONFIGURED_MESSAGE);

  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const workflowId = buildVideoGenerationWorkflowId({ assetId: input.assetId });
  const completionTarget = normalizeVideoGenerationCompletionTarget(
    input.completionTarget
  );
  const workflowInput: VideoGenerationWorkflowInput = {
    contractVersion: VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    attemptToken: input.attemptToken,
    spec: input.spec,
    prompt: input.prompt,
    providerSourceId: input.providerSourceId,
    mediaTaskQueue: resolveTemporalMediaTaskQueue(
      CREATIVE_ASSET_EDIT_TASK_QUEUE
    ),
    ...(completionTarget ? { completionTarget } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
  };

  try {
    const handle = await client.workflow.start(VIDEO_GENERATION_WORKFLOW, {
      workflowId,
      taskQueue: config.taskQueue,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [workflowInput],
    });

    return {
      workflowId,
      taskQueue: config.taskQueue,
      handle,
      duplicate: false,
    };
  } catch (error) {
    if (!isTemporalSdkError(error, "WorkflowExecutionAlreadyStartedError")) {
      throw new VideoGenerationWorkflowStartAmbiguousError(error);
    }

    const handle = client.workflow.getHandle(workflowId);
    let status: TemporalWorkflowExecutionStatusName;
    try {
      status = (await handle.describe()).status.name;
    } catch (describeError) {
      throw new VideoGenerationWorkflowStartAmbiguousError(describeError);
    }
    if (status !== "RUNNING") {
      throw new VideoGenerationWorkflowNotRunningError(status);
    }

    return {
      workflowId,
      taskQueue: config.taskQueue,
      handle,
      duplicate: true,
    };
  }
}

export async function signalVideoGenerationWorkflow(input: {
  workflowId: string;
  signal: VideoGenerationStatusSignal;
}): Promise<void> {
  requireTemporalConfigured(NOT_CONFIGURED_MESSAGE);
  const handle = getTemporalClient().workflow.getHandle(input.workflowId);
  await handle.signal(VIDEO_GENERATION_STATUS_SIGNAL, input.signal);
}
