// Cases shared by the team update-role and revoke route suites. Each suite
// keeps its own jest.mock factories and passes its mock handles in, so the
// it() calls below register inside the calling test file.

import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

export const target = {
  workspace_id: "workspace-1",
  role: "manager",
  user_id: "teammate-1",
};

export function query(data: unknown) {
  return createSupabaseQueryMock({ data, error: null }, { thenable: false });
}

type MembershipMutationMocks = {
  createClient: jest.Mock;
  adminFrom: jest.Mock;
  adminRpc: jest.Mock;
};

/** Queue the target membership read, then the requester's role read. */
export function authorize(
  adminFrom: jest.Mock,
  member: unknown = target,
  actorRole: string | null = "admin"
) {
  adminFrom
    .mockReturnValueOnce(query(member))
    .mockReturnValueOnce(query(actorRole ? { role: actorRole } : null));
}

/** Signed-in actor-1 and a successful mutate_team_membership RPC. */
export function resetMembershipMutationMocks(
  mocks: MembershipMutationMocks,
  successStatus: string
) {
  jest.clearAllMocks();
  mocks.adminFrom.mockReset();
  mocks.createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "actor-1" } } }) },
  });
  mocks.adminRpc.mockResolvedValue({
    data: [{ status: successStatus }],
    error: null,
  });
}

/** Authorization, conflict and not-found cases both mutation routes share. */
export function runSharedMembershipMutationCases({
  invoke,
  mocks,
}: {
  invoke: () => Promise<Response>;
  mocks: MembershipMutationMocks;
}) {
  const { createClient, adminFrom, adminRpc } = mocks;

  it.each([null, "owner", "member", "manager"])(
    "rejects a requester without same-workspace administration: %s",
    async role => {
      authorize(adminFrom, target, role);
      expect((await invoke()).status).toBe(403);
      expect(adminRpc).not.toHaveBeenCalled();
    }
  );
  it("does not authorize an admin membership in a different workspace", async () => {
    const actor = query(null);
    const filters: Record<string, unknown> = {};
    actor.eq.mockImplementation((key: string, value: unknown) => {
      filters[key] = value;
      return actor;
    });
    actor.single.mockImplementation(async () => ({
      data: filters.workspace_id === "workspace-2" ? { role: "admin" } : null,
      error: null,
    }));
    actor.maybeSingle.mockImplementation(actor.single);
    adminFrom.mockReturnValueOnce(query(target)).mockReturnValueOnce(actor);
    expect((await invoke()).status).toBe(403);
    expect(adminRpc).not.toHaveBeenCalled();
  });
  it("protects the acting admin's own membership", async () => {
    authorize(adminFrom, { ...target, role: "admin", user_id: "actor-1" });
    expect((await invoke()).status).toBe(403);
    expect(adminRpc).not.toHaveBeenCalled();
  });
  it.each(["demoted", "revoked"])(
    "rejects the acting admin %s after its initial permission check",
    async () => {
      authorize(adminFrom);
      adminRpc.mockResolvedValue({ data: null, error: { code: "42501" } });
      expect((await invoke()).status).toBe(403);
      expect(adminFrom).toHaveBeenCalledTimes(2);
    }
  );
  it.each(["role", "user", "workspace"])(
    "returns conflict if the target's %s changes after it is read",
    async () => {
      authorize(adminFrom);
      adminRpc.mockResolvedValue({ data: null, error: { code: "40001" } });
      expect((await invoke()).status).toBe(409);
      expect(adminRpc).toHaveBeenCalledWith(
        "mutate_team_membership",
        expect.objectContaining({
          input_workspace_id: target.workspace_id,
          input_expected_user_id: target.user_id,
          input_expected_role: target.role,
        })
      );
    }
  );
  it("allows an admin to mutate an unclaimed invitation using its null-user snapshot", async () => {
    authorize(adminFrom, { ...target, user_id: null });
    expect((await invoke()).status).toBe(200);
    expect(adminRpc).toHaveBeenCalledWith(
      "mutate_team_membership",
      expect.objectContaining({ input_expected_user_id: null })
    );
  });
  it("returns not found for an absent target", async () => {
    authorize(adminFrom, null);
    expect((await invoke()).status).toBe(404);
    expect(adminRpc).not.toHaveBeenCalled();
  });
  it("returns not found if the target disappears before the mutation", async () => {
    authorize(adminFrom);
    adminRpc.mockResolvedValue({ data: null, error: { code: "P0002" } });
    expect((await invoke()).status).toBe(404);
  });
  it("requires authentication", async () => {
    createClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });
    expect((await invoke()).status).toBe(401);
    expect(adminFrom).not.toHaveBeenCalled();
  });
}
