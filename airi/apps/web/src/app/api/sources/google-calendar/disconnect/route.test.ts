const mockCreateClient = jest.fn();
const mockRequireWorkspaceMembership = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockRequireWorkspaceMembership(...args),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string"
      ? value
      : (value as { encrypted?: string } | null)?.encrypted || "",
}));

import { DELETE } from "./route";

describe("DELETE /api/sources/google-calendar/disconnect", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as never;
    mockCreateClient.mockResolvedValue({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
      from: (...args: unknown[]) => mockSupabaseFrom(...args),
    });
    mockRequireWorkspaceMembership.mockResolvedValue(true);
    mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("revokes the stored refresh token and deletes the workspace source", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: "source-1",
        credentials: { refresh_token: { encrypted: "refresh-token" } },
      },
      error: null,
    });
    const deleteFilter = jest.fn().mockResolvedValue({ error: null });
    const deleteBuilder = {
      eq: jest.fn(() => ({ eq: deleteFilter })),
    };
    const sourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle,
      delete: jest.fn(() => deleteBuilder),
    };
    mockSupabaseFrom.mockReturnValue(sourceBuilder);

    const response = await DELETE(
      new Request(
        "https://www.airi.chat/api/sources/google-calendar/disconnect?workspaceId=workspace-1"
      )
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: expect.any(URLSearchParams),
      })
    );
    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("token")).toBe("refresh-token");
    expect(deleteBuilder.eq).toHaveBeenCalledWith("id", "source-1");
    expect(deleteFilter).toHaveBeenCalledWith("workspace_id", "workspace-1");
    await expect(response.json()).resolves.toEqual({ success: true });
  });
});
