import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

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
    const category = searchParams.get("category");
    const limit = Number(searchParams.get("limit") || 5);

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await connectDB();

    const match: Record<string, unknown> = {
      workspaceId,
      channel: "whatsapp",
      ...(category
        ? {
            "classification.category": category,
            ...buildCurrentConversationClassificationFilter(),
          }
        : {}),
    };

    const suggestions = await Conversation.aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: match },
      { $unwind: "$internal_labels" },
      {
        $group: {
          _id: "$internal_labels",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: Number.isFinite(limit) ? limit : 5 },
    ]);

    return NextResponse.json({
      suggestions: suggestions.map(item => ({
        name: item._id,
        count: item.count,
      })),
    });
  } catch (error) {
    console.error("Get internal label suggestions error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
