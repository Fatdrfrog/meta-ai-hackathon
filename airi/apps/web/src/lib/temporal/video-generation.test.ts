const mockWorkflowStart = jest.fn();
const mockGetHandle = jest.fn();
const mockSignal = jest.fn();
const mockDescribe = jest.fn();
const mockIsTemporalConfigured = jest.fn(() => true);
const mockGetTemporalClient = jest.fn(() => ({
  workflow: {
    start: (...args: unknown[]) => mockWorkflowStart(...args),
    getHandle: (...args: unknown[]) => mockGetHandle(...args),
  },
}));

jest.mock("server-only", () => ({}));
jest.mock("./client", () => ({
  getTemporalClient: () => mockGetTemporalClient(),
  getTemporalWebClientConfig: () => ({ taskQueue: "main-worker" }),
  isTemporalConfigured: () => mockIsTemporalConfigured(),
}));

import {
  VIDEO_GENERATION_STATUS_SIGNAL,
  VIDEO_GENERATION_WORKFLOW,
  buildVideoGenerationWorkflowId,
  type CompiledVideoPrompt,
  type VideoGenerationSpec,
  type VideoGenerationStatusSignal,
} from "@icecore/temporal";
import { loadTemporalClientSdk } from "./sdk";
import {
  signalVideoGenerationWorkflow,
  startVideoGenerationWorkflow,
  VideoGenerationWorkflowNotRunningError,
  VideoGenerationWorkflowStartAmbiguousError,
} from "./video-generation";

const { WorkflowExecutionAlreadyStartedError } = loadTemporalClientSdk();

const spec: VideoGenerationSpec = {
  contractVersion: 1,
  provider: "higgsfield",
  mode: "image_to_video",
  skill: "video",
  userPrompt: "A slow product reveal",
  modelId: "higgsfield-model",
  seed: null,
  durationSeconds: 5,
  aspectRatio: null,
  resolution: "provider_default",
  sourceAssetId: "source-1",
  referenceAssetIds: [],
};

const prompt: CompiledVideoPrompt = {
  compilerId: "airi-video-director",
  compilerVersion: 1,
  normalizedUserPrompt: "A slow product reveal",
  providerPrompt: "frozen provider prompt",
  providerPromptSha256: "a".repeat(64),
  warnings: [],
};

describe("video generation Temporal client", () => {
  const originalAiriMediaTaskQueue = process.env.AIRI_MEDIA_TASK_QUEUE;
  const originalTemporalMediaTaskQueue = process.env.TEMPORAL_MEDIA_TASK_QUEUE;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockGetTemporalClient.mockImplementation(() => ({
      workflow: {
        start: (...args: unknown[]) => mockWorkflowStart(...args),
        getHandle: (...args: unknown[]) => mockGetHandle(...args),
      },
    }));
    delete process.env.AIRI_MEDIA_TASK_QUEUE;
    delete process.env.TEMPORAL_MEDIA_TASK_QUEUE;
  });

  afterAll(() => {
    if (originalAiriMediaTaskQueue === undefined) {
      delete process.env.AIRI_MEDIA_TASK_QUEUE;
    } else {
      process.env.AIRI_MEDIA_TASK_QUEUE = originalAiriMediaTaskQueue;
    }
    if (originalTemporalMediaTaskQueue === undefined) {
      delete process.env.TEMPORAL_MEDIA_TASK_QUEUE;
    } else {
      process.env.TEMPORAL_MEDIA_TASK_QUEUE = originalTemporalMediaTaskQueue;
    }
  });

  it("starts only the stable workflow with the exact frozen bounded input", async () => {
    const handle = { workflowId: "handle-1" };
    mockWorkflowStart.mockResolvedValue(handle);

    const result = await startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec,
      prompt,
      providerSourceId: "private-source-1",
      completionTarget: {
        workflowId: "scenario-generation:workflow-1",
        signalName: "videoGenerationCompleted",
        correlationId: "execution-1",
      },
    });

    const workflowId = buildVideoGenerationWorkflowId({ assetId: "asset-1" });
    expect(mockWorkflowStart).toHaveBeenCalledWith(VIDEO_GENERATION_WORKFLOW, {
      workflowId,
      taskQueue: "main-worker",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [
        {
          contractVersion: 1,
          workspaceId: "workspace-1",
          assetId: "asset-1",
          attemptToken: "attempt-1",
          spec,
          prompt,
          providerSourceId: "private-source-1",
          mediaTaskQueue: "airi-media",
          completionTarget: {
            workflowId: "scenario-generation:workflow-1",
            signalName: "videoGenerationCompleted",
            correlationId: "execution-1",
          },
        },
      ],
    });
    expect(result).toEqual({
      workflowId,
      taskQueue: "main-worker",
      handle,
      duplicate: false,
    });
  });

  it("starts a recovery execution with only the persisted provider identity", async () => {
    const handle = { workflowId: "handle-recovery" };
    mockWorkflowStart.mockResolvedValue(handle);

    await startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-recovery",
      attemptToken: "attempt-recovery",
      spec,
      prompt,
      providerSourceId: "private-source-1",
      resume: {
        providerRequestId: "request-1",
        providerRequestLocator: "opaque-locator-1",
        pollCount: 0,
        elapsedMs: 0,
      },
    });

    expect(mockWorkflowStart).toHaveBeenCalledWith(
      VIDEO_GENERATION_WORKFLOW,
      expect.objectContaining({
        workflowId: "video-generation:asset-recovery",
        args: [
          expect.objectContaining({
            assetId: "asset-recovery",
            attemptToken: "attempt-recovery",
            resume: {
              providerRequestId: "request-1",
              providerRequestLocator: "opaque-locator-1",
              pollCount: 0,
              elapsedMs: 0,
            },
          }),
        ],
      })
    );
  });

  it("uses AIRI_MEDIA_TASK_QUEUE before TEMPORAL_MEDIA_TASK_QUEUE", async () => {
    process.env.AIRI_MEDIA_TASK_QUEUE = "airi-media";
    process.env.TEMPORAL_MEDIA_TASK_QUEUE = "legacy-media";
    mockWorkflowStart.mockResolvedValue({ workflowId: "handle-1" });

    await startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec,
      prompt,
      providerSourceId: null,
    });

    expect(mockWorkflowStart).toHaveBeenCalledWith(
      VIDEO_GENERATION_WORKFLOW,
      expect.objectContaining({
        taskQueue: "main-worker",
        args: [expect.objectContaining({ mediaTaskQueue: "airi-media" })],
      })
    );
  });

  it("returns the existing stable handle when Temporal reports AlreadyStarted", async () => {
    const error = new WorkflowExecutionAlreadyStartedError(
      "Workflow execution already started",
      "video-generation:asset-1",
      VIDEO_GENERATION_WORKFLOW
    );
    mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } });
    const existingHandle = {
      workflowId: "existing",
      describe: mockDescribe,
    };
    mockWorkflowStart.mockRejectedValue(error);
    mockGetHandle.mockReturnValue(existingHandle);

    const result = await startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec,
      prompt,
      providerSourceId: null,
    });

    expect(mockGetHandle).toHaveBeenCalledWith("video-generation:asset-1");
    expect(result.handle).toBe(existingHandle);
    expect(result.duplicate).toBe(true);
  });

  it("does not confirm a typed duplicate whose execution is already closed", async () => {
    mockWorkflowStart.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        "Workflow execution already started",
        "video-generation:asset-1",
        VIDEO_GENERATION_WORKFLOW
      )
    );
    mockGetHandle.mockReturnValue({
      describe: jest.fn().mockResolvedValue({ status: { name: "FAILED" } }),
    });

    const operation = startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec,
      prompt,
      providerSourceId: null,
    });
    await expect(operation).rejects.toBeInstanceOf(
      VideoGenerationWorkflowNotRunningError
    );
    await expect(operation).rejects.toMatchObject({
      name: "VideoGenerationWorkflowNotRunningError",
      status: "FAILED",
    });
  });

  it("does not classify an untyped already-started message as a duplicate", async () => {
    mockWorkflowStart.mockRejectedValue(
      new Error("workflow already started according to a proxy")
    );

    await expect(
      startVideoGenerationWorkflow({
        workspaceId: "workspace-1",
        assetId: "asset-1",
        attemptToken: "attempt-1",
        spec,
        prompt,
        providerSourceId: null,
      })
    ).rejects.toBeInstanceOf(VideoGenerationWorkflowStartAmbiguousError);
    expect(mockGetHandle).not.toHaveBeenCalled();
  });

  it("wraps a non-AlreadyStarted workflow start RPC failure as ambiguous", async () => {
    mockWorkflowStart.mockRejectedValue(new Error("connection reset"));

    const operation = startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec,
      prompt,
      providerSourceId: null,
    });

    await expect(operation).rejects.toBeInstanceOf(
      VideoGenerationWorkflowStartAmbiguousError
    );
    await expect(operation).rejects.toThrow("connection reset");
    expect(mockGetHandle).not.toHaveBeenCalled();
  });

  it("propagates an unconfigured preflight failure as definite", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);

    const operation = startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec,
      prompt,
      providerSourceId: null,
    });

    await expect(operation).rejects.toThrow(
      "Temporal is not configured for video generation"
    );
    await expect(operation).rejects.not.toBeInstanceOf(
      VideoGenerationWorkflowStartAmbiguousError
    );
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("propagates client construction failures before the start RPC as definite", async () => {
    mockGetTemporalClient.mockImplementationOnce(() => {
      throw new Error("client construction failed");
    });

    const operation = startVideoGenerationWorkflow({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      attemptToken: "attempt-1",
      spec,
      prompt,
      providerSourceId: null,
    });

    await expect(operation).rejects.toThrow("client construction failed");
    await expect(operation).rejects.not.toBeInstanceOf(
      VideoGenerationWorkflowStartAmbiguousError
    );
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("signals only the normalized contract-v1 status payload", async () => {
    const signal: VideoGenerationStatusSignal = {
      contractVersion: 1,
      assetId: "asset-1",
      providerRequestId: "request-1",
      status: "completed",
      receivedAt: "2026-07-23T00:00:00.000Z",
    };
    mockGetHandle.mockReturnValue({ signal: mockSignal });

    await signalVideoGenerationWorkflow({
      workflowId: "video-generation:asset-1",
      signal,
    });

    expect(mockSignal).toHaveBeenCalledWith(
      VIDEO_GENERATION_STATUS_SIGNAL,
      signal
    );
  });
});
