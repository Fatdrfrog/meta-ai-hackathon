import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

type LabelStats = {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  is_active: boolean;
  count: number;
};

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
    const activeOnly = searchParams.get("activeOnly") === "true";

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let labelQuery = supabase
      .from("internal_labels")
      .select("id,name,color,description,is_active")
      .eq("workspace_id", workspaceId)
      .order("name", { ascending: true });

    if (activeOnly) {
      labelQuery = labelQuery.eq("is_active", true);
    }

    const { data: labels, error } = await labelQuery;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await connectDB();

    const counts = await Conversation.aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: { workspaceId } },
      { $unwind: "$internal_labels" },
      {
        $group: {
          _id: "$internal_labels",
          count: { $sum: 1 },
        },
      },
    ]);

    const countByName = new Map(counts.map(entry => [entry._id, entry.count]));

    const payload: LabelStats[] = (labels || []).map(label => ({
      id: label.id,
      name: label.name,
      color: label.color ?? null,
      description: label.description ?? null,
      is_active: label.is_active,
      count: countByName.get(label.name) ?? 0,
    }));

    return NextResponse.json({ labels: payload });
  } catch (error) {
    console.error("Get internal label stats error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
