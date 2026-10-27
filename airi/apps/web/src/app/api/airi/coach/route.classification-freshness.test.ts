const mockGetHeavyTextModel = jest.fn(
  (..._args: unknown[]) => "heavy-tier-model"
);
const mockAnalyzeConversationContext = jest.fn(
  (..._args: unknown[]) => undefined
);
const mockBuildHeuristicTips = jest.fn((..._args: unknown[]) => []);
const mockCheckProfanity = jest.fn((..._args: unknown[]) => ({
  maxSeverity: "none",
  categories: [],
}));
const mockDetectLanguage = jest.fn(async (..._args: unknown[]) => "en");
const mockBuildQueryFromConversation = jest.fn((..._args: unknown[]) => ({
  query: "pricing question",
  context: "conversation context",
}));
const mockCoachGenerate = jest.fn();
const mockRetrieveHybridContext = jest.fn();
const mockTrackAiriSession = jest.fn();
const mockBuildCacheKey = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockEnsureCompanyCoachCapacity = jest.fn();
const mockConnectDB = jest.fn();
const mockGetWorkspaceCompanyInfo = jest.fn();
const mockCreateClient = jest.fn();
const mockConversationFindById = jest.fn();
const mockCustomerFindOne = jest.fn();
const mockMessageFind = jest.fn();
const mockQuickReplyFind = jest.fn();
const mockSupabaseAdminFrom = jest.fn();

jest.mock("@/lib/ai", () => ({
  getHeavyTextModel: (...args: unknown[]) => mockGetHeavyTextModel(...args),
}));

jest.mock("@/lib/airi/coach/coach-utils", () => ({
  analyzeConversationContext: (...args: unknown[]) =>
    mockAnalyzeConversationContext(...args),
  buildHeuristicTips: (...args: unknown[]) => mockBuildHeuristicTips(...args),
  checkProfanity: (...args: unknown[]) => mockCheckProfanity(...args),
}));

jest.mock("@/lib/airi/language-detector-server", () => ({
  detectLanguage: (...args: unknown[]) => mockDetectLanguage(...args),
}));

jest.mock("@/lib/airi/conversation", () => ({
  buildQueryFromConversation: (...args: unknown[]) =>
    mockBuildQueryFromConversation(...args),
}));

jest.mock("@/lib/airi/engine", () => ({
  simpleCoachEngine: {
    generate: (...args: unknown[]) => mockCoachGenerate(...args),
  },
}));

jest.mock("@/lib/airi/rag/pipeline/hybrid-retrieval", () => ({
  retrieveHybridContext: (...args: unknown[]) =>
    mockRetrieveHybridContext(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackAiriSession: (...args: unknown[]) => mockTrackAiriSession(...args),
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (...args: unknown[]) => mockBuildCacheKey(...args),
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyCoachCapacity: (...args: unknown[]) =>
    mockEnsureCompanyCoachCapacity(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getWorkspaceCompanyInfo: (...args: unknown[]) =>
    mockGetWorkspaceCompanyInfo(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
  },
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockCustomerFindOne(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

jest.mock("@/models/quick-reply", () => ({
  QuickReply: {
    find: (...args: unknown[]) => mockQuickReplyFind(...args),
  },
}));

import { NextRequest } from "next/server";

import { POST } from "./route";
import {
  buildCurrentConversation,
  createMessageListQuery,
  createSelectLeanQuery,
  customerProfile,
  expectCanonicalSelect,
  expectClassificationOmittedWithManualContext,
  sourceMessage,
} from "@/lib/airi/coach/airi-coach-test-utils";
import { NON_CURRENT_REVISION_7_OVERRIDES } from "@/lib/classifier/classified-conversation-test-utils";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

function createCustomerQuery() {
  return createSelectLeanQuery(customerProfile);
}

function createQuickReplyQuery() {
  return createMessageListQuery([]);
}

function createMembershipClient() {
  const membershipQuery = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
  };
  membershipQuery.select.mockReturnValue(membershipQuery);
  membershipQuery.eq.mockReturnValue(membershipQuery);
  membershipQuery.maybeSingle.mockResolvedValue({
    data: { workspace_id: "workspace-1" },
    error: null,
  });

  return {
    auth: supabaseAuth(),
    from: jest.fn(() => membershipQuery),
  };
}

function createSupabaseAdminQuery() {
  const query = {
    insert: jest.fn(),
    select: jest.fn(),
    single: jest.fn(),
    update: jest.fn(),
    eq: jest.fn(),
  };
  query.insert.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.update.mockReturnValue(query);
  query.eq.mockResolvedValue({ data: null, error: null });
  query.single.mockResolvedValue({ data: { id: null }, error: null });
  return query;
}

function coachRequest() {
  return new NextRequest("http://localhost/api/airi/coach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: "conversation-1",
      text: "Please improve this draft",
    }),
  });
}

function generatedConversationWindow(callIndex = 0): string {
  return String(
    (
      mockCoachGenerate.mock.calls[callIndex]?.[1] as
        | { conversationWindow?: unknown }
        | undefined
    )?.conversationWindow || ""
  );
}

describe("POST /api/airi/coach classification freshness", () => {
  let conversation: ReturnType<typeof buildCurrentConversation>;
  let conversationSelect = "";
  let cacheStore: Map<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    conversation = buildCurrentConversation();
    conversationSelect = "";
    cacheStore = new Map();

    mockCreateClient.mockResolvedValue(createMembershipClient());
    mockConnectDB.mockResolvedValue(undefined);
    mockConversationFindById.mockImplementation(() =>
      createSelectLeanQuery(conversation, selection => {
        conversationSelect = selection;
      })
    );
    mockMessageFind.mockImplementation(() =>
      createMessageListQuery([sourceMessage])
    );
    mockCustomerFindOne.mockImplementation(createCustomerQuery);
    mockQuickReplyFind.mockImplementation(createQuickReplyQuery);
    mockEnsureCompanyCoachCapacity.mockResolvedValue({ allowed: true });
    mockGetWorkspaceCompanyInfo.mockResolvedValue(null);
    mockRetrieveHybridContext.mockResolvedValue({
      snippet: null,
      kbArticles: [],
    });
    mockSupabaseAdminFrom.mockImplementation(createSupabaseAdminQuery);
    mockCoachGenerate.mockResolvedValue({
      tips: [],
      suggestedEdit: "",
      inference: undefined,
    });
    mockBuildCacheKey.mockImplementation(
      (namespace: string, parts: Array<string | number>) =>
        `icecore:${namespace}:${parts.join(":")}`
    );
    mockCacheGet.mockImplementation(async (key: string) =>
      cacheStore.has(key) ? cacheStore.get(key) : null
    );
    mockCacheSet.mockImplementation(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    });
  });

  it("denies ownerless conversations instead of borrowing a user membership", async () => {
    conversation = buildCurrentConversation({ workspaceId: undefined });
    expect((await POST(coachRequest())).status).toBe(404);
    expect(mockCoachGenerate).not.toHaveBeenCalled();
  });

  it("checks access before reporting a foreign conversation's disabled coach", async () => {
    conversation = buildCurrentConversation({ airi_coach_enabled: false });
    const client = createMembershipClient();
    client.from().maybeSingle.mockResolvedValue({ data: null, error: null });
    mockCreateClient.mockResolvedValue(client);
    expect((await POST(coachRequest())).status).toBe(403);
    expect(mockCoachGenerate).not.toHaveBeenCalled();
  });

  it("grounds the Coach prompt with exact-current classification", async () => {
    const response = await POST(coachRequest());

    expect(response.status).toBe(200);
    expect(generatedConversationWindow()).toContain(
      "- Classification: category classifier-category"
    );
    expect(generatedConversationWindow()).toContain("classifier-action");
    expectCanonicalSelect(conversationSelect);
  });

  it("tracks the model that served Coach, and the heavy tier when generation fails", async () => {
    mockGetWorkspaceCompanyInfo.mockResolvedValue({ company_id: "company-1" });
    mockCoachGenerate.mockResolvedValueOnce({
      tips: [
        {
          title: "Share the price",
          suggestion: "State the monthly price first.",
          type: "clarity",
          confidence: 0.8,
        },
      ],
      suggestedEdit: "",
      inference: {
        model: "gemini-3.5-flash",
        provider: "vertex",
        latencyMs: 20,
        totalTokens: 10,
      },
    });

    expect((await POST(coachRequest())).status).toBe(200);
    expect(mockTrackAiriSession).toHaveBeenCalledTimes(1);
    expect(mockTrackAiriSession.mock.calls[0][5]).toBe("gemini-3.5-flash");

    cacheStore.clear();
    mockCoachGenerate.mockRejectedValueOnce(new Error("engine crashed"));
    expect((await POST(coachRequest())).status).toBe(200);
    expect(mockTrackAiriSession).toHaveBeenCalledTimes(2);
    expect(mockTrackAiriSession.mock.calls[1][5]).toBe("heavy-tier-model");
    expect(mockTrackAiriSession.mock.calls[1][8]).toBe(true);
  });

  it("returns a source requirement instead of heuristic success at the text allowance limit", async () => {
    mockCoachGenerate.mockRejectedValueOnce(
      Object.assign(new Error("Connect Google AI"), {
        code: "own_ai_source_required",
        resetAt: "2026-10-01T00:00:00.000Z",
      })
    );
    const response = await POST(coachRequest());
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "own_ai_source_required",
    });
    expect(mockCoachGenerate).toHaveBeenCalledTimes(1);
  });

  it.each(NON_CURRENT_REVISION_7_OVERRIDES)(
    "omits $name classification without hiding manual context",
    async row => {
      conversation = buildCurrentConversation(row.overrides);

      const response = await POST(coachRequest());

      expect(response.status).toBe(200);
      expectClassificationOmittedWithManualContext(
        generatedConversationWindow(),
        conversationSelect
      );
    }
  );

  it("keeps the full analysis identity outside the truncated draft hash", async () => {
    const firstAnalysisRevisionId =
      "analysis-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tail-one";
    const secondAnalysisRevisionId =
      "analysis-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tail-two";
    conversation = buildCurrentConversation({
      classification_meta: {
        source_revision: 7,
        provenance_kind: "v2",
        analysis_revision_id: firstAnalysisRevisionId,
      },
    });

    const firstResponse = await POST(coachRequest());
    expect(firstResponse.status).toBe(200);

    conversation = buildCurrentConversation({
      classification_meta: {
        source_revision: 7,
        provenance_kind: "v2",
        analysis_revision_id: secondAnalysisRevisionId,
      },
    });

    const secondResponse = await POST(coachRequest());
    expect(secondResponse.status).toBe(200);

    expect(mockCoachGenerate).toHaveBeenCalledTimes(2);
    const firstParts = mockBuildCacheKey.mock.calls[0]?.[1] as string[];
    const secondParts = mockBuildCacheKey.mock.calls[1]?.[1] as string[];
    const firstEncodedTuple = firstParts[3]?.replace(
      /^current-classification:/u,
      ""
    );
    const secondEncodedTuple = secondParts[3]?.replace(
      /^current-classification:/u,
      ""
    );
    expect(
      JSON.parse(
        Buffer.from(firstEncodedTuple || "", "base64url").toString("utf8")
      )
    ).toEqual([7, firstAnalysisRevisionId]);
    expect(
      JSON.parse(
        Buffer.from(secondEncodedTuple || "", "base64url").toString("utf8")
      )
    ).toEqual([7, secondAnalysisRevisionId]);
    expect(firstParts[3]).not.toBe(secondParts[3]);
  });

  it("does not replay a grounded cache entry after classification becomes stale", async () => {
    const currentResponse = await POST(coachRequest());
    expect(currentResponse.status).toBe(200);

    conversation = buildCurrentConversation({
      classification_state: {
        contractVersion: 2,
        status: "ready",
        requestedRevision: 8,
        appliedRevision: 7,
      },
    });

    const staleResponse = await POST(coachRequest());
    expect(staleResponse.status).toBe(200);

    expect(mockCoachGenerate).toHaveBeenCalledTimes(2);
    const firstParts = mockBuildCacheKey.mock.calls[0]?.[1] as string[];
    const secondParts = mockBuildCacheKey.mock.calls[1]?.[1] as string[];
    expect(firstParts).toHaveLength(4);
    expect(secondParts).toHaveLength(4);
    expect(firstParts[3]).toMatch(/^current-classification:/u);
    const encodedTuple = firstParts[3]?.replace(
      /^current-classification:/u,
      ""
    );
    expect(
      JSON.parse(Buffer.from(encodedTuple || "", "base64url").toString("utf8"))
    ).toEqual([7, "analysis-7"]);
    expect(secondParts[3]).toBe("no-current-classification");
    expect(firstParts[3]).not.toBe(secondParts[3]);
    expect(generatedConversationWindow(1)).not.toContain("classifier-category");
  });
});
