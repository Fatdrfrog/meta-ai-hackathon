const mockRequireAppAdmin = jest.fn();
const mockReadStatus = jest.fn();
const mockResolveConfig = jest.fn();

jest.mock("@/lib/auth/app-admin", () => ({
  requireAppAdmin: () => mockRequireAppAdmin(),
}));

jest.mock("@/lib/tiktok-discovery/platform-credential", () => ({
  readTikTokPlatformCredentialStatus: () => mockReadStatus(),
}));

jest.mock("@/lib/tiktok-discovery/oauth-config", () => ({
  resolveTikTokOAuthConfig: () => mockResolveConfig(),
}));

import { NextRequest, NextResponse } from "next/server";

import { GET } from "./route";

const configuredOAuth = {
  status: "configured" as const,
  config: {
    appId: "app-1",
    appSecret: "secret",
    redirectUri: "https://www.airi.chat/api/internal/tiktok/callback",
    canonicalOrigin: "https://www.airi.chat",
    preferredAdvertiserId: null,
  },
};

describe("GET /api/internal/tiktok/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAppAdmin.mockResolvedValue({
      userId: "admin-1",
      response: null,
      supabase: {},
    });
    mockResolveConfig.mockReturnValue(configuredOAuth);
    mockReadStatus.mockResolvedValue(null);
  });

  it.each([401, 403] as const)(
    "stops on app-admin status %i before reading configuration or credentials",
    async status => {
      mockRequireAppAdmin.mockResolvedValue({
        userId: status === 401 ? null : "member-1",
        response: NextResponse.json({ error: "denied" }, { status }),
        supabase: {},
      });

      const response = await GET(
        new NextRequest("https://www.airi.chat/api/internal/tiktok/status")
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: "denied" });
      expect(mockResolveConfig).not.toHaveBeenCalled();
      expect(mockReadStatus).not.toHaveBeenCalled();
    }
  );

  it("returns only allowlisted operational credential fields", async () => {
    mockReadStatus.mockResolvedValue({
      generation: "a".repeat(32),
      advertiserId: "123",
      authorizedAdvertiserCount: 2,
      grantedScopes: ["18000000"],
      connectedByUserId: "admin-1",
      connectedAt: new Date("2026-08-13T00:00:00Z"),
      lastValidatedAt: null,
      status: "connected",
      lastErrorCode: null,
      encryptedAccessToken: "must-not-appear",
      ciphertext: "must-not-appear-either",
    });

    const response = await GET(
      new NextRequest(
        "https://www.airi.chat/api/internal/tiktok/status?result=connected"
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      configured: true,
      result: "connected",
      credential: {
        status: "connected",
        selectedAdvertiserId: "123",
        authorizedAdvertiserCount: 2,
        connectedAt: "2026-08-13T00:00:00.000Z",
        lastValidatedAt: null,
        lastErrorCode: null,
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('"selectedAdvertiserId":"123"');
    for (const forbidden of [
      "generation",
      "must-not-appear",
      "ciphertext",
      "appSecret",
      "grantedScopes",
      "connectedByUserId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not write OAuth secrets to the console", async () => {
    const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await GET(
        new NextRequest("https://www.airi.chat/api/internal/tiktok/status")
      );

      expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("secret");
    } finally {
      consoleLog.mockRestore();
    }
  });

  it.each([
    ["connected", "connected"],
    ["advertiser_selection_required", "advertiser_selection_required"],
    ["<script>alert(1)</script>", null],
    [null, null],
  ] as const)("normalizes status result %s", async (input, expected) => {
    const query = input === null ? "" : `?result=${encodeURIComponent(input)}`;
    const response = await GET(
      new NextRequest(
        `https://www.airi.chat/api/internal/tiktok/status${query}`
      )
    );

    expect(await response.json()).toMatchObject({
      configured: true,
      result: expected,
      credential: null,
    });
  });

  it("returns a generic outage without serializing Mongo errors", async () => {
    mockReadStatus.mockRejectedValue(
      new Error("atlas host and credential details")
    );

    const response = await GET(
      new NextRequest("https://www.airi.chat/api/internal/tiktok/status")
    );

    expect(response.status).toBe(503);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("atlas host");
    expect(serialized).not.toContain("credential details");
  });

  it.each([
    [
      { status: "configured", config: { appId: "app-1", appSecret: "secret" } },
      true,
    ],
    [{ status: "server_unconfigured", reason: "missing_app_secret" }, false],
  ] as const)(
    "projects configuration %# to Boolean %s",
    async (config, configured) => {
      mockResolveConfig.mockReturnValue(config);

      const response = await GET(
        new NextRequest("https://www.airi.chat/api/internal/tiktok/status")
      );
      const body = await response.json();

      expect(body.configured).toBe(configured);
      expect(JSON.stringify(body)).not.toContain("app-1");
      expect(JSON.stringify(body)).not.toContain("missing_app_secret");
    }
  );
});
