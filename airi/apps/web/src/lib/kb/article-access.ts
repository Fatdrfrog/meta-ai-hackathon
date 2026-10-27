import { getAuthenticatedUser } from "@/lib/supabase/auth-helpers";
import type { SupabaseClient, User } from "@supabase/supabase-js";

type WorkspaceMembership = {
  workspace_id: string;
};

export type KBRouteAccessResult =
  | {
      ok: true;
      user: User;
      workspaceIds: string[];
    }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
    };

export async function requireKBRouteAccess(
  supabase: SupabaseClient
): Promise<KBRouteAccessResult> {
  const { user, error: authError } = await getAuthenticatedUser(supabase);

  if (authError || !user) {
    return {
      ok: false,
      status: 401,
      error:
        authError?.message ||
        "Unauthorized. Please refresh the page and try again.",
    };
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id);

  if (membershipsError) {
    throw membershipsError;
  }

  const workspaceIds =
    (memberships as WorkspaceMembership[] | null)
      ?.map(membership => membership.workspace_id)
      .filter(Boolean) ?? [];

  if (workspaceIds.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "No workspace access",
    };
  }

  return {
    ok: true,
    user,
    workspaceIds,
  };
}

export async function getAccessibleKBArticle<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  articleId: string,
  workspaceIds: string[],
  select: string
): Promise<T | null> {
  const { data, error } = await supabase
    .from("kb_articles")
    .select(select)
    .eq("id", articleId)
    .in("workspace_id", workspaceIds)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as T | null) ?? null;
}
