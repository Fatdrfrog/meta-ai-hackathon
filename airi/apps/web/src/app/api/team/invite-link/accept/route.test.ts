const mockCreateClient = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockUsersUpsert = jest.fn();
const mockEnsureCompanySeatCapacityForUser = jest.fn();
const mockInsertCompanyUserMembership = jest.fn();
const mockResolveCompanyUserMembershipConflict = jest.fn();
const mockGrantTeamInviteMembership = jest.fn();
const mockTrackCompanyEvent = jest.fn();
let mockInviterRole: string | null;
let mockCompanyId: string;
let mockExistingMembership: { id: string } | null;

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/limits/company-limits", () => ({
  buildCompanySeatLimitExceededResponse: jest.fn(() =>
    Response.json({ error: "seat limit exceeded" }, { status: 402 })
  ),
  ensureCompanySeatCapacityForUser: (...args: unknown[]) =>
    mockEnsureCompanySeatCapacityForUser(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  ...jest.requireActual("@/lib/supabase/company-users"),
  insertCompanyUserMembership: (...args: unknown[]) =>
    mockInsertCompanyUserMembership(...args),
  grantTeamInviteMembership: (...args: unknown[]) =>
    mockGrantTeamInviteMembership(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackCompanyEvent: (...args: unknown[]) => mockTrackCompanyEvent(...args),
}));

import { createTeamInviteToken } from "@/lib/auth/team-invite-link";
import { POST } from "./route";

function membershipQuery(
  data: unknown | ((filters: Record<string, unknown>) => unknown),
  error: unknown = null
) {
  const filters: Record<string, unknown> = {};
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
  };

  query.select.mockReturnValue(query);
  query.eq.mockImplementation((key: string, value: unknown) => {
    filters[key] = value;
    return query;
  });
  query.maybeSingle.mockImplementation(async () => ({
    data: typeof data === "function" ? data(filters) : data,
    error,
  }));

  return query;
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/team/invite-link/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/team/invite-link/accept", () => {
  const previousSecret = process.env.TEAM_INVITE_LINK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_INVITE_LINK_SECRET = "test-invite-secret";
    mockInviterRole = "admin";
    mockCompanyId = "11111111-1111-4111-8111-111111111111";
    mockExistingMembership = null;

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: "user-1",
              email: "client@example.com",
              email_confirmed_at: "2026-10-03T00:00:00Z",
              user_metadata: {
                full_name: "Client User",
                avatar_url: "https://example.com/avatar.png",
              },
            },
          },
        }),
      },
    });

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "company_users") {
        return membershipQuery((filters: Record<string, unknown>) =>
          filters.user_id === "33333333-3333-4333-8333-333333333333"
            ? mockInviterRole
              ? { role: mockInviterRole }
              : null
            : mockExistingMembership
        );
      }
      if (table === "workspaces")
        return membershipQuery({ company_id: mockCompanyId });

      if (table === "users") {
        return {
          upsert: mockUsersUpsert.mockResolvedValue({ error: null }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    mockEnsureCompanySeatCapacityForUser.mockResolvedValue({ allowed: true });
    mockInsertCompanyUserMembership.mockResolvedValue({ error: null });
    mockResolveCompanyUserMembershipConflict.mockResolvedValue({
      status: "unresolved",
      error: null,
    });
    mockGrantTeamInviteMembership.mockImplementation(async () => ({
      status: mockInviterRole === "admin" ? "joined" : "unresolved",
      error: mockInviterRole === "admin" ? null : { code: "42501" },
    }));
  });

  afterEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = previousSecret;
  });

  it("syncs the public user profile before atomically granting membership", async () => {
    const { token } = createTeamInviteToken({
      companyId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });

    const response = await POST(jsonRequest({ token }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      status: "joined",
    });

    expect(mockUsersUpsert).toHaveBeenCalledWith(
      {
        id: "user-1",
        full_name: "Client User",
        avatar_url: "https://example.com/avatar.png",
      },
      { onConflict: "id" }
    );
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).toHaveBeenCalledWith(
      expect.anything(),
      {
        inviter_id: "33333333-3333-4333-8333-333333333333",
        user_id: "user-1",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        company_id: mockCompanyId,
        email: "client@example.com",
      }
    );
    expect(mockUsersUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockGrantTeamInviteMembership.mock.invocationCallOrder[0]
    );
  });

  it("uses the atomic grant operation to claim pending email memberships", async () => {
    const { token } = createTeamInviteToken({
      companyId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });

    const response = await POST(jsonRequest({ token }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      status: "joined",
    });
    expect(mockResolveCompanyUserMembershipConflict).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).toHaveBeenCalledWith(
      expect.anything(),
      {
        inviter_id: "33333333-3333-4333-8333-333333333333",
        user_id: "user-1",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        company_id: mockCompanyId,
        email: "client@example.com",
      }
    );
  });

  it("does not report success for an unresolved atomic grant", async () => {
    const { token } = createTeamInviteToken({
      companyId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });
    mockGrantTeamInviteMembership.mockResolvedValue({
      status: "unresolved",
      error: null,
    });

    const response = await POST(jsonRequest({ token }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "Failed to join workspace",
    });
  });

  it.each([null, "owner", "member", "manager"])(
    "rejects a link when the inviter loses authority during the capacity check: %s",
    async role => {
      const { token } = createTeamInviteToken({
        companyId: mockCompanyId,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        inviterId: "33333333-3333-4333-8333-333333333333",
      });
      mockEnsureCompanySeatCapacityForUser.mockImplementation(async () => {
        mockInviterRole = role;
        return { allowed: true };
      });
      expect((await POST(jsonRequest({ token }))).status).toBe(403);
      expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    }
  );

  it("does not let an unconfirmed email claim a pending privileged membership", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: "user-1",
              email: "client@example.com",
              user_metadata: {},
            },
          },
        }),
      },
    });
    const { token } = createTeamInviteToken({
      companyId: mockCompanyId,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });
    expect((await POST(jsonRequest({ token }))).status).toBe(200);
    expect(mockGrantTeamInviteMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: null })
    );
    expect(mockResolveCompanyUserMembershipConflict).not.toHaveBeenCalled();
  });

  it("reports a concurrent existing membership without replacing its role", async () => {
    mockGrantTeamInviteMembership.mockResolvedValue({
      status: "already_member",
      error: null,
    });
    const { token } = createTeamInviteToken({
      companyId: mockCompanyId,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });
    const response = await POST(jsonRequest({ token }));
    await expect(response.json()).resolves.toMatchObject({
      status: "already_member",
    });
  });

  it.each([null, "owner", "member", "manager"])(
    "rejects a link after its inviter loses admin permission: %s",
    async role => {
      mockInviterRole = role;
      const { token } = createTeamInviteToken({
        companyId: mockCompanyId,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        inviterId: "33333333-3333-4333-8333-333333333333",
      });
      const response = await POST(jsonRequest({ token }));
      expect(response.status).toBe(403);
      expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
      expect(mockResolveCompanyUserMembershipConflict).not.toHaveBeenCalled();
    }
  );

  it("rejects a signed token with a workspace/company mismatch", async () => {
    const { token } = createTeamInviteToken({
      companyId: "55555555-5555-4555-8555-555555555555",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });
    expect((await POST(jsonRequest({ token }))).status).toBe(403);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });

  it("rejects an email-bound invitation used by a different account", async () => {
    const { token } = createTeamInviteToken({
      companyId: mockCompanyId,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
      email: "someoneelse@example.com",
    } as Parameters<typeof createTeamInviteToken>[0]);
    expect((await POST(jsonRequest({ token }))).status).toBe(403);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });

  it("is idempotent for an existing workspace membership", async () => {
    mockExistingMembership = { id: "existing-membership" };
    const { token } = createTeamInviteToken({
      companyId: mockCompanyId,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      inviterId: "33333333-3333-4333-8333-333333333333",
    });
    const response = await POST(jsonRequest({ token }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "already_member",
    });
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });
});
