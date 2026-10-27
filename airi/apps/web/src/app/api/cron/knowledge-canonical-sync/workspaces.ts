import { supabaseAdmin } from "@/lib/supabase/admin";

export async function getActiveWorkspaces(limit = 100, offset = 0) {
  const { data: workspaces, error } = await supabaseAdmin
    .from("workspaces")
    .select("id, company_id")
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to fetch workspaces: ${error.message}`);
  }

  return workspaces || [];
}
