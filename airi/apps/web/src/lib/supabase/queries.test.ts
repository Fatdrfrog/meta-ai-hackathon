jest.mock("server-only", () => ({}));

import { getUserCompany, resolveUserWorkspaceMembership } from "./queries";

describe("getUserCompany", () => {
  const company = {
    id: "company-1",
    name: "Acme",
    slug: "acme",
    business_context: null,
    dynamic_context_tags: null,
    trial_starts_at: null,
    trial_ends_at: null,
    airi_language: "en",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  function client(result: { data: unknown; error: unknown }) {
    const query = {
      from: jest.fn(),
      select: jest.fn(),
      eq: jest.fn(),
      order: jest.fn(),
      limit: jest.fn(),
      single: jest.fn(),
    };

    query.from.mockReturnValue(query);
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    query.single.mockResolvedValue(result);
    return query;
  }

  function selectedCompanyColumns(query: ReturnType<typeof client>) {
    const select = String(query.select.mock.calls[0][0]);
    const columns = select.match(
      /companies!workspaces_company_id_fkey\s*\(([^)]*)\)/
    )?.[1];
    return (columns ?? "")
      .split(",")
      .map(column => column.trim())
      .filter(Boolean);
  }

  it("resolves the first workspace deterministically by membership creation time", async () => {
    const query = client({
      data: {
        workspace_id: "workspace-1",
        workspaces: {
          id: "workspace-1",
          company_id: "company-1",
          companies: company,
        },
      },
      error: null,
    });

    await expect(getUserCompany(query as never, "user-1")).resolves.toEqual({
      company_id: "company-1",
      workspaces: { id: "workspace-1" },
      companies: company,
    });

    expect(query.order).toHaveBeenCalledWith("created_at", {
      ascending: true,
    });
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  // PostgREST rejects the whole query when one embedded column is unknown, and
  // the legacy `lang` column no longer exists, which made this return null for
  // every user (column companies_2.lang does not exist).
  it("selects only columns that exist on companies", async () => {
    const query = client({ data: null, error: null });

    await getUserCompany(query as never, "user-1");

    expect(selectedCompanyColumns(query)).toEqual([
      "id",
      "name",
      "slug",
      "business_context",
      "dynamic_context_tags",
      "trial_starts_at",
      "trial_ends_at",
      "airi_language",
      "created_at",
    ]);
  });

  it("returns null when the lookup fails", async () => {
    const query = client({
      data: null,
      error: {
        code: "42703",
        message: "column companies_2.lang does not exist",
      },
    });

    await expect(getUserCompany(query as never, "user-1")).resolves.toBeNull();
  });
});

describe("resolveUserWorkspaceMembership", () => {
  function client(workspaceIds: string[], error: unknown = null) {
    const filters = new Map<string, unknown>();
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn((key: string, value: unknown): object => {
        filters.set(key, value);
        return query;
      }),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({
        data: workspaceIds.includes(String(filters.get("workspace_id")))
          ? { user_id: "user-1" }
          : null,
        error,
      })),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: workspaceIds
            .slice(0, 2)
            .map(workspace_id => ({ workspace_id })),
          error,
        }).then(resolve),
    };
    return { from: jest.fn(() => query), query };
  }

  it("selects the requested workspace even with multiple company memberships", async () => {
    const supabase = client(["workspace-1", "workspace-2"]);
    await expect(
      resolveUserWorkspaceMembership(supabase as never, "user-1", "workspace-2")
    ).resolves.toEqual({ ok: true, workspaceId: "workspace-2" });
    expect(supabase.query.eq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-2"
    );
    expect(supabase.query.limit).not.toHaveBeenCalled();
  });

  it("denies a workspace outside the user's memberships", async () => {
    const supabase = client(["workspace-1", "workspace-2"]);
    await expect(
      resolveUserWorkspaceMembership(supabase as never, "user-1", "workspace-3")
    ).resolves.toEqual({ ok: false, status: 403, error: "Forbidden" });
  });

  it("retains legacy requests only for one unambiguous membership", async () => {
    const supabase = client(["workspace-1"]);
    await expect(
      resolveUserWorkspaceMembership(supabase as never, "user-1")
    ).resolves.toEqual({ ok: true, workspaceId: "workspace-1" });
    expect(supabase.query.limit).toHaveBeenCalledWith(2);
  });

  it("requires a workspace instead of choosing the first membership", async () => {
    const supabase = client(["workspace-1", "workspace-2"]);
    await expect(
      resolveUserWorkspaceMembership(supabase as never, "user-1")
    ).resolves.toEqual({
      ok: false,
      status: 400,
      error: "workspaceId is required when you belong to multiple workspaces",
    });
  });

  it.each(["", " ", 42, {}])(
    "rejects malformed explicit workspace selection: %j",
    async selection => {
      const supabase = client(["workspace-1"]);
      await expect(
        resolveUserWorkspaceMembership(supabase as never, "user-1", selection)
      ).resolves.toEqual({
        ok: false,
        status: 400,
        error: "Invalid workspaceId",
      });
      expect(supabase.from).not.toHaveBeenCalled();
    }
  );

  it("denies empty memberships and fails closed on lookup errors", async () => {
    await expect(
      resolveUserWorkspaceMembership(client([]) as never, "user-1")
    ).resolves.toEqual({ ok: false, status: 403, error: "Forbidden" });
    await expect(
      resolveUserWorkspaceMembership(
        client(["workspace-1"], { message: "offline" }) as never,
        "user-1"
      )
    ).resolves.toEqual({
      ok: false,
      status: 500,
      error: "Failed to verify workspace membership",
    });
  });
});
