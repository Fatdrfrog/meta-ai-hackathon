import "server-only";

import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { customerApiResponse } from "./response";

/** Credentials grant workspace-wide access, so ordinary members cannot administer them. */
export async function requireCustomerApiAdmin(workspaceId: string) {
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access;

  const { data, error } = await access.supabase
    .from("company_users")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", access.userId)
    .maybeSingle();

  if (error || !isCompanyAdminRole(data?.role)) {
    return {
      ok: false as const,
      response: customerApiResponse(
        { error: "Workspace admin role required" },
        403
      ),
    };
  }
  return access;
}
