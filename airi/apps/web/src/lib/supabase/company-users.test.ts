import {
  listWorkspaceMemberLabels,
  isCompanyAdminRole,
  isWorkspaceManagerRole,
  isWorkspaceRole,
  getWorkspaceMemberDisplayName,
  grantTeamInviteMembership,
  mutateTeamMembership,
} from "./company-users";

describe("getWorkspaceMemberDisplayName", () => {
  function client(membership: unknown, profiles: unknown[] = []) {
    const profileRead = jest.fn(async () => ({ data: profiles, error: null }));
    return {
      profileRead,
      supabase: {
        from: jest.fn((table: string) => {
          if (table === "users") {
            return { select: () => ({ in: profileRead }) };
          }
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn(async () => ({
              data: membership,
              error: null,
            })),
          };
        }),
      },
    };
  }

  it("prefers the profile name, then the email's local part", async () => {
    const named = client({ email: "dana@example.com" }, [
      { id: "user-1", full_name: " Dana Lee " },
    ]);
    await expect(
      getWorkspaceMemberDisplayName(
        named.supabase as never,
        "user-1",
        "workspace-1"
      )
    ).resolves.toBe("Dana Lee");

    const unnamed = client({ email: "sam@example.com" });
    await expect(
      getWorkspaceMemberDisplayName(
        unnamed.supabase as never,
        "user-1",
        "workspace-1"
      )
    ).resolves.toBe("sam");
  });

  it("returns the fallback for a non-member without reading profiles", async () => {
    const outsider = client(null);

    await expect(
      getWorkspaceMemberDisplayName(
        outsider.supabase as never,
        "user-1",
        "workspace-1"
      )
    ).resolves.toBe("Manager");
    expect(outsider.profileRead).not.toHaveBeenCalled();
  });
});

describe("membership management roles", () => {
  it.each(["admin", "manager"])("accepts the assignable role %s", role => {
    expect(isWorkspaceRole(role)).toBe(true);
  });
  it.each(["owner", "member", " admin ", "ADMIN", null, undefined])(
    "rejects the unassignable role %s",
    role => expect(isWorkspaceRole(role)).toBe(false)
  );
  it.each(["admin", " admin "])(
    "allows %s to manage company settings",
    role => {
      expect(isCompanyAdminRole(role)).toBe(true);
      expect(isWorkspaceManagerRole(role)).toBe(true);
    }
  );
  it.each(["manager", " manager "])(
    "allows %s to manage only workspace settings",
    role => {
      expect(isCompanyAdminRole(role)).toBe(false);
      expect(isWorkspaceManagerRole(role)).toBe(true);
    }
  );
  it.each(["owner", " owner ", "member", "", "ADMIN", null, undefined, 1])(
    "does not grant management to %s",
    role => {
      expect(isCompanyAdminRole(role)).toBe(false);
      expect(isWorkspaceManagerRole(role)).toBe(false);
    }
  );
});

describe("mutateTeamMembership", () => {
  const payload = {
    actor_id: "actor-1",
    member_id: "member-1",
    workspace_id: "workspace-1",
    expected_user_id: "user-1",
    expected_role: "manager",
  };
  it.each([
    ["update-role", "updated"],
    ["revoke", "revoked"],
  ] as const)("uses the atomic RPC for %s", async (action, status) => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: [{ status }], error: null }),
    };
    await expect(
      mutateTeamMembership(supabase as never, {
        ...payload,
        action,
        ...(action === "update-role" ? { role: "admin" as const } : {}),
      })
    ).resolves.toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith("mutate_team_membership", {
      input_actor_id: "actor-1",
      input_member_id: "member-1",
      input_action: action,
      input_workspace_id: "workspace-1",
      input_expected_user_id: "user-1",
      input_expected_role: "manager",
      input_role: action === "update-role" ? "admin" : null,
    });
  });
  it.each([
    ["42501", 403],
    ["P0002", 404],
    ["40001", 409],
    ["22023", 400],
    ["XX000", 500],
  ] as const)("maps SQLSTATE %s to HTTP %s", async (code, status) => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: null, error: { code } }),
    };
    await expect(
      mutateTeamMembership(supabase as never, { ...payload, action: "revoke" })
    ).resolves.toMatchObject({ ok: false, status });
  });
  it.each([
    null,
    [],
    [{ status: "updated" }],
    [{ status: "revoked" }, { status: "revoked" }],
  ])("fails closed for invalid mutation result %j", async data => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data, error: null }),
    };
    await expect(
      mutateTeamMembership(supabase as never, { ...payload, action: "revoke" })
    ).resolves.toMatchObject({ ok: false, status: 500 });
  });
});

describe("grantTeamInviteMembership", () => {
  const payload = {
    inviter_id: "inviter-1",
    user_id: "user-1",
    workspace_id: "workspace-1",
    company_id: "company-1",
    email: "client@example.com",
  };

  it.each(["joined", "already_member"])(
    "uses the atomic service grant and returns %s",
    async status => {
      const supabase = {
        rpc: jest.fn().mockResolvedValue({ data: [{ status }], error: null }),
      };
      await expect(
        grantTeamInviteMembership(supabase as never, payload)
      ).resolves.toEqual({ status, error: null });
      expect(supabase.rpc).toHaveBeenCalledWith(
        "grant_team_invite_membership",
        {
          input_inviter_id: "inviter-1",
          input_user_id: "user-1",
          input_workspace_id: "workspace-1",
          input_company_id: "company-1",
          input_email: "client@example.com",
        }
      );
    }
  );

  it("passes no email when claiming email-bound access is unavailable", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValue({ data: [{ status: "joined" }], error: null }),
    };
    await grantTeamInviteMembership(supabase as never, {
      ...payload,
      email: null,
    });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "grant_team_invite_membership",
      expect.objectContaining({ input_email: null })
    );
  });

  it("propagates a database authority rejection without granting access", async () => {
    const error = {
      code: "42501",
      message: "Inviter can no longer grant membership",
    };
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: null, error }),
    };
    await expect(
      grantTeamInviteMembership(supabase as never, payload)
    ).resolves.toEqual({ status: "unresolved", error });
  });

  it.each([
    null,
    [],
    [{ status: "owner" }],
    [{ status: "joined" }, { status: "joined" }],
  ])("fails closed for invalid RPC result %j", async data => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data, error: null }),
    };
    await expect(
      grantTeamInviteMembership(supabase as never, payload)
    ).resolves.toMatchObject({
      status: "unresolved",
      error: expect.anything(),
    });
  });
});

describe("listWorkspaceMemberLabels", () => {
  it("limits name enrichment to requested workspace members", async () => {
    const membersQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({
        data: [{ user_id: "member-1", email: "member@example.com" }],
        error: null,
      }),
    };
    const usersQuery = {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({
        data: [{ id: "member-1", full_name: "Member" }],
        error: null,
      }),
    };
    const supabase = {
      from: jest.fn((table: string) =>
        table === "company_users" ? membersQuery : usersQuery
      ),
    };
    expect(
      await listWorkspaceMemberLabels(supabase as never, "workspace-1", [
        "member-1",
        "outside-user",
      ])
    ).toEqual([{ userId: "member-1", label: "Member" }]);
    expect(membersQuery.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(usersQuery.in).toHaveBeenCalledWith("id", ["member-1"]);
  });
  it("uses full name when present and email local-part otherwise", async () => {
    const membersQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        data: [
          { user_id: "user-2", email: "sam@example.com" },
          { user_id: "user-1", email: "dana@example.com" },
        ],
        error: null,
      }),
    };
    const usersQuery = {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({
        data: [{ id: "user-1", full_name: "Dana" }],
        error: null,
      }),
    };
    const supabase = {
      from: jest.fn((table: string) =>
        table === "company_users" ? membersQuery : usersQuery
      ),
    };

    const members = await listWorkspaceMemberLabels(
      supabase as never,
      "workspace-1"
    );

    expect(members).toEqual([
      { userId: "user-1", label: "Dana" },
      { userId: "user-2", label: "sam" },
    ]);
  });
});
