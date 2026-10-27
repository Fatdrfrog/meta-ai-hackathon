const mockInvalidateConversationCache = jest.fn();
const mockInvalidateRequestsForWorkspace = jest.fn();
const mockConnectDB = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockIsSupabaseRouteAuthError = jest.fn();
const mockConversationFindById = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockTriggerRealtimeEvent = jest.fn();

jest.mock("@/lib/cache", () => ({
  invalidateConversationCache: (...args: unknown[]) =>
    mockInvalidateConversationCache(...args),
  invalidateRequestsForWorkspace: (...args: unknown[]) =>
    mockInvalidateRequestsForWorkspace(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  triggerRealtimeEvent: (...args: unknown[]) =>
    mockTriggerRealtimeEvent(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (...args: unknown[]) =>
    mockIsSupabaseRouteAuthError(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

import { PATCH } from "./route";

const CONVERSATION_ID = "507f1f77bcf86cd799439011";

function makeSupabaseAccess(access: unknown = { workspace_id: "workspace-1" }) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            maybeSingle: jest.fn(async () => ({ data: access })),
          })),
        })),
      })),
    })),
  };
}

function mockConversationLookup(conversation: unknown) {
  mockConversationFindById.mockReturnValue({
    select: jest.fn(() => ({
      lean: jest.fn(async () => conversation),
    })),
  });
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("PATCH /api/conversations/[id]/quick-note", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: makeSupabaseAccess(),
      user: { id: "manager-1" },
      authType: "cookie",
    });
    mockIsSupabaseRouteAuthError.mockReturnValue(false);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockConversationLookup({
      _id: CONVERSATION_ID,
      workspaceId: "workspace-1",
    });
    mockConversationUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockInvalidateConversationCache.mockResolvedValue(undefined);
    mockInvalidateRequestsForWorkspace.mockResolvedValue(undefined);
    mockTriggerRealtimeEvent.mockResolvedValue(undefined);
  });

  it("rejects unauthorized requests", async () => {
    mockIsSupabaseRouteAuthError.mockReturnValue(true);
    mockGetSupabaseRouteAuth.mockResolvedValue({ response: new Response() });

    const response = await PATCH(
      new Request("http://localhost/quick-note", {
        method: "PATCH",
        body: JSON.stringify({ note: "VIP customer" }),
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) }
    );

    expect(response.status).toBe(401);
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("rejects invalid ids, missing conversations, forbidden users, and plan-gated conversations", async () => {
    const invalidIdResponse = await PATCH(
      new Request("http://localhost/quick-note", {
        method: "PATCH",
        body: JSON.stringify({ note: "Note" }),
      }),
      { params: Promise.resolve({ id: "bad-id" }) }
    );
    expect(invalidIdResponse.status).toBe(400);

    mockConversationLookup(null);
    const missingResponse = await PATCH(
      new Request("http://localhost/quick-note", {
        method: "PATCH",
        body: JSON.stringify({ note: "Note" }),
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) }
    );
    expect(missingResponse.status).toBe(404);

    mockConversationLookup({
      _id: CONVERSATION_ID,
      workspaceId: "workspace-1",
    });
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: makeSupabaseAccess(null),
      user: { id: "manager-1" },
      authType: "cookie",
    });
    const forbiddenResponse = await PATCH(
      new Request("http://localhost/quick-note", {
        method: "PATCH",
        body: JSON.stringify({ note: "Note" }),
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) }
    );
    expect(forbiddenResponse.status).toBe(403);

    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: makeSupabaseAccess(),
      user: { id: "manager-1" },
      authType: "cookie",
    });
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      Response.json({ error: "Plan gated" }, { status: 402 })
    );
    const planResponse = await PATCH(
      new Request("http://localhost/quick-note", {
        method: "PATCH",
        body: JSON.stringify({ note: "Note" }),
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) }
    );
    expect(planResponse.status).toBe(402);
  });

  it("saves a trimmed and truncated note, invalidates caches, and publishes realtime", async () => {
    const longNote = `  ${"a".repeat(1100)}  `;

    const response = await PATCH(
      new Request("http://localhost/quick-note", {
        method: "PATCH",
        body: JSON.stringify({ note: longNote }),
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) }
    );

    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload).toEqual({ note: "a".repeat(1000) });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: CONVERSATION_ID },
      {
        $set: expect.objectContaining({
          quick_note: "a".repeat(1000),
          quick_note_updated_by: "manager-1",
        }),
      }
    );
    expect(mockInvalidateConversationCache).toHaveBeenCalledWith(
      "workspace-1",
      CONVERSATION_ID
    );
    expect(mockInvalidateRequestsForWorkspace).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(mockTriggerRealtimeEvent).toHaveBeenCalledWith(
      `private-conversation-${CONVERSATION_ID}`,
      "conversation.note.changed",
      expect.objectContaining({
        workspaceId: "workspace-1",
        conversationId: CONVERSATION_ID,
        note: "a".repeat(1000),
        updatedBy: "manager-1",
      })
    );
  });

  it("clears empty notes", async () => {
    const response = await PATCH(
      new Request("http://localhost/quick-note", {
        method: "PATCH",
        body: JSON.stringify({ note: "   " }),
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) }
    );

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({ note: null });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: CONVERSATION_ID },
      {
        $set: expect.objectContaining({
          quick_note: null,
          quick_note_updated_by: "manager-1",
        }),
      }
    );
  });
});
