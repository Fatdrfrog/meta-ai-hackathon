const mockComplete = jest.fn();
const mockAccess = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/meta-ads/mcp/complete-mcp-oauth", () => ({
  completeMetaAdsMcpOAuth: (...args: unknown[]) => mockComplete(...args),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: () => mockUser() } }),
}));
jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) => mockAccess(...args),
}));
import { NextRequest } from "next/server";
import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/sources/meta-ads/mcp/complete", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("Meta Ads unified completion endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccess.mockResolvedValue(true);
    mockUser.mockResolvedValue({ data: { user: { id: "member-1" } } });
  });
  it.each([
    null,
    [],
    { workspaceId: "workspace-1", code: "code", intent: "unknown" },
  ])("rejects malformed or unknown-intent bodies: %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mockComplete).not.toHaveBeenCalled();
  });
  it("preserves reporting capability and inventory in the response", async () => {
    const result = {
      ok: true,
      createdSource: false,
      reportingReady: false,
      reporting: { canRead: false, reason: "account_unavailable" },
      readiness: { state: "stale" },
      adAccounts: [{ id: "act_1" }],
      selectedAdAccountId: "act_old",
    };
    mockComplete.mockResolvedValue(result);
    const response = await POST(
      request({
        workspaceId: "workspace-1",
        code: "code",
        intent: "reporting",
        allowCreateGraphSource: true,
      })
    );
    expect(await response.json()).toEqual({
      success: true,
      createdSource: false,
      reportingReady: false,
      reporting: result.reporting,
      readiness: result.readiness,
      adAccounts: result.adAccounts,
      selectedAdAccountId: "act_old",
    });
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "reporting",
        allowCreateGraphSource: true,
      })
    );
  });
  it("does not authorize a workspace outside membership", async () => {
    mockAccess.mockResolvedValue(false);
    expect(
      (await POST(request({ workspaceId: "other-workspace", code: "code" })))
        .status
    ).toBe(403);
    expect(mockComplete).not.toHaveBeenCalled();
  });
});
