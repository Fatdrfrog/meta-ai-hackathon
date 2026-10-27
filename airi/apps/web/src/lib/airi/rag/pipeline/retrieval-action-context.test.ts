jest.mock("@/lib/ai", () => ({
  ...jest.requireActual("@/lib/ai"),
  getQueryEmbeddingWithCache: jest.fn(),
}));
jest.mock("@/lib/company-context", () => ({
  fetchCompanyContextByWorkspace: jest.fn(async () => ({})),
}));
jest.mock("@/lib/airi/rag/knowledge/knowledge-chunks-retrieval", () => ({
  queryKnowledgeChunks: jest.fn(async () => []),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));

import { getQueryEmbeddingWithCache } from "@/lib/ai";
import {
  getWorkspaceTextAiAction,
  withWorkspaceTextAiAction,
} from "@/lib/ai/workspace-ai-policy";
import { RetrievalOrchestrator } from "./retrieval-orchestrator";
import { retrieveBestAnswer } from "./retrieval";
import type { HybridRetrievalOptions } from "@/lib/airi/rag/types";

const embedding = jest.mocked(getQueryEmbeddingWithCache);
const options: HybridRetrievalOptions = {
  includeSnippets: false,
  includeKB: false,
  includeConversationSummaries: false,
  enableTranslation: false,
  enableReranking: false,
  enableVerification: false,
  skipLlmRetrievalPlanner: true,
  retrievalIntent: {
    query: "refund policy",
    language: "en",
    label: "specific_factual",
    confidence: "high",
    shouldUseBroadRetrieval: false,
    shouldUseOverviewVariants: false,
    queryVariants: [],
    reason: "fixture",
    source: "turn_understanding",
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  embedding.mockResolvedValue([1]);
});

it("scopes standalone orchestration to its workspace", async () => {
  let action: ReturnType<typeof getWorkspaceTextAiAction>;
  embedding.mockImplementation(async () => {
    action = getWorkspaceTextAiAction();
    return [1];
  });
  const result = await new RetrievalOrchestrator(
    "workspace-a",
    "refund policy",
    "en",
    options
  ).orchestrate();
  expect(result.kbArticles).toEqual([]);
  expect(action).toEqual({
    workspaceId: "workspace-a",
    actionId: expect.stringMatching(/^rag-retrieval:/),
  });
  expect(getWorkspaceTextAiAction()).toBeUndefined();
});

it("preserves the semantic reply action during orchestration", async () => {
  const action = {
    workspaceId: "workspace-a",
    actionId: "auto-reply:message-1",
  };
  let observed: ReturnType<typeof getWorkspaceTextAiAction>;
  embedding.mockImplementation(async () => {
    observed = getWorkspaceTextAiAction();
    return [1];
  });
  await withWorkspaceTextAiAction(action, () =>
    new RetrievalOrchestrator(
      "workspace-a",
      "refund policy",
      "en",
      options
    ).orchestrate()
  );
  expect(observed).toEqual(action);
});

it("attributes standalone snippet search to the requested workspace", async () => {
  await retrieveBestAnswer("workspace-a", "refund policy");
  expect(embedding).toHaveBeenCalledWith("refund policy", {
    workspaceId: "workspace-a",
    actionId: expect.stringMatching(/^snippet-retrieval:/),
  });
});
