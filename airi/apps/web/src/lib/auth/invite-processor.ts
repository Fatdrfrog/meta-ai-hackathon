import { setCompanyProperties, trackUserRegistration } from "@/lib/analytics";
import { ensureCompanySeatCapacityForUser } from "@/lib/limits/company-limits";
import { syncPublicUserProfile } from "@/lib/auth/user-profile-sync";
import { validateTeamInviteAuthorization } from "@/lib/auth/team-invite-authorization";
import { verifyTeamInviteToken } from "@/lib/auth/team-invite-link";
import { grantTeamInviteMembership } from "@/lib/supabase/company-users";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { readServerTrackingConsent } from "@/lib/tracking-consent-server";
import type { User } from "@supabase/supabase-js";
import { z } from "zod";

export async function processInvite(user: User): Promise<{
  success: boolean;
  error?: string;
  workspaceId?: string;
  alreadyProcessed?: boolean;
}> {
  const metadata = user.user_metadata;
  const token =
    typeof metadata?.team_invite_token === "string"
      ? metadata.team_invite_token
      : "";
  const email = user.email || undefined;

  if (!token && !metadata?.company_id && !metadata?.workspace_id) {
    return { success: true, alreadyProcessed: false };
  }

  try {
    const verification = token ? verifyTeamInviteToken(token) : null;
    const existingWorkspace = z
      .string()
      .uuid()
      .safeParse(
        verification?.valid && verification.payload
          ? verification.payload.workspaceId
          : metadata?.workspace_id
      );

    // Editable hints can resume access already granted to this user, but cannot
    // authorize a new membership. Valid signed proof always selects its scope.
    if (existingWorkspace.success) {
      const { data: existing, error: selectError } = await supabaseAdmin
        .from("company_users")
        .select("id, created_at")
        .eq("user_id", user.id)
        .eq("workspace_id", existingWorkspace.data)
        .maybeSingle();

      if (selectError) {
        throw selectError;
      }
      if (existing) {
        await clearInviteMetadata(user.id);
        return {
          success: true,
          workspaceId: existingWorkspace.data,
          alreadyProcessed: true,
        };
      }
    }

    if (!token) {
      return {
        success: false,
        error:
          "Invalid invite: missing signed proof. Ask an admin for a new invitation.",
      };
    }
    if (!verification?.valid || !verification.payload) {
      return {
        success: false,
        error: verification?.reason || "Invalid invite",
      };
    }
    const authorization = await validateTeamInviteAuthorization(
      supabaseAdmin,
      verification.payload,
      user,
      { requireEmail: true }
    );
    if (!authorization.allowed) {
      return { success: false, error: authorization.error };
    }
    const { companyId: invitedCompanyId, workspaceId: invitedWorkspaceId } =
      verification.payload;
    await syncPublicUserProfile(user);

    const seatCapacity = await ensureCompanySeatCapacityForUser(
      supabaseAdmin,
      invitedWorkspaceId,
      user.id
    );
    if (!seatCapacity.allowed) {
      return {
        success: false,
        error:
          "Company seat limit exceeded. Upgrade to Pro to invite more teammates.",
        workspaceId: invitedWorkspaceId,
      };
    }

    const grant = await grantTeamInviteMembership(supabaseAdmin, {
      inviter_id: verification.payload.inviterId,
      user_id: user.id,
      workspace_id: invitedWorkspaceId,
      company_id: invitedCompanyId,
      email: user.email_confirmed_at ? email : null,
    });

    if (grant.error || grant.status === "unresolved") {
      return {
        success: false,
        error:
          grant.error?.code === "42501"
            ? "This invitation can no longer be accepted. Ask an admin for a new invitation."
            : "Failed to join workspace",
      };
    }

    await clearInviteMetadata(user.id);
    if (grant.status === "already_member") {
      return {
        success: true,
        workspaceId: invitedWorkspaceId,
        alreadyProcessed: true,
      };
    }

    const fullName = (metadata?.full_name || metadata?.name) as
      | string
      | undefined;

    trackUserRegistration(
      user.id,
      invitedCompanyId,
      invitedWorkspaceId,
      "manager",
      "invite",
      email,
      fullName,
      { consent: await readServerTrackingConsent() }
    );

    try {
      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("*")
        .eq("id", invitedCompanyId)
        .single();

      if (company) {
        setCompanyProperties(invitedCompanyId, {
          company_name: company.name,
          company_slug: company.slug,
          business_context: company.business_context,
          language: company.lang,
          airi_language: company.airi_language,
          trial_starts_at: company.trial_starts_at,
          trial_ends_at: company.trial_ends_at,
          dynamic_context_tags: company.dynamic_context_tags,
          created_at: company.created_at,
        });
      }
    } catch {}

    return {
      success: true,
      workspaceId: invitedWorkspaceId,
      alreadyProcessed: false,
    };
  } catch {
    return {
      success: false,
      error: "Unknown error",
    };
  }
}

async function clearInviteMetadata(userId: string): Promise<void> {
  try {
    await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: {
        company_id: null,
        workspace_id: null,
        team_invite_token: null,
      },
    });
  } catch {}
}
