const mockTryStart = jest.fn();
jest.mock("@/lib/temporal/knowledge-canonical-sync-client", () => ({
  tryStartKnowledgeCanonicalSyncWorkflow: (...args: unknown[]) =>
    mockTryStart(...args),
}));
jest.mock("@/lib/airi/shared/logger", () => ({
  ragLogger: { general: { warn: jest.fn() } },
}));
import { enqueueKnowledgeCanonicalSync } from "./enqueue-knowledge-canonical-sync";
it("preserves source identity when mutation callers enqueue canonical sync", () => {
  mockTryStart.mockResolvedValue({ ok: true });
  enqueueKnowledgeCanonicalSync({
    workspaceId: "workspace-1",
    sourceKinds: ["kb_article"],
    sourceRecordIds: ["article-1"],
    context: "kb.publish",
  });
  expect(mockTryStart).toHaveBeenCalledWith(
    expect.objectContaining({ sourceRecordIds: ["article-1"] })
  );
});
