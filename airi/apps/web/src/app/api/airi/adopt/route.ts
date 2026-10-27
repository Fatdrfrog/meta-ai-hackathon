import connectDB from "@/lib/mongoose";
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
import CoachingTip from "@/models/coaching-tip";
import { isValidObjectId } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const auth = await getSupabaseRouteAuth(req);
    if (isSupabaseRouteAuthError(auth))
      return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: Record<string, unknown>;
    try {
      body = await readJsonObjectBody(req);
    } catch (error) {
      return invalidJsonBodyResponse(error);
    }
    const { workspaceId: requestedWorkspaceId, suggestionId } = body || {};
    if (
      typeof requestedWorkspaceId !== "string" ||
      !requestedWorkspaceId.trim() ||
      !suggestionId
    ) {
      return new NextResponse(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
      });
    }
    if (typeof suggestionId !== "string" || !isValidObjectId(suggestionId))
      return NextResponse.json(
        { error: "Suggestion not found" },
        { status: 404 }
      );

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

    await connectDB();
    const tip = await CoachingTip.findById(suggestionId)
      .select("workspaceId")
      .lean<{ workspaceId?: string } | null>();
    if (!tip?.workspaceId)
      return NextResponse.json(
        { error: "Suggestion not found" },
        { status: 404 }
      );
    if (tip.workspaceId !== workspaceId)
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const adopted = await CoachingTip.findOneAndUpdate(
      { _id: suggestionId, workspaceId },
      { adopted: true, adoptedAt: new Date() }
    );
    if (!adopted)
      return NextResponse.json(
        { error: "Suggestion not found" },
        { status: 404 }
      );

    const { data: existing } = await supabaseAdmin
      .from("airi_savings")
      .select("workspace_id, applied_count")
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (existing) {
      await supabaseAdmin
        .from("airi_savings")
        .update({ applied_count: (existing.applied_count || 0) + 1 })
        .eq("workspace_id", workspaceId);
    } else {
      await supabaseAdmin
        .from("airi_savings")
        .insert({ workspace_id: workspaceId, applied_count: 1 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: "Internal error: " + e },
      { status: 500 }
    );
  }
}
