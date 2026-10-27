import { createClient } from "@/lib/supabase/server";
import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import { isValidObjectId } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

type EventPayload = {
  type:
    | "suggestion_shown"
    | "applied"
    | "dismissed"
    | "send_cleared"
    | "feedback";
  conversationId: string;
  suggestionId?: string;
  feedback?: "helpful" | "not_helpful" | "unclear";
  workspaceId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user)
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });

    const body = (await request.json()) as EventPayload;
    if (!body?.type || !body?.conversationId) {
      return new NextResponse(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
      });
    }

    if (!isValidObjectId(body.conversationId))
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    await connectDB();
    const conversation = await Conversation.findById(body.conversationId)
      .select("workspaceId")
      .lean<{ workspaceId?: string } | null>();
    if (!conversation?.workspaceId)
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    if (
      body.workspaceId != null &&
      body.workspaceId !== conversation.workspaceId
    )
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      });
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

    // Coach events are acknowledged only; the cooldown key this route once
    // wrote to Upstash was never read.
    return NextResponse.json({ ok: true });
  } catch (e) {
    return new NextResponse(JSON.stringify({ error: "Internal error" + e }), {
      status: 500,
    });
  }
}
