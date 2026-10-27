const mockRequireAppAdmin = jest.fn();
const mockRegisterState = jest.fn();
const mockResolveConfig = jest.fn();

jest.mock("@/lib/auth/app-admin", () => ({
  requireAppAdmin: () => mockRequireAppAdmin(),
}));

jest.mock("@/lib/tiktok-discovery/oauth-config", () => ({
  resolveTikTokOAuthConfig: () => mockResolveConfig(),
  buildTikTokAuthorizationUrl: ({
    appId,
    redirectUri,
    state,
  }: Record<string, string>) =>
    new URL(
      `https://ads.tiktok.com/marketing_api/auth?${new URLSearchParams({
        app_id: appId,
        redirect_uri: redirectUri,
        state,
      })}`
    ),
}));

jest.mock("@/lib/tiktok-discovery/oauth-state", () => ({
  generateTikTokOAuthState: () => "state-1",
  registerTikTokOAuthState: (...args: unknown[]) => mockRegisterState(...args),
  TIKTOK_OAUTH_COOKIE_NAME: "airi_tiktok_oauth_state",
  TIKTOK_OAUTH_STATE_TTL_SECONDS: 900,
}));

import { NextRequest, NextResponse } from "next/server";

import { GET } from "./route";

const configuredOAuth = {
  status: "configured" as const,
  config: {
    appId: "app-1",
    appSecret: "server-secret",
    redirectUri: "https://www.airi.chat/api/internal/tiktok/callback",
    canonicalOrigin: "https://www.airi.chat",
    preferredAdvertiserId: null,
  },
};

describe("GET /api/internal/tiktok/connect", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAppAdmin.mockResolvedValue({
      userId: "admin-1",
      response: null,
      supabase: {},
    });
    mockResolveConfig.mockReturnValue(configuredOAuth);
    mockRegisterState.mockResolvedValue("acquired");
  });

  it("registers state before redirecting and writes one scoped cookie", async () => {
    const response = await GET(
      new NextRequest("https://attacker.example/api/internal/tiktok/connect")
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://ads.tiktok.com");
    expect(location.pathname).toBe("/marketing_api/auth");
    expect(location.searchParams.get("app_id")).toBe("app-1");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://www.airi.chat/api/internal/tiktok/callback"
    );
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("scope")).toBeNull();
    expect(response.headers.get("location")).not.toContain("attacker.example");
    expect(response.headers.get("location")).not.toContain("server-secret");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("airi_tiktok_oauth_state=state-1");
    expect(cookie).toContain("Path=/api/internal/tiktok");
    expect(cookie).toContain("Max-Age=900");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).not.toContain("attacker.example");
    expect(cookie).not.toContain("server-secret");
    expect(mockRegisterState).toHaveBeenCalledWith({
      state: "state-1",
      userId: "admin-1",
      redirectUri: "https://www.airi.chat/api/internal/tiktok/callback",
    });
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
  ] as const)("stops on admin status %i", async (status, _description) => {
    mockRequireAppAdmin.mockResolvedValue({
      userId: null,
      response: NextResponse.json({ error: "denied" }, { status }),
      supabase: {},
    });

    const response = await GET(
      new NextRequest("https://attacker.example/api/internal/tiktok/connect")
    );

    expect(response.status).toBe(status);
    expect(mockRegisterState).not.toHaveBeenCalled();
  });

  it.each(["contended", "unavailable"] as const)(
    "fails closed when OAuth registration is %s",
    async registration => {
      mockRegisterState.mockResolvedValue(registration);

      const response = await GET(
        new NextRequest("https://attacker.example/api/internal/tiktok/connect")
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: "TikTok Discovery is temporarily unavailable",
      });
    }
  );

  it("returns generic 503 when server configuration is incomplete", async () => {
    mockResolveConfig.mockReturnValue({
      status: "server_unconfigured",
      reason: "missing_app_secret",
    });

    const response = await GET(
      new NextRequest("https://attacker.example/api/internal/tiktok/connect")
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockRegisterState).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(
      "missing_app_secret"
    );
  });
});
