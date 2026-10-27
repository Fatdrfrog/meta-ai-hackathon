const mockConsumeState = jest.fn();
const mockCompleteOAuth = jest.fn();
const mockRequireAppAdmin = jest.fn();
const mockLogEmit = jest.fn();
const mockResolveConfig = jest.fn();

jest.mock("@/instrumentation", () => ({
  loggerProvider: {
    getLogger: jest.fn(() => ({
      emit: (...args: unknown[]) => mockLogEmit(...args),
    })),
    forceFlush: jest.fn(),
  },
}));

jest.mock("@/lib/auth/app-admin", () => ({
  requireAppAdmin: () => mockRequireAppAdmin(),
}));

jest.mock("@/lib/tiktok-discovery/oauth-state", () => ({
  consumeTikTokOAuthState: (...args: unknown[]) => mockConsumeState(...args),
  TIKTOK_OAUTH_COOKIE_NAME: "airi_tiktok_oauth_state",
}));

jest.mock("@/lib/tiktok-discovery/complete-platform-oauth", () => ({
  completeTikTokPlatformOAuth: (...args: unknown[]) =>
    mockCompleteOAuth(...args),
}));

jest.mock("@/lib/tiktok-discovery/oauth-config", () => ({
  resolveTikTokOAuthConfig: () => mockResolveConfig(),
}));

import type { TikTokOAuthConfig } from "@/lib/tiktok-discovery/oauth-config";
import type { TikTokAdminOAuthResult } from "@/lib/tiktok-discovery/oauth-result";
import { NextRequest, NextResponse } from "next/server";

import { GET } from "./route";

const callbackConfig: TikTokOAuthConfig = {
  appId: "app-1",
  appSecret: "server-secret",
  redirectUri: "https://www.airi.chat/api/internal/tiktok/callback",
  canonicalOrigin: "https://www.airi.chat",
  preferredAdvertiserId: null,
};

function callbackRequest(
  query: Record<string, string | undefined>,
  cookieState: string | null,
  headers: Record<string, string> = {}
) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) search.set(name, value);
  }
  return new NextRequest(
    `https://host-attacker.example/api/internal/tiktok/callback?${search}`,
    {
      headers: {
        ...headers,
        ...(cookieState
          ? { cookie: `airi_tiktok_oauth_state=${cookieState}` }
          : {}),
      },
    }
  );
}

function requestWithState(authCode: string, state: string) {
  return callbackRequest({ auth_code: authCode, state }, state);
}

const terminalResults: TikTokAdminOAuthResult[] = [
  "connected",
  "cancelled",
  "invalid_state",
  "state_unavailable",
  "unauthorized",
  "forbidden",
  "server_unconfigured",
  "token_exchange_failed",
  "advertiser_selection_required",
  "advertiser_not_authorized",
  "save_failed",
  "coordination_unavailable",
];

describe("GET /api/internal/tiktok/callback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveConfig.mockReturnValue({
      status: "configured",
      config: callbackConfig,
    });
    mockRequireAppAdmin.mockResolvedValue({
      userId: "admin-1",
      response: null,
      supabase: {},
    });
    mockConsumeState.mockResolvedValue("consumed");
    mockCompleteOAuth.mockResolvedValue({
      result: "connected",
      advertiserCount: 1,
      selectedAdvertiserPresent: true,
      providerRequestId: "request-1",
    });
  });

  it("consumes the binding once so a replay cannot exchange the code again", async () => {
    mockConsumeState
      .mockResolvedValueOnce("consumed")
      .mockResolvedValueOnce("invalid");

    await GET(requestWithState("auth-1", "state-1"));
    await GET(requestWithState("auth-1", "state-1"));

    expect(mockConsumeState).toHaveBeenNthCalledWith(1, {
      state: "state-1",
      userId: "admin-1",
      redirectUri: "https://www.airi.chat/api/internal/tiktok/callback",
    });
    expect(mockCompleteOAuth).toHaveBeenCalledTimes(1);
  });

  it.each(terminalResults)(
    "redirects only to the allowlisted %s result",
    async result => {
      mockCompleteOAuth.mockResolvedValue({
        result,
        advertiserCount: 1,
        selectedAdvertiserPresent: true,
        providerRequestId: "request-1",
      });

      const response = await GET(requestWithState("auth-1", "state-1"));

      expect(response.headers.get("location")).toBe(
        `https://www.airi.chat/api/internal/tiktok/status?result=${result}`
      );
      expect(response.headers.get("location")).not.toContain(
        "host-attacker.example"
      );
      expect(response.headers.get("set-cookie")).toContain(
        "airi_tiktok_oauth_state="
      );
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(response.headers.get("set-cookie")).toContain(
        "Path=/api/internal/tiktok"
      );
      expect(mockLogEmit).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
  ] as const)("redirects admin status %i to %s", async (status, result) => {
    mockRequireAppAdmin.mockResolvedValue({
      userId: null,
      response: NextResponse.json({ error: "denied" }, { status }),
      supabase: {},
    });

    const response = await GET(requestWithState("auth-1", "state-1"));

    expect(response.headers.get("location")).toBe(
      `https://www.airi.chat/api/internal/tiktok/status?result=${result}`
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mockConsumeState).not.toHaveBeenCalled();
    expect(mockCompleteOAuth).not.toHaveBeenCalled();
    expect(mockLogEmit).toHaveBeenCalledTimes(1);
  });

  it("returns cookie-clearing JSON when no canonical configuration exists", async () => {
    mockResolveConfig.mockReturnValue({
      status: "server_unconfigured",
      reason: "missing_app_id",
    });

    const response = await GET(requestWithState("auth-1", "state-1"));

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mockRequireAppAdmin).not.toHaveBeenCalled();
    expect(mockConsumeState).not.toHaveBeenCalled();
    expect(mockCompleteOAuth).not.toHaveBeenCalled();
    expect(mockLogEmit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await response.json())).not.toContain(
      "missing_app_id"
    );
  });

  it.each([
    {
      name: "missing query state",
      query: { auth_code: "auth-1" },
      cookie: "state-1",
      consume: null,
      result: "invalid_state",
    },
    {
      name: "missing state cookie",
      query: { auth_code: "auth-1", state: "state-1" },
      cookie: null,
      consume: null,
      result: "invalid_state",
    },
    {
      name: "mismatched state cookie",
      query: { auth_code: "auth-1", state: "state-1" },
      cookie: "other-state",
      consume: null,
      result: "invalid_state",
    },
    {
      name: "replayed state",
      query: { auth_code: "auth-1", state: "state-1" },
      cookie: "state-1",
      consume: "invalid",
      result: "invalid_state",
    },
    {
      name: "state store unavailable",
      query: { auth_code: "auth-1", state: "state-1" },
      cookie: "state-1",
      consume: "unavailable",
      result: "state_unavailable",
    },
    {
      name: "provider cancellation",
      query: { error: "access_denied", state: "state-1" },
      cookie: "state-1",
      consume: "consumed",
      result: "cancelled",
    },
    {
      name: "missing authorization code",
      query: { state: "state-1" },
      cookie: "state-1",
      consume: "consumed",
      result: "token_exchange_failed",
    },
  ] as const)(
    "normalizes $name",
    async ({ query, cookie, consume, result }) => {
      if (consume) mockConsumeState.mockResolvedValue(consume);

      const response = await GET(callbackRequest(query, cookie));

      expect(response.headers.get("location")).toBe(
        `https://www.airi.chat/api/internal/tiktok/status?result=${result}`
      );
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(mockConsumeState).toHaveBeenCalledTimes(consume ? 1 : 0);
      expect(mockCompleteOAuth).not.toHaveBeenCalled();
      expect(mockLogEmit).toHaveBeenCalledTimes(1);
    }
  );

  it("logs one bounded completion event without callback secrets", async () => {
    const response = await GET(
      callbackRequest(
        {
          auth_code: "auth-1",
          state: "state-1",
          token: "secret-token",
          provider_body: "provider body",
          error_description: "provider message",
          provider_advertiser: "advertiserId",
          creator: "creator",
          title: "title",
        },
        "state-1"
      )
    );

    expect(response.status).toBe(307);
    expect(mockLogEmit).toHaveBeenCalledTimes(1);
    const serializedEvent = JSON.stringify(mockLogEmit.mock.calls[0]);
    for (const allowed of ["admin-1", "connected", "request-1"]) {
      expect(serializedEvent).toContain(allowed);
    }
    for (const banned of [
      "secret-token",
      "auth-1",
      "state-1",
      "cookie",
      "host-attacker.example",
      "advertiserId",
      "provider body",
      "provider message",
      "creator",
      "title",
    ]) {
      expect(serializedEvent).not.toContain(banned);
    }
  });

  it("drops untrusted request correlation headers from the completion event", async () => {
    const requestId = "state-1 auth-1 provider message secret-token";
    const correlationId =
      "state-1 auth-1 provider body server-secret x-correlation-id";

    const response = await GET(
      callbackRequest({ auth_code: "auth-1", state: "state-1" }, "state-1", {
        "x-request-id": requestId,
        "x-correlation-id": correlationId,
      })
    );

    expect(response.status).toBe(307);
    expect(mockLogEmit).toHaveBeenCalledTimes(1);
    const completionEvent = mockLogEmit.mock.calls[0]?.[0];
    expect(completionEvent).toMatchObject({
      body: "TikTok OAuth callback completed",
      attributes: expect.objectContaining({
        method: "GET",
        logStage: "complete",
        adminUserId: "admin-1",
        result: "connected",
      }),
    });
    expect(completionEvent).not.toHaveProperty("attributes.requestId");
    const serializedEvent = JSON.stringify(completionEvent);
    for (const unsafeValue of [
      requestId,
      correlationId,
      "state-1",
      "auth-1",
      "provider message",
      "provider body",
      "secret-token",
      "server-secret",
      "x-correlation-id",
    ]) {
      expect(serializedEvent).not.toContain(unsafeValue);
    }
  });
});
