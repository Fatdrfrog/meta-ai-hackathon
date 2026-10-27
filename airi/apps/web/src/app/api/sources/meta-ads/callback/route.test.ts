const mockCreateClient = jest.fn();
const mockAccess = jest.fn();
const mockComplete = jest.fn();
const mockInfo = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/meta-ads/mcp/complete-mcp-oauth", () => ({
  completeMetaAdsMcpOAuth: (...args: unknown[]) => mockComplete(...args),
}));
jest.mock("@/lib/meta-ads/meta-ads-login-config", () => ({
  getMetaAdsAppConfig: () => ({ appId: "app-1" }),
  resolveMetaAdsLoginConfigId: () => "reporting-config",
}));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: (...args: unknown[]) => mockInfo(...args),
  }),
  flushServerLogsAfterResponse: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

function request(state = "state-1") {
  return new NextRequest(
    `http://localhost/api/sources/meta-ads/callback?code=private-code&state=${state}`,
    {
      headers: {
        cookie:
          "meta_ads_oauth_state=state-1; meta_ads_oauth_workspace_id=workspace-1; meta_ads_oauth_redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Fsources%2Fmeta-ads%2Fcallback",
      },
    }
  );
}

describe("Meta Ads redirect callback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "member-1" } } }) },
    });
    mockAccess.mockResolvedValue(true);
    mockComplete.mockResolvedValue({ ok: true, adAccounts: [{ id: "act_1" }] });
  });

  it("uses the unified completion owner for reporting and clears OAuth cookies", async () => {
    const response = await GET(request());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("success")
    ).toBe("connected");
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        code: "private-code",
        redirectUri: "http://localhost/api/sources/meta-ads/callback",
        allowCreateGraphSource: true,
        intent: "reporting",
      })
    );
    expect(response.headers.get("set-cookie")).toContain(
      "meta_ads_oauth_state="
    );
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockInfo.mock.calls)).not.toContain("private-code");
  });

  it("rejects state mismatch before token exchange", async () => {
    const response = await GET(request("wrong-state"));
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).toBe("oauth_failed");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callbacks", async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });
    const response = await GET(request());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).toBe("unauthorized");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("rejects a callback outside the user's workspace membership", async () => {
    mockAccess.mockResolvedValue(false);
    const response = await GET(request());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).toBe("forbidden");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it.each([
    "ads_permissions_missing",
    "token_verification_failed",
    "no_ad_accounts",
    "ad_accounts_unavailable",
    "mcp_save_conflict",
  ])("does not claim success on %s", async error => {
    mockComplete.mockResolvedValue({ ok: false, status: 400, error });
    const response = await GET(request());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).toBe(error);
  });

  it("records one safe completion if the shared owner throws", async () => {
    mockComplete.mockRejectedValue(new Error("provider failed"));
    await expect(GET(request())).rejects.toThrow("provider failed");
    expect(mockInfo).toHaveBeenCalledWith(
      "meta_ads_callback_completed",
      expect.objectContaining({ outcome: "exception" })
    );
    expect(JSON.stringify(mockInfo.mock.calls)).not.toContain("private-code");
  });
});
