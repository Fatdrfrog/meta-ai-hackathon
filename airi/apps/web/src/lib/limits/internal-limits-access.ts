import { supabaseAdmin } from "@/lib/supabase/admin";

import { requireAppAdmin } from "@/lib/auth/app-admin";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import "server-only";

type InternalLimitsAccessResult =
  | {
      ok: true;
      companyId: string;
      role: string;
      userId: string;
      workspaceId: string;
    }
  | {
      ok: false;
      status: 401 | 403 | 404;
      error: string;
    };

export async function resolveInternalLimitsAccess(
  workspaceId: string
): Promise<InternalLimitsAccessResult> {
  const access = await getAuthenticatedWorkspaceMembership(workspaceId);

  if (access.error || !access.membership) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const admin = await requireAppAdmin(access.supabase);
  if (admin.response) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const { data: workspace, error: workspaceError } = await supabaseAdmin
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle();

  const companyId =
    typeof workspace?.company_id === "string" ? workspace.company_id : "";

  if (workspaceError || !companyId) {
    return {
      ok: false,
      status: 404,
      error: "Workspace company not found",
    };
  }

  return {
    ok: true,
    companyId,
    role: access.membership.role,
    userId: access.user.id,
    workspaceId,
  };
}

export async function canAccessInternalLimits(workspaceId: string) {
  const access = await resolveInternalLimitsAccess(workspaceId);
  return access.ok;
}
