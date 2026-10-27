const mockCreateClient = jest.fn();
const mockGetCompanyIdForUserWorkspace = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  getCompanyIdForUserWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForUserWorkspace(...args),
}));

import { requireIndexedUrlWorkspaceAccess } from "@/lib/kb/indexed-url-route-access";

function createAuthClient(userId: string | null) {
  return {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
      })),
    },
    from: jest.fn(() => {
      throw new Error("The auth client must not cross the admin boundary");
    }),
  };
}

describe("requireIndexedUrlWorkspaceAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns only the authorized user and company identity", async () => {
    const mockAuthClient = createAuthClient("user-1");
    mockCreateClient.mockResolvedValue(mockAuthClient);
    mockGetCompanyIdForUserWorkspace.mockResolvedValue("company-1");

    await expect(
      requireIndexedUrlWorkspaceAccess("workspace-1")
    ).resolves.toEqual({
      ok: true,
      userId: "user-1",
      companyId: "company-1",
    });
    expect(mockGetCompanyIdForUserWorkspace).toHaveBeenCalledWith(
      mockAuthClient,
      "user-1",
      "workspace-1"
    );
    expect(mockAuthClient.from).not.toHaveBeenCalled();
  });

  it("returns 401 without reaching company lookup or the admin boundary", async () => {
    const mockAuthClient = createAuthClient(null);
    mockCreateClient.mockResolvedValue(mockAuthClient);

    const access = await requireIndexedUrlWorkspaceAccess("workspace-1");

    expect(access.ok).toBe(false);
    if (access.ok) throw new Error("Expected access to be denied");
    expect(access.response.status).toBe(401);
    await expect(access.response.json()).resolves.toEqual({
      error: "Unauthorized",
    });
    expect(mockGetCompanyIdForUserWorkspace).not.toHaveBeenCalled();
    expect(mockAuthClient.from).not.toHaveBeenCalled();
  });

  it("returns 403 without crossing the admin boundary for a non-member", async () => {
    const mockAuthClient = createAuthClient("user-1");
    mockCreateClient.mockResolvedValue(mockAuthClient);
    mockGetCompanyIdForUserWorkspace.mockResolvedValue(null);

    const access = await requireIndexedUrlWorkspaceAccess("workspace-1");

    expect(access.ok).toBe(false);
    if (access.ok) throw new Error("Expected access to be denied");
    expect(access.response.status).toBe(403);
    await expect(access.response.json()).resolves.toEqual({
      error: "No company association for this workspace",
    });
    expect(mockGetCompanyIdForUserWorkspace).toHaveBeenCalledTimes(1);
    expect(mockAuthClient.from).not.toHaveBeenCalled();
  });
});
