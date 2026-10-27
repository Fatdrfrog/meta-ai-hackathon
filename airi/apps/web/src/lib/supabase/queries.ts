import { SupabaseClient } from "@supabase/supabase-js";
import "server-only";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";

export async function getUserCompany(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("company_users")
    .select(
      `
            workspace_id,
            workspaces!fk_workspace (
                id,
                company_id,
                companies!workspaces_company_id_fkey (
                    id,
                    name,
                    slug,
                    business_context,
                    dynamic_context_tags,
                    trial_starts_at,
                    trial_ends_at,
                    airi_language,
                    created_at
                )
            )
        `
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error && error.code !== "PGRST116") {
    return null;
  }

  const workspace = Array.isArray(data?.workspaces)
    ? data.workspaces[0]
    : data?.workspaces;
  const company = Array.isArray(workspace?.companies)
    ? workspace.companies[0]
    : workspace?.companies;

  if (!workspace?.company_id || !company) {
    return null;
  }

  return {
    company_id: workspace.company_id,
    workspaces: { id: workspace.id },
    companies: company,
  };
}

export async function checkUserWorkspaceAccess(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("company_users")
    .select("user_id")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    return false;
  }
  return Boolean(data);
}

/** The member's role in the workspace, or null when not a member or the read fails. */
export async function getWorkspaceMemberRole(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("company_users")
    .select("role")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const role = (data as { role?: unknown } | null)?.role;
  return role ? String(role) : null;
}

/** Resolve explicit selection, retaining legacy calls only for a single membership. */
export async function resolveUserWorkspaceMembership(
  supabase: SupabaseClient,
  userId: string,
  requestedWorkspaceId?: unknown
): Promise<
  | { ok: true; workspaceId: string }
  | { ok: false; status: 400 | 403 | 500; error: string }
> {
  if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== null) {
    if (
      typeof requestedWorkspaceId !== "string" ||
      !requestedWorkspaceId.trim()
    ) {
      return { ok: false, status: 400, error: "Invalid workspaceId" };
    }
    const workspaceId = requestedWorkspaceId.trim();
    return (await checkUserWorkspaceAccess(supabase, userId, workspaceId))
      ? { ok: true, workspaceId }
      : { ok: false, status: 403, error: "Forbidden" };
  }

  const { data, error } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", userId)
    .limit(2);
  if (error) {
    return {
      ok: false,
      status: 500,
      error: "Failed to verify workspace membership",
    };
  }
  const workspaceIds = [
    ...new Set((data ?? []).map(row => row.workspace_id).filter(Boolean)),
  ];
  if (workspaceIds.length === 0)
    return { ok: false, status: 403, error: "Forbidden" };
  if (workspaceIds.length !== 1) {
    return {
      ok: false,
      status: 400,
      error: "workspaceId is required when you belong to multiple workspaces",
    };
  }
  return { ok: true, workspaceId: workspaceIds[0] };
}

/** Resolves company_id for the user's membership in a specific workspace (avoids .single() failing when user has multiple workspaces). */
export async function getCompanyIdForUserWorkspace(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error || !data?.workspace_id) {
    return null;
  }

  return getCompanyIdForWorkspace(supabase, workspaceId);
}
