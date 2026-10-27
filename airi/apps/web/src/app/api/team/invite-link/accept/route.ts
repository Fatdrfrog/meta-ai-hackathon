import { trackCompanyEvent } from "@/lib/analytics";
import { verifyTeamInviteToken } from "@/lib/auth/team-invite-link";
import { validateTeamInviteAuthorization } from "@/lib/auth/team-invite-authorization";
import { syncPublicUserProfile } from "@/lib/auth/user-profile-sync";
import {
  buildCompanySeatLimitExceededResponse,
  ensureCompanySeatCapacityForUser,
} from "@/lib/limits/company-limits";
import { grantTeamInviteMembership } from "@/lib/supabase/company-users";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const token = typeof body?.token === "string" ? body.token : "";
    if (!token) return requiredFieldResponse("token");

    const verification = verifyTeamInviteToken(token);
    if (!verification.valid || !verification.payload) {
      return NextResponse.json(
        { error: verification.reason || "Invalid invite link" },
        { status: 400 }
      );
    }

    const payload = verification.payload;
    const authorization = await validateTeamInviteAuthorization(
      supabaseAdmin,
      payload,
      user
    );
    if (!authorization.allowed) {
      return NextResponse.json({ error: authorization.error }, { status: 403 });
    }
    const { data: existingMembership, error: membershipError } =
      await supabaseAdmin
        .from("company_users")
        .select("id")
        .eq("user_id", user.id)
        .eq("workspace_id", payload.workspaceId)
        .maybeSingle();

    if (membershipError) {
      return NextResponse.json(
        { error: "Failed to verify membership" },
        { status: 500 }
      );
    }

    let status: "already_member" | "joined" = "already_member";

    if (!existingMembership) {
      const seatCapacity = await ensureCompanySeatCapacityForUser(
        supabaseAdmin,
        payload.workspaceId,
        user.id
      );
      if (!seatCapacity.allowed) {
        return buildCompanySeatLimitExceededResponse(seatCapacity.limit);
      }

      await syncPublicUserProfile(user);

      const grant = await grantTeamInviteMembership(supabaseAdmin, {
        inviter_id: payload.inviterId,
        user_id: user.id,
        workspace_id: payload.workspaceId,
        company_id: payload.companyId,
        email: user.email_confirmed_at ? user.email || null : null,
      });

      if (grant.error || grant.status === "unresolved") {
        return NextResponse.json(
          { error: "Failed to join workspace" },
          { status: grant.error?.code === "42501" ? 403 : 500 }
        );
      }
      status = grant.status;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    trackCompanyEvent(
      "team_invite_link_joined",
      {
        user_id: user.id,
        inviter_user_id: payload.inviterId,
        status,
        token_age_seconds: Math.max(0, nowSeconds - payload.iat),
      },
      payload.companyId,
      payload.workspaceId
    );

    return NextResponse.json({
      success: true,
      workspaceId: payload.workspaceId,
      status,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to accept invite link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
