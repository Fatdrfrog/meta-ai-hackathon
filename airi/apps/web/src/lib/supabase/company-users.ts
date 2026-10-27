import type { SupabaseClient } from "@supabase/supabase-js";
import { getCompanyIdForWorkspace } from "@icecore/shared/lib/workspace-company";
import { firstOrSelf } from "@icecore/shared/lib/value-utils";
export { getCompanyIdForWorkspace };

export const WORKSPACE_ROLES = ["admin", "manager"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(role: unknown): role is WorkspaceRole {
  return WORKSPACE_ROLES.some(workspaceRole => workspaceRole === role);
}

type JoinedRelation<T> = T | T[] | null | undefined;

type JoinedUserProfile =
  | {
      full_name?: string | null;
      avatar_url?: string | null;
    }
  | Array<{
      full_name?: string | null;
      avatar_url?: string | null;
    }>
  | null
  | undefined;

export type UserProfile = {
  id: string;
  full_name?: string | null;
  avatar_url?: string | null;
};

type MembershipDisplayRow = {
  email?: string | null;
  users?: JoinedUserProfile;
};

type WorkspaceCompanyInfo = {
  company_id: string;
  airi_language?: string | null;
};

type MembershipInsertError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

type MembershipIdRow = {
  id?: string | number | null;
};

export type MembershipConflictResolutionStatus =
  | "already_member"
  | "joined"
  | "unresolved";

export const getSingleRelation = firstOrSelf;

export function getJoinedUserProfile(users: JoinedUserProfile): {
  full_name?: string | null;
  avatar_url?: string | null;
} | null {
  return getSingleRelation(users);
}

export function getMembershipDisplayName(
  row: MembershipDisplayRow,
  fallback = "Manager"
): string {
  const profile = getJoinedUserProfile(row.users);
  const fullName = profile?.full_name?.trim();
  if (fullName) return fullName;

  const emailName = row.email?.split("@")[0]?.trim();
  if (emailName) return emailName;

  return fallback;
}

export async function getUserProfilesByIds(
  supabase: SupabaseClient,
  userIds: string[]
): Promise<Map<string, UserProfile>> {
  const uniqueUserIds = Array.from(
    new Set(userIds.map(userId => userId.trim()).filter(Boolean))
  );
  if (uniqueUserIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("users")
    .select("id, full_name, avatar_url")
    .in("id", uniqueUserIds);

  if (error) throw error;

  return new Map(
    ((data ?? []) as UserProfile[]).map(profile => [profile.id, profile])
  );
}

/**
 * A workspace member's display name: profile full name, else the email's
 * local part, else `fallback` (also used for a non-member).
 */
export async function getWorkspaceMemberDisplayName(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  fallback = "Manager"
): Promise<string> {
  const { data } = await supabase
    .from("company_users")
    .select("email")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  const profile = data
    ? ((await getUserProfilesByIds(supabase, [userId])).get(userId) ?? null)
    : null;

  return getMembershipDisplayName(
    {
      email: (data as { email?: string | null } | null)?.email,
      users: profile,
    },
    fallback
  );
}

export type WorkspaceMemberLabel = {
  userId: string;
  label: string;
};

export async function listWorkspaceMemberLabels(
  supabase: SupabaseClient,
  workspaceId: string,
  userIds?: string[]
): Promise<WorkspaceMemberLabel[]> {
  if (userIds && !userIds.length) return [];
  let query = supabase
    .from("company_users")
    .select("user_id, email")
    .eq("workspace_id", workspaceId);
  if (userIds) query = query.in("user_id", [...new Set(userIds)]);
  const { data, error } = await query;

  if (error || !Array.isArray(data)) return [];

  const rows: { userId: string; email: string | null }[] = [];
  for (const row of data) {
    const typed = row as {
      user_id?: string | null;
      email?: string | null;
    };
    const userId = String(typed.user_id || "").trim();
    if (!userId) continue;
    rows.push({
      userId,
      email: typed.email ?? null,
    });
  }

  const profilesById = await getUserProfilesByIds(
    supabase,
    rows.map(row => row.userId)
  );

  const seen = new Set<string>();
  const members: WorkspaceMemberLabel[] = [];
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    members.push({
      userId: row.userId,
      label: getMembershipDisplayName(
        {
          email: row.email,
          users: profilesById.get(row.userId) ?? null,
        },
        "Teammate"
      ),
    });
  }

  return members.sort((left, right) => left.label.localeCompare(right.label));
}

export async function getWorkspaceCompanyInfo(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<WorkspaceCompanyInfo | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("company_id, companies!workspaces_company_id_fkey(airi_language)")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error || !data?.company_id) {
    return null;
  }

  const company = getSingleRelation(
    data.companies as JoinedRelation<{ airi_language?: string | null }>
  );

  return {
    company_id: data.company_id,
    airi_language: company?.airi_language ?? null,
  };
}

export async function getCompanyUserMembershipByUserWorkspace(
  supabase: SupabaseClient,
  payload: {
    user_id: string;
    workspace_id: string;
  }
): Promise<{
  data: MembershipIdRow | null;
  error: MembershipInsertError | null;
}> {
  const { data, error } = await supabase
    .from("company_users")
    .select("id")
    .eq("user_id", payload.user_id)
    .eq("workspace_id", payload.workspace_id)
    .maybeSingle();

  return {
    data: (data as MembershipIdRow | null) ?? null,
    error: (error as MembershipInsertError | null) ?? null,
  };
}

/** The service-only RPC rechecks current inviter authority while granting access. */
export async function grantTeamInviteMembership(
  supabase: SupabaseClient,
  payload: {
    inviter_id: string;
    user_id: string;
    workspace_id: string;
    company_id: string;
    email?: string | null;
  }
): Promise<{
  status: MembershipConflictResolutionStatus;
  error: MembershipInsertError | null;
}> {
  const { data, error } = await supabase.rpc("grant_team_invite_membership", {
    input_inviter_id: payload.inviter_id,
    input_user_id: payload.user_id,
    input_workspace_id: payload.workspace_id,
    input_company_id: payload.company_id,
    input_email: payload.email ?? null,
  });
  if (error) return { status: "unresolved", error };

  if (
    !Array.isArray(data) ||
    data.length !== 1 ||
    (data[0]?.status !== "joined" && data[0]?.status !== "already_member")
  ) {
    return {
      status: "unresolved",
      error: { message: "Invalid invited membership grant result" },
    };
  }
  return { status: data[0].status, error: null };
}

export function isCompanyAdminRole(role: unknown): boolean {
  return typeof role === "string" && role.trim() === "admin";
}

/** Recheck and hold actor authority in the same transaction as a team mutation. */
export async function mutateTeamMembership(
  supabase: SupabaseClient,
  payload: {
    actor_id: string;
    member_id: string;
    action: "update-role" | "revoke";
    workspace_id: string;
    expected_user_id: string | null;
    expected_role: string | null;
    role?: WorkspaceRole;
  }
): Promise<
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string }
> {
  const { data, error } = await supabase.rpc("mutate_team_membership", {
    input_actor_id: payload.actor_id,
    input_member_id: payload.member_id,
    input_action: payload.action,
    input_workspace_id: payload.workspace_id,
    input_expected_user_id: payload.expected_user_id,
    input_expected_role: payload.expected_role,
    input_role: payload.role ?? null,
  });
  if (error) {
    if (error.code === "42501") {
      return {
        ok: false,
        status: 403,
        error: "Forbidden: Admin access required",
      };
    }
    if (error.code === "P0002")
      return { ok: false, status: 404, error: "Member not found" };
    if (error.code === "40001") {
      return {
        ok: false,
        status: 409,
        error: "Member changed. Refresh the team and try again.",
      };
    }
    if (error.code === "22023")
      return {
        ok: false,
        status: 400,
        error: "Invalid team membership mutation",
      };
    return { ok: false, status: 500, error: "Internal server error" };
  }
  const expectedStatus =
    payload.action === "update-role" ? "updated" : "revoked";
  if (
    !Array.isArray(data) ||
    data.length !== 1 ||
    data[0]?.status !== expectedStatus
  ) {
    return { ok: false, status: 500, error: "Internal server error" };
  }
  return { ok: true };
}

export function isWorkspaceManagerRole(role: unknown): boolean {
  return typeof role === "string" && isWorkspaceRole(role.trim());
}
