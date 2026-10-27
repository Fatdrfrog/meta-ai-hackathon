export {};

const mockCreateConversationToken = jest.fn();
const mockGetWorkspaceBotRuntimeSettings = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockResolveAccess = jest.fn();
const mockCheckRateLimit = jest.fn();

jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  resolveWorkspaceElevenLabsGenerationAccess: (...args: unknown[]) =>
    mockResolveAccess(...args),
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => ({}),
  checkCriticalRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock("@/lib/ai/elevenlabs", () => ({
  createConversationToken: (...args: unknown[]) =>
    mockCreateConversationToken(...args),
  ElevenLabsError: class ElevenLabsError extends Error {},
}));

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotRuntimeSettings: (...args: unknown[]) =>
    mockGetWorkspaceBotRuntimeSettings(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (value: unknown) =>
    Boolean(
      value &&
        typeof value === "object" &&
        "status" in value &&
        "error" in value
    ),
}));

function createTokenRequest(body: unknown) {
  return new Request("https://example.com/api/elevenlabs/conversation-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("/api/elevenlabs/conversation-token", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAccess.mockResolvedValue({
      credentialSource: "workspace_source",
      apiKey: "customer-key",
    });
    mockCheckRateLimit.mockResolvedValue({ status: "granted" });
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: { from: jest.fn() },
      user: { id: "user-1" },
      authType: "cookie",
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceBotRuntimeSettings.mockResolvedValue({
      elevenlabsAgentId: "agent_workspace",
    });
    mockCreateConversationToken.mockResolvedValue({
      token: "conversation-token",
      agentId: "agent_workspace",
      expiresAt: "2026-06-12T00:10:00.000Z",
    });
  });

  it("uses the workspace Airi agent id when mobile sends only workspaceId", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      createTokenRequest({ workspaceId: "workspace-1" })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      token: "conversation-token",
      agentId: "agent_workspace",
      expiresAt: "2026-06-12T00:10:00.000Z",
    });
    expect(mockGetWorkspaceBotRuntimeSettings).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(mockCreateConversationToken).toHaveBeenCalledWith(
      "agent_workspace",
      "customer-key"
    );
  });

  it("rejects an agent that does not belong to the workspace configuration", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      createTokenRequest({
        workspaceId: "workspace-1",
        agentId: "agent_explicit",
      })
    );

    expect(response.status).toBe(403);
    expect(mockCreateConversationToken).not.toHaveBeenCalled();
  });

  it("requires a customer ElevenLabs source even when platform credentials exist", async () => {
    mockResolveAccess.mockResolvedValue({
      credentialSource: "platform",
      apiKey: "platform-key",
    });
    const { POST } = await import("./route");
    const response = await POST(
      createTokenRequest({ workspaceId: "workspace-1" })
    );
    expect(response.status).toBe(402);
    expect(mockCreateConversationToken).not.toHaveBeenCalled();
  });

  it.each([
    ["limited", 429],
    ["unavailable", 503],
  ])("blocks token issuance when admission is %s", async (status, expected) => {
    mockCheckRateLimit.mockResolvedValue({ status });
    const { POST } = await import("./route");
    const response = await POST(
      createTokenRequest({ workspaceId: "workspace-1" })
    );
    expect(response.status).toBe(expected);
    expect(mockCreateConversationToken).not.toHaveBeenCalled();
  });

  it("returns 400 when the workspace has no configured Airi voice agent", async () => {
    mockGetWorkspaceBotRuntimeSettings.mockResolvedValue({
      elevenlabsAgentId: null,
    });
    const { POST } = await import("./route");

    const response = await POST(
      createTokenRequest({ workspaceId: "workspace-1" })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "ElevenLabs agent is not configured for this workspace",
    });
    expect(mockCreateConversationToken).not.toHaveBeenCalled();
  });

  it("does not resolve agent settings when the user lacks workspace access", async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue(false);
    const { POST } = await import("./route");

    const response = await POST(
      createTokenRequest({ workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(403);
    expect(mockGetWorkspaceBotRuntimeSettings).not.toHaveBeenCalled();
    expect(mockCreateConversationToken).not.toHaveBeenCalled();
  });

  it.each([
    { workspaceId: 123 },
    { workspaceId: {} },
    { workspaceId: "workspace-1", agentId: 123 },
    { workspaceId: "workspace-1", agentId: {} },
  ])("rejects malformed token request values with 400: %j", async body => {
    const { POST } = await import("./route");
    const response = await POST(createTokenRequest(body));

    expect(response.status).toBe(400);
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockCreateConversationToken).not.toHaveBeenCalled();
  });

  it("does not issue a token to an unauthenticated caller", async () => {
    mockGetSupabaseRouteAuth.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });
    const { POST } = await import("./route");
    const response = await POST(
      createTokenRequest({ workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(401);
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockCreateConversationToken).not.toHaveBeenCalled();
  });
});
