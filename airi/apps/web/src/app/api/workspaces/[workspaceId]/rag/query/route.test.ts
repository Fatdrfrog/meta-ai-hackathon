const mockGenerateResponse = jest.fn();
const mockGetUser = jest.fn();
const mockWorkspaceAccess = jest.fn();

jest.mock("@/lib/airi/rag/response/rag-response-service", () => ({
  RagResponseService: {
    generateResponse: (...args: unknown[]) => mockGenerateResponse(...args),
  },
}));
jest.mock("@/lib/company-context", () => ({
  fetchCompanyContextByWorkspace: jest.fn(async () => ({
    airiLanguage: "en",
    businessContext: "Support",
  })),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: mockWorkspaceAccess,
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: mockGetUser,
      },
      from: () => query,
    };
  },
}));

import { POST } from "./route";
import {
  hasWorkspaceTextAiAction,
  withWorkspaceTextAiAction,
} from "@/lib/ai/workspace-ai-policy";

function request(mode = "answer") {
  return POST(
    new Request("http://localhost/api/workspaces/workspace-1/rag/query", {
      method: "POST",
      body: JSON.stringify({ query: "How do I return a product?", mode }),
    }) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mockWorkspaceAccess.mockResolvedValue({
    data: { workspace_id: "workspace-1" },
  });
});

it.each(["answer", "retrieve", "context"])(
  "scopes authenticated %s queries to the authorized workspace",
  async mode => {
    mockGenerateResponse.mockImplementationOnce(async () => {
      expect(hasWorkspaceTextAiAction()).toBe(true);
      await expect(
        withWorkspaceTextAiAction(
          { workspaceId: "other-workspace", actionId: "other" },
          async () => null
        )
      ).rejects.toThrow("An AI action cannot change workspace");
      return { productMode: mode, content: "Result" };
    });
    const response = await request(mode);
    expect(response.status).toBe(200);
    expect(hasWorkspaceTextAiAction()).toBe(false);
  }
);

it("returns a safe connection-required response when text admission rejects", async () => {
  mockGenerateResponse.mockRejectedValueOnce(
    Object.assign(new Error("secret provider diagnostic"), {
      code: "own_ai_source_required",
      resetAt: "2026-10-01T00:00:00.000Z",
    })
  );
  const response = await request();
  expect(response.status).toBe(402);
  // The allowance is lifetime, so the response never carries a reset date.
  expect(await response.json()).toMatchObject({
    code: "own_ai_source_required",
    resetAt: null,
  });
});

it("does not invoke AI for an unauthorized workspace", async () => {
  mockWorkspaceAccess.mockResolvedValue({ data: null });
  expect((await request()).status).toBe(403);
  expect(mockGenerateResponse).not.toHaveBeenCalled();
});

it("fails closed when the allowance ledger is unavailable", async () => {
  mockGenerateResponse.mockRejectedValueOnce(
    Object.assign(new Error("private database diagnostic"), {
      code: "workspace_ai_policy_unavailable",
    })
  );
  const response = await request();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Failed to run RAG query" });
});
