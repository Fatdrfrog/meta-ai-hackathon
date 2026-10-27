import {
  getCompanyIdForWorkspace,
  isCompanyAdminRole,
} from "@/lib/supabase/company-users";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { TeamInviteLinkPayload } from "./team-invite-link";

/** Check current database authority after verifying the invite signature. */
export async function validateTeamInviteAuthorization(
  supabase: SupabaseClient,
  payload: TeamInviteLinkPayload,
  user: Pick<User, "email" | "email_confirmed_at">,
  options: { requireEmail?: boolean } = {}
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  if (options.requireEmail && !payload.email) {
    return {
      allowed: false,
      error:
        "Invalid invite: missing signed recipient. Ask an admin for a new invitation.",
    };
  }

  if (
    payload.email &&
    (!user.email_confirmed_at ||
      user.email?.trim().toLowerCase() !== payload.email)
  ) {
    return {
      allowed: false,
      error:
        "Sign in with the verified email address this invitation was sent to.",
    };
  }

  const companyId = await getCompanyIdForWorkspace(
    supabase,
    payload.workspaceId
  );
  if (!companyId || companyId !== payload.companyId) {
    return {
      allowed: false,
      error: "Invite workspace/company could not be verified.",
    };
  }

  const { data: inviter, error } = await supabase
    .from("company_users")
    .select("role")
    .eq("user_id", payload.inviterId)
    .eq("workspace_id", payload.workspaceId)
    .maybeSingle();

  if (error || !inviter || !isCompanyAdminRole(inviter.role)) {
    return {
      allowed: false,
      error:
        "The inviter can no longer invite teammates to this workspace. Ask an admin for a new invitation.",
    };
  }

  return { allowed: true };
}
