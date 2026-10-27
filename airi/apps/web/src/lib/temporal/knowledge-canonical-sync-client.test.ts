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
  buildDailyKnowledgeCanonicalSyncExecutionId,
  startKnowledgeCanonicalSyncWorkflow,
} from "./knowledge-canonical-sync-client";

describe("knowledge canonical sync Temporal client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockWorkflowStart.mockResolvedValue({
      workflowId: "knowledge-canonical-sync:workspace-1:daily-2026-06-11",
    });
  });

  it("builds a stable UTC daily execution id", () => {
    expect(
      buildDailyKnowledgeCanonicalSyncExecutionId(
        new Date("2026-06-11T23:59:59.999Z")
      )
    ).toBe("daily-2026-06-11");
  });

  it("preserves an explicit article scope in the workflow payload", async () => {
    await startKnowledgeCanonicalSyncWorkflow({
      workspaceId: "workspace-1",
      sourceKinds: ["kb_article"],
      sourceRecordIds: ["article-1"],
    });
    expect(mockWorkflowStart.mock.calls[0][1].args[0]).toMatchObject({
      sourceRecordIds: ["article-1"],
    });
  });

  it("starts daily sync workflows with duplicate rejection and existing-run reuse", async () => {
    await startKnowledgeCanonicalSyncWorkflow({
      workspaceId: "workspace-1",
      executionId: "daily-2026-06-11",
    });

    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "knowledgeCanonicalSyncWorkflow",
      expect.objectContaining({
        workflowId: "knowledge-canonical-sync:workspace-1:daily-2026-06-11",
        taskQueue: "airi-task-queue",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
        args: [
          {
            contractVersion: 2,
            workspaceId: "workspace-1",
            sourceKinds: undefined,
            dryRun: undefined,
          },
        ],
      })
    );
  });

  it("passes only the supported requested product source kinds", async () => {
    await startKnowledgeCanonicalSyncWorkflow({
      workspaceId: "workspace-1",
      sourceKinds: ["indexed_url", "curated_snippet"],
      dryRun: true,
    });

    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "knowledgeCanonicalSyncWorkflow",
      expect.objectContaining({
        args: [
          {
            contractVersion: 2,
            workspaceId: "workspace-1",
            sourceKinds: ["indexed_url", "curated_snippet"],
            dryRun: true,
          },
        ],
      })
    );
  });
});
