export {};

const mockCreateScribeRealtimeToken = jest.fn();
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
  createScribeRealtimeToken: (...args: unknown[]) =>
    mockCreateScribeRealtimeToken(...args),
  ElevenLabsError: class ElevenLabsError extends Error {},
}));
jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));
jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (value: unknown) =>
    Boolean(value && typeof value === "object" && "error" in value),
}));

function createTokenRequest(body: unknown) {
  return new Request("https://example.com/api/elevenlabs/scribe-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("/api/elevenlabs/scribe-token", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAccess.mockResolvedValue({
      credentialSource: "workspace_source",
      apiKey: "customer-key",
    });
    mockCheckRateLimit.mockResolvedValue({ status: "granted" });
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: {},
      user: { id: "user-1" },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockCreateScribeRealtimeToken.mockResolvedValue({ token: "scribe-token" });
  });

  it("issues a token after checking the caller's workspace access", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      createTokenRequest({ workspaceId: " workspace-1 " })
    );

    expect(response.status).toBe(200);
    expect(mockCreateScribeRealtimeToken).toHaveBeenCalledWith("customer-key");
    expect(await response.json()).toEqual({
      success: true,
      token: "scribe-token",
      expiresAt: null,
    });
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      {},
      "user-1",
      "workspace-1"
    );
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
    expect(mockCreateScribeRealtimeToken).not.toHaveBeenCalled();
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
    expect(mockCreateScribeRealtimeToken).not.toHaveBeenCalled();
  });

  it.each([{ workspaceId: 123 }, { workspaceId: {} }])(
    "rejects malformed workspace values with 400: %j",
    async body => {
      const { POST } = await import("./route");
      const response = await POST(createTokenRequest(body));

      expect(response.status).toBe(400);
      expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
      expect(mockCreateScribeRealtimeToken).not.toHaveBeenCalled();
    }
  );

  it("does not issue tokens without workspace access", async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue(false);
    const { POST } = await import("./route");
    const response = await POST(
      createTokenRequest({ workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(403);
    expect(mockCreateScribeRealtimeToken).not.toHaveBeenCalled();
  });

  it("does not issue tokens to unauthenticated callers", async () => {
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
    expect(mockCreateScribeRealtimeToken).not.toHaveBeenCalled();
  });
});
