import { requireAppAdmin } from "./app-admin";

type AuthUserFixture = {
  id: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
};

function createSupabase(user: AuthUserFixture | null) {
  const profileQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: null,
      error: { message: "role column is unavailable" },
    }),
  };
  return {
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user } }),
    },
    from: jest.fn().mockReturnValue(profileQuery),
  };
}

function asAppAdminClient(client: ReturnType<typeof createSupabase>) {
  return client as unknown as Parameters<typeof requireAppAdmin>[0];
}

describe("requireAppAdmin", () => {
  it("returns 401 when there is no authenticated user", async () => {
    const result = await requireAppAdmin(
      asAppAdminClient(createSupabase(null))
    );

    expect(result.userId).toBeNull();
    expect(result.response?.status).toBe(401);
  });

  it.each([
    [{ id: "user-1" }, 403],
    [
      {
        id: "user-1",
        app_metadata: { platform_role: "member" },
      },
      403,
    ],
    [
      {
        id: "user-1",
        user_metadata: { platform_role: "admin" },
      },
      403,
    ],
  ] as const)(
    "denies non-platform-admin fixture %#",
    async (user, expectedStatus) => {
      const result = await requireAppAdmin(
        asAppAdminClient(createSupabase(user))
      );

      expect(result.userId).toBe("user-1");
      expect(result.response?.status).toBe(expectedStatus);
    }
  );

  it("allows a service-managed platform admin without querying public profiles", async () => {
    const supabase = createSupabase({
      id: "user-1",
      app_metadata: { platform_role: "admin" },
    });

    const result = await requireAppAdmin(asAppAdminClient(supabase));

    expect(result.userId).toBe("user-1");
    expect(result.response).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
