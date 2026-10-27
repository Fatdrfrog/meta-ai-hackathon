import "server-only";

import { redirect } from "next/navigation";
import { getReadOnlySupabaseContext } from "./server-context";

export async function requirePanelWorkspaceAccess(
  workspaceId: string,
  redirectTo = "/panel"
) {
  const { supabase, user } = await getReadOnlySupabaseContext();
  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!membership) {
    redirect(redirectTo);
  }

  return {
    supabase,
    user,
    membership,
  };
}
