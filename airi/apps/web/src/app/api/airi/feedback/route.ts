import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import { isValidObjectId } from "mongoose";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const {
      suggestionId,
      conversationId,
      feedback,
      tipType,
      workspaceId: requestedWorkspaceId,
    } = await req.json();

    if (!suggestionId || !conversationId || !feedback) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Get the current user
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isValidObjectId(conversationId))
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    await connectDB();
    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId")
      .lean<{ workspaceId?: string } | null>();
    if (!conversation?.workspaceId)
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    if (
      requestedWorkspaceId != null &&
      requestedWorkspaceId !== conversation.workspaceId
    )
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const access = await resolveUserWorkspaceMembership(
      supabase,
      user.id,
      conversation.workspaceId
    );
    if (!access.ok)
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );

    const { error } = await supabaseAdmin.from("airi_tip_feedback").insert({
      suggestion_id: suggestionId,
      agent_id: user.id,
      workspace_id: access.workspaceId,
      conversation_id: conversationId,
      tip_type: tipType || "unknown",
      action: "rated",
      was_helpful: feedback === "helpful",
    });
    if (error)
      return NextResponse.json(
        { error: "Failed to save feedback" },
        { status: 500 }
      );

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
