const mockCreateClient = jest.fn();
const mockCheckUserWorkspaceAccess = jest.fn();
const mockGetLimitSnapshot = jest.fn();
const mockGetTextAiAllowance = jest.fn();

jest.mock("@/lib/ai/workspace-ai-policy", () => ({
  getWorkspaceTextAiAllowance: (...args: unknown[]) =>
    mockGetTextAiAllowance(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { client: "supabase-admin" },
}));

jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockCheckUserWorkspaceAccess(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getCompanyConversationLimitSnapshot: (...args: unknown[]) =>
    mockGetLimitSnapshot(...args),
  toPublicLimitPayload: (snapshot: Record<string, unknown>) => ({
    subscriptionType: snapshot.subscriptionType,
    conversationLimit: snapshot.conversationLimit,
    conversationCount: snapshot.conversationCount,
    conversationsRemaining: snapshot.conversationsRemaining,
    conversationExhausted: snapshot.conversationExhausted,
    seatLimit: snapshot.seatLimit,
    seatCount: snapshot.seatCount,
    seatsRemaining: snapshot.seatsRemaining,
    seatExhausted: snapshot.seatExhausted,
    channelLimit: snapshot.channelLimit,
    channelCount: snapshot.channelCount,
    channelTypes: snapshot.channelTypes,
    channelsRemaining: snapshot.channelsRemaining,
    channelExhausted: snapshot.channelExhausted,
    airiAutoReplyLimit: snapshot.airiAutoReplyLimit,
    airiAutoReplyCount: snapshot.airiAutoReplyCount,
    airiAutoRepliesRemaining: snapshot.airiAutoRepliesRemaining,
    airiAutoReplyExhausted: snapshot.airiAutoReplyExhausted,
    scenarioLimit: snapshot.scenarioLimit,
    scenarioCount: snapshot.scenarioCount,
    scenariosRemaining: snapshot.scenariosRemaining,
    scenarioExhausted: snapshot.scenarioExhausted,
    bulkRecipientLimit: snapshot.bulkRecipientLimit,
    bulkRecipientCount: snapshot.bulkRecipientCount,
    bulkRecipientsRemaining: snapshot.bulkRecipientsRemaining,
    bulkRecipientExhausted: snapshot.bulkRecipientExhausted,
    classificationLimit: snapshot.classificationLimit,
    classificationCount: snapshot.classificationCount,
    classificationsRemaining: snapshot.classificationsRemaining,
    classificationExhausted: snapshot.classificationExhausted,
    coachLimit: snapshot.coachLimit,
    coachCount: snapshot.coachCount,
    coachSessionsRemaining: snapshot.coachSessionsRemaining,
    coachExhausted: snapshot.coachExhausted,
    studioChatLimit: snapshot.studioChatLimit,
    studioChatCount: snapshot.studioChatCount,
    studioChatsRemaining: snapshot.studioChatsRemaining,
    studioChatExhausted: snapshot.studioChatExhausted,
    exhausted: snapshot.exhausted,
    anyLimitExhausted: snapshot.anyLimitExhausted,
    lockedCapabilities: snapshot.lockedCapabilities,
  }),
}));

import { GET } from "./route";

describe("GET /api/workspaces/[workspaceId]/limits", () => {
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
    mockCheckUserWorkspaceAccess.mockResolvedValue(true);
    mockGetLimitSnapshot.mockResolvedValue({
      companyId: "company-1",
      workspaceIds: ["workspace-1"],
      subscriptionType: "free",
      conversationLimit: 500,
      conversationCount: 500,
      conversationsRemaining: 0,
      conversationExhausted: true,
      seatLimit: 1,
      seatCount: 1,
      seatsRemaining: 0,
      seatExhausted: true,
      channelLimit: 2,
      channelCount: 2,
      channelTypes: ["telegram", "whatsapp"],
      channelsRemaining: 0,
      channelExhausted: true,
      airiAutoReplyLimit: 100,
      airiAutoReplyCount: 25,
      airiAutoRepliesRemaining: 75,
      airiAutoReplyExhausted: false,
      classificationLimit: 500,
      classificationCount: 244,
      classificationsRemaining: 256,
      classificationExhausted: false,
      coachLimit: 500,
      coachCount: 0,
      coachSessionsRemaining: 500,
      coachExhausted: false,
      studioChatLimit: 500,
      studioChatCount: 12,
      studioChatsRemaining: 488,
      studioChatExhausted: false,
      scenarioLimit: 5,
      scenarioCount: 5,
      scenariosRemaining: 0,
      scenarioExhausted: true,
      bulkRecipientLimit: 500,
      bulkRecipientCount: 500,
      bulkRecipientsRemaining: 0,
      bulkRecipientExhausted: true,
      exhausted: true,
      anyLimitExhausted: true,
      lockedCapabilities: [
        "new_conversations",
        "scenario_creation",
        "bulk_campaigns",
        "team_invites",
        "channel_connections",
      ],
    });
  });

  it("returns the current workspace limit snapshot for members", async () => {
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockCheckUserWorkspaceAccess).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "workspace-1"
    );
    // Live counts, so the WhatsApp panel's pre-check matches the connect gate.
    expect(mockGetLimitSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ client: "supabase-admin" }),
      "workspace-1",
      { includeBulkRecipientUsage: true, liveCounts: true }
    );
    expect(payload).toEqual({
      subscriptionType: "free",
      conversationLimit: 500,
      conversationCount: 500,
      conversationsRemaining: 0,
      conversationExhausted: true,
      seatLimit: 1,
      seatCount: 1,
      seatsRemaining: 0,
      seatExhausted: true,
      channelLimit: 2,
      channelCount: 2,
      channelTypes: ["telegram", "whatsapp"],
      channelsRemaining: 0,
      channelExhausted: true,
      airiAutoReplyLimit: 100,
      airiAutoReplyCount: 25,
      airiAutoRepliesRemaining: 75,
      airiAutoReplyExhausted: false,
      classificationLimit: 500,
      classificationCount: 244,
      classificationsRemaining: 256,
      classificationExhausted: false,
      coachLimit: 500,
      coachCount: 0,
      coachSessionsRemaining: 500,
      coachExhausted: false,
      studioChatLimit: 500,
      studioChatCount: 12,
      studioChatsRemaining: 488,
      studioChatExhausted: false,
      scenarioLimit: 5,
      scenarioCount: 5,
      scenariosRemaining: 0,
      scenarioExhausted: true,
      bulkRecipientLimit: 500,
      bulkRecipientCount: 500,
      bulkRecipientsRemaining: 0,
      bulkRecipientExhausted: true,
      exhausted: true,
      anyLimitExhausted: true,
      lockedCapabilities: [
        "new_conversations",
        "scenario_creation",
        "bulk_campaigns",
        "team_invites",
        "channel_connections",
      ],
    });
  });

  it("rejects non-members", async () => {
    mockCheckUserWorkspaceAccess.mockResolvedValue(false);

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(403);
    expect(mockGetLimitSnapshot).not.toHaveBeenCalled();
    expect(mockGetTextAiAllowance).not.toHaveBeenCalled();
  });

  it("adds the safe shared monthly allowance for Pro", async () => {
    mockGetLimitSnapshot.mockResolvedValue({
      subscriptionType: "pro",
      conversationLimit: null,
    });
    const allowance = {
      workspaceId: "workspace-1",
      companyId: "company-1",
      plan: "pro",
      includedActions: 500,
      usedActions: 499,
      remainingActions: 1,
      periodStart: "2026-09-01T00:00:00.000Z",
      resetAt: null, allowancePeriod: "lifetime", spendLimitReached: false,
      hasCustomerSource: false,
    };
    mockGetTextAiAllowance.mockResolvedValue(allowance);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      textAiAllowance: { status: "available", ...allowance },
    });
    expect(mockGetTextAiAllowance).toHaveBeenCalledWith("workspace-1");
  });

  it("marks monthly usage unavailable without hiding other plan limits or exposing errors", async () => {
    mockGetLimitSnapshot.mockResolvedValue({
      subscriptionType: "pro",
      seatLimit: 1,
    });
    mockGetTextAiAllowance.mockRejectedValue(
      new Error("private database error")
    );
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subscriptionType: "pro",
      seatLimit: 1,
      textAiAllowance: { status: "unavailable" },
    });
  });

  it("preserves Free and Enterprise policy without reading a Pro allowance", async () => {
    for (const subscriptionType of ["free", "enterprise"]) {
      mockGetLimitSnapshot.mockResolvedValue({ subscriptionType });
      const response = await GET(new Request("http://localhost"), {
        params: Promise.resolve({ workspaceId: "workspace-1" }),
      });
      expect(await response.json()).toEqual({ subscriptionType });
    }
    expect(mockGetTextAiAllowance).not.toHaveBeenCalled();
  });

  it("does not read billing state before authentication", async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    expect(response.status).toBe(401);
    expect(mockGetTextAiAllowance).not.toHaveBeenCalled();
  });
});
