import { trackCompanyEvent } from "@/lib/analytics";
import { createTeamInviteToken } from "@/lib/auth/team-invite-link";
import {
  buildCompanySeatLimitExceededResponse,
  ensureCompanySeatCapacity,
} from "@/lib/limits/company-limits";
import {
  getCompanyIdForWorkspace,
  isCompanyAdminRole,
} from "@/lib/supabase/company-users";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

function getAppBaseUrl(request: NextRequest): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  const origin = new URL(request.url).origin;
  return (configured || origin).replace(/\/$/, "");
}

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
    const workspaceId =
      typeof body?.workspaceId === "string" ? body.workspaceId : "";

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const { data: membership, error: membershipError } = await supabaseAdmin
      .from("company_users")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (
      membershipError ||
      !membership ||
      !isCompanyAdminRole(membership.role)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const companyId = await getCompanyIdForWorkspace(
      supabaseAdmin,
      membership.workspace_id
    );

    if (!companyId) {
      return NextResponse.json(
        { error: "Workspace company not found" },
        { status: 400 }
      );
    }

    const seatCapacity = await ensureCompanySeatCapacity(
      supabaseAdmin,
      membership.workspace_id
    );
    if (!seatCapacity.allowed) {
      return buildCompanySeatLimitExceededResponse(seatCapacity.limit);
    }

    const { token, expiresAt } = createTeamInviteToken({
      companyId,
      workspaceId: membership.workspace_id,
      inviterId: user.id,
    });

    const appBaseUrl = getAppBaseUrl(request);
    const inviteUrl = `${appBaseUrl}/auth/joined?token=${encodeURIComponent(token)}`;
    const expiresAtIso = new Date(expiresAt * 1000).toISOString();

    trackCompanyEvent(
      "team_invite_link_copied",
      {
        user_id: user.id,
        role: membership.role || "manager",
        expires_at: expiresAtIso,
        entrypoint: "team_settings",
      },
      companyId,
      membership.workspace_id
    );

    return NextResponse.json({
      inviteUrl,
      expiresAt: expiresAtIso,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate invite link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
