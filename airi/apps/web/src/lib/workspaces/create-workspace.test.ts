const mockTrackWorkspaceCreated = jest.fn();
const mockEmitWorkspaceUsageDeltaBestEffort = jest.fn();
const mockEnsureCompanyWorkspaceCapacity = jest.fn();
const mockEnsureNewWorkspaceAiriDefaults = jest.fn();
const mockAdminFrom = jest.fn();
const mockAdminRpc = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
    rpc: (...args: unknown[]) => mockAdminRpc(...args),
  },
}));

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  ensureNewWorkspaceAiriDefaults: (...args: unknown[]) =>
    mockEnsureNewWorkspaceAiriDefaults(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackWorkspaceCreated: (...args: unknown[]) =>
    mockTrackWorkspaceCreated(...args),
}));

jest.mock("@/lib/tracking-consent-server", () => ({
  readServerTrackingConsent: async () => "granted",
}));

jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: (...args: unknown[]) =>
    mockEmitWorkspaceUsageDeltaBestEffort(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyWorkspaceCapacity: (...args: unknown[]) =>
    mockEnsureCompanyWorkspaceCapacity(...args),
}));

import { createWorkspaceForCompany } from "./create-workspace";

function createSupabaseMock(options: {
  memberships?: unknown[];
  membershipError?: unknown;
}) {
  const membershipQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({
      data: options.memberships ?? [
        {
          role: "admin",
          workspace_id: "existing-workspace-1",
          workspaces: { company_id: "company-1" },
        },
      ],
      error: options.membershipError ?? null,
    }),
  };

  const supabase = {
    from: jest.fn((table: string) => {
      if (table !== "company_users") {
        throw new Error(`Unexpected table: ${table}`);
      }
      return membershipQuery;
    }),
  };

  return {
    supabase,
    membershipQuery,
  };
}

describe("createWorkspaceForCompany", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureCompanyWorkspaceCapacity.mockResolvedValue({ allowed: true });
    mockEnsureNewWorkspaceAiriDefaults.mockResolvedValue(undefined);
    mockAdminRpc.mockResolvedValue({
      data: [
        {
          id: "created-workspace-1",
          name: "New workspace",
          company_id: "company-1",
          created_at: "2026-06-29T00:00:00.000Z",
        },
      ],
      error: null,
    });
  });

  it("authorizes with the caller client and creates through the trusted server client", async () => {
    const { supabase } = createSupabaseMock({});

    const result = await createWorkspaceForCompany({
      supabase: supabase as never,
      user: { id: "user-1", email: "owner@example.com" },
      name: "New workspace",
      companyId: "company-1",
    });

    expect(result).toEqual({
      ok: true,
      workspace: {
        id: "created-workspace-1",
        name: "New workspace",
        company_id: "company-1",
        created_at: "2026-06-29T00:00:00.000Z",
      },
    });
    expect(mockAdminRpc).toHaveBeenCalledWith(
      "create_authorized_company_workspace",
      {
        input_actor_id: "user-1",
        input_company_id: "company-1",
        input_name: "New workspace",
        input_email: "owner@example.com",
      }
    );
    // Counted with the trusted client: an admin may not see every workspace.
    expect(mockEnsureCompanyWorkspaceCapacity).toHaveBeenCalledWith(
      jest.requireMock("@/lib/supabase/admin").supabaseAdmin,
      "existing-workspace-1"
    );
    expect(supabase.from).not.toHaveBeenCalledWith("workspaces");
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(mockTrackWorkspaceCreated).toHaveBeenCalledWith(
      "company-1",
      "created-workspace-1",
      "New workspace",
      "user-1",
      { consent: "granted" }
    );
    expect(mockEmitWorkspaceUsageDeltaBestEffort).toHaveBeenCalledWith(
      {
        workspaceId: "created-workspace-1",
        companyId: "company-1",
        metric: "workspace_count",
        delta: 1,
        objectId: "created-workspace-1",
        source: "workspace_route",
      },
      {
        supabase,
        logContext: "workspaces.createWorkspaceForCompany",
      }
    );
    expect(mockEnsureNewWorkspaceAiriDefaults).toHaveBeenCalledWith({
      workspaceId: "created-workspace-1",
      updatedBy: "user-1",
    });
  });

  it.each(["manager", "member", "owner"])(
    "does not create a workspace for the %s role",
    async role => {
      const { supabase } = createSupabaseMock({
        memberships: [
          {
            role,
            workspace_id: "existing-workspace-1",
            workspaces: { company_id: "company-1" },
          },
        ],
      });

      const result = await createWorkspaceForCompany({
        supabase: supabase as never,
        user: { id: "user-1", email: "member@example.com" },
        name: "New workspace",
        companyId: "company-1",
      });

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: "Insufficient permissions",
      });
      expect(mockAdminRpc).not.toHaveBeenCalled();
      expect(mockAdminFrom).not.toHaveBeenCalled();
    }
  );

  it("returns the workspace limit result before inserting", async () => {
    const limit = {
      companyId: "company-1",
      lockedCapabilities: ["workspace_creation"],
    };
    mockEnsureCompanyWorkspaceCapacity.mockResolvedValue({
      allowed: false,
      limit,
    });
    const { supabase } = createSupabaseMock({});

    const result = await createWorkspaceForCompany({
      supabase: supabase as never,
      user: { id: "user-1", email: "owner@example.com" },
      name: "New workspace",
      companyId: "company-1",
    });

    expect(result).toEqual({
      ok: false,
      status: 402,
      error: "Company workspace limit exceeded",
      limit,
    });
    expect(mockAdminRpc).not.toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("uses an admin membership even when a manager membership is returned first", async () => {
    const { supabase } = createSupabaseMock({
      memberships: [
        {
          role: "manager",
          workspace_id: "member-space",
          workspaces: { company_id: "company-1" },
        },
        {
          role: "admin",
          workspace_id: "owner-space",
          workspaces: [{ company_id: "company-1" }],
        },
      ],
    });
    const result = await createWorkspaceForCompany({
      supabase: supabase as never,
      user: { id: "user-1" },
      name: "New workspace",
      companyId: "company-1",
    });
    expect(result.ok).toBe(true);
    expect(mockEnsureCompanyWorkspaceCapacity).toHaveBeenCalledWith(
      jest.requireMock("@/lib/supabase/admin").supabaseAdmin,
      "owner-space"
    );
    expect(mockAdminRpc).toHaveBeenCalledWith(
      "create_authorized_company_workspace",
      {
        input_actor_id: "user-1",
        input_company_id: "company-1",
        input_name: "New workspace",
        input_email: null,
      }
    );
  });

  it("rejects membership revoked after the authenticated precheck without assigning a stale role", async () => {
    const { supabase } = createSupabaseMock({});
    mockAdminRpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "Insufficient permissions" },
    });

    const result = await createWorkspaceForCompany({
      supabase: supabase as never,
      user: { id: "user-1", email: "owner@example.com" },
      name: "New workspace",
      companyId: "company-1",
    });

    expect(mockEnsureCompanyWorkspaceCapacity).toHaveBeenCalled();
    expect(result).toEqual({ ok: false, status: 403, error: "Forbidden" });
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(mockTrackWorkspaceCreated).not.toHaveBeenCalled();
    expect(mockEmitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
    expect(mockEnsureNewWorkspaceAiriDefaults).not.toHaveBeenCalled();
  });

  it("rejects elevated membership in another company before calling the RPC", async () => {
    const { supabase } = createSupabaseMock({});

    const result = await createWorkspaceForCompany({
      supabase: supabase as never,
      user: { id: "user-1", email: "owner@example.com" },
      name: "New workspace",
      companyId: "company-2",
    });

    expect(result).toEqual({ ok: false, status: 403, error: "Forbidden" });
    expect(mockEnsureCompanyWorkspaceCapacity).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: "Atomic workspace creation failed" } },
    { data: [], error: null },
  ])(
    "fails without post-create effects when the atomic operation returns %j",
    async rpcResult => {
      const { supabase } = createSupabaseMock({});
      mockAdminRpc.mockResolvedValue(rpcResult);

      const result = await createWorkspaceForCompany({
        supabase: supabase as never,
        user: { id: "user-1", email: "owner@example.com" },
        name: "New workspace",
        companyId: "company-1",
      });

      expect(result).toEqual({
        ok: false,
        status: 500,
        error: rpcResult.error?.message || "Failed to create workspace",
      });
      expect(mockAdminFrom).not.toHaveBeenCalled();
      expect(mockTrackWorkspaceCreated).not.toHaveBeenCalled();
      expect(mockEmitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
      expect(mockEnsureNewWorkspaceAiriDefaults).not.toHaveBeenCalled();
    }
  );
});
