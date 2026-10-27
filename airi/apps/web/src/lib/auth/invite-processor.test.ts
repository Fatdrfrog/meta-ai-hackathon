const mockSupabaseFrom = jest.fn();
const mockUpdateUserById = jest.fn();
const mockEnsureCompanySeatCapacityForUser = jest.fn();
const mockSyncPublicUserProfile = jest.fn();
const mockInsertCompanyUserMembership = jest.fn();
const mockResolveCompanyUserMembershipConflict = jest.fn();
const mockGrantTeamInviteMembership = jest.fn();
let inviterRole: string | null;
let workspaceCompanyId: string;
let existingMembership: { id: string; role?: string } | null;
let existingMembershipWorkspaceId: string;

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    auth: {
      admin: {
        updateUserById: (...args: unknown[]) => mockUpdateUserById(...args),
      },
    },
  },
}));
jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanySeatCapacityForUser: (...args: unknown[]) =>
    mockEnsureCompanySeatCapacityForUser(...args),
}));
jest.mock("@/lib/auth/user-profile-sync", () => ({
  syncPublicUserProfile: (...args: unknown[]) =>
    mockSyncPublicUserProfile(...args),
}));
jest.mock("@/lib/supabase/company-users", () => ({
  ...jest.requireActual("@/lib/supabase/company-users"),
  insertCompanyUserMembership: (...args: unknown[]) =>
    mockInsertCompanyUserMembership(...args),
  grantTeamInviteMembership: (...args: unknown[]) =>
    mockGrantTeamInviteMembership(...args),
}));
jest.mock("@/lib/analytics", () => ({
  setCompanyProperties: jest.fn(),
  trackUserRegistration: jest.fn(),
}));
jest.mock("@/lib/tracking-consent-server", () => ({
  readServerTrackingConsent: async () => "granted",
}));

import type { User } from "@supabase/supabase-js";
import { processInvite } from "./invite-processor";
import { createTeamInviteToken } from "./team-invite-link";
import { trackUserRegistration } from "@/lib/analytics";

const companyId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const inviterId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const otherWorkspaceId = "55555555-5555-4555-8555-555555555555";

function query(table: string) {
  const filters: Record<string, unknown> = {};
  const builder = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockImplementation((key: string, value: unknown) => {
    filters[key] = value;
    return builder;
  });
  builder.maybeSingle.mockImplementation(async () => ({
    data:
      table === "workspaces"
        ? { company_id: workspaceCompanyId }
        : filters.user_id === inviterId
          ? inviterRole
            ? { role: inviterRole }
            : null
          : filters.user_id === userId &&
              filters.workspace_id === existingMembershipWorkspaceId
            ? existingMembership
            : null,
    error: null,
  }));
  builder.single.mockResolvedValue({ data: null, error: null });
  return builder;
}

function invitedUser(overrides: Partial<User> = {}, email?: string) {
  const { token } = createTeamInviteToken({
    companyId,
    workspaceId,
    inviterId,
    ...(email === "" ? {} : { email: email ?? "client@example.com" }),
  } as Parameters<typeof createTeamInviteToken>[0]);
  return {
    id: userId,
    email: "client@example.com",
    email_confirmed_at: "2026-10-03T00:00:00Z",
    user_metadata: {
      company_id: companyId,
      workspace_id: workspaceId,
      team_invite_token: token,
      full_name: "Client",
    },
    ...overrides,
  } as User;
}

describe("processInvite", () => {
  const previousSecret = process.env.TEAM_INVITE_LINK_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_INVITE_LINK_SECRET = "test-invite-secret";
    inviterRole = "admin";
    workspaceCompanyId = companyId;
    existingMembership = null;
    existingMembershipWorkspaceId = workspaceId;
    mockSupabaseFrom.mockImplementation(query);
    mockUpdateUserById.mockResolvedValue({ error: null });
    mockEnsureCompanySeatCapacityForUser.mockResolvedValue({ allowed: true });
    mockSyncPublicUserProfile.mockResolvedValue(undefined);
    mockInsertCompanyUserMembership.mockResolvedValue({ error: null });
    mockResolveCompanyUserMembershipConflict.mockResolvedValue({
      status: "joined",
      error: null,
    });
    mockGrantTeamInviteMembership.mockImplementation(async () => ({
      status: inviterRole === "admin" ? "joined" : "unresolved",
      error: inviterRole === "admin" ? null : { code: "42501" },
    }));
  });
  afterEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = previousSecret;
    jest.useRealTimers();
  });

  it("does nothing for a user without invite metadata", async () => {
    await expect(
      processInvite({ id: userId, user_metadata: {} } as User)
    ).resolves.toEqual({ success: true, alreadyProcessed: false });
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });

  it("rejects self-editable company/workspace metadata without signed proof", async () => {
    const result = await processInvite(
      invitedUser({
        user_metadata: {
          company_id: companyId,
          workspace_id: workspaceId,
          role: "admin",
        },
      })
    );
    expect(result.success).toBe(false);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    expect(mockResolveCompanyUserMembershipConflict).not.toHaveBeenCalled();
  });

  it("rejects a shareable link substituted into email-invite metadata", async () => {
    expect((await processInvite(invitedUser({}, ""))).success).toBe(false);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });

  it("rejects a forged token without granting any new membership", async () => {
    const user = invitedUser();
    user.user_metadata.team_invite_token += ".extra";
    expect((await processInvite(user)).success).toBe(false);
    expect(mockSupabaseFrom).not.toHaveBeenCalledWith("workspaces");
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).not.toHaveBeenCalled();
  });

  it("resumes an exact existing membership from legacy unsigned hints without granting access", async () => {
    existingMembership = { id: "membership-1", role: "admin" };
    const user = invitedUser({
      user_metadata: {
        company_id: "untrusted-company",
        workspace_id: workspaceId,
        role: "admin",
        full_name: "Client",
      },
    });
    await expect(processInvite(user)).resolves.toEqual({
      success: true,
      workspaceId,
      alreadyProcessed: true,
    });
    expect(mockSupabaseFrom.mock.calls).toEqual([["company_users"]]);
    const lookup = mockSupabaseFrom.mock.results[0].value;
    expect(lookup.eq.mock.calls).toEqual([
      ["user_id", userId],
      ["workspace_id", workspaceId],
    ]);
    expect(mockSyncPublicUserProfile).not.toHaveBeenCalled();
    expect(mockEnsureCompanySeatCapacityForUser).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).not.toHaveBeenCalled();
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    expect(mockResolveCompanyUserMembershipConflict).not.toHaveBeenCalled();
    expect(mockUpdateUserById).toHaveBeenCalledWith(userId, {
      user_metadata: {
        company_id: null,
        workspace_id: null,
        team_invite_token: null,
      },
    });
  });

  it("rejects a forged foreign workspace hint even when the user belongs to another workspace", async () => {
    existingMembership = { id: "membership-1", role: "admin" };
    expect(
      (
        await processInvite(
          invitedUser({
            user_metadata: {
              company_id: companyId,
              workspace_id: otherWorkspaceId,
            },
          })
        )
      ).success
    ).toBe(false);
    expect(mockGrantTeamInviteMembership).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it("resumes an existing membership after its invite token expires", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-03T00:00:00Z"));
    const user = invitedUser();
    jest.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    existingMembership = { id: "membership-1", role: "manager" };
    await expect(processInvite(user)).resolves.toEqual({
      success: true,
      workspaceId,
      alreadyProcessed: true,
    });
    expect(mockSupabaseFrom.mock.calls).toEqual([["company_users"]]);
    expect(mockSyncPublicUserProfile).not.toHaveBeenCalled();
    expect(mockEnsureCompanySeatCapacityForUser).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).not.toHaveBeenCalled();
  });

  it.each([null, "owner", "member", "manager"])(
    "resumes an existing membership after the inviter role changes to %s",
    async role => {
      existingMembership = { id: "membership-1", role: "manager" };
      inviterRole = role;
      await expect(processInvite(invitedUser())).resolves.toEqual({
        success: true,
        workspaceId,
        alreadyProcessed: true,
      });
      expect(mockSupabaseFrom.mock.calls).toEqual([["company_users"]]);
      expect(mockSyncPublicUserProfile).not.toHaveBeenCalled();
      expect(mockEnsureCompanySeatCapacityForUser).not.toHaveBeenCalled();
      expect(mockGrantTeamInviteMembership).not.toHaveBeenCalled();
    }
  );

  it("does not read memberships for a malformed unsigned workspace hint", async () => {
    expect(
      (
        await processInvite(
          invitedUser({ user_metadata: { workspace_id: "another-workspace" } })
        )
      ).success
    ).toBe(false);
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).not.toHaveBeenCalled();
  });

  it("rejects an expired email invite", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-03T00:00:00Z"));
    const user = invitedUser();
    jest.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    expect((await processInvite(user)).success).toBe(false);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });

  it.each([
    { email: "attacker@example.com" },
    { email_confirmed_at: undefined },
  ])("requires the confirmed recipient email: %j", async overrides => {
    expect((await processInvite(invitedUser(overrides))).success).toBe(false);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });

  it.each([null, "owner", "member", "manager"])(
    "rejects an inviter whose current role is %s",
    async role => {
      inviterRole = role;
      expect((await processInvite(invitedUser())).success).toBe(false);
      expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    }
  );

  it("rejects a token whose company no longer matches its workspace", async () => {
    workspaceCompanyId = "55555555-5555-4555-8555-555555555555";
    expect((await processInvite(invitedUser())).success).toBe(false);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });

  it("uses only signed workspace/company IDs and adds a scoped member without changing other companies", async () => {
    const user = invitedUser();
    user.user_metadata.company_id = "another-company";
    user.user_metadata.workspace_id = otherWorkspaceId;
    existingMembership = { id: "membership-elsewhere", role: "admin" };
    existingMembershipWorkspaceId = otherWorkspaceId;
    await expect(processInvite(user)).resolves.toEqual({
      success: true,
      workspaceId,
      alreadyProcessed: false,
    });
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).toHaveBeenCalledTimes(1);
    expect(trackUserRegistration).toHaveBeenCalledWith(
      userId,
      companyId,
      workspaceId,
      "manager",
      "invite",
      "client@example.com",
      "Client",
      { consent: "granted" }
    );
    expect(mockGrantTeamInviteMembership).toHaveBeenCalledWith(
      expect.anything(),
      {
        inviter_id: inviterId,
        user_id: userId,
        workspace_id: workspaceId,
        company_id: companyId,
        email: "client@example.com",
      }
    );
    expect(mockUpdateUserById).toHaveBeenCalledWith(userId, {
      user_metadata: {
        company_id: null,
        workspace_id: null,
        team_invite_token: null,
      },
    });
  });

  it("preserves an existing member role without inserting another membership", async () => {
    existingMembership = { id: "membership-1", role: "admin" };
    await expect(processInvite(invitedUser())).resolves.toEqual({
      success: true,
      workspaceId,
      alreadyProcessed: true,
    });
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
    expect(mockEnsureCompanySeatCapacityForUser).not.toHaveBeenCalled();
  });

  it("uses the atomic grant operation to claim pending invitations", async () => {
    await expect(processInvite(invitedUser())).resolves.toEqual({
      success: true,
      workspaceId,
      alreadyProcessed: false,
    });
    expect(mockResolveCompanyUserMembershipConflict).not.toHaveBeenCalled();
    expect(mockGrantTeamInviteMembership).toHaveBeenCalledWith(
      expect.anything(),
      {
        inviter_id: inviterId,
        user_id: userId,
        workspace_id: workspaceId,
        company_id: companyId,
        email: "client@example.com",
      }
    );
  });

  it.each([null, "owner", "member", "manager"])(
    "rejects an inviter revoked during the capacity check: %s",
    async role => {
      mockEnsureCompanySeatCapacityForUser.mockImplementation(async () => {
        inviterRole = role;
        return { allowed: true };
      });
      expect((await processInvite(invitedUser())).success).toBe(false);
      expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
      expect(mockUpdateUserById).not.toHaveBeenCalled();
    }
  );

  it("handles an atomic grant that finds a concurrent existing membership", async () => {
    mockGrantTeamInviteMembership.mockResolvedValue({
      status: "already_member",
      error: null,
    });
    await expect(processInvite(invitedUser())).resolves.toMatchObject({
      success: true,
      alreadyProcessed: true,
    });
  });

  it("does not grant a membership over the company's seat limit", async () => {
    mockEnsureCompanySeatCapacityForUser.mockResolvedValue({ allowed: false });
    expect((await processInvite(invitedUser())).success).toBe(false);
    expect(mockInsertCompanyUserMembership).not.toHaveBeenCalled();
  });
});
