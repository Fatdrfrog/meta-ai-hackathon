import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  isCompanyAdminRole,
  mutateTeamMembership,
} from "@/lib/supabase/company-users";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ id: string }>;

export async function DELETE(req: NextRequest, { params }: { params: Params }) {
  const { id: memberId } = await params;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if the current user is an admin for the workspace/company
    // First, find the member we are trying to revoke
    const { data: targetMember, error: fetchError } = await supabaseAdmin
      .from("company_users")
      .select("workspace_id, user_id, role")
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
      .maybeSingle();

    if (requesterError || !requester || !isCompanyAdminRole(requester.role)) {
      return NextResponse.json(
        { error: "Forbidden: Admin access required" },
        { status: 403 }
      );
    }

    if (targetMember.user_id === user.id) {
      return NextResponse.json(
        {
          error: "You cannot remove your own membership",
        },
        { status: 403 }
      );
    }

    const mutation = await mutateTeamMembership(supabaseAdmin, {
      actor_id: user.id,
      member_id: memberId,
      action: "revoke",
      workspace_id: targetMember.workspace_id,
      expected_user_id: targetMember.user_id,
      expected_role: targetMember.role,
    });
    if (!mutation.ok) {
      return NextResponse.json(
        { error: mutation.error },
        { status: mutation.status }
      );
    }

    return NextResponse.json({ message: "Member removed successfully" });
  } catch (error) {
    console.error("Error revoking invite:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
