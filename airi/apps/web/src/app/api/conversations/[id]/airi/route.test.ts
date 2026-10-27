const mockConnectDB = jest.fn();
const mockCreateClient = jest.fn();
const mockConversationFindById = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockGetWorkspaceScenariosDefault = jest.fn();
const mockApplyClearedHandoffStateToConversation = jest.fn();

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceScenariosDefault: (...args: unknown[]) =>
    mockGetWorkspaceScenariosDefault(...args),
}));
jest.mock("@/lib/airi/reply/runtime/handoff-state", () => ({
  applyClearedHandoffStateToConversation: (...args: unknown[]) =>
    mockApplyClearedHandoffStateToConversation(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

import { PATCH } from "./route";

const PLAN_GATE_BODY = {
  code: "company_conversation_limit_exceeded",
  error:
    "Company conversation limit exceeded. Upgrade to Pro to create more conversations, scenarios, or bulk campaigns.",
  planGate: { hiddenCount: 2, reason: "trial_expired" },
};

function buildConversation(fields: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(
    Object.entries({
      workspaceId: "workspace-1",
      status: "open",
      airi_bot_enabled: false,
      airi_scenarios_enabled: false,
      airi_coach_enabled: false,
      airi_handoff_active: true,
      ...fields,
    })
  );
  return {
    workspaceId: values.get("workspaceId"),
    get: jest.fn((key: string) => values.get(key)),
    set: jest.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function createSupabaseClient(membership: unknown = { user_id: "user-1" }) {
  const membershipQuery = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({ data: membership, error: null }),
  };
  membershipQuery.select.mockReturnValue(membershipQuery);
  membershipQuery.eq.mockReturnValue(membershipQuery);

  return {
    auth: {
      getUser: jest
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-1" } } }),
    },
    from: jest.fn().mockReturnValue(membershipQuery),
  };
}

function patchAiri(body: Record<string, unknown>) {
  return PATCH(
    new Request("http://localhost/api/conversations/conversation-1/airi", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "conversation-1" }) }
  );
}

describe("PATCH /api/conversations/[id]/airi plan visibility gate", () => {
  let supabase: ReturnType<typeof createSupabaseClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = createSupabaseClient();
    mockConnectDB.mockResolvedValue(undefined);
    mockCreateClient.mockResolvedValue(supabase);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockGetWorkspaceScenariosDefault.mockResolvedValue(true);
  });

  it("returns the plan gate response for a hidden conversation without toggling Airi", async () => {
    const conversation = buildConversation();
    mockConversationFindById.mockResolvedValue(conversation);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      Response.json(PLAN_GATE_BODY, { status: 402 })
    );

    const response = await patchAiri({
      bot_enabled: true,
      coach_enabled: true,
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual(PLAN_GATE_BODY);
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      supabase,
      "workspace-1",
      "conversation-1"
    );
    expect(conversation.set).not.toHaveBeenCalled();
    expect(conversation.save).not.toHaveBeenCalled();
    expect(mockApplyClearedHandoffStateToConversation).not.toHaveBeenCalled();
    expect(mockGetWorkspaceScenariosDefault).not.toHaveBeenCalled();
  });

  it("keeps the membership check ahead of the plan gate", async () => {
    mockConversationFindById.mockResolvedValue(buildConversation());
    mockCreateClient.mockResolvedValue(createSupabaseClient(null));

    const response = await patchAiri({ bot_enabled: true });

    expect(response.status).toBe(403);
    expect(mockGetHiddenConversationPlanGateResponse).not.toHaveBeenCalled();
  });

  it("toggles Airi on a plan-visible conversation unchanged", async () => {
    const conversation = buildConversation();
    mockConversationFindById.mockResolvedValue(conversation);

    const response = await patchAiri({ bot_enabled: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      supabase,
      "workspace-1",
      "conversation-1"
    );
    expect(conversation.set).toHaveBeenCalledWith("airi_bot_enabled", true);
    expect(mockApplyClearedHandoffStateToConversation).toHaveBeenCalledWith(
      conversation
    );
    expect(conversation.save).toHaveBeenCalledTimes(1);
  });
});
