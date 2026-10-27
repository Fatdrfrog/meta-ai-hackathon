const mockSupabaseFrom = jest.fn();
const mockAdminFrom = jest.fn();
const mockAdminRpc = jest.fn();
const mockAuthGetUser = jest.fn();
const mockAuthUpdateUser = jest.fn();
const mockAdminUpdateUserById = jest.fn();
const mockAdminGetUserById = jest.fn();
const mockUsersUpsert = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(async () => ({
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    auth: {
      getUser: (...args: unknown[]) => mockAuthGetUser(...args),
      updateUser: (...args: unknown[]) => mockAuthUpdateUser(...args),
    },
  })),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
    rpc: (...args: unknown[]) => mockAdminRpc(...args),
    auth: {
      admin: {
        getUserById: (...args: unknown[]) => mockAdminGetUserById(...args),
        updateUserById: (...args: unknown[]) =>
          mockAdminUpdateUserById(...args),
      },
    },
  },
}));

import {
  getAccountMergePreviewForUser,
  getAccountMergeRedirectPath,
  mergeAccountAssetsForUser,
  rememberAccountMergeSkip,
} from "./account-merge";

function selectQuery(result: { data: unknown[] | null; error: unknown }) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    ilike: jest.fn(),
    neq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.ilike.mockReturnValue(query);
  query.neq.mockReturnValue(query);
  query.in.mockResolvedValue(result);
  query.order.mockResolvedValue(result);

  return query;
}

function updateQuery(result: { error: unknown } = { error: null }) {
  const query = {
    update: jest.fn(),
    eq: jest.fn(),
    ilike: jest.fn(),
    select: jest.fn(),
    single: jest.fn(),
  };

  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.ilike.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.single.mockResolvedValue(result);

  return query;
}

function deleteQuery(result: { error: unknown } = { error: null }) {
  const query = {
    delete: jest.fn(),
    eq: jest.fn(),
    ilike: jest.fn(),
    select: jest.fn(),
    single: jest.fn(),
  };

  query.delete.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.ilike.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.single.mockResolvedValue(result);

  return query;
}

function useCompanyUserQueries(queries: unknown[]) {
  const queue = [...queries];

  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === "users") {
      return {
        upsert: mockUsersUpsert.mockResolvedValue({ error: null }),
      };
    }

    if (table !== "company_users") {
      throw new Error(`Unexpected table: ${table}`);
    }

    const next = queue.shift();
    if (!next) {
      throw new Error("Unexpected company_users query");
    }

    return next;
  });
  mockAdminFrom.mockImplementation((table: string) => {
    if (table !== "company_users") {
      throw new Error(`Unexpected admin table: ${table}`);
    }
    const next = queue.shift();
    if (!next) throw new Error("Unexpected admin company_users query");
    return next;
  });
}

const verifiedCurrentUser = {
  id: "current-user",
  email: "founder@example.com",
  confirmed_at: "2026-01-01T00:00:00.000Z",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  user_metadata: { full_name: "Founder", avatar_url: "https://avatar" },
};

const legacyMembership = {
  id: "membership-old-1",
  user_id: "legacy-user-1",
  workspace_id: "workspace-1",
  role: "admin",
  email: "founder@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
  workspaces: {
    id: "workspace-1",
    name: "Support",
    companies: { name: "Airi Demo" },
  },
};

describe("account asset merge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseFrom.mockReset();
    mockAdminFrom.mockReset();
    mockAdminRpc.mockReset();
    mockAdminGetUserById.mockReset();
    mockAdminGetUserById.mockImplementation(async (userId: string) => ({
      data: { user: { id: userId, email: "founder@example.com" } },
      error: null,
    }));
    mockAdminRpc.mockResolvedValue({
      data: [{ moved: 1, deduplicated: 1 }],
      error: null,
    });
    mockAuthGetUser.mockResolvedValue({
      data: { user: verifiedCurrentUser },
      error: null,
    });
    mockAuthUpdateUser.mockResolvedValue({ data: { user: {} }, error: null });
    mockAdminUpdateUserById.mockResolvedValue({
      data: { user: {} },
      error: null,
    });
  });

  it("redirects authenticated users to the merge prompt when legacy memberships share their email", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);

    const redirectPath = await getAccountMergeRedirectPath(
      {
        id: "current-user",
        email: "founder@example.com",
        confirmed_at: "2026-01-01T00:00:00.000Z",
        email_confirmed_at: "2026-01-01T00:00:00.000Z",
      },
      "/panel/w/current-workspace/requests"
    );

    expect(redirectPath).toBe(
      "/auth/merge-assets?next=%2Fpanel%2Fw%2Fcurrent-workspace%2Frequests"
    );
  });

  it("matches legacy memberships with different email casing", async () => {
    useCompanyUserQueries([
      selectQuery({
        data: [{ ...legacyMembership, email: "Founder@Example.com" }],
        error: null,
      }),
    ]);

    const redirectPath = await getAccountMergeRedirectPath(
      {
        id: "current-user",
        email: "founder@example.com",
        confirmed_at: "2026-01-01T00:00:00.000Z",
        email_confirmed_at: "2026-01-01T00:00:00.000Z",
      },
      "/panel/w/current-workspace/requests"
    );

    expect(redirectPath).toBe(
      "/auth/merge-assets?next=%2Fpanel%2Fw%2Fcurrent-workspace%2Frequests"
    );
  });

  it("does not prompt unverified email users", async () => {
    const redirectPath = await getAccountMergeRedirectPath(
      {
        id: "current-user",
        email: "founder@example.com",
        confirmed_at: undefined,
        email_confirmed_at: undefined,
      },
      "/onboarding"
    );

    expect(redirectPath).toBeNull();
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });

  it("stores a skip signature so the same legacy candidates are not prompted repeatedly", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);

    await rememberAccountMergeSkip({
      id: "current-user",
      email: "founder@example.com",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      email_confirmed_at: "2026-01-01T00:00:00.000Z",
    });

    expect(mockAuthUpdateUser).toHaveBeenCalledWith({
      data: {
        airi_asset_merge_decided_emails: ["founder@example.com"],
        airi_asset_merge_skip_signature: null,
      },
    });
    expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
  });

  it("does not prompt again after the user has already decided for that email", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          ...verifiedCurrentUser,
          user_metadata: {
            airi_asset_merge_decided_emails: ["founder@example.com"],
          },
        },
      },
      error: null,
    });

    const redirectPath = await getAccountMergeRedirectPath(
      {
        id: "current-user",
        email: "founder@example.com",
        confirmed_at: "2026-01-01T00:00:00.000Z",
        email_confirmed_at: "2026-01-01T00:00:00.000Z",
        user_metadata: {
          airi_asset_merge_decided_emails: ["founder@example.com"],
        },
      },
      "/panel/w/current-workspace/requests"
    );

    expect(redirectPath).toBeNull();
  });

  it("moves non-conflicting memberships and deduplicates existing workspace access", async () => {
    const duplicateMembership = {
      ...legacyMembership,
      id: "membership-old-2",
      workspace_id: "workspace-2",
      role: "admin",
      workspaces: {
        id: "workspace-2",
        name: "Sales",
        companies: { name: "Airi Demo" },
      },
    };
    useCompanyUserQueries([
      selectQuery({
        data: [legacyMembership, duplicateMembership],
        error: null,
      }),
    ]);

    const result = await mergeAccountAssetsForUser({
      id: "current-user",
      email: "founder@example.com",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      email_confirmed_at: "2026-01-01T00:00:00.000Z",
      user_metadata: { full_name: "Founder", avatar_url: "https://avatar" },
    } as never);

    expect(result).toMatchObject({
      moved: 1,
      deduplicated: 1,
    });
    expect(mockUsersUpsert).toHaveBeenCalledWith(
      {
        id: "current-user",
        full_name: "Founder",
        avatar_url: "https://avatar",
      },
      { onConflict: "id" }
    );
    expect(mockAdminRpc).toHaveBeenCalledWith(
      "merge_verified_account_memberships",
      {
        input_user_id: "current-user",
        input_verified_email: "founder@example.com",
        input_candidates: [
          {
            membership_id: "membership-old-1",
            legacy_user_id: "legacy-user-1",
            workspace_id: "workspace-1",
            expected_role: "admin",
          },
          {
            membership_id: "membership-old-2",
            legacy_user_id: "legacy-user-1",
            workspace_id: "workspace-2",
            expected_role: "admin",
          },
        ],
      }
    );
    expect(mockAdminFrom).toHaveBeenCalledTimes(1);
    expect(mockAuthUpdateUser).toHaveBeenCalledWith({
      data: {
        airi_asset_merge_decided_emails: ["founder@example.com"],
        airi_asset_merge_skip_signature: null,
      },
    });
    expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
  });

  it("deduplicates later legacy rows after moving the first row for a workspace", async () => {
    const secondLegacyMembership = {
      ...legacyMembership,
      id: "membership-old-2",
      role: "admin",
      created_at: "2026-01-02T00:00:00.000Z",
    };
    useCompanyUserQueries([
      selectQuery({
        data: [legacyMembership, secondLegacyMembership],
        error: null,
      }),
    ]);

    const result = await mergeAccountAssetsForUser({
      id: "current-user",
      email: "founder@example.com",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      email_confirmed_at: "2026-01-01T00:00:00.000Z",
      user_metadata: { full_name: "Founder" },
    } as never);

    expect(result).toMatchObject({
      moved: 1,
      deduplicated: 1,
    });
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    expect(mockAdminRpc).toHaveBeenCalledWith(
      "merge_verified_account_memberships",
      {
        input_user_id: "current-user",
        input_verified_email: "founder@example.com",
        input_candidates: [
          {
            membership_id: "membership-old-1",
            legacy_user_id: "legacy-user-1",
            workspace_id: "workspace-1",
            expected_role: "admin",
          },
          {
            membership_id: "membership-old-2",
            legacy_user_id: "legacy-user-1",
            workspace_id: "workspace-1",
            expected_role: "admin",
          },
        ],
      }
    );
  });

  it("uses the trusted membership writer when the session client cannot mutate memberships", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "company_users") {
        throw new Error(
          "Authenticated membership mutation/read unavailable for legacy accounts"
        );
      }
      return { upsert: mockUsersUpsert.mockResolvedValue({ error: null }) };
    });

    await expect(
      mergeAccountAssetsForUser(verifiedCurrentUser as never)
    ).resolves.toMatchObject({ moved: 1 });
    expect(mockAdminFrom).toHaveBeenCalledWith("company_users");
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    expect(mockSupabaseFrom).toHaveBeenCalledTimes(1);
    expect(mockSupabaseFrom).toHaveBeenCalledWith("users");
  });

  it.each([
    ["missing session", null],
    ["different session user", { ...verifiedCurrentUser, id: "other-user" }],
    [
      "different verified email",
      { ...verifiedCurrentUser, email: "other@example.com" },
    ],
  ])(
    "rejects %s before using privileged membership access",
    async (_label, sessionUser) => {
      mockAuthGetUser.mockResolvedValue({
        data: { user: sessionUser },
        error: null,
      });
      await expect(
        mergeAccountAssetsForUser(verifiedCurrentUser as never)
      ).rejects.toThrow("Could not verify account merge identity");
      expect(mockAdminFrom).not.toHaveBeenCalled();
      expect(mockAdminRpc).not.toHaveBeenCalled();
      expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
      expect(mockUsersUpsert).not.toHaveBeenCalled();
    }
  );

  it("does not trust a stale confirmed caller when the session email is unverified", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          ...verifiedCurrentUser,
          email_confirmed_at: null,
          confirmed_at: null,
        },
      },
      error: null,
    });
    await expect(
      getAccountMergePreviewForUser(verifiedCurrentUser)
    ).resolves.toBeNull();
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("does not treat phone confirmation as verified email ownership", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: { user: { ...verifiedCurrentUser, email_confirmed_at: null } },
      error: null,
    });
    await expect(
      getAccountMergePreviewForUser(verifiedCurrentUser)
    ).resolves.toBeNull();
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("stops when a legacy membership changed after its verified email preview", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);
    mockAdminRpc.mockResolvedValue({
      data: null,
      error: new Error("Membership no longer matches verified email"),
    });
    await expect(
      mergeAccountAssetsForUser(verifiedCurrentUser as never)
    ).rejects.toThrow("Membership no longer matches verified email");
    expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
  });

  it("does not promote a duplicate membership before discovering stale legacy ownership", async () => {
    const promotion = updateQuery();
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
      selectQuery({
        data: [
          {
            id: "current-member",
            workspace_id: "workspace-1",
            role: "manager",
          },
        ],
        error: null,
      }),
      promotion,
      deleteQuery({ error: new Error("Legacy membership changed") }),
    ]);
    mockAdminRpc.mockResolvedValue({
      data: null,
      error: new Error("Legacy membership changed"),
    });
    await expect(
      mergeAccountAssetsForUser(verifiedCurrentUser as never)
    ).rejects.toThrow("Legacy membership changed");
    expect(promotion.update).not.toHaveBeenCalled();
    expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
  });

  it.each(["skip", "merge"])(
    "records %s preferences without writing trusted or unrelated metadata",
    async operation => {
      useCompanyUserQueries([
        selectQuery({ data: [legacyMembership], error: null }),
      ]);
      mockAuthGetUser.mockResolvedValue({
        data: {
          user: {
            ...verifiedCurrentUser,
            app_metadata: {
              platform_role: "admin",
              providers: ["google"],
              provider: "google",
              custom_trusted_field: { enabled: true },
              airi_asset_merge_skip_signature: "legacy-signature",
              airi_asset_merge_decided_emails: ["old@example.com"],
            },
            user_metadata: {
              ...verifiedCurrentUser.user_metadata,
              platform_role: "admin",
              providers: ["spoofed"],
              custom_preference: "retain",
            },
          },
        },
        error: null,
      });
      if (operation === "skip") {
        await rememberAccountMergeSkip(verifiedCurrentUser);
      } else {
        await mergeAccountAssetsForUser(verifiedCurrentUser as never);
      }
      expect(mockAuthUpdateUser).toHaveBeenCalledWith({
        data: {
          airi_asset_merge_decided_emails: [
            "founder@example.com",
            "old@example.com",
          ],
          airi_asset_merge_skip_signature: null,
        },
      });
      expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
    }
  );

  it("still reads merge decisions stored in legacy app metadata", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          ...verifiedCurrentUser,
          app_metadata: {
            airi_asset_merge_decided_emails: ["founder@example.com"],
          },
        },
      },
      error: null,
    });

    await expect(
      getAccountMergeRedirectPath(
        verifiedCurrentUser,
        "/panel/w/workspace-1/airi"
      )
    ).resolves.toBeNull();
    expect(mockAuthUpdateUser).not.toHaveBeenCalled();
    expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
  });

  it("propagates a failure to save authenticated decision preferences", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);
    mockAuthUpdateUser.mockResolvedValue({
      data: { user: null },
      error: new Error("Decision preferences could not be saved"),
    });

    await expect(rememberAccountMergeSkip(verifiedCurrentUser)).rejects.toThrow(
      "Decision preferences could not be saved"
    );
    expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
  });

  it("ignores stale membership emails when the legacy auth account now has a different email", async () => {
    useCompanyUserQueries([
      selectQuery({ data: [legacyMembership], error: null }),
    ]);
    mockAdminGetUserById.mockResolvedValue({
      data: { user: { id: "legacy-user-1", email: "different@example.com" } },
      error: null,
    });
    await expect(
      getAccountMergePreviewForUser(verifiedCurrentUser)
    ).resolves.toBeNull();
    expect(mockAdminRpc).not.toHaveBeenCalled();
    expect(mockAdminGetUserById).toHaveBeenCalledWith("legacy-user-1");
  });

  it("checks each legacy auth identity once across several workspace memberships", async () => {
    useCompanyUserQueries([
      selectQuery({
        data: [
          legacyMembership,
          { ...legacyMembership, id: "old-2", workspace_id: "workspace-2" },
        ],
        error: null,
      }),
    ]);
    await expect(
      getAccountMergePreviewForUser(verifiedCurrentUser)
    ).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect(mockAdminGetUserById).toHaveBeenCalledTimes(1);
  });
});
