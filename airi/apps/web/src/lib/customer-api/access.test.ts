const mockRequireAccess = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockRequireAccess(...args),
}));

import { requireCustomerApiAdmin } from "./access";

describe("customer API administration access", () => {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  };
  const supabase = { from: jest.fn(() => query) };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAccess.mockResolvedValue({
      ok: true,
      userId: "user-a",
      supabase,
    });
  });

  it("preserves authentication and membership denials without privileged database work", async () => {
    const response = new Response(null, { status: 401 });
    mockRequireAccess.mockResolvedValue({ ok: false, response });
    expect(await requireCustomerApiAdmin("workspace-a")).toEqual({
      ok: false,
      response,
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each(["admin", " admin "])(
    "allows the current workspace %s",
    async role => {
      query.maybeSingle.mockResolvedValue({ data: { role }, error: null });
      expect(await requireCustomerApiAdmin("workspace-a")).toMatchObject({
        ok: true,
      });
      expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace-a");
      expect(query.eq).toHaveBeenCalledWith("user_id", "user-a");
    }
  );

  it.each(["manager", "owner", "member", null])(
    "denies role %s",
    async role => {
      query.maybeSingle.mockResolvedValue({
        data: role ? { role } : null,
        error: null,
      });
      const result = await requireCustomerApiAdmin("workspace-a");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }
  );

  it("fails closed when membership role lookup fails", async () => {
    query.maybeSingle.mockResolvedValue({
      data: { role: "admin" },
      error: new Error("offline"),
    });
    const result = await requireCustomerApiAdmin("workspace-a");
    expect(result.ok).toBe(false);
  });
});
