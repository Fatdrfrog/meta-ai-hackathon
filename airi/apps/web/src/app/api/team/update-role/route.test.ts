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
import { POST } from "./route";
import {
  authorize,
  resetMembershipMutationMocks,
  runSharedMembershipMutationCases,
} from "../team-membership-mutation-test-utils";
const mocks = {
  createClient: mockCreateClient,
  adminFrom: mockAdminFrom,
  adminRpc: mockAdminRpc,
};
function invoke(role: string = "admin") {
  return POST(
    new Request("http://localhost/api/team/update-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "membership-1", role }),
    }) as never
  );
}
beforeEach(() => {
  resetMembershipMutationMocks(mocks, "updated");
});
it.each(["admin", "manager"])(
  "allows a workspace admin to atomically assign %s to a teammate",
  async role => {
    authorize(mockAdminFrom);
    expect((await invoke(role)).status).toBe(200);
    expect(mockAdminFrom).toHaveBeenCalledTimes(2);
    expect(mockAdminRpc).toHaveBeenCalledWith("mutate_team_membership", {
      input_actor_id: "actor-1",
      input_member_id: "membership-1",
      input_action: "update-role",
      input_workspace_id: "workspace-1",
      input_expected_user_id: "teammate-1",
      input_expected_role: "manager",
      input_role: role,
    });
  }
);
runSharedMembershipMutationCases({ invoke: () => invoke(), mocks });
it.each(["owner", "member", "invalid"])(
  "rejects unsupported role %s",
  async role => {
    expect((await invoke(role)).status).toBe(400);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  }
);
