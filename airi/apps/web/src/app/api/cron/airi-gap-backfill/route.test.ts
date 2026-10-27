const mockRetrieve = jest.fn();
const mockFind = jest.fn();
jest.mock("@/lib/ai", () => ({ chatCompletionWithFallback: jest.fn() }));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => null }));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockFind(...args) },
}));
jest.mock("@/lib/airi/language-detector-server", () => ({
  detectLanguage: async () => "en",
}));
jest.mock("@/lib/airi/rag/pipeline/hybrid-retrieval", () => ({
  retrieveHybridContext: (...args: unknown[]) => mockRetrieve(...args),
}));
jest.mock("@/lib/airi/rag/decision/decision-engine", () => ({
  selectBestContext: () => ({ priority: "generic" }),
}));
jest.mock("@/lib/airi/grounding/factual-grounding-guard", () => ({
  detectFactualIntent: () => "pricing",
  evaluateFactualGroundingGuard: () => ({
    shouldBlock: false,
    reason: "grounded",
  }),
}));
jest.mock("@/lib/airi/rag/knowledge/knowledge-gap-tracker", () => ({
  trackMissingKnowledgeGap: jest.fn(),
}));

import { GET } from "./route";

function mockMessages(messages: Array<Record<string, unknown>>) {
  const query = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockResolvedValue(messages);
  mockFind.mockReturnValue(query);
}

beforeEach(() => {
  jest.clearAllMocks();
});

it("keeps historical gap discovery on retrieval infrastructure without text generation", async () => {
  mockMessages([
    {
      _id: "message-1",
      workspaceId: "workspace-1",
      conversation: "conversation-1",
      text: "What is the price?",
    },
  ]);
  mockRetrieve.mockResolvedValue({ snippet: null, kbArticles: [] });
  const response = await GET(
    new Request("http://localhost/api/cron/airi-gap-backfill?strategy=deep")
  );
  expect(response.status).toBe(200);
  expect(mockRetrieve).toHaveBeenCalledWith(
    "workspace-1",
    "What is the price?",
    "en",
    expect.objectContaining({
      skipLlmRetrievalPlanner: true,
      retrievalIntent: expect.objectContaining({ label: "unclear" }),
      enableReranking: false,
      enableVerification: false,
      enableHyDE: false,
      enableTranslation: false,
    })
  );
});

// The run failed every day since 2026-10-11 because one workspace's AI
// allowance was used up ("GCP AI gateway HTTP 500").
it("skips a failing workspace and keeps scanning the others", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockMessages([
    { _id: "m-1", workspaceId: "ws-out", conversation: "c-1", text: "Price?" },
    { _id: "m-2", workspaceId: "ws-out", conversation: "c-2", text: "Cost?" },
    { _id: "m-3", workspaceId: "ws-ok", conversation: "c-3", text: "Hours?" },
  ]);
  mockRetrieve.mockImplementation(async (workspaceId: string) => {
    if (workspaceId === "ws-out") {
      throw new Error(
        "GCP AI gateway HTTP 500: Your included AI allowance is used"
      );
    }
    return { snippet: null, kbArticles: [] };
  });

  const response = await GET(
    new Request("http://localhost/api/cron/airi-gap-backfill?strategy=deep")
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    scanned: 3,
    failedWorkspaces: 1,
    skippedFailedWorkspace: 2,
  });
  expect(mockRetrieve).toHaveBeenCalledTimes(2);
  expect(mockRetrieve).toHaveBeenLastCalledWith(
    "ws-ok",
    "Hours?",
    "en",
    expect.any(Object)
  );
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
