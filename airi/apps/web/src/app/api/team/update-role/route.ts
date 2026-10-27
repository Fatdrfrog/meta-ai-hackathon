import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  isCompanyAdminRole,
  isWorkspaceRole,
  mutateTeamMembership,
} from "@/lib/supabase/company-users";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { memberId, role } = await req.json();

    if (!memberId || !role) {
      return NextResponse.json(
        { error: "Member ID and role are required" },
        { status: 400 }
      );
    }

    if (!isWorkspaceRole(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // First, verify the target member exists and get their company/workspace
    const { data: targetMember, error: fetchError } = await supabaseAdmin
      .from("company_users")
      .select("workspace_id, role, user_id")
      .eq("id", memberId)
      .single();

    if (fetchError || !targetMember) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Check if the requester is an admin in the same company/workspace
    const { data: requester, error: requesterError } = await supabaseAdmin
      .from("company_users")
      .select("role")
      .eq("user_id", user.id)
      .eq("workspace_id", targetMember.workspace_id)
      .single();

    if (requesterError || !isCompanyAdminRole(requester?.role)) {
      return NextResponse.json(
        { error: "Forbidden: Admin access required" },
        { status: 403 }
      );
    }

    if (targetMember.user_id === user.id) {
      return NextResponse.json(
        {
          error: "You cannot change your own role",
        },
        { status: 403 }
      );
    }

    const mutation = await mutateTeamMembership(supabaseAdmin, {
      actor_id: user.id,
      member_id: memberId,
      action: "update-role",
      workspace_id: targetMember.workspace_id,
      expected_user_id: targetMember.user_id,
      expected_role: targetMember.role,
      role,
    });
    if (!mutation.ok) {
      return NextResponse.json(
        { error: mutation.error },
        { status: mutation.status }
      );
    }

    return NextResponse.json({ message: "Role updated successfully" });
  } catch (error) {
    console.error("Error updating role:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
