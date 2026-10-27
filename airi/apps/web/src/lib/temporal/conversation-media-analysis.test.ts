const mockWorkflowStart = jest.fn();
const mockWorkflowGetHandle = jest.fn();
const mockIsTemporalConfigured = jest.fn();

jest.mock("./client", () => ({
  getTemporalClient: () => ({
    workflow: {
      start: (...args: unknown[]) => mockWorkflowStart(...args),
      getHandle: (...args: unknown[]) => mockWorkflowGetHandle(...args),
    },
  }),
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
}));

import {
  signalConversationMediaAnalysisAiriTriggerWorkflow,
  startConversationMediaAnalysisWorkflow,
} from "./conversation-media-analysis";

describe("conversation media analysis Temporal client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockWorkflowStart.mockResolvedValue({ workflowId: "started-handle" });
    mockWorkflowGetHandle.mockReturnValue({ workflowId: "existing-handle" });
  });

  it("starts media analysis with a stable message-level workflow id and duplicate rejection", async () => {
    const result = await startConversationMediaAnalysisWorkflow({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      mediaType: "video",
      sourceId: "source-1",
    });

    expect(result.duplicate).toBe(false);
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "conversationMediaAnalysisWorkflow",
      expect.objectContaining({
        workflowId:
          "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
        taskQueue: "airi-media",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      })
    );
    expect(mockWorkflowStart.mock.calls[0]?.[1]).not.toHaveProperty(
      "workflowIdConflictPolicy"
    );
  });

  it("reports duplicate true when Temporal rejects an existing media workflow id", async () => {
    const error = new Error("WorkflowExecutionAlreadyStarted");
    error.name = "WorkflowExecutionAlreadyStartedError";
    mockWorkflowStart.mockRejectedValue(error);

    const result = await startConversationMediaAnalysisWorkflow({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      mediaType: "voice",
    });

    expect(result).toMatchObject({
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:voice",
      taskQueue: "airi-media",
      duplicate: true,
      handle: { workflowId: "existing-handle" },
    });
    expect(mockWorkflowGetHandle).toHaveBeenCalledWith(
      "conversation-media-analysis:workspace-1:conversation-1:message-1:voice"
    );
  });

  it("signals an active media workflow to trigger Airi after analysis", async () => {
    const signal = jest.fn().mockResolvedValue(undefined);
    mockWorkflowGetHandle.mockReturnValue({ signal });
    const workflowId =
      "conversation-media-analysis:workspace-1:conversation-1:message-1:voice";

    await expect(
      signalConversationMediaAnalysisAiriTriggerWorkflow({ workflowId })
    ).resolves.toEqual({ workflowId });

    expect(mockWorkflowGetHandle).toHaveBeenCalledWith(workflowId);
    expect(signal).toHaveBeenCalledWith("conversationMediaAnalysisTriggerAiri");
  });
});
