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

import { startCreativeAssetEditWorkflow } from "./creative-asset-edits";

describe("creative asset edit Temporal client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockWorkflowStart.mockResolvedValue({ workflowId: "started-handle" });
    mockWorkflowGetHandle.mockReturnValue({ workflowId: "existing-handle" });
  });

  it("starts edit workflows with duplicate rejection instead of silent existing-run reuse", async () => {
    const result = await startCreativeAssetEditWorkflow({
      workspaceId: "workspace-1",
      sourceAssetId: "source-video",
      outputAssetId: "output-video",
      operation: "green_screen",
    });

    expect(result.duplicate).toBe(false);
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "creativeAssetEditWorkflow",
      expect.objectContaining({
        workflowId: "creative-asset-edit:output-video",
        taskQueue: "airi-media",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      })
    );
    expect(mockWorkflowStart.mock.calls[0]?.[1]).not.toHaveProperty(
      "workflowIdConflictPolicy"
    );
  });

  it("reports duplicate true when Temporal rejects an existing workflow id", async () => {
    const error = new Error("WorkflowExecutionAlreadyStarted");
    error.name = "WorkflowExecutionAlreadyStartedError";
    mockWorkflowStart.mockRejectedValue(error);

    const result = await startCreativeAssetEditWorkflow({
      workspaceId: "workspace-1",
      sourceAssetId: "source-video",
      outputAssetId: "output-video",
      operation: "green_screen",
    });

    expect(result).toMatchObject({
      workflowId: "creative-asset-edit:output-video",
      taskQueue: "airi-media",
      duplicate: true,
      handle: { workflowId: "existing-handle" },
    });
    expect(mockWorkflowGetHandle).toHaveBeenCalledWith(
      "creative-asset-edit:output-video"
    );
  });
});
