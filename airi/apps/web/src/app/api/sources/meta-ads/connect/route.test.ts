const mockCreateClient = jest.fn();
const mockRequireWorkspaceMembership = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();
const mockFlushServerLogsAfterResponse = jest.fn();

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
  flushServerLogsAfterResponse: () => mockFlushServerLogsAfterResponse(),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockRequireWorkspaceMembership(...args),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";

describe("GET /api/sources/meta-ads/connect", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_META_APP_ID: "meta-app-id",
      NEXT_PUBLIC_APP_URL: "",
    };
    mockCreateClient.mockResolvedValue({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
    });
    mockRequireWorkspaceMembership.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("requires a Facebook Login for Business configuration", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/sources/meta-ads/connect?workspaceId=workspace-1"
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Meta Ads Login for Business is not configured",
    });
  });

  it("uses Facebook Login for Business config_id when configured", async () => {
    process.env.META_ADS_LOGIN_CONFIG_ID = "meta-ads-login-config-1";

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/sources/meta-ads/connect?workspaceId=workspace-1"
      )
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") || "");
    expect(location.origin).toBe("https://www.facebook.com");
    expect(location.searchParams.get("client_id")).toBe("meta-app-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/sources/meta-ads/callback"
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("config_id")).toBe(
      "meta-ads-login-config-1"
    );
    expect(location.searchParams.get("scope")).toBeNull();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith("meta_ads_oauth_started", {
      workspaceId: "workspace-1",
      appId: location.searchParams.get("client_id"),
      loginConfigId: location.searchParams.get("config_id"),
    });
    const logged = JSON.stringify(mockLoggerInfo.mock.calls);
    expect(logged).not.toContain(location.searchParams.get("state"));
    expect(logged).not.toContain("redirect_uri");
    expect(logged).not.toContain("http");
    expect(mockFlushServerLogsAfterResponse).toHaveBeenCalledTimes(1);
  });
});
