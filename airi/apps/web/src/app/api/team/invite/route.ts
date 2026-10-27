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

// naive in-memory limiter per process (acceptable for serverless bursts; replace with Upstash for prod)
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const ipHits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  if (!rateLimit(ip)) {
    return new Response(JSON.stringify({ error: "Too Many Requests" }), {
      status: 429,
    });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const body = await request.json().catch(() => ({}));
  const newMemberEmail =
    typeof body?.email === "string" ? body.email.trim() : "";
  const workspaceIdFromBody =
    typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";

  if (!workspaceIdFromBody) return requiredFieldResponse("workspaceId");

  if (!newMemberEmail)
    return new Response(JSON.stringify({ error: "Email is required" }), {
      status: 400,
    });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(newMemberEmail))
    return new Response(JSON.stringify({ error: "Invalid email" }), {
      status: 400,
    });
  if (newMemberEmail.toLowerCase() === (user.email || "").toLowerCase()) {
    return new Response(
      JSON.stringify({ error: "You cannot invite yourself" }),
      { status: 400 }
    );
  }

  try {
    const companyUserQuery = supabase
      .from("company_users")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceIdFromBody);

    const { data: companyUser, error: membershipError } =
      await companyUserQuery.maybeSingle();

    if (
      membershipError ||
      !companyUser ||
      !isCompanyAdminRole(companyUser.role)
    )
      return new Response(
        JSON.stringify({
          error: "Only workspace admins can invite teammates",
        }),
        { status: 403 }
      );

    const companyId = await getCompanyIdForWorkspace(
      supabase,
      companyUser.workspace_id
    );

    if (!companyId) {
      return new Response(
        JSON.stringify({ error: "Workspace company not found" }),
        { status: 400 }
      );
    }

    const seatCapacity = await ensureCompanySeatCapacity(
      supabaseAdmin,
      companyUser.workspace_id
    );
    if (!seatCapacity.allowed) {
      return buildCompanySeatLimitExceededResponse(seatCapacity.limit);
    }

    const appBase = getAppBaseUrl(request);
    const redirectTo = `${appBase}/auth/confirm`;
    const { token } = createTeamInviteToken({
      companyId,
      workspaceId: companyUser.workspace_id,
      inviterId: user.id,
      email: newMemberEmail,
    });

    const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      newMemberEmail,
      {
        data: {
          company_id: companyId,
          workspace_id: companyUser.workspace_id,
          team_invite_token: token,
        },
        redirectTo,
      }
    );

    if (error) {
      const msg = (error.message || "").toLowerCase();
      const isLikelyExistingUser =
        error.status === 422 ||
        msg.includes("already") ||
        msg.includes("registered") ||
        msg.includes("exists");

      if (isLikelyExistingUser) {
        const manualInviteUrl = `${appBase}/auth/joined?token=${encodeURIComponent(token)}`;
        return NextResponse.json({
          success: true,
          delivery: "manual_link",
          manualInviteUrl,
          message: `This email already has an account. Copy the join link and send it to ${newMemberEmail} — after they sign in, they will join this workspace.`,
        });
      }

      if (error.code) {
        return new Response(
          JSON.stringify({
            error: error.message || error.code,
            code: error.code,
          }),
          { status: error.status || 400 }
        );
      }
      throw error;
    }

    return NextResponse.json({
      success: true,
      delivery: "email",
      message: `Request sent to ${newMemberEmail}`,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
    });
  }
}
