const mockCreateClient = jest.fn();
const mockAdminFrom = jest.fn();
const mockAdminRpc = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
    rpc: (...args: unknown[]) => mockAdminRpc(...args),
  },
}));
import { DELETE } from "./route";
import {
  authorize,
  resetMembershipMutationMocks,
  runSharedMembershipMutationCases,
  target,
} from "../../team-membership-mutation-test-utils";
const mocks = {
  createClient: mockCreateClient,
  adminFrom: mockAdminFrom,
  adminRpc: mockAdminRpc,
};
function invoke() {
  return DELETE(
    new Request("http://localhost/api/team/revoke/membership-1", {
      method: "DELETE",
    }) as never,
    { params: Promise.resolve({ id: "membership-1" }) }
  );
}
beforeEach(() => {
  resetMembershipMutationMocks(mocks, "revoked");
});
it.each(["admin", "manager"])(
  "allows a workspace admin to atomically remove a teammate with role %s",
  async role => {
    authorize(mockAdminFrom, { ...target, role });
    expect((await invoke()).status).toBe(200);
    expect(mockAdminFrom).toHaveBeenCalledTimes(2);
    expect(mockAdminRpc).toHaveBeenCalledWith("mutate_team_membership", {
      input_actor_id: "actor-1",
      input_member_id: "membership-1",
      input_action: "revoke",
      input_workspace_id: "workspace-1",
      input_expected_user_id: "teammate-1",
      input_expected_role: role,
      input_role: null,
    });
  }
);
runSharedMembershipMutationCases({ invoke, mocks });
