import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }
  const access = await resolveUserWorkspaceMembership(
    supabase,
    user.id,
    new URL(request.url).searchParams.get("workspaceId")
  );
  if (!access.ok)
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );

  const { data: sources, error: sourcesError } = await supabase
    .from("sources")
    .select("id, type, name")
    .eq("workspace_id", access.workspaceId);

  if (sourcesError) {
    return new Response(JSON.stringify({ error: sourcesError.message }), {
      status: 500,
    });
  }

  return NextResponse.json({ data: sources });
}
