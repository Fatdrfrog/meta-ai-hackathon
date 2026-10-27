const mockFrom = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom, auth: { getUser: mockUser } }),
}));
import { PATCH, GET } from "./route";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";
function query(data: unknown) {
  return createSupabaseQueryMock({ data, error: null }, { thenable: false });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});
function request() {
  return new Request("http://localhost/api/company-context", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "workspace-1", tags: ["sales"] }),
  });
}
it.each(["manager", "member", "owner"])(
  "denies %s before any company update",
  async role => {
    const membership = query({
      role,
      workspaces: { companies: { id: "company-1" } },
    });
    const company = query({ id: "company-1", dynamic_context_tags: ["sales"] });
    mockFrom.mockImplementation((table: string) =>
      table === "company_users" ? membership : company
    );
    const response = await PATCH(request());
    expect(response.status).toBe(403);
    expect(company.update).not.toHaveBeenCalled();
  }
);
it.each(["admin"])(
  "permits %s to update ordinary settings in their selected workspace",
  async role => {
    const membership = query({
      role,
      workspaces: { companies: { id: "company-1" } },
    });
    const company = query({ id: "company-1", dynamic_context_tags: ["sales"] });
    mockFrom.mockImplementation((table: string) =>
      table === "company_users" ? membership : company
    );
    const response = await PATCH(request());
    expect(response.status).toBe(200);
    expect(membership.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(company.update).toHaveBeenCalledWith({
      dynamic_context_tags: ["sales"],
    });
  }
);
it("does not write when the user has no selected-workspace membership", async () => {
  const membership = query(null);
  const company = query({ id: "company-1" });
  mockFrom.mockImplementation((table: string) =>
    table === "company_users" ? membership : company
  );
  expect((await PATCH(request())).status).toBe(404);
  expect(company.update).not.toHaveBeenCalled();
});
it("requires an explicit selection when the user belongs to several workspaces", async () => {
  const memberships = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({
      data: [{ workspace_id: "workspace-1" }, { workspace_id: "workspace-2" }],
      error: null,
    }),
  };
  mockFrom.mockReturnValue(memberships);
  const response = await GET(
    new Request("http://localhost/api/company-context")
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining("workspaceId is required"),
  });
});
