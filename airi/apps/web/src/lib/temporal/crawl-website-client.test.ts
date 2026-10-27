jest.mock("server-only", () => ({}));

const mockWorkflowStart = jest.fn();
const mockIsTemporalConfigured = jest.fn();

jest.mock("./client", () => ({
  getTemporalClient: () => ({
    workflow: {
      start: (...args: unknown[]) => mockWorkflowStart(...args),
    },
  }),
  getTemporalWebClientConfig: () => ({ taskQueue: "airi-task-queue" }),
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
}));

import {
  startCrawlWebsiteWorkflow,
  tryStartCrawlWebsiteWorkflow,
} from "./crawl-website-client";
import { loadTemporalClientSdk } from "./sdk";

const { WorkflowExecutionAlreadyStartedError } = loadTemporalClientSdk();

describe("crawl website Temporal client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockWorkflowStart.mockResolvedValue({ workflowId: "started-workflow" });
  });

  it("derives a deterministic workflow id with active-run reuse policies", async () => {
    await startCrawlWebsiteWorkflow({
      workspaceId: "workspace-1",
      websites: ["https://a.example"],
      includeInstagram: true,
    });

    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "crawlWebsiteWorkflow",
      expect.objectContaining({
        workflowId: expect.stringMatching(
          /^crawl-website:workspace-1:manual-[a-f0-9]{64}$/
        ),
        taskQueue: "airi-task-queue",
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
      })
    );
  });

  it("preserves an explicit execution id override", async () => {
    await startCrawlWebsiteWorkflow({
      workspaceId: "workspace-1",
      websites: ["https://a.example"],
      executionId: "batch-42",
    });

    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "crawlWebsiteWorkflow",
      expect.objectContaining({
        workflowId: "crawl-website:workspace-1:batch-42",
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
      })
    );
  });

  it("keeps startCrawlWebsiteWorkflow throwing when Temporal is not configured", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);

    await expect(
      startCrawlWebsiteWorkflow({ workspaceId: "workspace-1" })
    ).rejects.toThrow(
      "Temporal is not configured; cannot start crawl website workflow"
    );
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("reports not configured without trying to start", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);

    await expect(
      tryStartCrawlWebsiteWorkflow({ workspaceId: "workspace-1" })
    ).resolves.toEqual({ ok: false, reason: "temporal_not_configured" });
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("treats WorkflowExecutionAlreadyStartedError as a successful existing run", async () => {
    mockWorkflowStart.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        "Workflow execution already started",
        "crawl-website:workspace-1:manual-existing",
        "crawlWebsiteWorkflow"
      )
    );

    const result = await tryStartCrawlWebsiteWorkflow({
      workspaceId: "workspace-1",
      websites: ["https://a.example"],
    });
    const attemptedWorkflowId = mockWorkflowStart.mock.calls[0]?.[1].workflowId;

    expect(result).toEqual({ ok: true, workflowId: attemptedWorkflowId });
  });

  it("preserves ordinary start failures for server logs", async () => {
    mockWorkflowStart.mockRejectedValue(
      new Error("Workflow execution already started upstream")
    );

    await expect(
      tryStartCrawlWebsiteWorkflow({
        workspaceId: "workspace-1",
        websites: ["https://a.example"],
      })
    ).resolves.toEqual({
      ok: false,
      reason: "start_failed",
      message: "Workflow execution already started upstream",
    });
  });
});
