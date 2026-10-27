import { resolveKBNavigationWorkspaceIds } from "./navigation-workspace";

describe("resolveKBNavigationWorkspaceIds", () => {
  test("uses the provided workspace id for public navigation without extra lookup", async () => {
    const fetchWorkspaceIdsByCompanySlug = jest.fn();

    await expect(
      resolveKBNavigationWorkspaceIds({
        mode: "public",
        companySlug: "acme",
        workspaceId: "workspace-1",
        fetchWorkspaceIdsByCompanySlug,
      })
    ).resolves.toEqual(["workspace-1"]);

    expect(fetchWorkspaceIdsByCompanySlug).not.toHaveBeenCalled();
  });

  test("falls back to company lookup when public navigation has no workspace id", async () => {
    const fetchWorkspaceIdsByCompanySlug = jest
      .fn<Promise<string[]>, [string]>()
      .mockResolvedValue(["workspace-1", "workspace-2"]);

    await expect(
      resolveKBNavigationWorkspaceIds({
        mode: "public",
        companySlug: "acme",
        fetchWorkspaceIdsByCompanySlug,
      })
    ).resolves.toEqual(["workspace-1", "workspace-2"]);

    expect(fetchWorkspaceIdsByCompanySlug).toHaveBeenCalledWith("acme");
  });

  test("returns no workspace ids when public navigation lacks both workspace and company context", async () => {
    await expect(
      resolveKBNavigationWorkspaceIds({
        mode: "public",
      })
    ).resolves.toEqual([]);
  });
});
