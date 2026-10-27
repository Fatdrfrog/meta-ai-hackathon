const mockFrom = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom, auth: { getUser: mockUser } }),
}));
jest.mock("@/lib/cache", () => ({
  buildCacheKey: () => "key",
  cache: { del: jest.fn().mockResolvedValue(undefined) },
}));
import { PUT } from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";
function query(data: unknown) {
  return createSupabaseQueryMock({ data, error: null }, { thenable: false });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});
function request() {
  return new Request("http://localhost/api/workspaces/workspace-1/ltv-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseValue: 100, currency: "USD" }),
  });
}
it.each(["owner", "member"])(
  "denies retired %s writes before touching the workspace",
  async role => {
    const membership = query({ workspace_id: "workspace-1", role });
    const workspace = query({ ltv_base_value: 100, ltv_currency: "USD" });
    mockFrom.mockImplementation((table: string) =>
      table === "company_users" ? membership : workspace
    );
    expect(
      (
        await PUT(request() as never, {
          params: Promise.resolve({ workspaceId: "workspace-1" }),
        })
      ).status
    ).toBe(403);
    expect(workspace.update).not.toHaveBeenCalled();
  }
);
it.each(["admin", "manager"])(
  "allows exact-workspace %s writes",
  async role => {
    const membership = query({ workspace_id: "workspace-1", role });
    const workspace = query({ ltv_base_value: 100, ltv_currency: "USD" });
    mockFrom.mockImplementation((table: string) =>
      table === "company_users" ? membership : workspace
    );
    expect(
      (
        await PUT(request() as never, {
          params: Promise.resolve({ workspaceId: "workspace-1" }),
        })
      ).status
    ).toBe(200);
    expect(membership.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(workspace.update).toHaveBeenCalledWith({
      ltv_base_value: 100,
      ltv_currency: "USD",
    });
  }
);
