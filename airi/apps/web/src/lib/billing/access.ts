import "server-only";

import {
  getCompanyIdForWorkspace,
  isCompanyAdminRole,
} from "@/lib/supabase/company-users";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";

export async function requireBillingWorkspaceAccess(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, status: 401, error: "Unauthorized" };
  }

  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) {
    return { ok: false as const, status: 403, error: "Forbidden" };
  }

  const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
  if (!companyId) {
    return {
      ok: false as const,
      status: 404,
      error: "Workspace company not found",
    };
  }

  return {
    ok: true as const,
    supabase,
    user,
    companyId,
    workspaceId,
  };
}

export async function requireBillingWorkspaceAdmin(workspaceId: string) {
  const context = await requireBillingWorkspaceAccess(workspaceId);
  if (!context.ok) return context;

  const { data, error } = await context.supabase
    .from("company_users")
    .select("role")
    .eq("user_id", context.user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error || !isCompanyAdminRole(data?.role)) {
    return { ok: false as const, status: 403, error: "Admin role required" };
  }

  return context;
}
