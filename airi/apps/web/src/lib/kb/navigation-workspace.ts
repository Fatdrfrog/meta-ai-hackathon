export async function resolveKBNavigationWorkspaceIds({
  mode = "public",
  companySlug,
  workspaceId,
  fetchWorkspaceIdsByCompanySlug,
}: {
  mode?: "public" | "internal";
  companySlug?: string;
  workspaceId?: string;
  fetchWorkspaceIdsByCompanySlug?: (companySlug: string) => Promise<string[]>;
}): Promise<string[]> {
  if (workspaceId) {
    return [workspaceId];
  }

  if (mode !== "public" || !companySlug || !fetchWorkspaceIdsByCompanySlug) {
    return [];
  }

  const workspaceIds = await fetchWorkspaceIdsByCompanySlug(companySlug);
  return workspaceIds.filter(Boolean);
}
