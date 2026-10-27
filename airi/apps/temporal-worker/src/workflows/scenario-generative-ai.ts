import {
  AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL,
  AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
  normalizeAiriScenarioGenerativeAIProcessedAck,
  normalizeAiriScenarioGenerativeAIResultEvent,
  normalizeAiriScenarioGenerativeAIWorkflowInput,
  normalizeVideoGenerationCompletionResult,
  CREATIVE_IMAGE_GENERATION_WORKFLOW,
  type CreativeImageGenerationWorkflowResult,
  type AiriScenarioGenerativeAIProcessedAck,
  type AiriScenarioGenerativeAIResultEvent,
  type AiriScenarioGenerativeAIWorkflowInput,
  type VideoGenerationCompletionResult,
} from "@icecore/temporal";
import {
  condition,
  continueAsNew,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
  workflowInfo,
} from "@temporalio/workflow";

import type {
  ScenarioGenerativeAIAcceptInput,
  ScenarioGenerativeAIAcceptResult,
  ScenarioGenerativeAIBeginResult,
  ScenarioGenerativeAIImportResult,
  ScenarioGenerativeAIStartInput,
  ScenarioGenerativeAIStartResult,
  ScenarioGenerativeAIImageAcceptResult,
} from "../activities/scenario-generative-ai";

const videoCompletionSignal = defineSignal<[VideoGenerationCompletionResult]>(
  AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
);
const resultProcessedSignal = defineSignal<
  [AiriScenarioGenerativeAIProcessedAck]
>(AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL);

const beginActivities = proxyActivities<{
  [AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY]: (
    input: AiriScenarioGenerativeAIWorkflowInput,
  ) => Promise<ScenarioGenerativeAIBeginResult>;
}>({
  startToCloseTimeout: "2m",
  retry: {
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
    maximumAttempts: 5,
  },
});

const acceptActivities = proxyActivities<{
  [AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY]: (
    input: ScenarioGenerativeAIAcceptInput,
  ) => Promise<ScenarioGenerativeAIAcceptResult>;
}>({
  startToCloseTimeout: "5m",
  retry: {
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "1m",
  },
});

const startActivities = proxyActivities<{
  [AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY]: (
    input: ScenarioGenerativeAIStartInput,
  ) => Promise<ScenarioGenerativeAIStartResult>;
}>({
  startToCloseTimeout: "2m",
  retry: {
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "1m",
  },
});

const reportActivities = proxyActivities<{
  [AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY]: (
    event: AiriScenarioGenerativeAIResultEvent,
  ) => Promise<void>;
}>({
  startToCloseTimeout: "2m",
  retry: {
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
    maximumAttempts: 5,
  },
});

const imageActivities = proxyActivities<{
  [AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY]: (
    input: AiriScenarioGenerativeAIWorkflowInput,
  ) => Promise<ScenarioGenerativeAIImageAcceptResult>;
}>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 5, initialInterval: "2s", maximumInterval: "30s" },
});

const beginScenarioGenerativeAI =
  beginActivities[AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY];
const acceptScenarioGenerativeAIVideo =
  acceptActivities[AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY];
const startScenarioGenerativeAIVideo =
  startActivities[AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY];
const reportScenarioGenerativeAIResult =
  reportActivities[AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY];

const REPORT_BACKOFF_SECONDS = [5, 15, 30, 60, 120, 300] as const;
const MAX_BUFFERED_COMPLETIONS = 4;
const REPORT_ATTEMPTS_PER_RUN = 100;

function preAssetFailure(
  input: AiriScenarioGenerativeAIWorkflowInput,
  code:
    | "execution_unavailable"
    | "source_import_failed"
    | "generation_preparation_failed",
): AiriScenarioGenerativeAIResultEvent {
  return normalizeAiriScenarioGenerativeAIResultEvent({
    kind: "generative_ai_result",
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.executionId,
    executionId: input.executionId,
    scenarioWorkflowId: input.workflowId,
    videoWorkflowId: null,
    assetId: null,
    terminal: {
      state: "failed",
      code,
      attemptToken: null,
    },
  });
}

function acceptedFailure(
  input: AiriScenarioGenerativeAIWorkflowInput,
  accepted: ScenarioGenerativeAIAcceptResult,
): AiriScenarioGenerativeAIResultEvent {
  return normalizeAiriScenarioGenerativeAIResultEvent({
    kind: "generative_ai_result",
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.executionId,
    executionId: input.executionId,
    scenarioWorkflowId: input.workflowId,
    videoWorkflowId: accepted.videoWorkflowId,
    assetId: accepted.assetId,
    terminal: {
      state: "failed",
      code: "generation_start_failed",
      attemptToken: accepted.attemptToken,
    },
  });
}

function completionEvent(
  input: AiriScenarioGenerativeAIWorkflowInput,
  accepted: ScenarioGenerativeAIAcceptResult,
  completion: VideoGenerationCompletionResult,
): AiriScenarioGenerativeAIResultEvent {
  return normalizeAiriScenarioGenerativeAIResultEvent({
    kind: "generative_ai_result",
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.executionId,
    executionId: input.executionId,
    scenarioWorkflowId: input.workflowId,
    videoWorkflowId: accepted.videoWorkflowId,
    assetId: accepted.assetId,
    terminal: {
      state: completion.terminal,
      code: completion.code,
      attemptToken: accepted.attemptToken,
    },
  });
}

function matchesCompletion(
  completion: VideoGenerationCompletionResult,
  input: AiriScenarioGenerativeAIWorkflowInput,
  accepted: ScenarioGenerativeAIAcceptResult,
): boolean {
  return (
    completion.correlationId === input.executionId &&
    completion.assetId === accepted.assetId &&
    completion.attemptToken === accepted.attemptToken
  );
}

async function reportUntilProcessed(
  event: AiriScenarioGenerativeAIResultEvent,
  isProcessed: () => boolean,
  input: AiriScenarioGenerativeAIWorkflowInput,
  initialReportAttempt = 0,
): Promise<void> {
  let reportAttempt = initialReportAttempt;
  const runStartAttempt = initialReportAttempt;
  while (!isProcessed()) {
    try {
      await reportScenarioGenerativeAIResult(event);
    } catch {
      // The next bounded workflow-timer attempt reuses the same event key.
    }
    if (isProcessed()) return;
    const backoffSeconds =
      REPORT_BACKOFF_SECONDS[
        Math.min(reportAttempt, REPORT_BACKOFF_SECONDS.length - 1)
      ]!;
    reportAttempt += 1;
    if (
      workflowInfo().continueAsNewSuggested ||
      reportAttempt - runStartAttempt >= REPORT_ATTEMPTS_PER_RUN
    ) {
      await continueAsNew<typeof airiScenarioGenerativeAIWorkflow>({
        ...input,
        reporting: {
          resultEvent: event,
          reportAttempt,
        },
      });
    }
    await condition(() => isProcessed(), `${backoffSeconds}s`);
  }
}

export async function airiScenarioGenerativeAIWorkflow(
  value: AiriScenarioGenerativeAIWorkflowInput,
): Promise<void> {
  const normalizedInput = normalizeAiriScenarioGenerativeAIWorkflowInput(value);
  const actualWorkflowId = workflowInfo().workflowId;
  if (normalizedInput.workflowId !== actualWorkflowId) {
    throw new Error(
      "Scenario Generative AI workflow input identity does not match",
    );
  }
  const input: AiriScenarioGenerativeAIWorkflowInput = {
    ...normalizedInput,
    workflowId: actualWorkflowId,
  };
  const completions: VideoGenerationCompletionResult[] = [];
  let resultProcessed = false;

  setHandler(videoCompletionSignal, (value) => {
    try {
      const completion = normalizeVideoGenerationCompletionResult(value);
      if (completion.correlationId !== input.executionId) return;
      completions.push(completion);
      if (completions.length > MAX_BUFFERED_COMPLETIONS) {
        completions.shift();
      }
    } catch {
      // Malformed or unrelated signals cannot enter the workflow state.
    }
  });
  setHandler(resultProcessedSignal, (value) => {
    try {
      const acknowledgment =
        normalizeAiriScenarioGenerativeAIProcessedAck(value);
      if (acknowledgment.executionId === input.executionId) {
        resultProcessed = true;
      }
    } catch {
      // Ignore malformed acknowledgments.
    }
  });

  if (input.reporting) {
    await reportUntilProcessed(
      input.reporting.resultEvent,
      () => resultProcessed,
      input,
      input.reporting.reportAttempt,
    );
    return;
  }

  let event: AiriScenarioGenerativeAIResultEvent;
  let begin: ScenarioGenerativeAIBeginResult;
  try {
    begin = await beginScenarioGenerativeAI(input);
  } catch {
    event = preAssetFailure(input, "execution_unavailable");
    await reportUntilProcessed(event, () => resultProcessed, input);
    return;
  }

  let sourceAssetId: string | null = null;
  if (begin.mode === "text_to_image") {
    let accepted: ScenarioGenerativeAIImageAcceptResult;
    try {
      accepted =
        await imageActivities[
          AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY
        ](input);
    } catch {
      await reportUntilProcessed(
        preAssetFailure(input, "generation_preparation_failed"),
        () => resultProcessed,
        input,
      );
      return;
    }
    try {
      const result = (await executeChild<
        typeof import("./creative-image-generation").creativeImageGenerationWorkflow
      >(CREATIVE_IMAGE_GENERATION_WORKFLOW, {
        workflowId: accepted.videoWorkflowId,
        taskQueue: begin.mediaTaskQueue,
        args: [accepted.imageInput],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      })) as CreativeImageGenerationWorkflowResult;
      event = completionEvent(input, accepted, {
        contractVersion: 1,
        correlationId: input.executionId,
        assetId: accepted.assetId,
        attemptToken: accepted.attemptToken,
        terminal:
          result.assetId === accepted.assetId && result.status === "complete"
            ? "complete"
            : "failed",
        code:
          result.assetId === accepted.assetId && result.status === "complete"
            ? "generation_complete"
            : "generation_failed",
      });
    } catch {
      event = acceptedFailure(input, accepted);
    }
    await reportUntilProcessed(event, () => resultProcessed, input);
    return;
  }
  if (begin.mode === "image_to_video") {
    const importActivities = proxyActivities<{
      [AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY]: (
        input: AiriScenarioGenerativeAIWorkflowInput,
      ) => Promise<ScenarioGenerativeAIImportResult>;
    }>({
      taskQueue: begin.mediaTaskQueue,
      startToCloseTimeout: "10m",
      scheduleToCloseTimeout: "30m",
      retry: {
        initialInterval: "5s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
        maximumAttempts: 3,
      },
    });
    const importScenarioGenerativeAISource =
      importActivities[AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY];
    try {
      const imported = await importScenarioGenerativeAISource(input);
      sourceAssetId = imported.sourceAssetId;
    } catch {
      event = preAssetFailure(input, "source_import_failed");
      await reportUntilProcessed(event, () => resultProcessed, input);
      return;
    }
  }

  let accepted: ScenarioGenerativeAIAcceptResult;
  try {
    accepted = await acceptScenarioGenerativeAIVideo({
      ...input,
      sourceAssetId,
    });
  } catch {
    event = preAssetFailure(input, "generation_preparation_failed");
    await reportUntilProcessed(event, () => resultProcessed, input);
    return;
  }

  try {
    await startScenarioGenerativeAIVideo({
      ...input,
      ...accepted,
    });
  } catch {
    event = acceptedFailure(input, accepted);
    await reportUntilProcessed(event, () => resultProcessed, input);
    return;
  }

  await condition(() =>
    completions.some((completion) =>
      matchesCompletion(completion, input, accepted),
    ),
  );
  const completion = completions.find((candidate) =>
    matchesCompletion(candidate, input, accepted),
  )!;
  event = completionEvent(input, accepted, completion);
  await reportUntilProcessed(event, () => resultProcessed, input);
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  airiScenarioGenerativeAIWorkflow,
);
