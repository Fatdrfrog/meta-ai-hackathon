import {
  getRegisteredUsersEmailAudienceSummary,
  isRegisteredUsersEmailAudienceEnabledForWorkspace,
  resolveRegisteredUsersEmailAudience,
} from "./registered-users-audience";

const mockCreateClient = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
    })),
    auth: { admin: { listUsers: jest.fn() } },
  },
}));

function mockAudienceAccess({
  platformAdmin = true,
  membership = true,
  workspace = {
    id: "41b51d55-697c-4455-875a-9a7238bdf272",
    company_id: "d81123b4-b2fa-49d3-86af-25b4482b8269",
  },
} = {}) {
  const client = {
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: {
          user: {
            id: "operator-1",
            app_metadata: platformAdmin ? { platform_role: "admin" } : {},
            user_metadata: { platform_role: "admin" },
          },
        },
      }),
    },
    from: jest.fn(
      (table: string) =>
        mockWorkspaceLookup(
          table === "company_users"
            ? membership
              ? { user_id: "operator-1" }
              : null
            : workspace
        ).query
    ),
  };
  mockCreateClient.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  mockAudienceAccess();
});

function mockAuthUsersPages(pages: Array<Record<string, unknown>>) {
  const listUsers = jest.fn(({ page }: { page?: number } = {}) =>
    Promise.resolve(
      pages[Math.max(0, (page || 1) - 1)] || {
        data: { users: [], nextPage: null, total: 0 },
        error: null,
      }
    )
  );

  return { listUsers };
}

function mockWorkspaceLookup(row: unknown, error: unknown = null) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: row,
      error,
    }),
  };

  return {
    query,
    supabase: {
      from: jest.fn().mockReturnValue(query),
    },
  };
}

describe("resolveRegisteredUsersEmailAudience", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves registered app auth users instead of workspace member rows", async () => {
    const authAdmin = mockAuthUsersPages([
      {
        data: {
          users: [
            {
              id: "user-1",
              email: "First@Example.com",
              email_confirmed_at: "2026-05-01T00:01:00.000Z",
              created_at: "2026-05-01T00:00:00.000Z",
              user_metadata: { full_name: "First User" },
            },
            {
              id: "user-2",
              email: "pending@example.com",
              email_confirmed_at: null,
              confirmed_at: null,
              created_at: "2026-05-02T00:00:00.000Z",
              user_metadata: { full_name: "Pending User" },
            },
            {
              id: "user-3",
              email: "not-an-email",
              email_confirmed_at: "2026-05-03T00:01:00.000Z",
              created_at: "2026-05-03T00:00:00.000Z",
              user_metadata: { full_name: "Invalid User" },
            },
            {
              id: "user-4",
              email: "dupe@example.com",
              email_confirmed_at: "2026-05-04T00:01:00.000Z",
              created_at: "2026-05-04T00:00:00.000Z",
              user_metadata: { full_name: "Dupe User" },
            },
            {
              id: "user-5",
              email: "DUPE@example.com",
              email_confirmed_at: "2026-05-05T00:01:00.000Z",
              created_at: "2026-05-05T00:00:00.000Z",
              user_metadata: { full_name: "Duplicate User" },
            },
            {
              id: "user-6",
              email: "anonymous@example.com",
              email_confirmed_at: "2026-05-06T00:01:00.000Z",
              created_at: "2026-05-06T00:00:00.000Z",
              user_metadata: { full_name: "Anonymous User" },
              is_anonymous: true,
            },
            {
              id: "user-7",
              email: "second@example.com",
              confirmed_at: "2026-05-07T00:01:00.000Z",
              created_at: "2026-05-07T00:00:00.000Z",
              user_metadata: {},
              identities: [
                {
                  identity_data: { full_name: "Second User" },
                },
              ],
            },
          ],
          nextPage: null,
          total: 7,
        },
        error: null,
      },
    ]);

    const audience = await resolveRegisteredUsersEmailAudience({
      workspaceId: "workspace-1",
      authAdmin: authAdmin as never,
    });

    expect(authAdmin.listUsers).toHaveBeenCalledWith({
      page: 1,
      perPage: 1000,
    });
    expect(audience).toEqual({
      recipients: [
        expect.objectContaining({
          email: "first@example.com",
          name: "First User",
          variables: expect.objectContaining({
            userId: "user-1",
            authUserId: "user-1",
            recipientName: "First User",
          }),
        }),
        expect.objectContaining({
          email: "dupe@example.com",
          name: "Dupe User",
          variables: expect.objectContaining({
            userId: "user-4",
            recipientName: "Dupe User",
          }),
        }),
        expect.objectContaining({
          email: "second@example.com",
          name: "Second User",
          variables: expect.objectContaining({
            userId: "user-7",
            recipientName: "Second User",
          }),
        }),
      ],
      totalAuthUsers: 7,
      skippedUnconfirmed: 1,
      skippedInvalidEmail: 1,
      skippedAnonymous: 1,
      skippedDuplicate: 1,
    });
  });

  it("adds locale variables from auth metadata before company language fallback", async () => {
    const authAdmin = mockAuthUsersPages([
      {
        data: {
          users: [
            {
              id: "user-1",
              email: "one@example.com",
              email_confirmed_at: "2026-05-01T00:01:00.000Z",
              created_at: "2026-05-01T00:00:00.000Z",
              user_metadata: { full_name: "One User", locale: "ru-RU" },
            },
            {
              id: "user-2",
              email: "two@example.com",
              email_confirmed_at: "2026-05-02T00:01:00.000Z",
              created_at: "2026-05-02T00:00:00.000Z",
              user_metadata: { full_name: "Two User" },
            },
          ],
          nextPage: null,
          total: 2,
        },
        error: null,
      },
    ]);
    const languageQuery = {
      in: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          {
            user_id: "user-1",
            workspaces: { companies: { airi_language: "kz" } },
          },
          {
            user_id: "user-2",
            workspaces: { companies: { lang: "kz" } },
          },
        ],
        error: null,
      }),
    };
    const supabase = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue(languageQuery),
      }),
    };

    const audience = await resolveRegisteredUsersEmailAudience({
      workspaceId: "workspace-1",
      authAdmin: authAdmin as never,
      supabase: supabase as never,
    });

    expect(languageQuery.in).toHaveBeenCalledWith("user_id", [
      "user-1",
      "user-2",
    ]);
    expect(audience.recipients).toEqual([
      expect.objectContaining({
        email: "one@example.com",
        variables: expect.objectContaining({
          locale: "ru",
          language: "ru",
        }),
      }),
      expect.objectContaining({
        email: "two@example.com",
        variables: expect.objectContaining({
          locale: "kz",
          language: "kz",
        }),
      }),
    ]);
  });

  it("keeps airi_language locales when the legacy company lang column is absent", async () => {
    const authAdmin = mockAuthUsersPages([
      {
        data: {
          users: [
            {
              id: "user-1",
              email: "one@example.com",
              email_confirmed_at: "2026-05-01T00:01:00.000Z",
              created_at: "2026-05-01T00:00:00.000Z",
              user_metadata: { full_name: "One User" },
            },
            {
              id: "user-2",
              email: "two@example.com",
              email_confirmed_at: "2026-05-02T00:01:00.000Z",
              created_at: "2026-05-02T00:00:00.000Z",
              user_metadata: { full_name: "Two User" },
            },
          ],
          nextPage: null,
          total: 2,
        },
        error: null,
      },
    ]);
    const airiLanguageQuery = {
      in: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          {
            user_id: "user-1",
            workspaces: { companies: { airi_language: "ru" } },
          },
          {
            user_id: "user-2",
            workspaces: { companies: { airi_language: null } },
          },
        ],
        error: null,
      }),
    };
    const langQuery = {
      in: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: null,
        error: {
          code: "42703",
          message: "column companies_2.lang does not exist",
        },
      }),
    };
    const supabase = {
      from: jest.fn().mockReturnValue({
        select: jest.fn((selection: string) =>
          selection.includes("airi_language") ? airiLanguageQuery : langQuery
        ),
      }),
    };

    const audience = await resolveRegisteredUsersEmailAudience({
      workspaceId: "workspace-1",
      authAdmin: authAdmin as never,
      supabase: supabase as never,
    });

    expect(airiLanguageQuery.in).toHaveBeenCalledWith("user_id", [
      "user-1",
      "user-2",
    ]);
    expect(langQuery.in).toHaveBeenCalledWith("user_id", ["user-2"]);
    expect(audience.recipients).toEqual([
      expect.objectContaining({
        email: "one@example.com",
        variables: expect.objectContaining({
          locale: "ru",
          language: "ru",
        }),
      }),
      expect.objectContaining({
        email: "two@example.com",
        variables: expect.objectContaining({
          locale: "en",
          language: "en",
        }),
      }),
    ]);
  });

  it("paginates through Supabase Auth users and previews the full small list", async () => {
    const authAdmin = mockAuthUsersPages([
      {
        data: {
          users: [
            {
              id: "user-1",
              email: "one@example.com",
              email_confirmed_at: "2026-05-01T00:01:00.000Z",
              created_at: "2026-05-01T00:00:00.000Z",
              user_metadata: { full_name: "One User" },
            },
          ],
          nextPage: 2,
          total: 2,
        },
        error: null,
      },
      {
        data: {
          users: [
            {
              id: "user-2",
              email: "two@example.com",
              email_confirmed_at: "2026-05-02T00:01:00.000Z",
              created_at: "2026-05-02T00:00:00.000Z",
              user_metadata: { full_name: "Two User" },
            },
          ],
          nextPage: null,
          total: 2,
        },
        error: null,
      },
    ]);

    const summary = await getRegisteredUsersEmailAudienceSummary({
      workspaceId: "workspace-1",
      authAdmin: authAdmin as never,
    });

    expect(authAdmin.listUsers).toHaveBeenCalledTimes(2);
    expect(authAdmin.listUsers).toHaveBeenNthCalledWith(1, {
      page: 1,
      perPage: 1000,
    });
    expect(authAdmin.listUsers).toHaveBeenNthCalledWith(2, {
      page: 2,
      perPage: 1000,
    });
    expect(summary.total).toBe(2);
    expect(summary.totalAuthUsers).toBe(2);
    expect(summary.preview).toEqual([
      {
        userId: "user-1",
        email: "one@example.com",
        name: "One User",
        registeredAt: "2026-05-01T00:00:00.000Z",
        locale: "en",
      },
      {
        userId: "user-2",
        email: "two@example.com",
        name: "Two User",
        registeredAt: "2026-05-02T00:00:00.000Z",
        locale: "en",
      },
    ]);
  });
});

describe("isRegisteredUsersEmailAudienceEnabledForWorkspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AIRI_CHAT_REGISTERED_USERS_COMPANY_IDS;
    delete process.env.AIRI_CHAT_REGISTERED_USERS_WORKSPACE_IDS;
  });

  it("enables the registered app users audience for the Airi.chat workspace", async () => {
    const supabase = mockAudienceAccess({
      workspace: {
        id: "41b51d55-697c-4455-875a-9a7238bdf272",
        company_id: "d81123b4-b2fa-49d3-86af-25b4482b8269",
      },
    });

    await expect(
      isRegisteredUsersEmailAudienceEnabledForWorkspace({
        workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
      })
    ).resolves.toBe(true);

    expect(supabase.from).toHaveBeenCalledWith("workspaces");
    expect(supabase.from.mock.results[1].value.eq).toHaveBeenCalledWith(
      "id",
      "41b51d55-697c-4455-875a-9a7238bdf272"
    );
  });

  it("disables the registered app users audience for non-Airi workspaces", async () => {
    mockAudienceAccess({
      workspace: {
        id: "11111111-1111-4111-8111-111111111111",
        company_id: "22222222-2222-4222-8222-222222222222",
      },
    });

    await expect(
      isRegisteredUsersEmailAudienceEnabledForWorkspace({
        workspaceId: "11111111-1111-4111-8111-111111111111",
      })
    ).resolves.toBe(false);
  });

  it("supports environment allowlist overrides for non-production projects", async () => {
    process.env.AIRI_CHAT_REGISTERED_USERS_COMPANY_IDS =
      "33333333-3333-4333-8333-333333333333";
    process.env.AIRI_CHAT_REGISTERED_USERS_WORKSPACE_IDS =
      "44444444-4444-4444-8444-444444444444";

    mockAudienceAccess({
      workspace: {
        id: "44444444-4444-4444-8444-444444444444",
        company_id: "55555555-5555-4555-8555-555555555555",
      },
    });

    await expect(
      isRegisteredUsersEmailAudienceEnabledForWorkspace({
        workspaceId: "44444444-4444-4444-8444-444444444444",
      })
    ).resolves.toBe(true);
  });

  it("denies an airi workspace admin with only editable platform metadata", async () => {
    mockAudienceAccess({ platformAdmin: false });

    await expect(
      isRegisteredUsersEmailAudienceEnabledForWorkspace({
        workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
      })
    ).resolves.toBe(false);
  });

  it("denies a platform admin without exact workspace membership", async () => {
    mockAudienceAccess({ membership: false });

    await expect(
      isRegisteredUsersEmailAudienceEnabledForWorkspace({
        workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
      })
    ).resolves.toBe(false);
  });

  it("blocks direct global audience resolution before reading Auth users", async () => {
    mockAudienceAccess({ platformAdmin: false });
    const authAdmin = mockAuthUsersPages([]);

    await expect(
      getRegisteredUsersEmailAudienceSummary({
        workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
        authAdmin: authAdmin as never,
      })
    ).rejects.toThrow("Forbidden");
    expect(authAdmin.listUsers).not.toHaveBeenCalled();
  });

  it("blocks direct audience resolution by platform admins outside the fixed workspace allowlist", async () => {
    mockAudienceAccess({
      workspace: { id: "customer-workspace", company_id: "customer-company" },
    });
    const authAdmin = mockAuthUsersPages([]);

    await expect(
      resolveRegisteredUsersEmailAudience({
        workspaceId: "customer-workspace",
        authAdmin: authAdmin as never,
      })
    ).rejects.toThrow("Forbidden");
    expect(authAdmin.listUsers).not.toHaveBeenCalled();
  });
});
