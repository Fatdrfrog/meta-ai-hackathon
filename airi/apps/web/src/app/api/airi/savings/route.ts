import { NextResponse } from "next/server";
import {
  invalidJsonBodyResponse,
  readJsonObjectBody,
} from "@/lib/api/json-body";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";

export async function GET(req: Request) {
  const auth = await getSupabaseRouteAuth(req);
  if (isSupabaseRouteAuthError(auth))
    return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(req.url);
  const requestedWorkspaceId = searchParams.get("workspaceId");
  if (!requestedWorkspaceId?.trim())
    return new NextResponse(JSON.stringify({ error: "Missing workspaceId" }), {
      status: 400,
    });
  const access = await resolveUserWorkspaceMembership(
    auth.supabase,
    auth.user.id,
    requestedWorkspaceId
  );
  if (!access.ok)
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );
  const { workspaceId } = access;

  const { data, error } = await supabaseAdmin
    .from("airi_savings")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error)
    return new NextResponse(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  return NextResponse.json(
    data || {
      workspace_id: workspaceId,
      applied_count: 0,
      refund_avoid_count: 0,
      avg_refund_value: 0,
      minutes_saved_per_case: 0,
    }
  );
}

export async function PATCH(req: Request) {
  const auth = await getSupabaseRouteAuth(req);
  if (isSupabaseRouteAuthError(auth))
    return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObjectBody(req);
  } catch (error) {
    return invalidJsonBodyResponse(error);
  }
  const {
    workspaceId: requestedWorkspaceId,
    refund_avoid_count,
    avg_refund_value,
    minutes_saved_per_case,
  } = body || {};
  if (typeof requestedWorkspaceId !== "string" || !requestedWorkspaceId.trim())
    return new NextResponse(JSON.stringify({ error: "Invalid workspaceId" }), {
      status: 400,
    });
  const access = await resolveUserWorkspaceMembership(
    auth.supabase,
    auth.user.id,
    requestedWorkspaceId
  );
  if (!access.ok)
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );
  const { workspaceId } = access;

  const { data: existing } = await supabaseAdmin
    .from("airi_savings")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin
      .from("airi_savings")
      .update({ refund_avoid_count, avg_refund_value, minutes_saved_per_case })
      .eq("workspace_id", workspaceId);
    if (error)
      return new NextResponse(JSON.stringify({ error: error.message }), {
        status: 500,
      });
  } else {
    const { error } = await supabaseAdmin.from("airi_savings").insert({
      workspace_id: workspaceId,
      refund_avoid_count,
      avg_refund_value,
      minutes_saved_per_case,
      applied_count: 0,
    });
    if (error)
      return new NextResponse(JSON.stringify({ error: error.message }), {
        status: 500,
      });
  }

  return NextResponse.json({ ok: true });
}
