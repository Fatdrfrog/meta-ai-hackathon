import { createTeamInviteToken } from "./team-invite-link";
import { resolveTeamInviteContext } from "./team-invite-context";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

describe("resolveTeamInviteContext", () => {
  const previousSecret = process.env.TEAM_INVITE_LINK_SECRET;

  beforeEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = previousSecret;
  });

  it("returns workspace and company context for a valid invite token", async () => {
    const { token, expiresAt } = createTeamInviteToken({
      companyId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });
    const query = createSupabaseQueryMock({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Support Workspace",
        companies: { name: "Airi Demo" },
      },
      error: null,
    });
    const supabase = {
      from: jest.fn(() => query),
    };

    await expect(
      resolveTeamInviteContext(supabase as never, token)
    ).resolves.toEqual({
      status: "valid",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "Support Workspace",
      companyName: "Airi Demo",
      expiresAtIso: new Date(expiresAt * 1000).toISOString(),
    });

    expect(supabase.from).toHaveBeenCalledWith("workspaces");
    expect(query.select).toHaveBeenCalledWith(
      "id, name, companies!workspaces_company_id_fkey(name)"
    );
    expect(query.eq).toHaveBeenCalledWith(
      "id",
      "22222222-2222-4222-8222-222222222222"
    );
  });

  it("does not query the database for malformed invite tokens", async () => {
    const supabase = {
      from: jest.fn(),
    };

    await expect(
      resolveTeamInviteContext(supabase as never, "not-a-token")
    ).resolves.toEqual({
      status: "invalid",
      reason: "Malformed token",
    });

    expect(supabase.from).not.toHaveBeenCalled();
  });
});
