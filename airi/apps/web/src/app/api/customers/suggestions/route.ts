import { getCustomerSuggestions } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { Conversation } from "@/models/conversation";
import { NextRequest, NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const conversationId = request.nextUrl.searchParams.get("conversationId");
    if (!conversationId) return requiredFieldResponse("conversationId");

    await connectDB();

    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId")
      .lean<{ workspaceId?: string } | null>();

    if (!conversation?.workspaceId) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      conversation.workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const flags = await getWorkspaceFeatureFlags(conversation.workspaceId, [
      "customer_identity",
    ]);
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const suggestions = await getCustomerSuggestions({
      conversationId,
    });

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error("[Customer Suggestions API] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load customer suggestions" },
      { status: 500 }
    );
  }
}
