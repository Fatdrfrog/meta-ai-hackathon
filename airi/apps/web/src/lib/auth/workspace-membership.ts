import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function getAuthenticatedWorkspaceMembership(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const { data: membership, error: membershipError } = await supabase
    .from("company_users")
    .select("role")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (membershipError || !membership) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return {
    supabase,
    user: { id: user.id },
    membership,
  };
}
