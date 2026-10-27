export type WorkspaceCompanyClient = {
  from(table: "workspaces"): unknown;
};
type WorkspaceCompanyTable = {
  select(columns: "company_id"): {
    eq(
      column: "id",
      workspaceId: string,
    ): {
      maybeSingle(): PromiseLike<{
        data: { company_id?: string | null } | null;
        error: unknown;
      }>;
    };
  };
};

export async function getCompanyIdForWorkspace(
  supabase: WorkspaceCompanyClient,
  workspaceId: string,
): Promise<string | null> {
  const table = supabase.from("workspaces") as WorkspaceCompanyTable;
  const { data, error } = await table
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle();
  return error || !data?.company_id ? null : data.company_id;
}
