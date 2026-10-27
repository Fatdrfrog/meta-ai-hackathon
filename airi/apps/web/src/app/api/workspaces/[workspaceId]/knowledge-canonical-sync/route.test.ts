const mockCreateClient = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockRequireWorkspaceMembership = jest.fn();
const mockStartKnowledgeCanonicalSyncWorkflow = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockRequireWorkspaceMembership(...args),
}));

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
}));

jest.mock("@/lib/temporal/knowledge-canonical-sync-client", () => ({
  startKnowledgeCanonicalSyncWorkflow: (...args: unknown[]) =>
    mockStartKnowledgeCanonicalSyncWorkflow(...args),
}));

import { POST } from "./route";

function postRaw(body: string) {
  return POST(
    new Request(
      "https://www.airi.chat/api/workspaces/workspace-1/knowledge-canonical-sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }
    ),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}

function post(body: Record<string, unknown>) {
  return postRaw(JSON.stringify(body));
}

describe("POST /api/workspaces/[workspaceId]/knowledge-canonical-sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
    });
    mockRequireWorkspaceMembership.mockResolvedValue(true);
    mockIsTemporalConfigured.mockReturnValue(true);
    mockStartKnowledgeCanonicalSyncWorkflow.mockResolvedValue({
      workflowId: "knowledge-canonical-sync:workspace-1:run-1",
    });
  });

  it("starts version-2 sync with only the exact supported requested kinds", async () => {
    const response = await post({
      sourceKinds: ["indexed_url", "kb_article", "indexed_url"],
      dryRun: true,
    });

    expect(response.status).toBe(200);
    expect(mockStartKnowledgeCanonicalSyncWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceKinds: ["indexed_url", "kb_article"],
      dryRun: true,
    });
  });

  it("keeps an omitted source list as the three-source runtime default", async () => {
    const response = await post({});

    expect(response.status).toBe(200);
    expect(mockStartKnowledgeCanonicalSyncWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceKinds: undefined,
      dryRun: false,
    });
  });

  it.each([
    ["runtime null", null],
    ["non-array", "kb_article"],
    ["empty", []],
    ["retired-only", ["conversation_summary"]],
    ["mixed retired", ["kb_article", "conversation_summary"]],
    ["mixed malformed", ["kb_article", 42]],
    ["unknown", ["future_source"]],
  ])("rejects an explicitly %s source list", async (_label, sourceKinds) => {
    const response = await post({ sourceKinds });

    expect(response.status).toBe(400);
    expect(mockStartKnowledgeCanonicalSyncWorkflow).not.toHaveBeenCalled();
  });

  it("rejects an invalid source list before reporting Temporal availability", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);

    const response = await post({ sourceKinds: ["conversation_summary"] });

    expect(response.status).toBe(400);
    expect(mockStartKnowledgeCanonicalSyncWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-object body", JSON.stringify(["kb_article"])],
  ])(
    "rejects %s instead of broadening it to defaults",
    async (_label, body) => {
      const response = await postRaw(body);

      expect(response.status).toBe(400);
      expect(mockStartKnowledgeCanonicalSyncWorkflow).not.toHaveBeenCalled();
    }
  );
});
