const mockConnectDB = jest.fn();
const mockGetUser = jest.fn();
const mockCheckUserWorkspaceAccess = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageExists = jest.fn();
const mockSendWidgetCsatRequest = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: () => mockGetUser() } }),
}));
jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockCheckUserWorkspaceAccess(...args),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));
jest.mock("@/lib/widget-csat", () => ({
  sendWidgetCsatRequest: (...args: unknown[]) =>
    mockSendWidgetCsatRequest(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { exists: (...args: unknown[]) => mockMessageExists(...args) },
}));

import { POST } from "./route";

function sendCsat() {
  return POST(
    new Request(
      "http://localhost/api/conversations/conversation-1/send-widget-csat",
      { method: "POST" }
    ),
    { params: Promise.resolve({ id: "conversation-1" }) }
  );
}

describe("POST /api/conversations/[id]/send-widget-csat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    mockConnectDB.mockResolvedValue(undefined);
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockConversationFindById.mockReturnValue({
      select: () => ({ lean: async () => ({ workspaceId: "workspace-1" }) }),
    });
    mockCheckUserWorkspaceAccess.mockResolvedValue(true);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockMessageExists.mockResolvedValue(null);
    mockSendWidgetCsatRequest.mockResolvedValue({
      ok: true,
      messageId: "message-1",
    });
  });

  it("sends the CSAT request for a workspace member", async () => {
    const response = await sendCsat();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockSendWidgetCsatRequest).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      ensureAwaiting: true,
    });
  });

  it("checks membership before any CSAT state is read", async () => {
    mockCheckUserWorkspaceAccess.mockResolvedValue(false);

    const response = await sendCsat();

    expect(response.status).toBe(403);
    expect(mockMessageExists).not.toHaveBeenCalled();
    expect(mockSendWidgetCsatRequest).not.toHaveBeenCalled();
  });

  it("returns the plan gate response for a hidden conversation without sending", async () => {
    const body = {
      code: "company_conversation_limit_exceeded",
      planGate: { hiddenCount: 2, reason: "trial_expired" },
    };
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      Response.json(body, { status: 402 })
    );

    const response = await sendCsat();

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual(body);
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      "conversation-1"
    );
    expect(mockMessageExists).not.toHaveBeenCalled();
    expect(mockSendWidgetCsatRequest).not.toHaveBeenCalled();
  });

  it("refuses a repeat send without touching the earlier request", async () => {
    mockMessageExists.mockResolvedValue({ _id: "csat-message-1" });

    const response = await sendCsat();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "CSAT request already sent for this conversation",
    });
    expect(mockSendWidgetCsatRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "not_web_widget",
      "This action is only available for web_widget conversations",
    ],
    ["already_rated", "CSAT score already submitted for this conversation"],
  ])("turns a %s skip into a 400", async (reason, error) => {
    mockSendWidgetCsatRequest.mockResolvedValue({
      ok: true,
      skipped: true,
      reason,
    });

    const response = await sendCsat();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
  });
});
