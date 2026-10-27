const mockCreateClient = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

import {
  requireWorkspaceApiAccess,
  requireWorkspaceApiAccessWithRead,
} from "@/lib/supabase/workspace-api-access";

describe("workspace API access", () => {
  const membership = jest.fn();
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: membership,
  };
  const supabase = {
    from: jest.fn().mockReturnValue(query),
    auth: {
      getUser: jest.fn(),
      getSession: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue(supabase);
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: "session-token" } },
    });
    membership.mockResolvedValue({
      data: { user_id: "user-1", workspace_id: "workspace-1" },
      error: null,
    });
  });

  it("rejects an absent verified user before membership or session reads", async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: null } });
    const result = await requireWorkspaceApiAccess("workspace-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected access denial");
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: "Unauthorized" });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: null, error: { message: "lookup failed" } },
    { data: { user_id: "user-1" }, error: { message: "lookup failed" } },
  ])(
    "denies missing or failed membership without reading a session: %j",
    async value => {
      membership.mockResolvedValue(value);
      const result = await requireWorkspaceApiAccess("workspace-1");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected access denial");
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: "Forbidden" });
      expect(supabase.auth.getSession).not.toHaveBeenCalled();
    }
  );

  it.each(["session-token", null])(
    "scopes membership to both identities and returns the optional token: %s",
    async token => {
      supabase.auth.getSession.mockResolvedValue({
        data: { session: token ? { access_token: token } : null },
      });
      const result = await requireWorkspaceApiAccess("workspace-1");
      expect(supabase.from).toHaveBeenCalledWith("company_users");
      expect(query.eq.mock.calls).toEqual([
        ["user_id", "user-1"],
        ["workspace_id", "workspace-1"],
      ]);
      expect(membership.mock.invocationCallOrder[0]).toBeGreaterThan(
        supabase.auth.getUser.mock.invocationCallOrder[0]
      );
      expect(
        supabase.auth.getSession.mock.invocationCallOrder[0]
      ).toBeGreaterThan(membership.mock.invocationCallOrder[0]);
      expect(result).toEqual({
        ok: true,
        supabase,
        userId: "user-1",
        accessToken: token,
      });
    }
  );

  describe("with a read overlapping the membership check", () => {
    it("never starts the read for a caller who is not signed in", async () => {
      supabase.auth.getUser.mockResolvedValue({ data: { user: null } });
      const startRead = jest.fn(async () => "scenario");

      const result = await requireWorkspaceApiAccessWithRead(
        "workspace-1",
        startRead
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected access denial");
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({ error: "Unauthorized" });
      expect(startRead).not.toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("starts the read after the user check, alongside membership", async () => {
      let finishMembership!: (value: unknown) => void;
      membership.mockReturnValueOnce(
        new Promise(resolve => {
          finishMembership = resolve;
        })
      );
      const startRead = jest.fn(async () => "scenario");

      const pending = requireWorkspaceApiAccessWithRead(
        "workspace-1",
        startRead
      );
      await new Promise(resolve => setImmediate(resolve));
      expect(startRead).toHaveBeenCalledTimes(1);
      expect(startRead.mock.invocationCallOrder[0]).toBeGreaterThan(
        supabase.auth.getUser.mock.invocationCallOrder[0]
      );
      expect(supabase.auth.getSession).not.toHaveBeenCalled();

      finishMembership({ data: { user_id: "user-1" }, error: null });
      const result = await pending;
      expect(result).toEqual({
        ok: true,
        supabase,
        userId: "user-1",
        accessToken: "session-token",
        read: expect.any(Promise),
      });
      if (!result.ok) throw new Error("Expected access");
      await expect(result.read).resolves.toBe("scenario");
    });

    it("denies a non-member and discards the read, rejection included", async () => {
      const unhandled = jest.fn();
      process.on("unhandledRejection", unhandled);
      try {
        membership.mockResolvedValue({ data: null, error: null });
        const startRead = jest.fn(() =>
          Promise.reject(new Error("mongo offline"))
        );

        const result = await requireWorkspaceApiAccessWithRead(
          "workspace-1",
          startRead
        );
        for (let round = 0; round < 3; round += 1) {
          await new Promise(resolve => setImmediate(resolve));
        }

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected access denial");
        expect(result.response.status).toBe(403);
        expect(result).not.toHaveProperty("read");
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });
});
