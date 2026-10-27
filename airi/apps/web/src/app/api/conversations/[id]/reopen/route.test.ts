const mockConnectDB = jest.fn();
const mockCreateClient = jest.fn();
const mockConversationFindById = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockTriggerConversationReopened = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));
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
jest.mock("@/lib/webhook-events", () => ({
  triggerConversationReopened: (...args: unknown[]) =>
    mockTriggerConversationReopened(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "./route";

const PLAN_GATE_BODY = {
  code: "company_conversation_limit_exceeded",
  error:
    "Company conversation limit exceeded. Upgrade to Pro to create more conversations, scenarios, or bulk campaigns.",
  planGate: { hiddenCount: 2, reason: "trial_expired" },
};

function buildConversation(fields: Record<string, unknown> = {}) {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    status: "closed",
    channel: "whatsapp",
    user: "77001112233",
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
    handled_by_agent_id: null as string | null,
    save: jest.fn().mockResolvedValue(undefined),
    ...fields,
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

function reopen() {
  return POST(
    new NextRequest(
      "http://localhost/api/conversations/conversation-1/reopen",
      { method: "POST" }
    ),
    { params: Promise.resolve({ id: "conversation-1" }) }
  );
}

describe("POST /api/conversations/[id]/reopen", () => {
  let supabase: ReturnType<typeof createSupabaseClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = createSupabaseClient();
    mockConnectDB.mockResolvedValue(undefined);
    mockCreateClient.mockResolvedValue(supabase);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockTriggerConversationReopened.mockResolvedValue(undefined);
  });

  it("keeps the membership check ahead of the plan gate", async () => {
    mockConversationFindById.mockResolvedValue(buildConversation());
    mockCreateClient.mockResolvedValue(createSupabaseClient(null));

    const response = await reopen();

    expect(response.status).toBe(403);
    expect(mockGetHiddenConversationPlanGateResponse).not.toHaveBeenCalled();
    expect(mockTriggerConversationReopened).not.toHaveBeenCalled();
  });

  it("returns the plan gate response for a hidden conversation without reopening it", async () => {
    const conversation = buildConversation();
    mockConversationFindById.mockResolvedValue(conversation);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      Response.json(PLAN_GATE_BODY, { status: 402 })
    );

    const response = await reopen();

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual(PLAN_GATE_BODY);
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      supabase,
      "workspace-1",
      "conversation-1"
    );
    expect(conversation.status).toBe("closed");
    expect(conversation.save).not.toHaveBeenCalled();
    expect(mockTriggerConversationReopened).not.toHaveBeenCalled();
  });

  it("rejects a conversation that is not closed", async () => {
    const conversation = buildConversation({ status: "in_progress" });
    mockConversationFindById.mockResolvedValue(conversation);

    const response = await reopen();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Conversation is not closed",
      currentStatus: "in_progress",
    });
    expect(conversation.save).not.toHaveBeenCalled();
    expect(mockTriggerConversationReopened).not.toHaveBeenCalled();
  });

  it("reopens a plan-visible closed conversation and sends conversation.reopened", async () => {
    const conversation = buildConversation();
    mockConversationFindById.mockResolvedValue(conversation);

    const response = await reopen();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(conversation.status).toBe("in_progress");
    expect(conversation.handled_by_agent_id).toBe("user-1");
    expect(conversation.save).toHaveBeenCalledTimes(1);
    expect(mockTriggerConversationReopened).toHaveBeenCalledWith(
      "workspace-1",
      {
        conversation_id: "conversation-1",
        status: "in_progress",
        previous_status: "closed",
        channel: "whatsapp",
        customer_phone: "77001112233",
        created_at: "2026-10-01T09:00:00.000Z",
        updated_at: expect.any(String),
      }
    );
  });

  it("still answers ok when the webhook delivery fails", async () => {
    const failure = new Error("delivery failed");
    mockConversationFindById.mockResolvedValue(buildConversation());
    mockTriggerConversationReopened.mockRejectedValue(failure);

    const response = await reopen();
    await new Promise(resolve => setImmediate(resolve));

    expect(response.status).toBe(200);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "conversation.reopened_webhook_failed",
      failure,
      { workspaceId: "workspace-1", conversationId: "conversation-1" }
    );
  });
});
