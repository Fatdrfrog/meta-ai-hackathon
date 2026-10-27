const mockGetActiveWorkspaces = jest.fn();
const mockVerifyCronAuth = jest.fn();
const mockTryStartKnowledgeCanonicalSyncWorkflow = jest.fn();

jest.mock("./workspaces", () => ({
  getActiveWorkspaces: (...args: unknown[]) => mockGetActiveWorkspaces(...args),
}));

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockVerifyCronAuth(...args),
}));

jest.mock("@/lib/temporal/knowledge-canonical-sync-client", () => ({
  buildDailyKnowledgeCanonicalSyncExecutionId: (date: Date = new Date()) =>
    `daily-${date.toISOString().slice(0, 10)}`,
  tryStartKnowledgeCanonicalSyncWorkflow: (...args: unknown[]) =>
    mockTryStartKnowledgeCanonicalSyncWorkflow(...args),
}));

describe("/api/cron/knowledge-canonical-sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-06-11T05:30:00.000Z"));
    mockVerifyCronAuth.mockReturnValue(null);
    mockTryStartKnowledgeCanonicalSyncWorkflow.mockResolvedValue({
      ok: true,
      workflowId: "workflow-id",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses one idempotent daily execution id for every workspace in a cron run", async () => {
    mockGetActiveWorkspaces
      .mockResolvedValueOnce([{ id: "workspace-1" }, { id: "workspace-2" }])
      .mockResolvedValueOnce([]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/knowledge-canonical-sync")
    );

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        started: 2,
        failed: 0,
      })
    );
    expect(mockTryStartKnowledgeCanonicalSyncWorkflow).toHaveBeenCalledTimes(2);
    expect(mockTryStartKnowledgeCanonicalSyncWorkflow).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: "workspace-1",
        executionId: "daily-2026-06-11",
      }
    );
    expect(mockTryStartKnowledgeCanonicalSyncWorkflow).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: "workspace-2",
        executionId: "daily-2026-06-11",
      }
    );
  });
});

export {};
