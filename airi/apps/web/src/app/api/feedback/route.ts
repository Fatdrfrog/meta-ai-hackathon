import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

/**
 * Session Feedback API
 * Collect feedback after conversation resolution
 */

interface FeedbackRequest {
  conversationId: string;
  rating?: number;
  resolutionQuality?: number;
  agentHelpfulness?: number;
  responseSpeed?: number;
  whatWentWell?: string;
  whatNeedsImprovement?: string;
  additionalComments?: string;
}

/**
 * POST - Submit feedback for a conversation
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as FeedbackRequest;
    const {
      conversationId,
      rating,
      resolutionQuality,
      agentHelpfulness,
      responseSpeed,
      whatWentWell,
      whatNeedsImprovement,
      additionalComments,
    } = body;

    if (!conversationId) return requiredFieldResponse("conversationId");

    // Validate ratings if provided
    const validateRating = (val: number | undefined, name: string) => {
      if (val !== undefined && (val < 1 || val > 5)) {
        throw new Error(`${name} must be between 1 and 5`);
      }
    };

    validateRating(rating, "rating");
    validateRating(resolutionQuality, "resolutionQuality");
    validateRating(agentHelpfulness, "agentHelpfulness");
    validateRating(responseSpeed, "responseSpeed");

    await connectDB();

    // Get conversation to verify access and get metadata
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const workspaceId = conversation.workspaceId;

    // Verify workspace access
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Access denied to this conversation" },
        { status: 403 }
      );
    }

    // Calculate conversation metrics
    const messageCount = await Message.countDocuments({
      conversation: conversationId,
    });

    const conversationDurationSeconds =
      conversation.lastMessageAt && conversation.createdAt
        ? Math.floor(
            (new Date(conversation.lastMessageAt).getTime() -
              new Date(conversation.createdAt).getTime()) /
              1000
          )
        : 0;

    const resolutionTimeSeconds =
      conversation.status === "closed" &&
      conversation.createdAt &&
      conversation.updatedAt
        ? Math.floor(
            (new Date(conversation.updatedAt).getTime() -
              new Date(conversation.createdAt).getTime()) /
              1000
          )
        : 0;

    // Insert feedback
    const { data: feedback, error: insertError } = await supabase
      .from("session_feedback")
      .insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        rating,
        resolution_quality: resolutionQuality,
        agent_helpfulness: agentHelpfulness,
        response_speed: responseSpeed,
        what_went_well: whatWentWell,
        what_needs_improvement: whatNeedsImprovement,
        additional_comments: additionalComments,
        channel: conversation.channel,
        submitted_by: user.id,
        submitted_by_type: "agent", // Could also be "customer" for post-session surveys
        conversation_duration_seconds: conversationDurationSeconds,
        message_count: messageCount,
        resolution_time_seconds: resolutionTimeSeconds,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Insert feedback error:", insertError);
      return NextResponse.json(
        { error: "Failed to save feedback" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      feedback,
      message: "Thank you for your feedback!",
    });
  } catch (error) {
    console.error("Submit feedback error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * GET - Get feedback analytics for workspace
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const conversationId = searchParams.get("conversationId");
    const days = parseInt(searchParams.get("days") || "30", 10);

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    // Verify workspace access
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    let query = supabase
      .from("session_feedback")
      .select("*")
      .eq("workspace_id", workspaceId)
      .gte("created_at", startDate.toISOString())
      .order("created_at", { ascending: false });

    if (conversationId) {
      query = query.eq("conversation_id", conversationId);
    }

    const { data: feedback, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: "Failed to fetch feedback" },
        { status: 500 }
      );
    }

    // Calculate aggregated metrics
    const feedbackData = feedback || [];
    const avgRating =
      feedbackData.length > 0
        ? feedbackData.reduce((sum, f) => sum + (f.rating || 0), 0) /
          feedbackData.length
        : 0;

    const avgResolutionQuality =
      feedbackData.length > 0
        ? feedbackData.reduce(
            (sum, f) => sum + (f.resolution_quality || 0),
            0
          ) / feedbackData.length
        : 0;

    const avgAgentHelpfulness =
      feedbackData.length > 0
        ? feedbackData.reduce((sum, f) => sum + (f.agent_helpfulness || 0), 0) /
          feedbackData.length
        : 0;

    const avgResponseSpeed =
      feedbackData.length > 0
        ? feedbackData.reduce((sum, f) => sum + (f.response_speed || 0), 0) /
          feedbackData.length
        : 0;

    return NextResponse.json({
      feedback: feedbackData,
      aggregates: {
        total_responses: feedbackData.length,
        avg_rating: parseFloat(avgRating.toFixed(2)),
        avg_resolution_quality: parseFloat(avgResolutionQuality.toFixed(2)),
        avg_agent_helpfulness: parseFloat(avgAgentHelpfulness.toFixed(2)),
        avg_response_speed: parseFloat(avgResponseSpeed.toFixed(2)),
      },
    });
  } catch (error) {
    console.error("Get feedback error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
