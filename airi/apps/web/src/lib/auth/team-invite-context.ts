import type { SupabaseClient } from "@supabase/supabase-js";
import { getSingleRelation } from "@/lib/supabase/company-users";
import { verifyTeamInviteToken } from "./team-invite-link";

export type TeamInviteContext =
  | {
      status: "valid";
      workspaceId: string;
      workspaceName?: string | null;
      companyName?: string | null;
      expiresAtIso: string;
    }
  | {
      status: "invalid" | "expired";
      reason: string;
    };

type WorkspaceInviteRow = {
  id?: string | null;
  name?: string | null;
  companies?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

export async function resolveTeamInviteContext(
  supabase: SupabaseClient,
  token: string
): Promise<TeamInviteContext | null> {
  if (!token.trim()) {
    return null;
  }

  let verification: ReturnType<typeof verifyTeamInviteToken>;
  try {
    verification = verifyTeamInviteToken(token);
  } catch {
    return {
      status: "invalid",
      reason: "Invite link could not be verified",
    };
  }

  if (!verification.valid || !verification.payload) {
    const reason = verification.reason || "Invalid invite link";
    return {
      status: /expired/i.test(reason) ? "expired" : "invalid",
      reason,
    };
  }

  const { workspaceId, exp } = verification.payload;
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, name, companies!workspaces_company_id_fkey(name)")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error) {
    return {
      status: "valid",
      workspaceId,
      expiresAtIso: new Date(exp * 1000).toISOString(),
    };
  }

  const row = data as WorkspaceInviteRow | null;
  const company = getSingleRelation(row?.companies);

  return {
    status: "valid",
    workspaceId,
    workspaceName: row?.name ?? null,
    companyName: company?.name ?? null,
    expiresAtIso: new Date(exp * 1000).toISOString(),
  };
}
