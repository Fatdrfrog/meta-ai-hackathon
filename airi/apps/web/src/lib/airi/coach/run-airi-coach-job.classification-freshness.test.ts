const mockGetHeavyTextModel = jest.fn(
  (..._args: unknown[]) => "claude-sonnet-5-5"
);
const mockComputeCoachTags = jest.fn((..._args: unknown[]) => []);
const mockCoachGenerate = jest.fn();
const mockEmitWorkspaceUsageDeltaBestEffort = jest.fn();
const mockEnsureCompanyCoachCapacity = jest.fn();
const mockConnectDB = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockSupabaseAdminFrom = jest.fn();
const mockGetWorkspaceCompanyInfo = jest.fn();
const mockCoachingTipFindOne = jest.fn();
const mockCoachingTipCreate = jest.fn();
const mockConversationFindOne = jest.fn();
const mockCustomerFindOne = jest.fn();
const mockMessageFindById = jest.fn();
const mockMessageFind = jest.fn();

jest.mock("@/lib/ai", () => ({
  getHeavyTextModel: (...args: unknown[]) => mockGetHeavyTextModel(...args),
}));

jest.mock("@/lib/airi/coach/coach-utils", () => ({
  computeCoachTags: (...args: unknown[]) => mockComputeCoachTags(...args),
}));

jest.mock("@/lib/airi/engine", () => ({
  simpleCoachEngine: {
    generate: (...args: unknown[]) => mockCoachGenerate(...args),
  },
}));

jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: (...args: unknown[]) =>
    mockEmitWorkspaceUsageDeltaBestEffort(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyCoachCapacity: (...args: unknown[]) =>
    mockEnsureCompanyCoachCapacity(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
  },
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getWorkspaceCompanyInfo: (...args: unknown[]) =>
    mockGetWorkspaceCompanyInfo(...args),
}));

jest.mock("@/models/coaching-tip", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockCoachingTipFindOne(...args),
    create: (...args: unknown[]) => mockCoachingTipCreate(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
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
    findById: (...args: unknown[]) => mockMessageFindById(...args),
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

import { runAiriCoachJob } from "./run-airi-coach-job";
import {
  buildCurrentConversation,
  createMessageListQuery,
  createSelectLeanQuery,
  customerProfile,
  expectCanonicalSelect,
  expectClassificationOmittedWithManualContext,
  sourceMessage,
} from "./airi-coach-test-utils";
import { NON_CURRENT_REVISION_7_OVERRIDES } from "@/lib/classifier/classified-conversation-test-utils";
import { hasWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";

function createSupabaseAdminQuery() {
  const query = {
    insert: jest.fn(),
    select: jest.fn(),
    maybeSingle: jest.fn(),
  };
  query.insert.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { id: null }, error: null });
  return query;
}

function generatedConversationWindow(): string {
  return String(
    (
      mockCoachGenerate.mock.calls[0]?.[1] as
        | { conversationWindow?: unknown }
        | undefined
    )?.conversationWindow || ""
  );
}

describe("runAiriCoachJob classification freshness", () => {
  let conversation: ReturnType<typeof buildCurrentConversation>;
  let conversationSelect = "";

  beforeEach(() => {
    jest.clearAllMocks();
    conversation = buildCurrentConversation();
    conversationSelect = "";

    mockConnectDB.mockResolvedValue(undefined);
    mockCoachingTipFindOne.mockImplementation(() =>
      createSelectLeanQuery(null)
    );
    mockMessageFindById.mockImplementation(() =>
      createSelectLeanQuery(sourceMessage)
    );
    mockConversationFindOne.mockImplementation(() =>
      createSelectLeanQuery(conversation, selection => {
        conversationSelect = selection;
      })
    );
    mockMessageFind.mockImplementation(() =>
      createMessageListQuery([sourceMessage])
    );
    mockCustomerFindOne.mockImplementation(() =>
      createSelectLeanQuery(customerProfile)
    );
    mockEnsureCompanyCoachCapacity.mockResolvedValue({ allowed: true });
    mockGetWorkspaceCompanyInfo.mockResolvedValue(null);
    mockCoachGenerate.mockResolvedValue({ tips: [] });
    mockSupabaseAdminFrom.mockImplementation(createSupabaseAdminQuery);
    mockRealtimeTrigger.mockResolvedValue(undefined);
  });

  async function runJob() {
    return runAiriCoachJob({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      agentId: "agent-1",
    });
  }

  it("grounds the background Coach prompt with exact-current classification", async () => {
    mockCoachGenerate.mockImplementationOnce(async () => {
      expect(hasWorkspaceTextAiAction()).toBe(true);
      return { tips: [] };
    });
    const result = await runJob();

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        skipped: true,
        reason: "no_tips_generated",
      })
    );
    expect(generatedConversationWindow()).toContain(
      "- Classification: category classifier-category"
    );
    expect(generatedConversationWindow()).toContain("classifier-action");
    expectCanonicalSelect(conversationSelect);
    expect(hasWorkspaceTextAiAction()).toBe(false);
  });

  it.each(NON_CURRENT_REVISION_7_OVERRIDES)(
    "omits $name classification without hiding manual context",
    async row => {
      conversation = buildCurrentConversation(row.overrides);

      const result = await runJob();

      expect(result.ok).toBe(true);
      expectClassificationOmittedWithManualContext(
        generatedConversationWindow(),
        conversationSelect
      );
    }
  );
});

describe("runAiriCoachJob model version", () => {
  const tips = [
    {
      title: "Share the price",
      suggestion: "State the monthly price first.",
      type: "clarity",
      confidence: 0.8,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCoachingTipFindOne.mockImplementation(() =>
      createSelectLeanQuery(null)
    );
    mockMessageFindById.mockImplementation(() =>
      createSelectLeanQuery(sourceMessage)
    );
    mockConversationFindOne.mockImplementation(() =>
      createSelectLeanQuery(buildCurrentConversation())
    );
    mockMessageFind.mockImplementation(() =>
      createMessageListQuery([sourceMessage])
    );
    mockCustomerFindOne.mockImplementation(() =>
      createSelectLeanQuery(customerProfile)
    );
    mockEnsureCompanyCoachCapacity.mockResolvedValue({ allowed: true });
    mockGetWorkspaceCompanyInfo.mockResolvedValue(null);
    mockSupabaseAdminFrom.mockImplementation(createSupabaseAdminQuery);
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockCoachingTipCreate.mockImplementation(async (doc: object) => ({
      _id: "tip-1",
      createdAt: new Date("2026-08-10T12:00:01.000Z"),
      ...doc,
    }));
  });

  it.each([
    {
      name: "Claude",
      inference: {
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        latencyMs: 30,
      },
      expected: "anthropic:claude-sonnet-5-5",
    },
    {
      name: "the Vertex outage fallback",
      inference: {
        model: "gemini-3.5-flash",
        provider: "vertex",
        latencyMs: 30,
      },
      expected: "vertex:gemini-3.5-flash",
    },
    {
      name: "a customer Google key",
      inference: {
        model: "gemini-3.5-flash",
        provider: "google",
        latencyMs: 30,
      },
      expected: "google:gemini-3.5-flash",
    },
    {
      name: "the heuristic fallback (legacy prefix)",
      inference: { model: "heuristic-fallback", latencyMs: 0 },
      expected: "vertex:heuristic-fallback",
    },
    {
      name: "a missing inference (configured heavy tier)",
      inference: undefined,
      expected: "anthropic:claude-sonnet-5-5",
    },
  ])("records the provider that served $name", async row => {
    mockCoachGenerate.mockResolvedValue({
      tips,
      suggestedEdit: "",
      inference: row.inference,
    });

    const result = await runAiriCoachJob({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      agentId: "agent-1",
    });

    expect(result).toMatchObject({ ok: true, tipCount: 1 });
    expect(mockCoachingTipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVersion: row.expected,
        inference: row.inference,
      })
    );
  });
});
