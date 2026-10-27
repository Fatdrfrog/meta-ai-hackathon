import { createClient } from "@/lib/supabase/server";
import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { isValidObjectId } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      conversationId,
      outcomeType,
      revenueAmount,
      confidence,
      notes,
      workspaceId: requestedWorkspaceId,
    } = await req.json();

    // Validate required fields
    if (!conversationId || !outcomeType || !revenueAmount || !confidence) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Validate outcome type
    const validOutcomes = [
      "churn_prevented",
      "upsell",
      "cross_sell",
      "expansion",
      "retention",
    ];
    if (!validOutcomes.includes(outcomeType)) {
      return NextResponse.json(
        { error: "Invalid outcome type" },
        { status: 400 }
      );
    }

    // Validate confidence
    const validConfidence = ["confirmed", "estimated", "predicted"];
    if (!validConfidence.includes(confidence)) {
      return NextResponse.json(
        { error: "Invalid confidence level" },
        { status: 400 }
      );
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

    // Insert attribution to Supabase
    const { data: attribution, error: attributionError } = await supabase
      .from("revenue_attributions")
      .insert({
        workspace_id: access.workspaceId,
        conversation_id: conversationId,
        outcome_type: outcomeType,
        revenue_amount: parseFloat(revenueAmount),
        attributed_to_agent: user.id,
        confidence,
        notes: notes || null,
      })
      .select()
      .single();

    if (attributionError) {
      console.error("Error creating attribution:", attributionError);
      return NextResponse.json(
        { error: "Failed to create attribution" },
        { status: 500 }
      );
    }

    // Update conversation in MongoDB with attribution ID
    await Conversation.findByIdAndUpdate(conversationId, {
      revenue_attribution_id: attribution.id,
    });

    return NextResponse.json({ success: true, attribution });
  } catch (error) {
    console.error("Revenue attribution error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const conversationId = searchParams.get("conversationId");

    const requestedWorkspaceId = searchParams.get("workspaceId");
    let resourceWorkspaceId: string | undefined;
    if (conversationId) {
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
      resourceWorkspaceId = conversation.workspaceId;
      if (
        requestedWorkspaceId != null &&
        requestedWorkspaceId !== resourceWorkspaceId
      )
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const access = await resolveUserWorkspaceMembership(
      supabase,
      user.id,
      resourceWorkspaceId ?? requestedWorkspaceId
    );
    if (!access.ok)
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );

    // Build query
    let query = supabase
      .from("revenue_attributions")
      .select("*")
      .eq("workspace_id", access.workspaceId)
      .order("created_at", { ascending: false });

    if (conversationId) {
      query = query.eq("conversation_id", conversationId);
    }

    const { data: attributions, error } = await query;

    if (error) {
      console.error("Error fetching attributions:", error);
      return NextResponse.json(
        { error: "Failed to fetch attributions" },
        { status: 500 }
      );
    }

    return NextResponse.json({ attributions });
  } catch (error) {
    console.error("Revenue attribution fetch error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
